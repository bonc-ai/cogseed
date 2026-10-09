import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(process.cwd(), 'scripts/check-community-skills.mjs');

let root = '';

function write(rel: string, content: string, mode?: number): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function run() {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
}

function seedValidSkill(id = 'rubric-checker'): void {
  write(`community/skills/${id}/SKILL.md`, `---
name: ${id}
description: 根据用户提供的评分标准检查作业草稿并返回逐项改进建议。
---

# Rubric Checker

use_when:
- 用户提供了作业草稿和评分标准。

do_not_use_when:
- 用户没有提供评分标准，或要求代写整份作业。

## 输入

用户明确提供的草稿和评分标准。

## 工作流

逐项比较要求、证据和缺口。

## 输出

返回检查结果、证据定位和修改建议。

## 边界

本候选不联网、不执行脚本、不写入外部系统。
production_release_allowed: false
`);
  write(`community/skills/${id}/evals/evals.json`, JSON.stringify({
    cases: [
      { id: 'accept-rubric', kind: 'positive', input: '按这份评分表检查草稿', expected: '逐项检查并引用草稿证据' },
      { id: 'reject-writing', kind: 'negative', input: '替我写完整作业', expected: '拒绝代写并说明能力边界' },
    ],
  }, null, 2));
  write(`community/skills/${id}/provenance.json`, JSON.stringify({
    author_github: 'student-one',
    original_work: true,
    third_party_materials: [],
  }, null, 2));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-community-skills-'));
  fs.mkdirSync(path.join(root, 'community', 'skills', '_template'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('community Skill candidate gate', () => {
  it('accepts a complete declarative candidate and ignores the template directory', () => {
    seedValidSkill();

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 candidate package(s)');
  });

  it('rejects executable files and paths outside the pilot allow-list', () => {
    seedValidSkill();
    write('community/skills/rubric-checker/scripts/run.sh', '#!/bin/sh\necho unsafe\n', 0o755);

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('top-level path scripts is not allowed');
    expect(result.stderr).toContain('only text-based .md/.json/.txt/.yaml/.yml files are allowed');
  });

  it('rejects an id mismatch, incomplete evals, placeholders, and machine-specific paths', () => {
    seedValidSkill('study-helper');
    const skillFile = path.join(root, 'community/skills/study-helper/SKILL.md');
    const text = fs.readFileSync(skillFile, 'utf8')
      .replace('name: study-helper', 'name: other-name')
      .replace('逐项比较要求、证据和缺口。', '读取 /Users/test/private/TODO 后继续。');
    fs.writeFileSync(skillFile, text, 'utf8');
    write('community/skills/study-helper/evals/evals.json', JSON.stringify({
      cases: [{ id: 'only-positive', kind: 'positive', input: '检查', expected: '结果' }],
    }));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('frontmatter name must equal directory name study-helper');
    expect(result.stderr).toContain('unresolved template placeholder found');
    expect(result.stderr).toContain('machine-specific absolute path found');
    expect(result.stderr).toContain('a negative case is required');
  });

  it('requires attribution details when the contribution is not wholly original', () => {
    seedValidSkill();
    write('community/skills/rubric-checker/provenance.json', JSON.stringify({
      author_github: 'student-one',
      original_work: false,
      third_party_materials: [],
    }));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-original work must list its third-party materials');
  });

  it('does not let invalid candidate directories hide behind an underscore prefix', () => {
    seedValidSkill('_hidden-candidate');

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('directory name must use lowercase ASCII kebab-case');
  });

  it('rejects stray files at the collection root', () => {
    write('community/skills/.DS_Store', 'local metadata');

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected file at the Skill collection root');
  });
});
