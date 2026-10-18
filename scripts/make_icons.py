"""Generate PWA icons (192 / 512) without external assets.

Run:
  <venv>/Scripts/python.exe scripts/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "icons"


def build(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), "#0B1220")
    d = ImageDraw.Draw(img)
    s = size / 512.0

    # rounded background panel
    d.rounded_rectangle(
        [24 * s, 24 * s, 488 * s, 488 * s], radius=96 * s, fill="#123A5E"
    )

    # camera body
    d.rounded_rectangle(
        [96 * s, 176 * s, 416 * s, 384 * s], radius=40 * s, fill="#E8F1F8"
    )
    # camera top bump
    d.rounded_rectangle(
        [204 * s, 128 * s, 308 * s, 190 * s], radius=20 * s, fill="#E8F1F8"
    )
    # lens outer
    d.ellipse([188 * s, 216 * s, 324 * s, 352 * s], fill="#0B1220")
    # lens inner
    d.ellipse([212 * s, 240 * s, 300 * s, 328 * s], fill="#22D3A6")
    # lens glint
    d.ellipse([232 * s, 258 * s, 262 * s, 288 * s], fill="#0B1220")

    # baseline accent bar
    d.rounded_rectangle(
        [136 * s, 408 * s, 376 * s, 432 * s], radius=12 * s, fill="#22D3A6"
    )
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        build(size).save(OUT / f"icon-{size}.png", "PNG", optimize=True)
        print("wrote", OUT / f"icon-{size}.png")
    # apple touch icon (iOS home screen)
    build(180).save(OUT / "apple-touch-icon.png", "PNG", optimize=True)
    print("wrote", OUT / "apple-touch-icon.png")


if __name__ == "__main__":
    main()
