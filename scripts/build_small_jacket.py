from pathlib import Path
import shutil
import sys
from xml.etree import ElementTree as ET

from PIL import Image, ImageDraw, ImageFont
from ifstools import IFS


def main() -> None:
    if len(sys.argv) not in (5, 6, 7, 8):
        raise SystemExit("usage: build_small_jacket.py <small-pack.ifs> <source.jpg> <output.ifs> <index> [title] [artist] [description]")

    template_ifs = Path(sys.argv[1]).resolve()
    source_image = Path(sys.argv[2]).resolve()
    output_ifs = Path(sys.argv[3]).resolve()
    index = int(sys.argv[4])
    title = sys.argv[5] if len(sys.argv) >= 6 else "New Song"
    artist = sys.argv[6] if len(sys.argv) >= 7 else ""
    description = sys.argv[7] if len(sys.argv) == 8 else "Community custom chart"
    padded = f"{index:04d}"

    scratch = output_ifs.parent / f"{template_ifs.stem}_ifs_build"
    if scratch.exists():
        shutil.rmtree(scratch)

    template = IFS(str(template_ifs), super_disable=True)
    template.extract(path=str(scratch), overwrite=True, super_disable=True)

    tex = scratch / "tex"
    source = Image.open(source_image).convert("RGBA") if source_image.exists() else placeholder_cover(title)
    square_cover(source).resize((74, 74), Image.Resampling.LANCZOS).save(tex / f"jk{padded}_s.png")
    title_strip(title, artist, description, 248, 64).save(tex / f"ms{padded}_s.png")

    texturelist = tex / "texturelist.xml"
    tree = ET.parse(texturelist)
    root = tree.getroot()
    texture = root.find("texture")
    if texture is None:
        raise RuntimeError("texturelist.xml has no texture node")

    title_imgrect, title_uvrect, jacket_imgrect, jacket_uvrect = atlas_rects(index)
    ensure_texture_size(texture, title_imgrect, jacket_imgrect)
    upsert_image(texture, f"ms{padded}_s", title_imgrect, title_uvrect)
    upsert_image(texture, f"jk{padded}_s", jacket_imgrect, jacket_uvrect)
    tree.write(texturelist, encoding="UTF-8", xml_declaration=True)

    backup = output_ifs.with_suffix(output_ifs.suffix + ".op3-mapper.bak")
    if not backup.exists() and output_ifs.exists():
        shutil.copy2(output_ifs, backup)

    temp_output = output_ifs.with_suffix(output_ifs.suffix + ".tmp")
    if temp_output.exists():
        temp_output.unlink()
    repack = IFS(str(scratch))
    repack.repack(path=str(temp_output))
    repack.close()
    try:
        temp_output.replace(output_ifs)
    except PermissionError:
        # Some Windows setups allow writing the file but reject atomic replace.
        # Fall back to a direct byte overwrite of the already-built archive.
        output_ifs.write_bytes(temp_output.read_bytes())
        temp_output.unlink()
    shutil.rmtree(scratch)


def remove_existing(texture: ET.Element, name: str) -> None:
    for image in list(texture):
        if image.attrib.get("name") == name:
            texture.remove(image)


def upsert_image(texture: ET.Element, name: str, imgrect: str, uvrect: str) -> None:
    images = list(texture)
    existing_index = next((i for i, image in enumerate(images) if image.attrib.get("name") == name), None)
    image = make_image(name, imgrect, uvrect)
    if existing_index is None:
        texture.append(image)
    else:
        texture.remove(images[existing_index])
        texture.insert(existing_index, image)


def add_image(texture: ET.Element, name: str, imgrect: str, uvrect: str) -> None:
    texture.append(make_image(name, imgrect, uvrect))


def make_image(name: str, imgrect: str, uvrect: str) -> ET.Element:
    image = ET.Element("image", {"name": name})
    uv = ET.SubElement(image, "uvrect")
    uv.set("__type", "4u16")
    uv.text = uvrect
    img = ET.SubElement(image, "imgrect")
    img.set("__type", "4u16")
    img.text = imgrect
    return image


def ensure_texture_size(texture: ET.Element, *rects: str) -> None:
    size = texture.find("size")
    if size is None or not size.text:
        return

    width, height = [int(value) for value in size.text.split()]
    max_x = width * 2
    max_y = height * 2
    for rect in rects:
        x1, x2, y1, y2 = [int(value) for value in rect.split()]
        max_x = max(max_x, x1, x2)
        max_y = max(max_y, y1, y2)

    needed_width = next_power_of_two(max(width, (max_x + 1) // 2))
    needed_height = next_power_of_two(max(height, (max_y + 1) // 2))
    size.text = f"{needed_width} {needed_height}"


def next_power_of_two(value: int) -> int:
    power = 1
    while power < value:
        power *= 2
    return power


def atlas_rects(index: int) -> tuple[str, str, str, str]:
    # Small jacket packs are grouped by tens: afp_jkms052_s.ifs stores
    # jk/ms0520_s through jk/ms0529_s. Coordinates are stored at 2x the
    # extracted PNG dimensions.
    slot = index % 10
    title_slots = [
        (0, 496, 512, 640),
        (496, 992, 512, 640),
        (496, 992, 384, 512),
        (496, 992, 256, 384),
        (496, 992, 128, 256),
        (496, 992, 0, 128),
        (0, 496, 384, 512),
        (0, 496, 256, 384),
        (0, 496, 128, 256),
        (0, 496, 0, 128),
    ]
    jacket_slots = [
        (444, 592, 788, 936),
        (296, 444, 788, 936),
        (148, 296, 788, 936),
        (0, 148, 788, 936),
        (740, 888, 640, 788),
        (592, 740, 640, 788),
        (444, 592, 640, 788),
        (296, 444, 640, 788),
        (148, 296, 640, 788),
        (0, 148, 640, 788),
    ]
    tx1, tx2, ty1, ty2 = title_slots[slot]
    jx1, jx2, jy1, jy2 = jacket_slots[slot]
    title_imgrect = f"{tx1} {tx2} {ty1} {ty2}"
    title_uvrect = f"{tx1 + 2} {tx2 - 2} {ty1 + 2} {ty2 - 2}"
    jacket_imgrect = f"{jx1} {jx2} {jy1} {jy2}"
    jacket_uvrect = f"{jx1 + 2} {jx2 - 2} {jy1 + 2} {jy2 - 2}"
    return title_imgrect, title_uvrect, jacket_imgrect, jacket_uvrect


def square_cover(image: Image.Image) -> Image.Image:
    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def placeholder_cover(text: str) -> Image.Image:
    image = Image.new("RGBA", (256, 256), (38, 34, 28, 255))
    draw = ImageDraw.Draw(image)
    font = title_font(26)
    lines = wrap_text(text, 14)[:4]
    y = 74
    for line in lines:
        draw.text((18, y), line, fill=(238, 224, 190, 255), font=font)
        y += 34
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
    return image.crop((left, top, left + crop_width, top + crop_height)).resize((target_width, target_height), Image.Resampling.LANCZOS)


def title_strip(text: str, artist: str, description: str, width: int, height: int) -> Image.Image:
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    title_font_face = fit_font(text, 18, width - 14, 22)
    artist_font = title_font(14)
    desc_font = title_font(11)

    draw.text((7, 1), text, fill=(58, 42, 24, 245), font=title_font_face)
    if artist:
        draw.text((8, 24), artist, fill=(67, 50, 31, 235), font=artist_font)
    draw.text((8, 44), fit_text(description, desc_font, width - 16), fill=(75, 57, 36, 220), font=desc_font)
    return image


def fit_text(text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont, max_width: int) -> str:
    if text_width(text, font) <= max_width:
        return text
    trimmed = text
    while trimmed and text_width(f"{trimmed}...", font) > max_width:
        trimmed = trimmed[:-1]
    return f"{trimmed}..." if trimmed else ""


def text_width(text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont) -> int:
    left, top, right, bottom = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=font)
    return right - left


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


def fit_font(text: str, size: int, max_width: int, max_height: int = 54) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    while size > 12:
        font = title_font(size)
        left, top, right, bottom = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=font)
        if right - left <= max_width and bottom - top <= max_height:
            return font
        size -= 1
    return title_font(size)


if __name__ == "__main__":
    main()
