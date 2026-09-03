"""Serve the app under a subpath locally, the way Apache will in production.

Verification B in the deployment plan ("the app works at https://host/webcip/") otherwise needs
the AWS box. This is a ~40-line stand-in for the one thing Apache does that matters: strip the
mount prefix before handing the request on, and redirect the bare form to the trailing-slash one.

    python deploy/subpath_test.py            # http://127.0.0.1:8012/webcip/
    python deploy/subpath_test.py --prefix /foo --port 9000

Everything outside the prefix returns 404 here; in production that is where the PHP site lives,
which is the more dangerous version of the same thing — a stray request to /api or /icons gets
someone else's 200 HTML instead of a clean 404. So a run here that shows no 404s is the check
that no root-absolute URL survives in the build.
"""
from __future__ import annotations

import argparse
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app import app as _app  # noqa: E402


class StripPrefix:
    """The mod_proxy half of ``ProxyPass /webcip/ http://127.0.0.1:8011/``."""

    def __init__(self, app, prefix: str):
        self.app = app
        self.prefix = prefix.rstrip("/")

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        path = scope["path"]
        if path == self.prefix:
            # RedirectMatch 301 "^/webcip$" "/webcip/" — without this the SPA's own relative
            # <script src> resolves against the parent directory and never loads.
            return await _redirect(send, self.prefix + "/")
        if not path.startswith(self.prefix + "/"):
            return await _plain(send, 404, b"not the app (in production: the PHP site)")

        scope = dict(scope)
        scope["path"] = path[len(self.prefix):]
        raw = scope.get("raw_path")
        if raw:
            scope["raw_path"] = raw[len(self.prefix.encode()):]
        scope["root_path"] = self.prefix
        return await self.app(scope, receive, send)


async def _redirect(send, location: str) -> None:
    await send({"type": "http.response.start", "status": 301,
                "headers": [(b"location", location.encode())]})
    await send({"type": "http.response.body", "body": b""})


async def _plain(send, status: int, body: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": body})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--prefix", default="/webcip")
    ap.add_argument("--port", type=int, default=8012)
    args = ap.parse_args()

    import uvicorn

    print(f"open http://127.0.0.1:{args.port}{args.prefix}/")
    uvicorn.run(StripPrefix(_app, args.prefix), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
