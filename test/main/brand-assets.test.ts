import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Jimp } from 'jimp';

const root = path.join(__dirname, '../..');
const asset = (name: string) => path.join(root, 'src/resources/icons', name);

const hasPixelNear = (
  image: Awaited<ReturnType<typeof Jimp.read>>,
  target: readonly [number, number, number],
  tolerance = 8,
) => {
  const [red, green, blue] = target;
  for (let index = 0; index < image.bitmap.data.length; index += 4) {
    if (
      image.bitmap.data[index + 3] > 0 &&
      Math.abs(image.bitmap.data[index] - red) <= tolerance &&
      Math.abs(image.bitmap.data[index + 1] - green) <= tolerance &&
      Math.abs(image.bitmap.data[index + 2] - blue) <= tolerance
    ) {
      return true;
    }
  }
  return false;
};

const readPngHeader = (file: string) => {
  const png = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.length, `${file} minimum PNG header length`).toBeGreaterThanOrEqual(29);
  expect(png.subarray(0, signature.length), `${file} PNG signature`).toEqual(signature);
  expect(png.readUInt32BE(8), `${file} IHDR length`).toBe(13);
  expect(png.subarray(12, 16).toString('ascii'), `${file} first chunk`).toBe('IHDR');
  return {
    bitDepth: png.readUInt8(24),
    colorType: png.readUInt8(25),
  };
};

const hasOpaqueLightPixel = (image: Awaited<ReturnType<typeof Jimp.read>>, tolerance = 8) => {
  for (let index = 0; index < image.bitmap.data.length; index += 4) {
    const red = image.bitmap.data[index];
    const green = image.bitmap.data[index + 1];
    const blue = image.bitmap.data[index + 2];
    const alpha = image.bitmap.data[index + 3];
    if (alpha === 255 && red >= 247 - tolerance && green >= 247 - tolerance && blue >= 247 - tolerance) {
      return true;
    }
  }
  return false;
};

const hasFullyTransparentPixel = (image: Awaited<ReturnType<typeof Jimp.read>>) => {
  for (let index = 3; index < image.bitmap.data.length; index += 4) {
    if (image.bitmap.data[index] === 0) return true;
  }
  return false;
};

describe('CogSeed brand assets', () => {
  it('ships a maintainable SVG master with the approved palette', () => {
    const svg = fs.readFileSync(asset('cogseed-master.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('#146441');
    expect(svg).toContain('#D58926');
    expect(svg).toMatch(/(?:id|class|data-part)="[^"]*ring[^"]*"/i);
    expect(svg).toMatch(/(?:id|class|data-part)="[^"]*character[^"]*"/i);
    expect(svg).toMatch(/(?:id|class|data-part)="[^"]*seed[^"]*"/i);
    expect(svg).not.toMatch(/#7C3AED|#3B82F6|#22D3EE|#11152B/i);
    expect(svg).not.toMatch(/id="(?:node|glow)"|url\(#node\)/i);
    expect(svg).not.toMatch(/orca|whale/i);
  });

  it('ships transparent page and light-background app logos with the approved visual signature', async () => {
    const icon = await Jimp.read(asset('icon.png'));
    const logo = await Jimp.read(asset('logo.png'));
    const darkGreen = [20, 100, 65] as const;
    const orange = [213, 137, 38] as const;

    expect(readPngHeader(asset('logo.png'))).toEqual({ bitDepth: 8, colorType: 6 });
    expect(readPngHeader(asset('icon.png'))).toEqual({ bitDepth: 8, colorType: 6 });
    expect(hasFullyTransparentPixel(logo)).toBe(true);
    // macOS-style rounded app-icon tile: transparent corners, opaque center.
    expect(hasFullyTransparentPixel(icon)).toBe(true);
    expect(icon.bitmap.data[3]).toBe(0); // top-left corner is transparent
    const centerOffset = ((icon.bitmap.width * 256) + 256) * 4;
    expect(icon.bitmap.data[centerOffset + 3]).toBe(255); // center is opaque
    expect(hasOpaqueLightPixel(icon)).toBe(true);
    // The opaque tile must be inset like system apps (measured Finder/Photos:
    // ~87.5% of the canvas) so the Dock size matches other apps.
    const alpha = icon.bitmap.data;
    const opaqueXs = new Set<number>();
    const opaqueYs = new Set<number>();
    for (let index = 0; index < alpha.length; index += 4) {
      if (alpha[index + 3] === 0) continue;
      const x = (index / 4) % icon.bitmap.width;
      const y = Math.floor(index / 4 / icon.bitmap.width);
      opaqueXs.add(x);
      opaqueYs.add(y);
    }
    const tileW = (Math.max(...opaqueXs) - Math.min(...opaqueXs) + 1) / icon.bitmap.width;
    const tileH = (Math.max(...opaqueYs) - Math.min(...opaqueYs) + 1) / icon.bitmap.height;
    expect(tileW).toBeGreaterThanOrEqual(0.85);
    expect(tileW).toBeLessThanOrEqual(0.90);
    expect(tileH).toBeGreaterThanOrEqual(0.85);
    expect(tileH).toBeLessThanOrEqual(0.90);
    expect(hasPixelNear(logo, darkGreen)).toBe(true);
    expect(hasPixelNear(logo, orange)).toBe(true);
    expect(hasPixelNear(icon, darkGreen)).toBe(true);
    expect(hasPixelNear(icon, orange)).toBe(true);
    expect(hasPixelNear(logo, [124, 58, 237])).toBe(false);
    expect(hasPixelNear(logo, [59, 130, 246])).toBe(false);
    expect(hasPixelNear(icon, [124, 58, 237])).toBe(false);
    expect(hasPixelNear(icon, [59, 130, 246])).toBe(false);
  });

  it('ships the expected raster dimensions', async () => {
    const icon = await Jimp.read(asset('icon.png'));
    const logo = await Jimp.read(asset('logo.png'));
    expect([icon.bitmap.width, icon.bitmap.height]).toEqual([512, 512]);
    expect([logo.bitmap.width, logo.bitmap.height]).toEqual([1024, 1024]);
  });

  it('ships valid ICNS and multi-image ICO containers', () => {
    const icns = fs.readFileSync(asset('icon.icns'));
    const ico = fs.readFileSync(asset('icon.ico'));
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(7);
  });
});
