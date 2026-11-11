"""Generate static/icons/og-image.png (1200×630 social share image). Requires Pillow + DejaVu fonts."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "static" / "icons" / "og-image.png"
W, H = 1200, 630
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def main() -> None:
    base = Image.new("RGB", (W, H), "#0b0a14")
    glow = Image.new("RGB", (W, H), "#0b0a14")
    gd = ImageDraw.Draw(glow)
    for x, y, r, c in [(180, 80, 330, (139, 92, 246)), (1050, 140, 300, (217, 70, 239)), (650, 640, 320, (249, 115, 22))]:
        gd.ellipse([x - r, y - r, x + r, y + r], fill=c)
    img = Image.blend(base, glow.filter(ImageFilter.GaussianBlur(140)), 0.55).convert("RGBA")

    # logo mark: gradient rounded square with the download glyph
    mx, my, ms = 96, 150, 112
    grad = Image.new("RGBA", (ms, ms))
    g = ImageDraw.Draw(grad)
    for i in range(ms):
        t = i / ms
        g.line([(i, 0), (i, ms)], fill=tuple(int(a + (b - a) * t) for a, b in zip((139, 92, 246), (249, 115, 22))) + (255,))
    mask = Image.new("L", (ms, ms), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, ms - 1, ms - 1], 30, fill=255)
    img.paste(grad, (mx, my), mask)

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = mx + ms // 2
    d.line([(cx, my + 26), (cx, my + 66)], fill="white", width=9)
    d.line([(cx - 20, my + 48), (cx, my + 68), (cx + 20, my + 48)], fill="white", width=9, joint="curve")
    d.line([(mx + 26, my + 74), (mx + 26, my + 84), (mx + ms - 26, my + 84), (mx + ms - 26, my + 74)], fill="white", width=9, joint="curve")
    title = font(BOLD, 92)
    d.text((mx + ms + 34, my + 4), "Media", font=title, fill="white")
    d.text((mx + ms + 34 + d.textlength("Media", font=title), my + 4), "Grab", font=title, fill=(232, 121, 249))
    d.text((96, 318), "Videos in genuine HD · 4K · 8K", font=font(BOLD, 50), fill="white")
    d.text((96, 384), "Photos & carousels in original quality · MP3", font=font(REG, 38), fill=(205, 203, 222))
    img = Image.alpha_composite(img, layer)

    chips = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    c = ImageDraw.Draw(chips)
    chip_font = font(BOLD, 30)
    x = 96
    for name in ["YouTube", "Facebook", "Instagram", "X", "TikTok"]:
        tw = c.textlength(name, font=chip_font)
        c.rounded_rectangle([x, 470, x + tw + 44, 524], 27, fill=(255, 255, 255, 34), outline=(255, 255, 255, 150), width=2)
        x += tw + 64
    img = Image.alpha_composite(img, chips)
    t = ImageDraw.Draw(img)
    x = 96
    for name in ["YouTube", "Facebook", "Instagram", "X", "TikTok"]:
        tw = t.textlength(name, font=chip_font)
        t.text((x + 22, 478), name, font=chip_font, fill="white")
        x += tw + 64
    img.convert("RGB").save(OUT, optimize=True)
    print(f"wrote {OUT} {img.size}")


if __name__ == "__main__":
    main()
