"""Generate original collectible sticker artwork without paid services."""
from __future__ import annotations

import json
import math
from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "apps" / "sticker-market" / "public" / "stickers"
CATALOG = ROOT / "data" / "stickers_catalog.json"
SIZE = 1024
THEMES = [
    ("Holiday", ["Snow Glow", "Festive Fox", "Starry Night", "Winter Spark", "Merry Light", "Candy Swirl", "Jolly Moon", "Cocoa Cloud", "Frost Pop", "Sleigh Bell"]),
    ("Crypto / Memes", ["Pixel Coin", "Moon Mood", "Block Party", "Rocket Wink", "Diamond Day", "Happy Token", "Pixel Pals", "Rocket Club", "Byte Bloom", "Bright Block"]),
    ("Cosmic", ["Orbit Bloom", "Galaxy Glow", "Little Comet", "Star Drift", "Solar Smile", "Lunar Wave", "Nebula Pop", "Astro Heart", "Planet Party", "Cosmic Spark"]),
    ("Neon Pets", ["Glow Cat", "Electric Pup"]),
    ("Retro Badges", ["Sunset Club", "Good Vibes", "Retro Wave", "Lucky Day", "Groovy Star", "Sunny Side", "Dream Team", "Happy Trail"]),
    ("Baby Announcement & Milestone", ["Baby On Board", "Coming Soon", "It's a Surprise!", "First Ultrasound", "Big Sister", "Big Brother", "New Parents Club", "Hello Little One", "Tiny Toes", "Our Little Star"]),
]
LEGACY_NAMES = ["Pixel Bunny", "Star Hamster", "Neon Kitty", "Moon Pup", "Rainbow Bunny", "Flash Fox", "Glow Bear", "Cosmic Cat",
                "Sunset Club", "Good Vibes", "Retro Wave", "Lucky Day", "Groovy Star", "Sunny Side", "Dream Team", "Happy Trail", "Bright Days", "Nice One"]
PALETTES = [
    ("#f14b75", "#ffcb68", "#492b69"), ("#435be8", "#72f1cf", "#171442"),
    ("#732bd8", "#ffb5d8", "#17113c"), ("#0d9c97", "#ffe367", "#1a1b4b"),
    ("#ee704c", "#ffe3a3", "#5a294e"), ("#c64c91", "#ffe8a6", "#48275e"),
]


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in ("C:\\Windows\\Fonts\\arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def star(cx: float, cy: float, outer: float, inner: float, points: int = 5) -> list[tuple[float, float]]:
    return [(cx + (outer if i % 2 == 0 else inner) * math.cos(-math.pi / 2 + i * math.pi / points),
             cy + (outer if i % 2 == 0 else inner) * math.sin(-math.pi / 2 + i * math.pi / points))
            for i in range(points * 2)]


def render(index: int, theme_index: int, name: str) -> Image.Image:
    rng = random.Random(20261119 + index)
    primary, accent, dark = PALETTES[theme_index]
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((64, 64, 960, 960), fill="white")
    draw.ellipse((88, 88, 936, 936), fill=dark)
    draw.ellipse((106, 106, 918, 918), fill=primary)
    draw.ellipse((132, 132, 892, 892), outline="white", width=8)
    for _ in range(24):
        x, y = rng.randrange(180, 845), rng.randrange(180, 800)
        if (x - 512) ** 2 + (y - 512) ** 2 < 320 ** 2 and (theme_index != 5 or y < 700):
            radius = rng.randrange(4, 12)
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=accent)
    if theme_index == 0:
        draw.polygon(star(512, 420, 230, 100, 8), fill=accent, outline="white", width=12)
        draw.ellipse((414, 322, 610, 518), fill=primary, outline="white", width=10)
    elif theme_index == 1:
        draw.rounded_rectangle((310, 245, 714, 640), radius=75, fill=accent, outline="white", width=14)
        draw.rounded_rectangle((370, 300, 654, 575), radius=48, fill=dark)
        draw.polygon(star(512, 435, 100, 50, 4), fill=accent)
    elif theme_index == 2:
        draw.ellipse((325, 280, 700, 655), fill=accent, outline="white", width=12)
        draw.arc((180, 350, 850, 580), 5, 175, fill="white", width=25)
        draw.ellipse((580, 325, 628, 373), fill=primary)
    elif theme_index == 3:
        draw.polygon([(290, 420), (310, 230), (440, 300), (580, 300), (710, 230), (734, 420)], fill=accent, outline="white", width=12)
        draw.ellipse((300, 300, 724, 650), fill=accent, outline="white", width=14)
        draw.ellipse((400, 420, 435, 455), fill=dark)
        draw.ellipse((590, 420, 625, 455), fill=dark)
        draw.arc((450, 455, 575, 535), 10, 170, fill=dark, width=10)
    elif theme_index == 4:
        draw.rounded_rectangle((265, 270, 760, 630), radius=80, fill=accent, outline="white", width=14)
        for i, color in enumerate(("#f7606b", "#ffae6b", "#7d71ed", "#4dc7b6")):
            draw.rectangle((315, 330 + i * 55, 710, 372 + i * 55), fill=color)
        draw.polygon(star(512, 435, 120, 55), fill="white")
    else:
        draw.ellipse((300, 240, 724, 664), fill=accent, outline="white", width=14)
        draw.ellipse((367, 307, 657, 597), fill=primary, outline="white", width=8)
        variant = index - 41
        if variant == 0:
            draw.polygon([(512, 335), (630, 452), (512, 570), (394, 452)], fill="white")
            draw.ellipse((477, 397, 547, 467), fill=dark)
            draw.arc((455, 446, 570, 555), 190, 350, fill=dark, width=16)
        elif variant == 1:
            draw.ellipse((395, 350, 628, 580), fill="white")
            draw.ellipse((455, 330, 650, 540), fill=primary)
            draw.polygon(star(565, 389, 58, 28), fill=accent)
        elif variant == 2:
            draw.ellipse((412, 361, 515, 464), fill="white")
            draw.ellipse((509, 361, 612, 464), fill="white")
            draw.polygon([(412, 420), (612, 420), (512, 555)], fill="white")
            draw.text((485, 399), "?", font=font(90), fill=primary)
        elif variant == 3:
            draw.rounded_rectangle((394, 350, 630, 550), radius=20, fill=dark, outline="white", width=8)
            draw.arc((439, 389, 585, 512), 190, 345, fill=accent, width=15)
            draw.ellipse((474, 403, 540, 469), fill="white")
            draw.line((417, 525, 606, 525), fill="white", width=5)
        elif variant in (4, 5, 6):
            for x, y, radius in ([(450, 420, 42), (565, 420, 42), (510, 474, 29)] if variant == 6 else [(463, 409, 52), (563, 462, 33)]):
                draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill="white")
                draw.arc((x-radius-12, y+radius-5, x+radius+12, y+radius+90), 190, 350, fill="white", width=14)
        elif variant == 7:
            draw.ellipse((445, 369, 579, 503), fill="white")
            draw.arc((459, 432, 564, 490), 10, 170, fill=primary, width=8)
            draw.ellipse((475, 409, 487, 421), fill=dark)
            draw.ellipse((536, 409, 548, 421), fill=dark)
            draw.arc((424, 346, 600, 530), 20, 160, fill=accent, width=14)
        elif variant == 8:
            for x in (454, 565):
                draw.ellipse((x-30, 430, x+30, 537), fill="white")
                for toe in range(4):
                    draw.ellipse((x-32+toe*17, 394-toe*4, x-18+toe*17, 408-toe*4), fill="white")
        else:
            draw.polygon(star(512, 449, 125, 58), fill="white")
            draw.ellipse((485, 425, 497, 437), fill=primary)
            draw.ellipse((527, 425, 539, 437), fill=primary)
            draw.arc((487, 437, 537, 470), 10, 170, fill=primary, width=6)
        for i in range(index % 5 + 2):
            angle = i * 2 * math.pi / (index % 5 + 2)
            x, y = 512 + 250 * math.cos(angle), 452 + 250 * math.sin(angle)
            draw.ellipse((x - 14, y - 14, x + 14, y + 14), fill=accent, outline="white", width=3)
    label = name.upper()
    face = font(47)
    box = draw.textbbox((0, 0), label, font=face)
    draw.text(((SIZE - (box[2] - box[0])) / 2, 738), label, font=face, fill="white", stroke_width=1)
    draw.text((485, 803), f"{index:02}", font=font(30), fill=accent)
    return image


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    legacy_output = OUTPUT / "legacy"
    legacy_output.mkdir(parents=True, exist_ok=True)
    legacy_catalog = []
    for index, name in enumerate(LEGACY_NAMES, 33):
        theme_index = 3 if index <= 40 else 4
        theme = "Neon Pets" if theme_index == 3 else "Retro Badges"
        filename = f"sticker-{index:02}.png"
        render(index, theme_index, name).save(legacy_output / filename, optimize=True)
        legacy_catalog.append({"id": f"sticker-{index:02}", "name": name, "theme": theme,
                               "image": f"/stickers/legacy/{filename}", "alt": f"{name}, an original {theme} collectible sticker",
                               "width": SIZE, "height": SIZE})
    catalog = []
    for theme_index, (theme, names) in enumerate(THEMES):
        for name in names:
            index = len(catalog) + 1
            filename = f"sticker-{index:02}.png"
            render(index, theme_index, name).save(OUTPUT / filename, optimize=True)
            catalog.append({"id": f"sticker-{index:02}", "name": name, "theme": theme,
                            "image": f"/stickers/{filename}", "alt": f"{name}, an original {theme} collectible sticker",
                            "width": SIZE, "height": SIZE})
    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (ROOT / "data" / "legacy_stickers_catalog.json").write_text(json.dumps(legacy_catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Generated {len(catalog)} original {SIZE}x{SIZE} PNGs and metadata.")


if __name__ == "__main__":
    main()
