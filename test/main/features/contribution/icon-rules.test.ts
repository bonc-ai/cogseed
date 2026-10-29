import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ICON_RULES, checkContributionIcon, sniffIconBytes } from '../../../../src/main/features/contribution/icon-rules';

/**
 * 报告 HUB-2 的回归测试：客户端准入必须镜像 Hub 的图标规则。
 *
 * 这些用例与 Hub `src/features/contributions/iconRules.ts` 的规则一一对应（`icon.duplicate` /
 * `icon.location` / `icon.format` / `icon.decode` / `icon.size` / `icon.dimension`）。
 * 判据只读头部字节，因此夹具是**最小的合法头部**，不是可解码的图片——这正是客户端与 Hub
 * 的差异边界，测试要把这条边界写明。
 */

const tempRoots: string[] = [];

const makeTree = (files: Record<string, Buffer | string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-icon-'));
  tempRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** 最小 PNG 头部：签名 + IHDR；`animated` 时插入 acTL。 */
const png = (width: number, height: number, options: { animated?: boolean; padBytes?: number } = {}): Buffer => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // color type
  const actl = options.animated
    ? Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('acTL', 'ascii'), Buffer.alloc(8)])
    : Buffer.alloc(0);
  const tail = Buffer.alloc(12);
  tail.writeUInt32BE(0, 0);
  tail.write('IEND', 4, 'ascii');
  const pad = Buffer.alloc(options.padBytes ?? 0);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, actl, tail, pad]);
};

/** 最小 WebP 头部（VP8X 扩展格式，含可选动画标志）。 */
const webpVp8x = (width: number, height: number, animated = false): Buffer => {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = animated ? 0x02 : 0x00;
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
};

/** 最小 WebP 无损头部（VP8L）。 */
const webpVp8l = (width: number, height: number): Buffer => {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(8, 16);
  buf[20] = 0x2f;
  buf.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return buf;
};

/** 最小 WebP 有损头部（VP8）。 */
const webpVp8 = (width: number, height: number): Buffer => {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(8, 16);
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
};

describe('sniffIconBytes', () => {
  it('读出 PNG / WebP 三种位流的宽高', () => {
    expect(sniffIconBytes(png(48, 32))).toMatchObject({ format: 'png', width: 48, height: 32 });
    expect(sniffIconBytes(webpVp8x(64, 64))).toMatchObject({ format: 'webp', width: 64, height: 64 });
    expect(sniffIconBytes(webpVp8l(80, 40))).toMatchObject({ format: 'webp', width: 80, height: 40 });
    expect(sniffIconBytes(webpVp8(96, 24))).toMatchObject({ format: 'webp', width: 96, height: 24 });
  });

  it('识别动画标志', () => {
    expect(sniffIconBytes(webpVp8x(32, 32, true))?.animated).toBe(true);
    expect(sniffIconBytes(png(32, 32, { animated: true }))?.animated).toBe(true);
  });

  it('不是 PNG / WebP 的字节返回 null', () => {
    expect(sniffIconBytes(Buffer.from('not an image at all, just text padding here'))).toBeNull();
    expect(sniffIconBytes(Buffer.alloc(4))).toBeNull();
  });
});

describe('checkContributionIcon', () => {
  it('没有图标是合法状态', async () => {
    const root = makeTree({ 'SKILL.md': '---\nname: demo\n---\n' });
    await expect(checkContributionIcon(root)).resolves.toEqual({ icon: null, issues: [] });
  });

  it('包根多一份 icon.png：icon.duplicate', async () => {
    const root = makeTree({ 'SKILL.md': '---\nname: demo\n---\n', 'icon.png': png(64, 64) });
    const result = await checkContributionIcon(root);
    expect(result.icon).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: 'ICON_INVALID', entry: 'icon.png', rule: 'icon.duplicate' });
  });

  it('合法的 assets/icon.png 通过', async () => {
    const root = makeTree({ 'assets/icon.png': png(128, 128) });
    const result = await checkContributionIcon(root);
    expect(result.issues).toEqual([]);
    expect(result.icon).toMatchObject({ format: 'png', height: 128, path: 'assets/icon.png', width: 128 });
  });

  it('位置不合法：assets/icon.svg', async () => {
    const root = makeTree({ 'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    const result = await checkContributionIcon(root);
    expect(result.issues.map((issue) => issue.rule)).toEqual(['icon.location']);
  });

  it('两个候选同存：icon.duplicate', async () => {
    const root = makeTree({ 'assets/icon.png': png(32, 32), 'assets/icon.webp': webpVp8x(32, 32) });
    const result = await checkContributionIcon(root);
    expect(result.issues.map((issue) => issue.rule)).toEqual(['icon.duplicate']);
  });

  it('PNG 字节命名为 .webp：扩展名与真实格式不一致', async () => {
    const root = makeTree({ 'assets/icon.webp': png(64, 64) });
    const result = await checkContributionIcon(root);
    expect(result.issues.map((issue) => issue.rule)).toEqual(['icon.format']);
    expect(result.issues[0]!.message).toContain('.webp');
  });

  it('SVG 内容伪装成 .png：格式不允许（不是「文件坏了」）', async () => {
    const root = makeTree({ 'assets/icon.png': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    const result = await checkContributionIcon(root);
    expect(result.issues.map((issue) => issue.rule)).toEqual(['icon.format']);
  });

  it('头部不是图片：icon.decode', async () => {
    const root = makeTree({ 'assets/icon.png': Buffer.from('definitely not a png, just padding bytes') });
    const result = await checkContributionIcon(root);
    expect(result.issues.map((issue) => issue.rule)).toEqual(['icon.decode']);
  });

  it('动图拒绝', async () => {
    const root = makeTree({ 'assets/icon.png': png(32, 32, { animated: true }) });
    const result = await checkContributionIcon(root);
    expect(result.issues.map((issue) => issue.rule)).toEqual(['icon.format']);
  });

  it('尺寸与字节数上限', async () => {
    const big = makeTree({ 'assets/icon.png': png(ICON_RULES.maxDimension + 1, 32) });
    expect((await checkContributionIcon(big)).issues.map((issue) => issue.rule)).toEqual(['icon.dimension']);

    const heavy = makeTree({ 'assets/icon.png': png(32, 32, { padBytes: ICON_RULES.maxBytes }) });
    expect((await checkContributionIcon(heavy)).issues.map((issue) => issue.rule)).toEqual(['icon.size']);
  });
});
