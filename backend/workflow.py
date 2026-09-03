"""The workflow session — the state the numbered steps accumulate, shared with Auto process.

The desktop keeps this on its AppContext: the loaded images with their roles, the chosen ear, and
the planning objects/matrices each step contributes. Auto process and the manual steps drive the
SAME state there (auto_process's runners call the same `ctx` the step classes do), so the web needs
one session-level ``autoprocess.Run`` rather than one per job — otherwise step 4 would not see what
step 3 produced.

Gating lives here too, as a port of each step's ``is_available(ctx)``
(projects/cip/__init__.py): the browser asks for the state and greys the steps it says are not
ready, so the rules stay in one place rather than being restated in TypeScript.
"""
from __future__ import annotations

import time

import numpy as np

from . import autoprocess, store


# How long a holder keeps an IDLE workspace after their last action.
#
# Short on purpose. The hold exists to stop two people clobbering each other, and the case where
# that actually destroys something is a step RUNNING — which is handled separately below, and
# never lapses. An idle hold protects only "images I loaded and am still looking at", so a stale
# one (a closed tab, a script that exited) costs far more than it saves: the workspace reads as
# busy while the machine sits doing nothing. 30 minutes of that was pure friction.
HOLD_IDLE_SECONDS = 3 * 60


class Session:
    """One workspace: the images (with roles), the ear, and the plan state built up by the steps."""

    def __init__(self) -> None:
        self.run = autoprocess.Run([], "", 0)
        self.plan_name = ""
        # There is ONE workspace for the whole server, so two browsers would otherwise
        # overwrite each other in silence — B's 'Load preop CT' calls clear() and A's next
        # click acts on B's scan. The holder does not prevent that; it makes it VISIBLE, which
        # is the difference between a coordination problem and a patient mix-up.
        self.holder: str = ""
        self.held_at: float = 0.0

    # --- who has the workspace ------------------------------------------------------
    def holder_now(self) -> str:
        """The current holder, or '' once the hold has lapsed.

        A hold does NOT lapse while a step is running: that is the one case where a second
        session's action would corrupt something (two runners mutating one Run), and a long
        pipeline step legitimately goes minutes without an HTTP call. Otherwise it lapses on
        idle, so nothing stays "in use" while the machine is doing nothing.
        """
        if not self.holder:
            return ""
        from . import jobs                                # local: jobs imports autoprocess
        if jobs.current() is not None:
            return self.holder
        if time.time() - self.held_at > HOLD_IDLE_SECONDS:
            self.holder = ""
        return self.holder

    def release(self, sid: str) -> bool:
        """Give the workspace back. A client that is finished should say so rather than leave
        everyone else waiting out the idle timer."""
        if sid and self.holder == sid:
            self.holder = ""
            return True
        return False

    def claim(self, sid: str, takeover: bool = False) -> str | None:
        """Take or refresh the hold for `sid`. Returns the blocking holder, or None on success.

        Called by every mutating route. Claiming is implicit — the first action takes the
        workspace — so a lone user never sees this machinery at all.
        """
        current = self.holder_now()
        if current and current != sid and not takeover:
            return current
        self.holder = sid
        self.held_at = time.time()
        return None

    def touch(self, sid: str) -> None:
        """Extend the hold without claiming it (for a holder's own read-only polling)."""
        if sid and self.holder_now() == sid:
            self.held_at = time.time()

    # --- images ------------------------------------------------------------------
    def add_image(self, image, role: str) -> None:
        """Add a loaded image in a role, with the desktop's Load-file semantics
        (projects/cip/__init__.py::_LoadStep):

        - 'preop' CLEARS the workspace first — one patient per plan.
        - 'postop' REPLACES any existing postop and is stacked over the preop.
        """
        if role == "preop":
            self.clear()
        elif role == "postop":
            for old in [im for im in self.run.images if getattr(im, "role", "") == "postop"]:
                self.run.images.remove(old)
        image.role = role
        self.run.images.append(image)

    def remove_image(self, image_id: str) -> bool:
        before = len(self.run.images)
        self.run.images = [im for im in self.run.images if im.id != image_id]
        return len(self.run.images) != before

    # --- side --------------------------------------------------------------------
    @property
    def side(self) -> str:
        return self.run.side

    def set_side(self, side: str) -> None:
        """Choosing a different ear cancels the planning work but keeps the images — the
        desktop's `reset_plan_keep_images` (the confirmation is the browser's)."""
        if self.run.side and self.run.side != side:
            self.reset_plan_keep_images()
        self.run.side = side
        self.run.state["side"] = side

    # --- clearing ----------------------------------------------------------------
    def clear(self) -> None:
        """Back to scratch: no images, no plan, NO SIDE (the Load menu's 'Clear workspace' —
        `self.session = Session()` then "re-gate steps + clear the banner status (no side)",
        desktop/main.py::clear_workspace)."""
        self.run = autoprocess.Run([], "", 0)
        self.plan_name = ""

    def reset_plan_keep_images(self) -> None:
        """Drop the planning work, keep the loaded images. A synthetic is a RESULT (of Erase
        implant), so it goes with the work and the image it came from returns to being the preop."""
        images = [im for im in self.run.images if getattr(im, "role", "") != "synthetic"]
        has_preop = any(getattr(im, "role", "") == "preop" for im in images)
        for im in images:
            # Erase implant flipped the original to 'postop'; with its synthetic gone it is the
            # preop again, so the flow can be re-run from the implanted scan.
            if not has_preop and getattr(im, "role", "") == "postop":
                im.role = "preop"
                has_preop = True
            im.clear_registration()      # the placement each step produced goes with the work
        run = autoprocess.Run(images, self.run.side, self.run.electrode_id)
        run.state["side"] = self.run.side
        self.run = run

    def clear_structures(self) -> None:
        """Step 4's 'Clear all': remove segmented anatomy + any insertion plan, but KEEP the
        postop-anchored implant meshes (they belong to the electrode search) and the lead."""
        postop = self.run.postop()
        pid = postop.id if postop is not None else None
        self.run.objects = [
            o for o in self.run.objects
            if o.kind != "trajectory"
            and not (o.kind == "structure" and getattr(o, "source_image", None) != pid)
        ]
        cip = self.run.state.setdefault("cip", {})
        for key in ("preseg_out", "segmentation"):
            cip.pop(key, None)
        cip["electrode_id"] = None
        cip["plan_electrodes"] = []

    def clear_electrodes(self) -> None:
        """Step 6's 'Clear all': the lead + the two implant meshes; segmented anatomy untouched."""
        postop = self.run.postop()
        pid = postop.id if postop is not None else None
        self.run.objects = [
            o for o in self.run.objects
            if o.kind != "lead"
            and not (o.kind == "structure" and pid is not None
                     and getattr(o, "source_image", None) == pid)
        ]
        self.run.state.setdefault("cip", {})["seg_electrode_id"] = None

    # --- gating (ports of each step's is_available) --------------------------------
    def _registered(self) -> bool:
        m = self.run.state.get("mat_preop")
        return m is not None and not np.allclose(np.asarray(m, float), np.eye(4))

    def _has_structures(self) -> bool:
        """Segmented ANATOMY — excludes the postop-anchored implant meshes, which persist through
        'Clear all structures' and must not be mistaken for anatomy (the desktop's rule)."""
        postop = self.run.postop()
        pid = postop.id if postop is not None else None
        return any(o.kind == "structure" and getattr(o, "source_image", None) != pid
                   for o in self.run.objects)

    def state(self, sid: str = "") -> dict:
        """What the browser needs to render the workflow column: the banner, per-step gating,
        which results exist, and who holds the workspace."""
        preop, postop = self.run.preop(), self.run.postop()
        has_lead = self.run.lead() is not None
        registered = self._registered()
        structures = self._has_structures()
        two_cts = preop is not None and postop is not None and preop is not postop
        has_img = bool(self.run.images)
        from . import jobs
        running = jobs.current()
        holder = self.holder_now()
        return {
            "holder": holder,
            "holderSince": self.held_at if holder else 0.0,
            "isMine": not holder or holder == sid,
            # True only while a step is actually running — the difference between "someone is
            # mid-run" and "someone loaded an image a minute ago".
            "busy": running is not None,
            "busyLabel": (running.steps[0]["label"] if running and running.steps else ""),
            "side": self.run.side,
            "module": "postop" if postop is not None else "preop",
            "planName": self.plan_name,
            "images": [store.geometry_dict(im) for im in self.run.images],
            "electrodeId": (self.run.state.get("cip") or {}).get("seg_electrode_id"),
            "results": {
                "registered": registered,
                "structures": structures,
                "synthetic": self.run.synthetic() is not None,
                "postopRegistered": self.run.state.get("mat_postop_preop") is not None,
                "lead": has_lead,
            },
            # Gating per numbered step. The desktop's rule is
            #   enabled = step.is_available(ctx) and (has_img or not step.requires_image)
            # (desktop/workflow.py:240) — so every step but Load also needs an image, which is
            # why `has_img` is folded in here rather than left to each predicate.
            "available": {
                "load": True,                                    # _LoadStep.requires_image False
                "side": has_img,                                 # _SideStep
                "atlas": has_img and bool(self.run.side),        # _RegisterAtlasStep
                "segment": has_img and registered,               # _SegmentStructuresStep
                "postop": has_img and bool(self.run.side) and two_cts,   # _RegisterPostopStep
                "electrodes": has_img and structures and postop is not None,  # _SearchElectrodesStep
            },
        }


_SESSION = Session()


def session() -> Session:
    return _SESSION


def reset() -> None:
    _SESSION.clear()
