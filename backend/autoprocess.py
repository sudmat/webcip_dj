"""The CIP 'Auto process' pipeline, headless — a port of projects/cip/auto_process.py.

The desktop module cannot be reused directly: unlike ``workspace.load_workspace`` and
``cdb_scene.assemble`` it imports PySide6 and drives ``ctx`` (AppContext -> MainWindow -> Qt
dialogs). Everything BENEATH it is Qt-free and IS reused unchanged — the tools themselves
(``pv_core.tools.dq/jn/pcisp``), the transforms each one wants
(``projects.cip.reg_debug.jn_transform / pcisp_transform``), and the parsers that turn tool
output into planning objects (``projects.cip.segmentation.load_structures / load_postop``).
Only the orchestration is re-implemented, with ``ctx`` replaced by `Run` and every Qt popup
replaced by a raised `StepFailed`.

PREOP-ONLY route (an implanted scan loaded as the preop):

    register preop to atlas (DQ) -> erase implant (JN, auto-accepted) ->
    segment structures (PCISP, on the synthetic) -> search for electrodes.

PREOP+POSTOP route (two real scans): the erase is skipped and the postop is registered onto the
preop instead (DL global, then AMIR local MI on the modiolus box).

The same runners serve the MANUAL workflow — the numbered step column drives one of them at a
time through POST /api/step/{key} (backend/workflow.py holds the session they share).

Each step drives the SAME machinery as its manual counterpart, minus the per-step
confirmations — matrices, provenance histories and session state land where the manual steps
put them. preop->atlas is matrix-only: ``mat_preop = inv(M_dl)`` by dq.landmark_matrix's
contract, and nothing moves.
"""
from __future__ import annotations

import numpy as np

from . import pvcore_path  # noqa: F401  (sets sys.path for pv_core + projects)


class StepFailed(RuntimeError):
    """A step failed; its message is user-facing (the desktop showed it in a dialog)."""


# --- the run's state (the web's stand-in for AppContext + Scene + Session) ------------

class Run:
    """One auto-process run: the images with their roles, plus the planning state the steps
    accumulate (the desktop's ``session.state`` + ``session.objects``)."""

    def __init__(self, images, side: str, electrode_id: int):
        self.images = list(images)
        self.side = side
        self.electrode_id = int(electrode_id)
        self.state: dict = {"side": side, "cip": {}}
        self.objects: list = []          # plan_objects: Structures + the localized Lead

    # role lookup — mirrors projects/cip/__init__.py::_preop_ct / _postop_ct / _synthetic_image
    def _by_role(self, role: str):
        return next((im for im in self.images if getattr(im, "role", "") == role), None)

    def synthetic(self):
        return self._by_role("synthetic")

    def postop(self):
        return self._by_role("postop")

    def preop(self):
        """The image the preop steps act on: the synthetic stands in as the preop once it
        exists, else the preop-role image, else the first loaded image."""
        return (self.synthetic() or self._by_role("preop")
                or (self.images[0] if self.images else None))

    def add_image(self, image) -> None:
        self.images.append(image)

    def structures(self) -> list:
        return [o for o in self.objects if o.kind == "structure"]

    def lead(self):
        return next((o for o in self.objects if o.kind == "lead"), None)


def plan_steps(images) -> list:
    """The (key, label) flow for the loaded images. A lone preop is an implanted scan that gets
    erased; with a real preop AND a postop the erase is skipped and the postop is registered to
    the preop instead."""
    single = not any(getattr(im, "role", "") == "postop" for im in images)
    steps = [("atlas", "Register preop to atlas")]
    if single:
        steps.append(("erase", "Erase implant"))
    steps.append(("segment", "Segment structures"))
    if not single:
        steps.append(("postop", "Register postop to preop"))
    steps.append(("electrodes", "Search for electrodes"))
    return steps


def _require(tool, name: str, image: str) -> None:
    """The desktop's own wording when a tool's Docker image is missing."""
    if not tool.available():
        raise StepFailed(
            f"{name} (Docker) is not available on this machine.\n\n"
            f"Make sure Docker is running and the {image} image is loaded.")


def _mat_nonidentity(m) -> bool:
    return m is not None and not np.allclose(np.asarray(m, float), np.eye(4))


class _Ctx:
    """A duck-typed stand-in for the desktop's AppContext, exposing only what the registration
    helpers actually read: ``session.state``, ``session.of_kind`` and ``scene.images``.

    It exists so the postop step's matrix math can be reused VERBATIM instead of retyped.
    ``_RegisterPostopStep._dl_motion`` / ``._roi`` / ``._store`` are pure — they build no
    widgets — but they take a ctx; giving them one is a far smaller risk than transcribing the
    frame conventions (postop atlas-home, the uniform on-Done read) a second time.
    """

    class _Session:
        def __init__(self, run: "Run"):
            self.state = run.state
            self._run = run

        @property
        def objects(self):
            return self._run.objects

        def of_kind(self, kind: str) -> list:
            return [o for o in self._run.objects if o.kind == kind]

    class _Scene:
        def __init__(self, run: "Run"):
            self._run = run

        @property
        def images(self):
            return self._run.images

    def __init__(self, run: "Run"):
        self.session = _Ctx._Session(run)
        self.scene = _Ctx._Scene(run)
        self.window = None          # only ever passed to dialogs, which are not reached here


# --- the steps -----------------------------------------------------------------------

def run_atlas(run: Run, log) -> None:
    """DL preop->atlas, matrix-only (the manual step's DL path without the panel): DQ localizes
    the preop's ear landmarks; ``mat_preop = inv(M_dl)`` by dq.landmark_matrix's contract. The
    preop does not move — only the matrix is extracted."""
    from pv_core.tools import dq
    import projects.cip as cip
    from projects.cip import reg_debug

    preop = run.preop()
    if preop is None:
        raise StepFailed("No preop CT is loaded.")
    _require(dq, "Deep-learning registration (DQ)", "cip/dq")

    M_dl, _info = dq.landmark_matrix(preop, run.side, log=log)
    w = np.linalg.inv(np.asarray(M_dl, float))
    run.state["mat_preop"] = w.tolist()
    try:
        target = cip._atlas_fingerprint()
    except OSError:                      # no atlas.nii — DL doesn't need the file
        target = "atlas"
    # DL is absolute (it cancels any earlier placement exactly), so the provenance record
    # RESETS to this one entry — the same rule record_reg_history applies for DL.
    preop.reg_history = [{"method": "dl", "target": target}]
    run.state["mat_preop_history"] = [dict(e) for e in preop.reg_history]
    reg_debug.dump_store(run.side, w)


def run_erase(run: Run, log) -> None:
    """JN erase-implant, auto-accepted (no review panel): the synthetic becomes the preop and
    the original flips to the postop — the desktop's _create_synthetic_preop minus the
    confirmations, then _use_synthetic_preop's role flip."""
    from pv_core.image import Image
    from pv_core.tools import jn
    import projects.cip as cip
    from projects.cip import reg_debug

    preop = run.preop()
    w = run.state.get("mat_preop")
    if preop is None or not _mat_nonidentity(w):
        raise StepFailed("The atlas registration is missing.")
    if (getattr(preop, "source", None) or {}).get("type") == "created":
        raise StepFailed("A synthetic preop already exists.")
    _require(jn, "JN", "cip/jn")

    transform = reg_debug.jn_transform(run.side, w)
    syn_sitk, _info = jn.create_synthetic(preop, side=run.side,
                                          postop_to_atlas=transform, log=log)

    synthetic = Image(syn_sitk, cip.ROLE_DISPLAY["synthetic"])
    synthetic.role = "synthetic"
    synthetic.source = {"type": "created", "parent": preop.id}
    cip._set_ear_label(synthetic, run.side, cip._SYNTHETIC_LABEL)
    run.add_image(synthetic)
    preop.role = "postop"                # the erased-from image is now the postop


def run_segment(run: Run, log) -> None:
    """PCISP on the (just-created) synthetic preop — the manual Segment minus the
    confirmations. The parse + A/B/round-window derivation are the desktop's own."""
    from pv_core.tools import pcisp
    import projects.cip as cip
    from projects.cip import reg_debug, segmentation

    preop = run.preop()
    w = run.state.get("mat_preop")
    if preop is None or not _mat_nonidentity(w):
        raise StepFailed("The atlas registration is missing.")
    _require(pcisp, "PCISP", "cip/pcisp")

    transform = reg_debug.pcisp_transform(run.side, w)
    out, _info = pcisp.segment(preop, side=run.side, atlas_to_preop=transform,
                               dicom=cip._dicom_info(preop), log=log)
    try:
        structures = segmentation.load_structures(out, run.side, preop)
    except Exception as exc:  # noqa: BLE001
        raise StepFailed(f"Segmentation ran, but its output could not be read:\n{exc}") from exc
    if not structures:
        raise StepFailed("Segmentation produced no structures.")
    # A/B measurements + the round-window mesh, both derived from the same cip_data ST mesh.
    cip._add_ab_and_rw(structures, out, run.side, preop)

    # Replace the anatomy, keeping any postop-anchored implant meshes (they belong to the
    # electrode search, not this preop segmentation) — the desktop's _apply_segmentation rule.
    postop = run.postop()
    implants = [s for s in run.structures()
                if postop is not None and getattr(s, "source_image", None) == postop.id]
    run.objects = [o for o in run.objects if o.kind != "structure"]
    run.objects.extend(structures + implants)
    # 'Search for electrodes' reads the anatomy back out of this blob as its cip_data_src.
    run.state.setdefault("cip", {})["preseg_out"] = out
    run.state["cip"]["segmentation"] = {"method": "auto"}


def run_electrodes(run: Run, log) -> None:
    """SegmentCIElectrode for the chosen model — the manual quick search without its
    confirmation. The preop/postop are aligned here (the synthetic came from the postop's own
    grid), so t_postop_preop is identity and atlas->postop == atlas->preop."""
    from pv_core.tools import pcisp
    import projects.cip as cip
    from projects.cip import implant_models, reg_debug, segmentation
    from projects.cip.cdb import CIP_DATA, Cdb

    preop, postop = run.preop(), run.postop()
    if preop is None or postop is None or preop is postop:
        raise StepFailed("Both a preop and a postop CT are needed.")
    w = run.state.get("mat_preop")
    if not _mat_nonidentity(w):
        raise StepFailed("The atlas registration is missing.")
    out_preseg = (run.state.get("cip") or {}).get("preseg_out")
    if not out_preseg:
        raise StepFailed("The structures have not been segmented.")
    _require(pcisp, "PCISP", "cip/pcisp")

    # The search is fed the segmentation's cip_data blob as (path, offset, length) — read the
    # same way the manual step does (_SearchElectrodesStep._search).
    si = 0 if run.side == "left" else 1
    try:
        with Cdb.open_cip_data(out_preseg, si) as cdb:
            cip_off, cip_len = cdb.tags[CIP_DATA[si]]
    except Exception as exc:  # noqa: BLE001
        raise StepFailed(f"Could not read the segmentation output:\n{exc}") from exc
    cip_data_src = (out_preseg, cip_off, cip_len)

    transform = reg_debug.pcisp_transform(run.side, w)
    out, _info = pcisp.segment_electrodes(
        postop, preop, side=run.side, electrode_id=run.electrode_id,
        cip_data_src=cip_data_src, atlas_to_preop=transform,
        preop_to_postop=None, atlas_to_postop=transform,
        dicom=cip._dicom_info(postop), log=log)

    try:
        res = segmentation.load_postop(out, run.side, postop, preop)
    except Exception as exc:  # noqa: BLE001
        raise StepFailed(
            f"The electrode search ran, but its output could not be read:\n{exc}") from exc
    lead = res.get("lead")
    if lead is None:
        raise StepFailed("The electrode search found no electrodes.")

    # SegmentCIElectrode doesn't echo the model into its output CIE (lead_type comes back 0),
    # so stamp the requested type here — the lead is then self-describing (the electrode
    # table's type header + `model` derive from it) and it survives save/reload.
    cie = lead.extra.setdefault("cie", {})
    if not cie.get("lead_type"):
        cie["lead_type"] = int(run.electrode_id)
    if not lead.model:
        lead.model = implant_models.model_name(int(run.electrode_id)) or ""
    lead.extra["search"] = {"method": "graph"}

    # The implant meshes are anchored to the postop; the modified cochlear meshes REPLACE the
    # preop originals of the same name (apply_electrode_result's rule).
    new = res.get("structures") or []
    names = {s.name for s in new}
    run.objects = [o for o in run.objects
                   if not (o.kind == "structure" and o.name in names) and o.kind != "lead"]
    run.objects.extend(new)
    run.objects.append(lead)
    run.state.setdefault("cip", {})["seg_electrode_id"] = int(run.electrode_id)


def run_postop_reg(run: Run, log) -> None:
    """Postop->preop: DL global (DQ), then AMIR local MI restricted to the preop's modiolus box —
    the pairing auto_process._run_postop_reg uses, minus the busy dialogs.

    Unlike the atlas step this one MOVES an image: the motions are pushed onto the postop exactly
    as the registration panel would, then the panel's own on-Done math derives the globals from
    the final placement (uniform over every method, frame-independent). The matrix work is the
    desktop's own — see _Ctx for why it is called rather than retyped.
    """
    from pv_core import registration
    from pv_core.tools import amir, dq
    import projects.cip as cip

    step = cip._RegisterPostopStep()
    ctx = _Ctx(run)
    postop, preop = run.postop(), run.preop()
    if postop is None or preop is None or postop is preop:
        raise StepFailed("Both a preop and a postop CT are needed.")
    if not _mat_nonidentity(run.state.get("mat_preop")):
        raise StepFailed("The atlas registration is missing.")
    _require(dq, "Deep-learning registration (DQ)", "cip/dq")

    log("Registration (Deep Learning) in progress…")
    motion = step._dl_motion(ctx, postop, preop, log=log)
    registration.push_world_motion(postop, motion, "rigid", method="dl")

    # ROI = preop voxels around the modiolus (id 18). Without that mesh AMIR runs whole-image,
    # which is the desktop's own fallback rather than an error.
    roi = step._roi(ctx, preop, "amir_modiolus")
    method = "amir_modiolus" if roi is not None else "amir"
    _require(amir, "AMIR", "cip/amir")
    log("Registration (AMIR) in progress…")
    motion = amir.register(postop, preop, roi=roi)[0]
    registration.push_world_motion(postop, motion, "rigid", method=method)

    # The panel's Done: fold provenance, store the globals, bake the chain.
    postop.record_reg_history(preop.id)
    step._store(ctx, run.side, preop, postop)
    postop.flatten_reg_chain()


RUNNERS = {"atlas": run_atlas, "erase": run_erase, "segment": run_segment,
           "postop": run_postop_reg, "electrodes": run_electrodes}


def electrode_options() -> list:
    """`[{id, label}]` for the dialog's Electrode-type dropdown — EVERY model in the config, as
    the desktop's _all_electrode_options does. SegmentCIElectrode can localize any model, so
    this is independent of the insertion panel's plannable subset. The label carries the id
    ('Cochlear CI532 (19)') because the id is what a plan stores and what the tool is told."""
    from projects.cip import cfg as cip_cfg
    return [{"id": int(e.id), "label": f"{e.name} ({e.id})"}
            for e in cip_cfg.default().electrodes.values()]
