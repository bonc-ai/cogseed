import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// scripts/check-skipped-tests.mjs 的自测。
//
// 这道检查存在的理由本身就是"检查自己不会失败"：nightly 里原来那条只数文件数、
// 只 ::warning、末尾恒 exit 0，于是"用 skip 静音"没有任何一道会自动变红的关卡。
// 所以这个自测的重点不是"能扫出 skip"，而是**该失败时真的失败**、
// **不该失败时（平台条件跳过、已登记条目）不误伤**。

const SCRIPT = path.resolve(process.cwd(), 'scripts/check-skipped-tests.mjs');

let root = '';

function write(rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function run(extra: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], { encoding: 'utf8' });
}

function allowlist(entries: unknown[]): void {
  write('test/skip-allowlist.json', JSON.stringify({ allowed: entries }, null, 2));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-skip-scan-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('check-skipped-tests 扫描器', () => {
  it('未登记的硬跳过在 --strict 下判失败，并打印文件与标题', () => {
    write('test/foo.test.ts', [
      "import { describe, it } from 'vitest';",
      "describe('foo', () => {",
      "  it.skip('silently disabled case', () => {});",
      '});',
    ].join('\n'));

    const r = run(['--strict']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('test/foo.test.ts');
    expect(r.stdout).toContain('silently disabled case');
  });

  it('登记之后同样的硬跳过可以通过', () => {
    write('test/foo.test.ts', [
      "import { describe, it } from 'vitest';",
      "describe('foo', () => {",
      "  it.skip('silently disabled case', () => {});",
      '});',
    ].join('\n'));
    allowlist([
      {
        file: 'test/foo.test.ts',
        title: 'silently disabled case',
        reason: 'pending gateway-side semantics',
        since: '2026-08-24',
      },
    ]);

    const r = run(['--strict']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('所有硬跳过都已在');
  });

  it('非 --strict 模式只报告，不判失败', () => {
    write('test/foo.test.ts', "it.skip('unregistered', () => {});\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('只报告，不判失败');
  });

  it('skipIf / 条件跳过只统计，不判失败（平台条件跳过是正当用法）', () => {
    write('test/foo.test.ts', [
      "it.skipIf(process.platform === 'win32')('win32 only gap', () => {});",
      "describe.skipIf(process.env.CI)('ci only', () => {});",
    ].join('\n'));
    allowlist([]);

    const r = run(['--strict']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skipIf / 条件跳过：2 处');
    expect(r.stdout).toContain('test/foo.test.ts');
  });

  it('白名单里已不存在的条目会被提示为过期（但不判失败）', () => {
    write('test/foo.test.ts', "it('alive', () => {});\n");
    allowlist([
      { file: 'test/gone.test.ts', title: 'already restored', reason: 'x', since: '2026-08-24' },
    ]);

    const r = run(['--strict']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('白名单过期条目');
    expect(r.stdout).toContain('already restored');
  });

  it('describe.skip 与 test.skip 同样计入硬跳过', () => {
    write('test/foo.test.ts', [
      "describe.skip('whole suite parked', () => {});",
      "test.skip('single case parked', () => {});",
    ].join('\n'));

    const r = run(['--strict']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('whole suite parked');
    expect(r.stdout).toContain('single case parked');
  });
});
