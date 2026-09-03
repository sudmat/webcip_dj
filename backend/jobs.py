"""Background job runner for the auto-process pipeline.

A run takes several minutes (four Docker tools), so it cannot be an HTTP request. One job runs
at a time on a worker thread; the browser follows it over SSE and can rejoin after a reload.

The event payload mirrors what the desktop's ``desktop/busy.py::progress_sink`` feeds the
Auto-process dialog's rows — per step: status, elapsed, the tool's latest log line, and an
optional fraction — plus a run total. Each tool's own ``log=`` callback becomes ``line``.
"""
from __future__ import annotations

import queue
import threading
import time
import uuid

from . import autoprocess, store

PENDING, RUNNING, DONE, FAILED = "pending", "running", "done", "failed"


class Job:
    """One run of one or more steps against a SHARED `autoprocess.Run`.

    The Run belongs to the workflow session, not the job: Auto process and the manual numbered
    steps drive the same state (as the desktop's steps and auto_process both drive one `ctx`), so
    a manual step continues from where the previous one left off.
    """

    def __init__(self, run, steps):
        self.id = uuid.uuid4().hex[:12]
        self.run = run
        self.steps = [{"key": k, "label": lbl, "status": PENDING, "elapsed": 0.0}
                      for k, lbl in steps]
        self.active: str | None = None
        self.line = ""
        self.frac: float | None = None
        self.error: str | None = None
        self.started = 0.0
        # Bumped whenever a step lands something displayable. The desktop's steps push straight
        # into the live scene as they finish (a synthetic after Erase, structures after Segment,
        # the lead after Search); the browser can't be pushed to, so it re-fetches the result
        # whenever this changes.
        self.revision = 0
        self.finished = False
        self.completed = False           # every step done
        self._step_started = 0.0
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()

    # --- state -------------------------------------------------------------------
    def snapshot(self) -> dict:
        total = (time.monotonic() - self.started) if self.started else 0.0
        if self.finished:
            total = sum(s["elapsed"] for s in self.steps)
        return {
            "jobId": self.id,
            "steps": [dict(s) for s in self.steps],
            "active": self.active,
            "line": self.line,
            "frac": self.frac,
            "total": round(total, 1),
            "revision": self.revision,
            "error": self.error,
            "finished": self.finished,
            "completed": self.completed,
        }

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._subs.append(q)
        q.put(self.snapshot())
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def _emit(self) -> None:
        snap = self.snapshot()
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            q.put(snap)

    def _tick(self) -> None:
        """Refresh the running step's elapsed from OUR step clock — one step may make several
        reported calls (a registration runs two passes), and the row should show the time that
        STEP has taken, not the time since its latest sub-call (the desktop's _tick)."""
        if self.active:
            for s in self.steps:
                if s["key"] == self.active:
                    s["elapsed"] = round(time.monotonic() - self._step_started, 1)

    # --- the run -----------------------------------------------------------------
    def start(self) -> None:
        threading.Thread(target=self._work, name=f"auto-{self.id}", daemon=True).start()

    def _work(self) -> None:
        self.started = time.monotonic()
        try:
            for step in self.steps:
                key = step["key"]
                self.active = key
                self._step_started = time.monotonic()
                step["status"] = RUNNING
                self.line = ""
                self.frac = None
                self._emit()

                def log(msg, _k=key):
                    self.line = str(msg)
                    self._tick()
                    self._emit()

                runner = autoprocess.RUNNERS.get(key)
                if runner is None:
                    raise autoprocess.StepFailed(
                        f"'{step['label']}' is not implemented on the web yet.")
                try:
                    runner(self.run, log)
                except Exception as exc:  # noqa: BLE001 — the step failed; stop the run
                    self._tick()
                    step["status"] = FAILED
                    self.error = str(exc) or exc.__class__.__name__
                    self.active = None
                    self._emit()
                    return
                self._tick()
                step["status"] = DONE
                self.active = None
                self.revision += 1        # this step's result is displayable now
                self._emit()
            self.completed = True
        finally:
            self.active = None
            self.finished = True
            self._emit()

    # --- the result --------------------------------------------------------------
    def result(self) -> dict:
        """The run so far, in POST /api/cdb's shape (backend/result.py) — the browser displays it
        through the path the .cdb feature already uses."""
        from .result import cdb_payload

        # A one-step job is a MANUAL step, so it is named after the step rather than captioning
        # every result "Auto process".
        name = self.steps[0]["label"] if len(self.steps) == 1 else "Auto process"
        return cdb_payload(self.run, self.id, name)


# --- the registry ----------------------------------------------------------------
# Process-global, like everything else the workflow owns (backend/workflow.py). Jobs are kept
# after they finish so a browser can still fetch the result and rejoin the event stream.
_JOBS: dict[str, Job] = {}
_current: str | None = None


def start(run, steps) -> Job:
    """Start a job over `steps` (a list of ``(key, label)``) against `run`.

    ONE AT A TIME, process-wide: the steps mutate the shared session, so two running together
    would corrupt it. A second start while one is live is refused, and the caller turns that
    into a 409.
    """
    global _current
    cur = current()
    if cur is not None:
        raise RuntimeError("A processing step is already in progress.")
    job = Job(run, steps)
    _JOBS[job.id] = job
    _current = job.id
    job.start()
    return job


def get(job_id: str) -> "Job | None":
    return _JOBS.get(job_id)


def current() -> "Job | None":
    """The job running right now, or None. Used both to refuse a second start and to decide
    whether the workspace is genuinely busy (backend/workflow.py)."""
    job = _JOBS.get(_current or "")
    return job if job is not None and not job.finished else None
