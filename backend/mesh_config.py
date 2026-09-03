"""Per-mesh appearance (name, color, opacity, renderOrder) keyed by type_id.

Ported from the musc-analytics config: config/mesh/NN.json → material.color is either an
"rgb(r,g,b)" string or a 0xRRGGBB integer. Files copied into backend/mesh_config/.
"""
from __future__ import annotations

import json
import os
import re

_DIR = os.path.join(os.path.dirname(__file__), "mesh_config")


def mesh_info(type_id: int) -> dict:
    path = os.path.join(_DIR, f"{int(type_id):02d}.json")
    if not os.path.exists(path):
        return {"name": str(type_id), "color": [200, 200, 200], "opacity": 1.0, "render_order": 0}
    d = json.load(open(path))
    m = d.get("material", {})
    return {
        "name": d.get("name", str(type_id)),
        "color": _color(m.get("color")),
        "opacity": float(m.get("opacity", 1.0)),
        "render_order": int(d.get("renderOrder", 0)),
    }


def _color(c) -> list[int]:
    if isinstance(c, (int, float)):
        v = int(c)
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    m = re.match(r"rgb\((\d+),\s*(\d+),\s*(\d+)\)", str(c or ""))
    if m:
        return [int(m.group(1)), int(m.group(2)), int(m.group(3))]
    return [200, 200, 200]
