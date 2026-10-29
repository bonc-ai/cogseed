/**
 * 读取一个本机 Skill 的显示名（SKILL.md frontmatter 的 `name`）。
 *
 * 贡献预览里 Hub 依赖只有 12 位 ID，对用户没意义；本机装着的话就取它的名字，没装就返回 `null`
 * 由调用方退回显示 ID。叶模块：只读文件，不 import Electron / 其他 feature。
 *
 * 只读第一段 frontmatter、只认 `name:` 一行，不跟随符号链接，读不到一律 `null`，不抛错——
 * 取名字是锦上添花，不能让贡献预览因此失败。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_BYTES = 16 * 1024;

function nameFromSkillMd(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  for (const line of m[1].split(/\r?\n/)) {
    const hit = /^name\s*:\s*(.*)$/.exec(line);
    if (!hit) continue;
    const value = hit[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    return value || null;
  }
  return null;
}

/** 按顺序在候选目录里找第一个读得到名字的 Skill。 */
export function readSkillDisplayName(candidateDirs: readonly string[]): string | null {
  for (const dir of candidateDirs) {
    const file = path.join(dir, 'SKILL.md');
    try {
      if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) continue;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(MAX_BYTES);
        const n = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
        const name = nameFromSkillMd(buf.toString('utf8', 0, n));
        if (name) return name;
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* 读不到就试下一个 */ }
  }
  return null;
}
