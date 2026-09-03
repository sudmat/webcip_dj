"""Who currently holds the single shared workspace.

There is one `workflow.Session` for the whole server (see backend/workflow.py), so two browsers
drive the same images, the same ear and the same results. Left alone that fails silently: B's
"Load preop CT" calls `Session.clear()`, and A — whose screen still shows the old state — makes
their next click against B's scan.

This does not make concurrent work possible. It makes the collision visible: the first action
claims the workspace, anyone else is refused with 409 and told who holds it and since when, and
they can take it over deliberately. Real per-user isolation is a later, larger change.

The identity is a `webcip_sid` cookie, minted here on first contact. It identifies a browser, not
a person — that is all the banner needs.
"""
from __future__ import annotations

import uuid

from fastapi import HTTPException, Request

from . import workflow as wf

COOKIE = "webcip_sid"


async def attach_sid(request: Request, call_next):
    """ASGI middleware: give every browser a stable id, minting one on first contact."""
    sid = request.cookies.get(COOKIE) or ""
    fresh = not sid
    if fresh:
        sid = uuid.uuid4().hex
    request.state.sid = sid
    response = await call_next(request)
    if fresh:
        # Scoped to our own mount, so the cookie is not also sent to whatever else shares the
        # domain (in production the app is a subpath alongside a PHP site).
        path = request.scope.get("root_path") or "/"
        # A year: the id only has to outlive a working session, and losing it just means the
        # browser reads as a new one. Not httponly — nothing here is a credential.
        response.set_cookie(COOKIE, sid, max_age=31536000, samesite="lax", path=path)
    return response


def sid_of(request: Request) -> str:
    return getattr(request.state, "sid", "")


def require_hold(request: Request, takeover: bool = False) -> str:
    """Claim the workspace for this browser, or refuse with 409 naming the holder.

    Call at the top of every route that mutates the session. Claiming is implicit, so a single
    user never encounters any of this.
    """
    sess = wf.session()
    blocking = sess.claim(sid_of(request), takeover=takeover)
    if blocking is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "The workspace is in use by another session.",
                "holder": blocking,
                "holderSince": sess.held_at,
                "canTakeOver": True,
            },
        )
    return sid_of(request)
