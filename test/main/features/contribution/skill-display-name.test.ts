/**
 * 本机 Skill 显示名：读得到就用，读不到返回 null，绝不抛错、不跟随符号链接。
 * 用真实临时目录——要测的正是"读到了什么"。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSkillDisplayName } from '../../../../src/main/features/contribution/skill-display-name';

let root: string;
const skill = (rel: string, md: string): string => {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  return dir;
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-name-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('readSkillDisplayName', () => {
  it('读 frontmatter 的 name，含引号与空白', () => {
    expect(readSkillDisplayName([skill('a', '---\nname: 发票字段抽取\ndescription: d\n---\n正文')])).toBe('发票字段抽取');
    expect(readSkillDisplayName([skill('b', '---\nname:   "报销制度预检"  \n---\n')])).toBe('报销制度预检');
    expect(readSkillDisplayName([skill('c', "---\r\nname: 'x y'\r\n---\r\n")])).toBe('x y');
  });

  it('按候选顺序取第一个读得到的', () => {
    const first = skill('first', '---\nname: 市场版\n---\n');
    const second = skill('second', '---\nname: 自建版\n---\n');
    expect(readSkillDisplayName([first, second])).toBe('市场版');
    expect(readSkillDisplayName([path.join(root, 'missing'), second])).toBe('自建版');
  });

  it('没有 name、没有 frontmatter、目录不存在：返回 null 而不是抛错', () => {
    expect(readSkillDisplayName([skill('d', '---\ndescription: 只有描述\n---\n')])).toBeNull();
    expect(readSkillDisplayName([skill('e', '# 没有 frontmatter')])).toBeNull();
    expect(readSkillDisplayName([skill('f', '---\nname:\n---\n')])).toBeNull();
    expect(readSkillDisplayName([path.join(root, 'nope')])).toBeNull();
    expect(readSkillDisplayName([])).toBeNull();
  });

  it('只认第一段 frontmatter 里的 name，正文里的 name: 不算', () => {
    expect(readSkillDisplayName([skill('g', '---\ndescription: d\n---\nname: 正文里的\n')])).toBeNull();
  });

  it('不跟随符号链接', () => {
    const real = skill('real', '---\nname: 真名\n---\n');
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    expect(readSkillDisplayName([link])).toBeNull();
  });

  it('只读文件开头一段，超大文件不会被整个读入', () => {
    const big = skill('big', `---\nname: 大文件\n---\n${'x'.repeat(200_000)}`);
    expect(readSkillDisplayName([big])).toBe('大文件');
  });
});
