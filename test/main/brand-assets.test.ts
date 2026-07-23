import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Jimp } from 'jimp';

const root = path.join(__dirname, '../..');
const asset = (name: string) => path.join(root, 'src/resources/icons', name);

describe('Mate Agent brand assets', () => {
  it('ships a maintainable SVG master with the approved palette', () => {
    const svg = fs.readFileSync(asset('mate-agent-master.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('#7C3AED');
    expect(svg).toContain('#3B82F6');
    expect(svg).toContain('#22D3EE');
    expect(svg).toContain('#11152B');
    expect(svg).not.toMatch(/orca|whale/i);
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
