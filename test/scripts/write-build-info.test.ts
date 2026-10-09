import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'write-build-info.cjs');
const require = createRequire(import.meta.url);
const { normalizeHttpsOrigin, resolveHubApiBaseForBuild } = require(scriptPath);

function tempOutFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-build-info-'));
  return path.join(dir, 'build-info.json');
}

describe('write-build-info: service origin validation', () => {
  it('normalizes a clean HTTPS origin and drops the trailing slash', () => {
    expect(normalizeHttpsOrigin('https://hub.example.test/')).toBe('https://hub.example.test');
    expect(normalizeHttpsOrigin('  https://hub.example.test/root/  ')).toBe('https://hub.example.test/root');
  });

  it.each([
    'http://hub.example.test',
    'https://user:pass@hub.example.test',
    'https://hub.example.test/?query=1',
    'https://hub.example.test/#fragment',
    'not-a-url',
    '',
  ])('rejects unusable origin %s', (value) => {
    expect(normalizeHttpsOrigin(value)).toBeNull();
  });
});

describe('write-build-info: release builds must carry an origin', () => {
  it('fails a release build that carries no origin', () => {
    const decision = resolveHubApiBaseForBuild({ channel: 'release', raw: '' });
    expect(decision.ok).toBe(false);
    // 报错必须点名仓库变量，否则拿到红单的人不知道该配什么。
    expect(decision.ok === false && decision.error).toMatch(/COGSEED_HUB_API_BASE_URL/);
  });

  it('fails a release build whose origin is unusable', () => {
    const decision = resolveHubApiBaseForBuild({ channel: 'release', raw: 'http://hub.example.test' });
    expect(decision.ok).toBe(false);
  });

  it('allows an explicit placeholder opt-out for local layout checks', () => {
    expect(resolveHubApiBaseForBuild({ channel: 'release', raw: '', allowPlaceholder: true }))
      .toEqual({ ok: true, value: '' });
  });

  it('leaves non-release channels without an origin untouched', () => {
    // ci / packaged-dev 包只做验收，不要求注入；缺值时 build-info 不写该字段。
    for (const channel of ['ci', 'packaged-dev', 'dev']) {
      expect(resolveHubApiBaseForBuild({ channel, raw: '' })).toEqual({ ok: true, value: '' });
    }
  });

  it('bakes a normalized origin when one is provided', () => {
    expect(resolveHubApiBaseForBuild({ channel: 'release', raw: 'https://hub.example.test/' }))
      .toEqual({ ok: true, value: 'https://hub.example.test' });
  });
});

describe('write-build-info: CLI contract', () => {
  it('writes the injected origin into build-info.json', () => {
    const out = tempOutFile();
    execFileSync('node', [
      scriptPath, '--channel=release',
      '--hub-api-base=https://hub.example.test/',
      `--out=${out}`,
    ], { cwd: repoRoot, encoding: 'utf8' });
    const info = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(info.channel).toBe('release');
    expect(info.hubApiBase).toBe('https://hub.example.test');
  });

  it('omits the field when no origin is injected', () => {
    const out = tempOutFile();
    execFileSync('node', [
      scriptPath, '--channel=packaged-dev', `--out=${out}`,
    ], { cwd: repoRoot, encoding: 'utf8' });
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).not.toHaveProperty('hubApiBase');
  });

  it('exits non-zero for a release build without an origin', () => {
    const out = tempOutFile();
    let status = 0;
    let stderr = '';
    try {
      execFileSync('node', [
        scriptPath, '--channel=release', `--out=${out}`,
      ], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
      stderr = String((error as { stderr?: string }).stderr || '');
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/COGSEED_HUB_API_BASE_URL/);
    expect(fs.existsSync(out)).toBe(false);
  });
});
