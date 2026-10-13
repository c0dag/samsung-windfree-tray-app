"""Generate transparent display-LED overlays by diffing each baked temperature
image against the display-off base. Only the pixels that differ (the lit LED and
its halo) stay; everything else — body, louver, background — becomes transparent.
This replaces the CSS clip-path rectangle, which caught part of the louver."""
import os
from PIL import Image, ImageChops

ASSETS = os.path.join(os.path.dirname(__file__), "..", "src", "assets")
GAIN = 3  # amplify the diff so the LED core is solid and the halo feathers out

base_rgb = Image.open(ASSETS + "/ac-unit.png").convert("RGB")

for t in range(16, 31):
    img = Image.open(ASSETS + f"/ac-{t}.png").convert("RGBA")
    diff = ImageChops.difference(img.convert("RGB"), base_rgb)
    r, g, b = diff.split()
    mask = ImageChops.lighter(ImageChops.lighter(r, g), b)
    mask = mask.point(lambda v: min(255, v * GAIN))
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out.save(ASSETS + f"/display-{t}.png", optimize=True)
    print(f"display-{t}.png  bbox={out.getbbox()}")

print("done")
