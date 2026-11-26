"""Draw the Backstage app icon (a vinyl record with the app's blue label) as a 1024px PNG.

Pure standard library so it runs anywhere:  python3 src-tauri/make_icon.py src-tauri/icon-source.png
Then:  pnpm tauri icon src-tauri/icon-source.png
"""
import math
import struct
import sys
import zlib

S = 1024
C = S / 2


def clamp(x, lo=0.0, hi=1.0):
    return lo if x < lo else hi if x > hi else x


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


BG_TOP, BG_BOTTOM = hexrgb("#232a36"), hexrgb("#0d0f13")
VINYL, GROOVE = hexrgb("#0a0b0e"), hexrgb("#20242c")
LABEL_A, LABEL_B = hexrgb("#6cb6ff"), hexrgb("#2f7fe0")
RIM = hexrgb("#3a414d")


def pixel(x, y):
    px, py = x + 0.5 - C, y + 0.5 - C
    # macOS-style squircle tile (superellipse), 824px wide inside the 1024 canvas.
    a, n = 412.0, 5.0
    f = (abs(px / a) ** n + abs(py / a) ** n) ** (1 / n)
    tile = clamp((1 - f) * a + 0.5)
    if tile <= 0:
        return (0, 0, 0, 0)
    col = mix(BG_TOP, BG_BOTTOM, clamp((py + a) / (2 * a)))

    r = math.hypot(px, py)
    theta = math.atan2(py, px)
    R = 330.0
    disc = clamp(R - r + 0.5)
    if disc > 0:
        v = VINYL
        if 132 < r < R - 8:  # fine grooves
            g = 0.5 + 0.5 * math.cos(r * 2 * math.pi / 7.0)
            v = mix(v, GROOVE, 0.35 * g * g)
        shine = max(0.0, math.cos(2 * (theta + math.pi / 4))) ** 6  # two light wedges
        v = mix(v, (0.55, 0.62, 0.72), 0.16 * shine * clamp((r - 120) / 60))
        rim = clamp(1 - abs(r - (R - 2)) / 2.5)
        v = mix(v, RIM, 0.8 * rim)
        col = mix(col, v, disc)
    label = clamp(124 - r + 0.5)
    if label > 0:
        col = mix(col, mix(LABEL_A, LABEL_B, clamp((py + px * 0.4 + 124) / 248)), label)
        ring = clamp(1 - abs(r - 96) / 1.5)
        col = mix(col, (1, 1, 1), 0.18 * ring)
    hole = clamp(18 - r + 0.5)
    if hole > 0:
        col = mix(col, BG_BOTTOM, hole)
    return tuple(round(clamp(c) * 255) for c in col) + (round(tile * 255),)


def write_png(path):
    rows = []
    for y in range(S):
        row = bytearray(b"\x00")
        for x in range(S):
            row.extend(pixel(x, y))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    write_png(sys.argv[1] if len(sys.argv) > 1 else "icon-source.png")
