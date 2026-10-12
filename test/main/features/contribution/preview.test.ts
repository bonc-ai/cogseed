/**
 * 预览清单：「预览即发出」这条不变量的机械保证。
 *
 * `C-FR-004a` 要求实际发出的清单与预览逐项一致。实现上靠**同一份清单既用于展示也
 * 用于打包**来保证，而不是两处各自遍历目录。这套用例覆盖的是那份清单本身的性质：
 * 确定性、能反映增删、排除本机安装态、不跟随符号链接。
 *
 * 用真实临时目录而非 mock fs：要测的正是"遍历真实目录得到什么"，mock 会把结论假设掉。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPreview, previewChanged, checkLimits, PACKAGE_LIMITS,
} from '../../../../src/main/features/contribution/preview';

let tmp: string;
const staging = () => ({ dir: tmp, sourceSkillId: 'demo', token: 'deadbeef' });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrib-preview-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
function write(rel: string, content: string): void {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('清单的确定性', () => {
  it('同一内容两次构建产出同一 digest', () => {
    write('SKILL.md', '# demo');
    write('scripts/run.py', 'print(1)');
    expect(buildPreview(staging()).digest).toBe(buildPreview(staging()).digest);
  });

  it('路径按字典序排序，不依赖目录遍历顺序', () => {
    write('z.md', 'z');
    write('a.md', 'a');
    write('m/b.md', 'b');
    expect(buildPreview(staging()).files.map((f) => f.path)).toEqual(['a.md', 'm/b.md', 'z.md']);
  });

  it('相对路径用正斜杠，跨平台稳定', () => {
    write('a/b/c.md', 'x');
    expect(buildPreview(staging()).files[0].path).toBe('a/b/c.md');
  });
});

describe('digest 覆盖清单本身，不只是内容', () => {
  /**
   * 只哈希各文件内容会漏掉增删与改名：一个空文件的内容摘要恒定，增删它不改变
   * 任何单文件摘要，但清单变了——而"发出去的是哪些文件"正是隐私承诺的对象。
   */
  it('新增一个空文件会改变 digest', () => {
    write('SKILL.md', '# demo');
    const before = buildPreview(staging());
    write('empty.txt', '');
    const after = buildPreview(staging());
    expect(previewChanged(before, after)).toBe(true);
  });

  it('改名（内容不变）会改变 digest', () => {
    write('a.md', 'same');
    const before = buildPreview(staging());
    fs.renameSync(path.join(tmp, 'a.md'), path.join(tmp, 'b.md'));
    expect(previewChanged(before, buildPreview(staging()))).toBe(true);
  });

  it('内容变化会改变 digest', () => {
    write('a.md', 'v1');
    const before = buildPreview(staging());
    write('a.md', 'v2');
    expect(previewChanged(before, buildPreview(staging()))).toBe(true);
  });

  it('未变化时 digest 相同', () => {
    write('a.md', 'v1');
    const before = buildPreview(staging());
    expect(previewChanged(before, buildPreview(staging()))).toBe(false);
  });
});

describe('预览外的本机数据不得进入清单', () => {
  it('排除本机安装态文件', () => {
    write('SKILL.md', '# demo');
    write('_install.json', '{"local":"state"}');
    write('_cache.json', '{}');
    write('_resource_manifest.json', '{}');
    const paths = buildPreview(staging()).files.map((f) => f.path);
    expect(paths).toEqual(['SKILL.md']);
  });

  it('保留 _meta.json —— 它是内容的一部分（描述/分类/来源）', () => {
    write('SKILL.md', '# demo');
    write('_meta.json', '{"category":"x"}');
    expect(buildPreview(staging()).files.map((f) => f.path)).toContain('_meta.json');
  });

  it('不跟随符号链接 —— 跟随会让清单指向副本之外的内容', () => {
    write('SKILL.md', '# demo');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contrib-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SHOULD-NOT-APPEAR');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(tmp, 'link.txt'));
    } catch {
      return; // 平台不支持建链接时跳过
    }
    const preview = buildPreview(staging());
    expect(preview.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(JSON.stringify(preview)).not.toContain('SHOULD-NOT-APPEAR');
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('包上限核对', () => {
  it('文件数超限被报出', () => {
    for (let i = 0; i < PACKAGE_LIMITS.maxFiles + 1; i += 1) write(`f${i}.txt`, 'x');
    const v = checkLimits(buildPreview(staging()));
    expect(v.some((x) => x.kind === 'too_many_files')).toBe(true);
  });

  it('正常包不报上限', () => {
    write('SKILL.md', '# demo');
    expect(checkLimits(buildPreview(staging()))).toEqual([]);
  });
});
