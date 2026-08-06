#!/usr/bin/env python3
"""
Generate build/icon.icns from scratch.

Kept as a script rather than a committed binary so the icon can be re-tuned
without a design tool. Run it after changing the palette in
src/shared/themes.ts if you want the two to stay in step:

    python3 scripts/make-icon.py && npm run dist
"""

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"

S = 1024  # master size; every other size is downsampled from this

# Pulled from the Dusk theme so the icon and the app agree.
BG_TOP = (31, 31, 43)
BG_BOTTOM = (18, 18, 26)
ACCENT = (139, 124, 246)
FG = (230, 225, 216)

# Apple's macOS grid: the tile is ~824/1024 wide, leaving the rest as margin.
MARGIN = 100
TILE = S - MARGIN * 2
RADIUS = 185


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return mask


def gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return grad.resize((size, size))


def build_master() -> Image.Image:
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # The tile itself: a soft vertical gradient clipped to a rounded square.
    tile = gradient(TILE, BG_TOP, BG_BOTTOM).convert("RGBA")
    tile.putalpha(rounded_mask(TILE, RADIUS))
    icon.paste(tile, (MARGIN, MARGIN), tile)

    d = ImageDraw.Draw(icon)

    # A hairline of light along the edge. Kept very low alpha: anything stronger
    # stops reading as a bevel and starts reading as a drawn white ring.
    d.rounded_rectangle(
        [MARGIN, MARGIN, MARGIN + TILE - 1, MARGIN + TILE - 1],
        RADIUS,
        outline=(255, 255, 255, 14),
        width=2,
    )

    # Nudge the glyph group left so accent-bar-through-underscore is optically
    # centred in the tile rather than sitting right of it.
    x = -18

    # The active-tab marker from the left rail, as the icon's one accent.
    d.rounded_rectangle([258 + x, 400, 288 + x, 624], 15, fill=ACCENT + (255,))

    # Prompt chevron. Round joints and caps so it stays smooth when downsampled.
    chevron = [(392 + x, 372), (566 + x, 512), (392 + x, 652)]
    d.line(chevron, fill=FG + (255,), width=58, joint="curve")
    for px_, py in chevron:
        d.ellipse([px_ - 29, py - 29, px_ + 29, py + 29], fill=FG + (255,))

    # Cursor underscore.
    d.rounded_rectangle([620 + x, 604, 800 + x, 652], 24, fill=FG + (255,))

    return icon


def main() -> None:
    ICONSET.mkdir(parents=True, exist_ok=True)
    master = build_master()
    master.save(BUILD / "icon.png")

    # iconutil requires exactly these names.
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = base * scale
            suffix = "@2x" if scale == 2 else ""
            master.resize((px, px), Image.LANCZOS).save(
                ICONSET / f"icon_{base}x{base}{suffix}.png"
            )

    subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET), "-o", str(BUILD / "icon.icns")],
        check=True,
    )
    print(f"wrote {BUILD / 'icon.icns'}")


if __name__ == "__main__":
    main()
