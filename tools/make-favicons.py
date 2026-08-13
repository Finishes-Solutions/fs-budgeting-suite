#!/usr/bin/env python3
"""Regenerate the favicon set from the FS monogram.

    python3 tools/make-favicons.py        (needs Pillow)

Why the icon is a filled tile rather than the bare monogram: the brand mark is
black ink on transparency, which disappears against a dark browser tab strip.
Serving two transparent variants behind `media="(prefers-color-scheme: ...)"`
is possible, but any browser that ignores that attribute picks one at random and
half the time it is the invisible one.

A self-contained tile removes the guesswork. The glyph is white on the app's own
ink-900 tile, so legibility comes from glyph-against-tile contrast, which is
fixed, rather than glyph-against-browser-chrome, which is not. It reads on a
light strip (dark shape) and on a dark strip (white glyph) with no media query
and no per-browser behaviour to rely on.

Small sizes get less padding and a tighter corner radius — at 16px the default
padding leaves the tall F/S too small to read.
"""
from PIL import Image, ImageDraw

SRC   = 'app/assets/fs-monogram-color.png'
INK   = (255, 255, 255)   # glyph
GREEN = (31, 146, 73)     # brand green-500; brighter than the source accent, for a dark tile
TILE  = (22, 25, 26)      # ink-900, matching the app header

# size: (corner radius ratio, padding ratio)
SIZES = {16: (0.20, 0.05), 32: (0.22, 0.10), 48: (0.22, 0.13),
         180: (0.22, 0.16), 512: (0.22, 0.16)}


def recolour(src):
    """White glyph, brand green accent, alpha preserved so edges stay smooth."""
    w, h = src.size
    px, out = src.load(), Image.new('RGBA', src.size, (0, 0, 0, 0))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if not a:
                continue
            # The accent square is the only saturated colour in the mark.
            op[x, y] = (*(GREEN if g > r + 18 and g > b + 18 else INK), a)
    return out


def build(glyph, size, radius_ratio, pad_ratio):
    tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=(*TILE, 255))
    pad = int(size * pad_ratio)
    box = size - 2 * pad
    gw, gh = glyph.size
    scale = min(box / gw, box / gh)
    g = glyph.resize((max(1, int(gw * scale)), max(1, int(gh * scale))), Image.LANCZOS)
    tile.alpha_composite(g, ((size - g.width) // 2, (size - g.height) // 2))
    return tile


def main():
    src = Image.open(SRC).convert('RGBA')
    glyph = recolour(src.crop(src.split()[3].getbbox()))
    for size, (rr, pr) in SIZES.items():
        build(glyph, size, rr, pr).save(f'app/assets/favicon-{size}.png')
        print(f'app/assets/favicon-{size}.png')
    # A bare /favicon.ico request should find something rather than 404.
    build(glyph, 48, 0.22, 0.10).save('app/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
    print('app/favicon.ico')


if __name__ == '__main__':
    main()
