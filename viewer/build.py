#!/usr/bin/env python3
"""Builds LVB-Viewer.html: one file with the viewer and its libraries inside.

Run from anywhere:  python3 viewer/build.py
"""
import base64
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parent


def script(path):
    # A literal "</script" inside inlined code would end the tag early.
    return path.read_text(encoding="utf-8").replace("</script", "<\\/script")


def fonts_css():
    # IBM Plex, as in the reader app, embedded so the emailed file needs nothing else.
    faces = [("IBM Plex Sans", "400 700", "IBMPlexSans.woff2"),
             ("IBM Plex Mono", "500", "IBMPlexMono-500.woff2"),
             ("IBM Plex Mono", "600", "IBMPlexMono-600.woff2")]
    out = ["/* IBM Plex (SIL Open Font License), latin subset. */"]
    for family, weight, name in faces:
        data = base64.b64encode((here / "fonts" / name).read_bytes()).decode()
        out.append(f"@font-face {{ font-family: '{family}'; font-style: normal; font-weight: {weight}; "
                   f"font-display: swap; src: url(data:font/woff2;base64,{data}) format('woff2'); }}")
    return "\n".join(out)


parts = {
    "/*{{FONTS_CSS}}*/": fonts_css(),
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
