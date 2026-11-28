"""Draw the Cratify app icon as SVG: two overlapping discs (two songs being mixed) on a dark macOS squircle tile.

Pure standard library. Writes the icon to src-tauri/icon.svg (the source for the app icons),
static/icon.svg (page header and favicon) and src-tauri/loading/icon.svg (the startup page):

    uv run --no-project src-tauri/make_icon.py

Then regenerate the bundle icons and keep only the ones tauri.conf.json lists:

    pnpm tauri icon src-tauri/icon.svg -o /tmp/cratify-icons
    cp /tmp/cratify-icons/{32x32.png,128x128.png,128x128@2x.png,icon.icns,icon.png} src-tauri/icons/
"""
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUTS = [ROOT / "src-tauri/icon.svg", ROOT / "static/icon.svg", ROOT / "src-tauri/loading/icon.svg"]

TILE_TOP, TILE_BOTTOM = "#1c1f27", "#0c0d11"
LEFT, RIGHT, OVERLAP = "#f1f2f4", "#ff5a4e", "#6c7487"
R = 230  # disc radius
LEFT_X, RIGHT_X, Y = 400, 624, 512


def squircle(a=412.0, n=5.0, c=512.0, steps=240):
    """macOS-style tile (a superellipse), 824px wide inside the 1024 canvas."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = c + a * math.copysign(abs(ct) ** (2 / n), ct)
        y = c + a * math.copysign(abs(st) ** (2 / n), st)
        pts.append(f"{x:.1f} {y:.1f}")
    return "M" + " L".join(pts) + " Z"


def svg():
    tile = squircle()
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{TILE_TOP}"/><stop offset="1" stop-color="{TILE_BOTTOM}"/></linearGradient>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="12"/></filter>
    <clipPath id="left"><circle cx="{LEFT_X}" cy="{Y}" r="{R}"/></clipPath>
  </defs>
  <path d="{tile}" transform="translate(0 10)" opacity="0.28" filter="url(#shadow)"/>
  <path d="{tile}" fill="url(#tile)"/>
  <circle cx="{LEFT_X}" cy="{Y}" r="{R}" fill="{LEFT}"/>
  <circle cx="{RIGHT_X}" cy="{Y}" r="{R}" fill="{RIGHT}"/>
  <circle cx="{RIGHT_X}" cy="{Y}" r="{R}" fill="{OVERLAP}" clip-path="url(#left)"/>
</svg>
"""


if __name__ == "__main__":
    text = svg()
    for path in OUTPUTS:
        path.write_text(text)
        print(path.relative_to(ROOT))
