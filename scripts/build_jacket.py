from pathlib import Path
import shutil
import sys
from xml.etree import ElementTree as ET

from PIL import Image, ImageDraw, ImageFont
from ifstools import IFS


def main() -> None:
    if len(sys.argv) not in (5, 6):
        raise SystemExit("usage: build_jacket.py <template.ifs> <source.jpg> <output.ifs> <index> [title]")

    template_ifs = Path(sys.argv[1]).resolve()
    source_image = Path(sys.argv[2]).resolve()
    output_ifs = Path(sys.argv[3]).resolve()
    index = int(sys.argv[4])
    title = sys.argv[5] if len(sys.argv) == 6 else "New Song"
    padded = f"{index:04d}"

    scratch = output_ifs.parent / f"afp_jkms{padded}_l_ifs_build"
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.parent.mkdir(parents=True, exist_ok=True)

    template = IFS(str(template_ifs), super_disable=True)
    template.extract(path=str(scratch), overwrite=True, super_disable=True)

    tex = scratch / "tex"
    for old in tex.glob("*0405_l.png"):
        old.unlink()

    jacket = Image.open(source_image).convert("RGBA") if source_image.exists() else placeholder_cover(title)
    jacket = square_cover(jacket).resize((326, 326), Image.Resampling.LANCZOS)
    jacket.save(tex / f"jk{padded}_l.png")

    title_strip(title, 326, 50).save(tex / f"ms{padded}_l.png")

    texturelist = tex / "texturelist.xml"
    tree = ET.parse(texturelist)
    root = tree.getroot()
    for image in root.iter("image"):
        name = image.attrib.get("name", "")
        image.set("name", name.replace("0405", padded))
    tree.write(texturelist, encoding="UTF-8", xml_declaration=True)

    if output_ifs.exists():
        output_ifs.unlink()
    repack = IFS(str(scratch))
    repack.repack(path=str(output_ifs))
    shutil.rmtree(scratch)


def square_cover(image: Image.Image) -> Image.Image:
    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def placeholder_cover(text: str) -> Image.Image:
    image = Image.new("RGBA", (512, 512), (38, 34, 28, 255))
    draw = ImageDraw.Draw(image)
    font = title_font(42)
    lines = wrap_text(text, 18)[:5]
    y = 170
    for line in lines:
        draw.text((34, y), line, fill=(238, 224, 190, 255), font=font)
        y += 52
    return image


def wrap_text(text: str, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words or [text]:
        candidate = f"{current} {word}".strip()
        if len(candidate) > width and current:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def wide_cover(image: Image.Image, target_width: int, target_height: int) -> Image.Image:
    width, height = image.size
    source_ratio = width / height
    target_ratio = target_width / target_height
    if source_ratio > target_ratio:
        crop_height = height
        crop_width = int(height * target_ratio)
    else:
        crop_width = width
        crop_height = int(width / target_ratio)
    left = (width - crop_width) // 2
    top = (height - crop_height) // 2
    cropped = image.crop((left, top, left + crop_width, top + crop_height))
    banner = cropped.resize((target_width, target_height), Image.Resampling.LANCZOS)

    # Slight darkening keeps busy art readable in the music-select strip.
    overlay = Image.new("RGBA", banner.size, (0, 0, 0, 42))
    banner.alpha_composite(overlay)
    return banner


def title_strip(text: str, width: int, height: int) -> Image.Image:
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font = fit_font(text, 28, width - 10)
    bbox = draw.textbbox((0, 0), text, font=font)
    y = max(0, (height - (bbox[3] - bbox[1])) // 2 - 2)
    draw.text((4, y), text, fill=(62, 45, 27, 245), font=font)
    return image


def title_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    font_candidates = [
        Path("C:/Windows/Fonts/ACaslonPro-Regular.otf"),
        Path("C:/Windows/Fonts/georgia.ttf"),
        Path("C:/Windows/Fonts/times.ttf"),
        Path("C:/Windows/Fonts/yumin.ttf"),
    ]
    for font_path in font_candidates:
        if font_path.exists():
            return ImageFont.truetype(str(font_path), size)
    return ImageFont.load_default(size=size)


def fit_font(text: str, size: int, max_width: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    while size > 12:
        font = title_font(size)
        left, top, right, bottom = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=font)
        if right - left <= max_width and bottom - top <= 44:
            return font
        size -= 1
    return title_font(size)


if __name__ == "__main__":
    main()
