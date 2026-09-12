"""Regenerates the extension icons (128 and 48) and the Web Store promo tile.

Run from the repo root:  python3 scripts/make_icons.py   (needs Pillow)

The mark is a blue rounded square with a white check, drawn from shapes so
each size gets exact padding. Chrome's store guideline is 96x96 artwork
inside the 128x128 icon (16px transparent padding); 48 uses the same ratio
(36 inside 48). icon16.png is deliberately not generated: the hand-made
16px original is sharper at toolbar size than a redraw.

The geometry was fitted to the original 128px icon on 2026-09-11 (the check
matched it at 0.958 soft IoU), in that icon's pixel coordinates, where the
square spans 113x113 from (8, 8). Kept as constants so this script always
reproduces the committed images instead of re-fitting to its own output.
"""
from PIL import Image, ImageDraw

BLUE = (37, 99, 235)
SRC_ORIGIN, SRC_SIDE, SRC_RADIUS = 8, 113, 17
CHECK_POINTS = [(34.25, 66.25), (55.0, 87.5), (94.5, 40.25)]
CHECK_WIDTH = 12.5


def draw_mark(canvas, x, y, size, s, square_fill, check_fill):
    """Draws the mark into the square (x, y, size), on a canvas supersampled by s."""
    k = size / SRC_SIDE
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle(
        [x * s, y * s, (x + size) * s - 1, (y + size) * s - 1],
        radius=SRC_RADIUS * k * s,
        fill=square_fill,
    )
    pts = [((x + (px - SRC_ORIGIN) * k) * s, (y + (py - SRC_ORIGIN) * k) * s) for px, py in CHECK_POINTS]
    width = CHECK_WIDTH * k * s
    d.line(pts, fill=check_fill, width=max(1, round(width)), joint='curve')
    for px, py in (pts[0], pts[2]):
        d.ellipse([px - width / 2, py - width / 2, px + width / 2, py + width / 2], fill=check_fill)


def icon(size, art, s=16):
    # Transparent pixels carry the blue so downsampling can't pull in a dark
    # fringe; BOX (area average) keeps the edges exactly on pixel boundaries.
    canvas = Image.new('RGBA', (size * s, size * s), BLUE + (0,))
    offset = (size - art) / 2
    draw_mark(canvas, offset, offset, art, s, BLUE + (255,), (255, 255, 255, 255))
    return canvas.resize((size, size), Image.BOX)


def promo_tile(s=4):
    """440x280, no text (Chrome's guidance): the mark inverted on brand blue,
    beside three abstract spreadsheet rows with status-colour dots."""
    w, h = 440, 280
    bottom = Image.new('RGBA', (w * s, h * s), (29, 78, 216, 255))
    top = Image.new('RGBA', (w * s, h * s), BLUE + (255,))
    canvas = Image.composite(bottom, top, Image.linear_gradient('L').resize((w * s, h * s)))
    draw_mark(canvas, 52, 64, 152, s, (255, 255, 255, 255), BLUE + (255,))
    d = ImageDraw.Draw(canvas)
    for i, dot in enumerate([(22, 163, 74), (234, 179, 8), (220, 38, 38)]):
        y = 82 + i * 44
        d.rounded_rectangle([236 * s, y * s, 396 * s, (y + 30) * s], radius=8 * s, fill=(255, 255, 255, 235))
        d.rounded_rectangle([250 * s, (y + 11) * s, 330 * s, (y + 19) * s], radius=4 * s, fill=(191, 206, 247, 255))
        d.ellipse([360 * s, (y + 7) * s, 376 * s, (y + 23) * s], fill=dot + (255,))
    return canvas.resize((w, h), Image.BOX).convert('RGB')


if __name__ == '__main__':
    icon(128, 96).save('public/icons/icon128.png')
    icon(48, 36).save('public/icons/icon48.png')
    promo_tile().save('store-assets/promo-tile-440x280.png')
    print('wrote public/icons/icon128.png, public/icons/icon48.png, store-assets/promo-tile-440x280.png')
