import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import AdmZip from 'adm-zip';

import { agentPrivateSkillIdsFromBundle, stampPrivateSkillOwners } from '../../../src/main/features/marketplace_private_skills';

describe('marketplace private skill bundles', () => {
  it('recognizes only top-level skill directories containing SKILL.md', () => {
    const zip = new AdmZip();
    zip.addFile('sample-router/SKILL.md', Buffer.from('---\nname: sample-router\n---\n'));
    zip.addFile('sample-router/references/routing.md', Buffer.from('# Routing\n'));
    zip.addFile('stage-compose/SKILL.md', Buffer.from('---\nname: stage-compose\n---\n'));
    zip.addFile('nested/not-a-root-skill/SKILL.md', Buffer.from('ignored'));
    zip.addFile('readme-only/README.md', Buffer.from('ignored'));

    expect([...agentPrivateSkillIdsFromBundle(zip)].sort()).toEqual([
      'sample-router',
      'stage-compose',
    ]);
  });

  it('returns an empty set when no private bundle exists', () => {
    expect(agentPrivateSkillIdsFromBundle(null)).toEqual(new Set());
  });
});

let dir: string;
const write = (rel: string, content: string): void => {
  const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
};
const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-skills-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('stampPrivateSkillOwners', () => {
  it('把贡献者本机 id 改写成安装后的 Agent id，保留其余内容', async () => {
    write('invoice-ocr/SKILL.md', '---\nname: ocr\nownerAgent: contributor-local\n---\n正文\n');
    write('invoice-ocr/scripts/run.py', 'print(1)\n');
    const out = await stampPrivateSkillOwners(dir, 'abcdef123456');
    expect(out).toEqual(['invoice-ocr']);
    expect(read('invoice-ocr/SKILL.md')).toBe('---\nname: ocr\nownerAgent: abcdef123456\n---\n正文\n');
    expect(read('invoice-ocr/scripts/run.py')).toBe('print(1)\n');
  });

  it('已一致（存量官方 Agent）是空操作，不改文件', async () => {
    write('seo-crawl/SKILL.md', '---\nname: s\nownerAgent: abcdef123456\n---\nx\n');
    const before = fs.statSync(path.join(dir, 'seo-crawl/SKILL.md')).mtimeMs;
    expect(await stampPrivateSkillOwners(dir, 'abcdef123456')).toEqual([]);
    expect(fs.statSync(path.join(dir, 'seo-crawl/SKILL.md')).mtimeMs).toBe(before);
  });

  it('没有 frontmatter 的 SKILL.md 保持原样，不被写坏', async () => {
    write('plain/SKILL.md', '# 没有 frontmatter\n');
    expect(await stampPrivateSkillOwners(dir, 'abcdef123456')).toEqual([]);
    expect(read('plain/SKILL.md')).toBe('# 没有 frontmatter\n');
  });

  it('只处理子目录；散落文件与目录不存在都不抛错', async () => {
    write('README.md', 'x');
    expect(await stampPrivateSkillOwners(dir, 'abcdef123456')).toEqual([]);
    expect(await stampPrivateSkillOwners(path.join(dir, 'nope'), 'abcdef123456')).toEqual([]);
  });

  it('多个私有 Skill 各自改写', async () => {
    write('a/SKILL.md', '---\nname: a\n---\n');
    write('b/SKILL.md', '---\nname: b\nownerAgent: old\n---\n');
    expect((await stampPrivateSkillOwners(dir, 'id1')).sort()).toEqual(['a', 'b']);
    expect(read('a/SKILL.md')).toContain('ownerAgent: id1');
    expect(read('b/SKILL.md')).toContain('ownerAgent: id1');
  });
});
