#!/usr/bin/env python3
"""Generate the approved Mate Agent double-node companion icon assets."""

from __future__ import annotations

import math
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'src' / 'resources' / 'icons'
PURPLE = '#7C3AED'
BLUE = '#3B82F6'
CYAN = '#22D3EE'
BG = '#11152B'
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def _hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def _linear_gradient(size: int, start: str, end: str) -> Image.Image:
    start_rgb = _hex_rgb(start)
    end_rgb = _hex_rgb(end)
    image = Image.new('RGBA', (size, size))
    draw = ImageDraw.Draw(image)
    for x in range(size):
        t = x / max(1, size - 1)
        rgb = tuple(round(start_rgb[i] * (1 - t) + end_rgb[i] * t) for i in range(3))
        draw.line((x, 0, x, size), fill=(*rgb, 255))
    return image


def _bezier_points(scale: float) -> list[tuple[float, float]]:
    p0 = (420 * scale, 570 * scale)
    p1 = (530 * scale, 420 * scale)
    p2 = (610 * scale, 420 * scale)
    p3 = (690 * scale, 370 * scale)
    points: list[tuple[float, float]] = []
    for step in range(41):
        t = step / 40
        u = 1 - t
        x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
        points.append((x, y))
    return points


def render(size: int) -> Image.Image:
    scale = size / 1024
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))

    background = Image.new('RGBA', image.size, (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(background)
    bg_draw.rounded_rectangle(
        (48 * scale, 48 * scale, 976 * scale, 976 * scale),
        radius=220 * scale,
        fill=BG,
    )
    image.alpha_composite(background)

    aura = Image.new('RGBA', image.size, (0, 0, 0, 0))
    aura_draw = ImageDraw.Draw(aura)
    aura_draw.ellipse((170 * scale, 420 * scale, 650 * scale, 900 * scale), fill=(124, 58, 237, 85))
    aura_draw.ellipse((560 * scale, 210 * scale, 850 * scale, 500 * scale), fill=(59, 130, 246, 70))
    aura = aura.filter(ImageFilter.GaussianBlur(max(1, round(65 * scale))))
    image.alpha_composite(aura)

    points = _bezier_points(scale)
    glow = Image.new('RGBA', image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.line(points, fill=(34, 211, 238, 145), width=max(2, round(78 * scale)), joint='curve')
    glow = glow.filter(ImageFilter.GaussianBlur(max(1, round(28 * scale))))
    image.alpha_composite(glow)

    connector = Image.new('RGBA', image.size, (0, 0, 0, 0))
    connector_draw = ImageDraw.Draw(connector)
    connector_draw.line(points, fill=CYAN, width=max(2, round(30 * scale)), joint='curve')
    image.alpha_composite(connector)

    node_gradient = _linear_gradient(size, PURPLE, BLUE)
    node_mask = Image.new('L', image.size, 0)
    mask_draw = ImageDraw.Draw(node_mask)
    mask_draw.ellipse((205 * scale, 465 * scale, 595 * scale, 855 * scale), fill=255)
    mask_draw.ellipse((600 * scale, 255 * scale, 820 * scale, 475 * scale), fill=255)
    image.alpha_composite(Image.composite(node_gradient, Image.new('RGBA', image.size), node_mask))

    rim = Image.new('RGBA', image.size, (0, 0, 0, 0))
    rim_draw = ImageDraw.Draw(rim)
    rim_draw.ellipse(
        (205 * scale, 465 * scale, 595 * scale, 855 * scale),
        outline=(255, 255, 255, 42),
        width=max(1, round(8 * scale)),
    )
    rim_draw.ellipse(
        (600 * scale, 255 * scale, 820 * scale, 475 * scale),
        outline=(255, 255, 255, 52),
        width=max(1, round(7 * scale)),
    )
    image.alpha_composite(rim)

    highlights = Image.new('RGBA', image.size, (0, 0, 0, 0))
    hi_draw = ImageDraw.Draw(highlights)
    hi_draw.ellipse((285 * scale, 545 * scale, 390 * scale, 650 * scale), fill=(248, 252, 255, 242))
    hi_draw.ellipse((654 * scale, 307 * scale, 711 * scale, 364 * scale), fill=(248, 252, 255, 242))
    image.alpha_composite(highlights)

    return image


def write_svg(path: Path) -> None:
    path.write_text(
        '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="node" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="#7C3AED"/>
      <stop offset="1" stop-color="#3B82F6"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="28"/>
    </filter>
  </defs>
  <rect x="48" y="48" width="928" height="928" rx="220" fill="#11152B"/>
  <path d="M420 570 C530 420 610 420 690 370" fill="none" stroke="#22D3EE" stroke-width="78" stroke-linecap="round" opacity=".42" filter="url(#glow)"/>
  <path d="M420 570 C530 420 610 420 690 370" fill="none" stroke="#22D3EE" stroke-width="30" stroke-linecap="round"/>
  <circle cx="400" cy="660" r="195" fill="url(#node)" stroke="#FFFFFF" stroke-opacity=".16" stroke-width="8"/>
  <circle cx="710" cy="365" r="110" fill="url(#node)" stroke="#FFFFFF" stroke-opacity=".2" stroke-width="7"/>
  <circle cx="337.5" cy="597.5" r="52.5" fill="#F8FCFF"/>
  <circle cx="682.5" cy="335.5" r="28.5" fill="#F8FCFF"/>
</svg>
''',
        encoding='utf-8',
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix='mate-agent-icons-') as tmp:
        tmpdir = Path(tmp)
        master = render(1024)
        master.save(tmpdir / 'logo.png', 'PNG', optimize=True)
        master.resize((512, 512), Image.Resampling.LANCZOS).save(tmpdir / 'icon.png', 'PNG', optimize=True)
        master.save(tmpdir / 'icon.icns', 'ICNS')
        master.save(tmpdir / 'icon.ico', 'ICO', sizes=ICO_SIZES)
        write_svg(tmpdir / 'mate-agent-master.svg')
        outputs = ['logo.png', 'icon.png', 'icon.icns', 'icon.ico', 'mate-agent-master.svg']
        for name in outputs:
            if not (tmpdir / name).is_file() or (tmpdir / name).stat().st_size == 0:
                raise RuntimeError(f'icon generation produced an invalid file: {name}')
        for name in outputs:
            os.replace(tmpdir / name, OUT / name)


if __name__ == '__main__':
    main()
