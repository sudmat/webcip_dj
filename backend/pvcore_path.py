"""Make the existing, unmodified `pv_core` package importable by the backend.

The desktop repo (containing `pv_core/` and `projects/`) lives outside this web project.
Point WEBCIP_SRC at it, or rely on the default. It is reused as-is — the backend never
modifies it (see the plan: heavy I/O stays in Python, once, at load time).

The default is the CURRENT desktop tree, `pypv`. The older `webcip` checkout has diverged
(its `pv_core/image.py` and `projects/cip/` differ, and it has no `auto_process` tooling this
backend can drive), so pointing back at it is not supported — the two must not be mixed in one
process either, since both provide the same `pv_core` / `projects` package names.
"""
from __future__ import annotations

import os
import sys

WEBCIP_SRC = os.environ.get("WEBCIP_SRC", "/data/mipwork/pypv")

if WEBCIP_SRC not in sys.path:
    sys.path.insert(0, WEBCIP_SRC)
