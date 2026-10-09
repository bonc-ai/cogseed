/**
 * 合成 Skill 包生成器 —— 供 Hub Skill 生命周期（specs/010）的测试使用。
 *
 * ⚠️ **仅合成内容**。不得使用真实发布物、真实账号或生产记录
 * （`AUTH-HUB-OPEN1-US3-US6-001` 的 `data_boundary` 明列）。
 * 全部输出确定性可重现，不含随机字节。NOT for production.
 */

import { Buffer } from 'node:buffer';
import * as crypto from 'node:crypto';

import AdmZip from 'adm-zip';

/** 合规包的默认稳定 ID。合成值，与任何真实 Skill 无关。 */
export const FIXTURE_SKILL_ID = 'fixture0skill0id';

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 合成 `SKILL.md`：frontmatter + 正文，结构与客户端解析路径一致。 */
function skillMarkdown(id: string, version: string): Buffer {
  return Buffer.from(
    `---\nname: ${id}\nversion: ${version}\ndescription: synthetic fixture, not a real skill\n---\n\n# ${id}\n\n合成夹具正文。\n`,
    'utf8',
  );
}

export interface SkillPackage {
  /** zip 字节。 */
  bytes: Buffer;
  /** 字节的真实摘要。 */
  sha256: string;
  /** 字节长度。 */
  sizeBytes: number;
}

function seal(zip: AdmZip): SkillPackage {
  const bytes = zip.toBuffer();
  return { bytes, sha256: sha256(bytes), sizeBytes: bytes.length };
}

/**
 * 1. 合规包 —— `<id>/SKILL.md` + 少量文本文件，结构与体积均在限内。
 */
export function makeCompliantSkillPackage(
  id: string = FIXTURE_SKILL_ID,
  version = '1.0.0',
): SkillPackage {
  const zip = new AdmZip();
  zip.addFile(`${id}/SKILL.md`, skillMarkdown(id, version));
  zip.addFile(`${id}/reference.md`, Buffer.from('# 参考\n\n合成内容。\n', 'utf8'));
  zip.addFile(`${id}/scripts/run.sh`, Buffer.from('#!/bin/sh\necho synthetic\n', 'utf8'));
  return seal(zip);
}

/**
 * 2. 摘要不匹配包 —— 字节合规，但**声明的摘要**与真实摘要不同。
 *
 * 用于 FR-011：摘要不匹配时不返回字节、不落盘。
 * `declaredSha256` 是刻意错开的值，不是真实摘要。
 */
export function makeDigestMismatchPackage(
  id: string = FIXTURE_SKILL_ID,
): SkillPackage & { declaredSha256: string } {
  const pkg = makeCompliantSkillPackage(id);
  // 把真实摘要的首字符换掉，得到一个等长但必然不匹配的声明值。
  const declaredSha256 = (pkg.sha256[0] === '0' ? '1' : '0') + pkg.sha256.slice(1);
  return { ...pkg, declaredSha256 };
}

/**
 * 3. 含二进制且**解包后约 9 MiB** 的包 —— FR-025 的判据夹具。
 *
 * ⚠️ 这是一个刻意落在冲突区间的夹具：PRD §6.3 允许 ≤10 MiB 且未禁二进制，
 * 而客户端 `readMatchingSnapshot → captureSkillTree` 限单文件 2 MiB / 整树 8 MiB
 * 且拒 NUL 字节——**读取路径也会失败**。9 MiB + NUL 正好同时触发两侧。
 *
 * 内容为可压缩的重复模式（含 NUL），因此 zip 体积远小于解包体积：
 * 这样触发的是解包/捕获侧的上限，而不是下载体积上限。
 */
export function makeBinaryHeavyPackage(
  id: string = FIXTURE_SKILL_ID,
  uncompressedBytes = 9 * 1024 * 1024,
): SkillPackage & { uncompressedBytes: number } {
  const zip = new AdmZip();
  zip.addFile(`${id}/SKILL.md`, skillMarkdown(id, '1.0.0'));

  // 每 16 字节一个确定性重复单元，含 NUL 与高位字节 → 二进制且高度可压缩。
  const unit = Buffer.from([
    0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x7f,
    0x00, 0x10, 0x20, 0x30, 0x00, 0xaa, 0x55, 0x00,
  ]);
  const blob = Buffer.alloc(uncompressedBytes);
  for (let off = 0; off < blob.length; off += unit.length) {
    unit.copy(blob, off, 0, Math.min(unit.length, blob.length - off));
  }
  zip.addFile(`${id}/assets/model.bin`, blob);

  return { ...seal(zip), uncompressedBytes };
}

/**
 * 4. 结构不合规包 —— **没有 `SKILL.md`**。
 *
 * 用于确认结构质量门的判定，而非安全扫描的判定。
 */
export function makeStructurallyInvalidPackage(
  id: string = FIXTURE_SKILL_ID,
): SkillPackage {
  const zip = new AdmZip();
  zip.addFile(`${id}/README.md`, Buffer.from('# 没有 SKILL.md\n', 'utf8'));
  zip.addFile(`${id}/notes.txt`, Buffer.from('synthetic\n', 'utf8'));
  return seal(zip);
}
