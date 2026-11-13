#!/usr/bin/env python3
"""Builds LVB-Viewer.html: one file with the viewer and its libraries inside.

Run from anywhere:  python3 viewer/build.py
"""
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parent


def script(path):
    # A literal "</script" inside inlined code would end the tag early.
    return path.read_text(encoding="utf-8").replace("</script", "<\\/script")


parts = {
    "/*{{LEAFLET_CSS}}*/": (root / "vendor/leaflet/leaflet.css").read_text(encoding="utf-8"),
    "/*{{VIEWER_CSS}}*/": (here / "viewer.css").read_text(encoding="utf-8"),
    "/*{{XLSX_JS}}*/": script(root / "vendor/xlsx.full.min.js"),
    "/*{{LEAFLET_JS}}*/": script(root / "vendor/leaflet/leaflet.js"),
    "/*{{VIEWER_JS}}*/": script(here / "viewer.js"),
}

html = (here / "viewer.src.html").read_text(encoding="utf-8")
for marker, text in parts.items():
    if html.count(marker) != 1:
        raise SystemExit(f"Expected exactly one {marker} in viewer.src.html")
    html = html.replace(marker, text)

out = here / "LVB-Viewer.html"
out.write_text(html, encoding="utf-8")
print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
