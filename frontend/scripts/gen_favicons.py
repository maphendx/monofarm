#!/usr/bin/env python3
"""Generate Farm Grid favicon set using Pillow.

Farm Grid mark: 3×3 grid of outlined dots (r=1.6 in a 24×24 viewbox),
center dot omitted from outline group, filled center circle (r=2.6).
Accent color: #22d3ee (cyan-400, dark-mode value — looks good on any bg).

Output (frontend/public/):
  favicon-16.png  favicon-32.png  favicon-48.png
  favicon-64.png  favicon-128.png favicon-256.png
  apple-touch-icon.png (180×180)
  favicon.ico (multi-res 16/32/48)
"""
from __future__ import annotations
import math, pathlib, struct, zlib
from PIL import Image, ImageDraw

PUBLIC = pathlib.Path(__file__).parent.parent / "public"
PUBLIC.mkdir(exist_ok=True)

# Brand accent in dark mode
ACCENT = (34, 211, 238)        # #22d3ee

GRID_POSITIONS = [
    (5, 5), (12, 5), (19, 5),
    (5, 12),          (19, 12),   # center (12,12) excluded from outlined grid
    (5, 19), (12, 19), (19, 19),
]
CENTER = (12.0, 12.0)


def render(size: int) -> Image.Image:
    """Draw the Farm Grid mark at `size`×`size` with 4× supersampling."""
    ss = 4
    big = size * ss
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    scale = big / 24.0

    # Dot radius in original coords (1.6 units) mapped to big canvas
    dot_r = 1.6 * scale

    # Outlined outer dots — 50% opacity stroke simulation via filled circle
    # with a slightly smaller transparent punch-through gives a "ring" look.
    outer_alpha = 130  # ~50% opacity
    for gx, gy in GRID_POSITIONS:
        cx = gx * scale
        cy = gy * scale
        # Draw filled circle (ring outer edge)
        fill_color = ACCENT + (outer_alpha,)
        draw.ellipse(
            [cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r],
            fill=fill_color,
        )

    # Filled center dot — fully opaque, slightly larger (2.6 units)
    center_r = 2.6 * scale
    cx, cy = CENTER[0] * scale, CENTER[1] * scale
    draw.ellipse(
        [cx - center_r, cy - center_r, cx + center_r, cy + center_r],
        fill=ACCENT + (255,),
    )

    # Downsample with LANCZOS for crisp sub-pixel rendering
    return img.resize((size, size), Image.LANCZOS)


SIZES = [16, 32, 48, 64, 128, 256]

for s in SIZES:
    img = render(s)
    img.save(PUBLIC / f"favicon-{s}.png", "PNG")
    print(f"  ✓ favicon-{s}.png")

# Apple touch icon (180×180)
render(180).save(PUBLIC / "apple-touch-icon.png", "PNG")
print("  ✓ apple-touch-icon.png")


# Build favicon.ico (16, 32, 48 multi-res ICO)
def _png_bytes(img: Image.Image) -> bytes:
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()

ico_sizes = [16, 32, 48]
images = [render(s) for s in ico_sizes]
pngs = [_png_bytes(img) for img in images]

# ICO header + directory + image data
count = len(ico_sizes)
header = struct.pack("<HHH", 0, 1, count)  # reserved, type=1 (ICO), count
dir_offset = 6 + count * 16
data_offset = dir_offset
image_data = b""

entries = []
for i, (s, png) in enumerate(zip(ico_sizes, pngs)):
    w = s if s < 256 else 0
    h = s if s < 256 else 0
    entries.append((w, h, len(png), data_offset + len(image_data)))
    image_data += png

directory = b""
for w, h, size, offset in entries:
    directory += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, size, offset)

ico_data = header + directory + image_data
(PUBLIC / "favicon.ico").write_bytes(ico_data)
print("  ✓ favicon.ico (16/32/48)")

print(f"\nAll favicons written to {PUBLIC}")
