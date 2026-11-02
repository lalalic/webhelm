"""Generate WebHelm's own toolbar icons; run with Python and Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw
import math

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "runtime/extension/icons"
ICONS.mkdir(exist_ok=True)

def icon(size):
    # Vector-like strokes rendered at high resolution for crisp 16px glyphs.
    n = 512
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    pixels = im.load()
    for y in range(n):
        for x in range(n):
            dx = abs(x - n / 2) - n * .41
            dy = abs(y - n / 2) - n * .41
            c = max(dx, dy, 0)
            dist = math.hypot(max(dx, 0), max(dy, 0))
            if (dx <= 0 and dy <= 0) or dist <= n * .13:
                t = (x + y) / (2 * n)
                pixels[x, y] = (int(37 + 27 * t), int(75 + 47 * t), int(194 + 25 * t), 255)
    draw = ImageDraw.Draw(im)
    points = [(116, 185), (176, 337), (256, 234), (336, 337), (396, 185)]
    draw.line(points, fill=(255, 255, 255, 255), width=48, joint="curve")
    r = 24
    for x, y in points:
        draw.ellipse((x-r,y-r,x+r,y+r), fill=(255,255,255,255))
    # Small cyan navigation marker differentiates WebHelm at a glance.
    draw.ellipse((345,95,417,167), fill=(115, 239, 238, 255))
    return im.resize((size,size), Image.Resampling.LANCZOS)

for size in (16,32,48,128):
    icon(size).save(ICONS / f"webhelm-{size}.png", optimize=True)
    print(f"created icons/webhelm-{size}.png")
