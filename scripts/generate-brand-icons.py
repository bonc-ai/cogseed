#!/usr/bin/env python3
"""Generate the approved CogSeed brand icon assets from the approved logo source.

The source is the user-approved animal-and-seed brand mark (dark green ring,
orange seed-guardian character). This script:

- removes the near-white background with a soft alpha transition;
- writes a transparent page logo (logo.png, 1024x1024);
- writes a rounded light-background app-icon tile (icon.png, 512x512);
- regenerates the Windows ICO and macOS ICNS containers;
- writes a maintainable labeled SVG master (cogseed-master.svg).

Usage:
    python3 scripts/generate-brand-icons.py [SOURCE_PNG]

The source defaults to the approved desktop upload; pass an explicit path when
regenerating from another location.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageChops, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'src' / 'resources' / 'icons'

# 无内置默认源：源图是设计交付资产，路径随机器变化，必须由调用方显式传入。

# App icon background: opaque light warm-white (r,g,b all >= 239 so the asset
# contract can distinguish it from the transparent page logo).
ICON_BACKGROUND = (248, 245, 240)

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

# macOS iconutil iconset layout: name → pixel size. iconutil builds the final
# ICNS from these; PIL's own ICNS writer has produced alpha-corrupted files
# (opaque pixels written with alpha=0 → invisible Dock icon), so we never use
# `Image.save(..., 'ICNS')`.
ICONSET_LAYOUT = [
    ('icon_16x16.png', 16),
    ('icon_16x16@2x.png', 32),
    ('icon_32x32.png', 32),
    ('icon_32x32@2x.png', 64),
    ('icon_128x128.png', 128),
    ('icon_128x128@2x.png', 256),
    ('icon_256x256.png', 256),
    ('icon_256x256@2x.png', 512),
    ('icon_512x512.png', 512),
    ('icon_512x512@2x.png', 1024),
]


def _write_icns(icon: Image.Image, target: Path) -> None:
    """Pack `icon` (square RGBA, >= 1024px) into an ICNS via iconutil.

    Requires macOS (`iconutil` is not shipped on other platforms); the mac
    package step already runs on macOS only.
    """
    with TemporaryDirectory(prefix='cogseed-iconset-') as tmp:
        iconset = Path(tmp) / 'icon.iconset'
        iconset.mkdir()
        for name, px in ICONSET_LAYOUT:
            scaled = icon.resize((px, px), Image.Resampling.LANCZOS)
            scaled.save(iconset / name, 'PNG')
        subprocess.run(
            ['iconutil', '-c', 'icns', str(iconset), '-o', str(target)],
            check=True,
        )

# Whitening-distance soft mask: pixels whose minimum channel is >= BACKGROUND_MIN
# are fully transparent; pixels below BACKGROUND_MIN - SOFT are fully opaque;
# the SOFT range in between becomes a smooth alpha ramp for anti-aliased edges.
BACKGROUND_MIN = 248
SOFT = 16


def _alpha_for_whiteness(min_channel: Image.Image) -> Image.Image:
    """Turn the minimum RGB channel into a soft alpha mask (0=bg, 255=mark)."""

    def ramp(value: int) -> int:
        if value >= BACKGROUND_MIN:
            return 0
        if value <= BACKGROUND_MIN - SOFT:
            return 255
        return round((BACKGROUND_MIN - value) * 255 / SOFT)

    return Image.eval(min_channel, ramp)


def _remove_background(source: Image.Image) -> Image.Image:
    rgb = source.convert('RGB')
    red, green, blue = rgb.split()
    min_channel = ImageChops.darker(ImageChops.darker(red, green), blue)
    alpha = _alpha_for_whiteness(min_channel)
    return Image.merge('RGBA', (red, green, blue, alpha))


def _square_padded(image: Image.Image, target: int, fill: tuple[int, int, int, int]) -> Image.Image:
    """Center the mark on a square canvas with symmetric padding, resize to target."""
    box = image.getchannel('A').getbbox()
    if not box:
        raise RuntimeError('source mark has no visible pixels after background removal')
    margin = 12
    left = max(0, box[0] - margin)
    top = max(0, box[1] - margin)
    right = min(image.width, box[2] + margin)
    bottom = min(image.height, box[3] + margin)
    cropped = image.crop((left, top, right, bottom))

    side = max(cropped.width, cropped.height)
    square = Image.new('RGBA', (side, side), fill)
    square.alpha_composite(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2))

    content = round(target * 0.88)
    scaled = square.resize((content, content), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (target, target), fill)
    canvas.alpha_composite(scaled, ((target - content) // 2, (target - content) // 2))
    return canvas



def _rounded_tile(logo: Image.Image, size: int, background: tuple[int, int, int]) -> Image.Image:
    """Build a macOS-style app-icon tile matching system-app proportions.

    Measured on this machine (Finder/Music/Photos/Chrome/VSCode): the opaque
    tile occupies ~84-87.5% of the canvas with a ~21-26% corner radius. We
    target the Apple system-app values: tile 87.5% of the canvas (6.25% margin
    per side), corner radius 21% of the canvas, and the mark scaled to ~72%
    of the canvas (the passed `logo` already carries ~12% padding, so the
    visible mark lands at ~72% — previously 0.66×tile shrunk it to ~51%,
    leaving the Dock tile mostly background).
    """
    margin = round(size * 0.0625)
    tile_side = size - margin * 2
    corner = round(size * 0.21)
    tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (margin, margin, size - 1 - margin, size - 1 - margin),
        radius=corner,
        fill=255,
    )
    tile.paste(Image.new('RGBA', (size, size), (*background, 255)), (0, 0), mask)

    content = round(size * 0.82)
    scaled = logo.resize((content, content), Image.Resampling.LANCZOS)
    tile.paste(scaled, ((size - content) // 2, (size - content) // 2), scaled)
    return tile


def write_svg(path: Path) -> None:
    path.write_text(
        '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <!-- Approved CogSeed brand mark: green sprout ring and orange seed-guardian character. -->
  <g id="brand">
    <circle id="ring" cx="512" cy="512" r="400" fill="none" stroke="#146441" stroke-width="88"/>
    <g id="character">
      <circle cx="392" cy="322" r="58" fill="#D58926"/>
      <circle cx="632" cy="322" r="58" fill="#D58926"/>
      <ellipse cx="512" cy="700" rx="252" ry="218" fill="#D58926"/>
      <ellipse cx="512" cy="740" rx="150" ry="130" fill="#F1E3CB"/>
      <circle cx="512" cy="408" r="158" fill="#F1E3CB"/>
      <circle cx="454" cy="392" r="16" fill="#146441"/>
      <circle cx="570" cy="392" r="16" fill="#146441"/>
      <ellipse cx="512" cy="452" rx="20" ry="13" fill="#146441"/>
      <path d="M470 496 Q512 528 554 496" fill="none" stroke="#146441" stroke-width="14" stroke-linecap="round"/>
      <path d="M392 640 Q330 760 420 830" fill="none" stroke="#D58926" stroke-width="46" stroke-linecap="round"/>
      <path d="M632 640 Q694 760 604 830" fill="none" stroke="#D58926" stroke-width="46" stroke-linecap="round"/>
    </g>
    <g id="seed">
      <path d="M512 790 C560 800 582 862 512 930 C442 862 464 800 512 790 Z" fill="#D58926"/>
      <ellipse cx="512" cy="830" rx="16" ry="26" fill="#F8E7C8"/>
    </g>
    <g id="leaves">
      <path d="M452 250 C470 190 540 190 560 250 C520 240 490 240 452 250 Z" fill="#146441"/>
      <path d="M512 270 C500 320 470 330 452 310 C480 290 500 280 512 270 Z" fill="#146441"/>
    </g>
  </g>
</svg>
''',
        encoding='utf-8',
    )


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not source.is_file():
        raise SystemExit(
            f'brand icon source not found: {source}\n'
            'Pass the approved source PNG as the first argument, e.g.\n'
            '  python3 scripts/generate-brand-icons.py /path/to/brand-source.png'
        )

    with Image.open(source) as raw:
        mark = _remove_background(raw)

    OUT.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix='cogseed-brand-') as tmp:
        tmpdir = Path(tmp)

        transparent = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
        square = _square_padded(mark, 1024, (0, 0, 0, 0))
        transparent.alpha_composite(square)
        transparent.save(tmpdir / 'logo.png', 'PNG', optimize=True)

        logo_square = _square_padded(mark, 1024, (0, 0, 0, 0))
        icon = _rounded_tile(logo_square, 1024, background=ICON_BACKGROUND)
        icon.resize((512, 512), Image.Resampling.LANCZOS).save(tmpdir / 'icon.png', 'PNG', optimize=True)
        _write_icns(icon, tmpdir / 'icon.icns')
        icon.resize((512, 512), Image.Resampling.LANCZOS).save(tmpdir / 'icon.ico', 'ICO', sizes=ICO_SIZES)
        write_svg(tmpdir / 'cogseed-master.svg')

        outputs = ['logo.png', 'icon.png', 'icon.icns', 'icon.ico', 'cogseed-master.svg']
        for name in outputs:
            target = tmpdir / name
            if not target.is_file() or target.stat().st_size == 0:
                raise RuntimeError(f'icon generation produced an invalid file: {name}')
        for name in outputs:
            os.replace(tmpdir / name, OUT / name)


if __name__ == '__main__':
    main()
