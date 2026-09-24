/**
 * local_text_export —— 把文本导出到用户本机文件夹。
 *
 * 覆盖：
 *   1. 文件名净化：绝不带路径出目录（`../../etc/passwd` 只能当名字看）；
 *   2. 「原文所在文件夹」那条路**绝不覆盖**：冲突落 -2/-3，且竞态下也不覆盖（`wx`）；
 *   3. 系统保存框那条路允许覆盖（用户已明确选名）；
 *   4. 写入敏感清单拦住 authorized_keys / /etc/cron*，但**不拦**用户自己导出到桌面
 *      （读侧清单含 `^~/(Desktop|Documents|Downloads)`，这里刻意不复用）；
 *   5. 目录不存在/内容为空等失败都是带 code 的显式失败，不静默。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_EXPORT_BYTES,
  candidateExportName,
  exportTextToDirectory,
  exportTextToPath,
  sanitizeExportFileName,
} from '../../../src/main/features/local_text_export';
import { sensitivePathReasons, sensitiveWritePathReasons } from '../../../src/main/features/local_access_policy';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-local-export-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('文件名净化', () => {
  it('路径分隔符/上跳段只当普通名字看，绝不出目录', () => {
    expect(sanitizeExportFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeExportFileName('a/b\\c.txt')).toBe('c.txt');
    expect(sanitizeExportFileName('..\\..\\windows\\system32\\x.txt')).toBe('x.txt');
  });

  it('Windows 保留字符与控制字符换成 -（否则 Windows 上写不出来）', () => {
    expect(sanitizeExportFileName('站会:清理版?.txt')).toBe('站会-清理版-.txt');
    expect(sanitizeExportFileName('a\u0000b.txt')).toBe('a-b.txt');
  });

  it('隐藏文件名去掉前导点（避免导出一个用户看不见的文件）', () => {
    expect(sanitizeExportFileName('.hidden.txt')).toBe('hidden.txt');
  });

  it('空名回退 archive.txt（老 behave：不能让目标变成目录本身）', () => {
    expect(sanitizeExportFileName('')).toBe('archive.txt');
    expect(sanitizeExportFileName('   ')).toBe('archive.txt');
    expect(sanitizeExportFileName('...')).toBe('archive.txt');
    expect(sanitizeExportFileName(undefined)).toBe('archive.txt');
  });

  it('超长名截断但保留扩展名', () => {
    const name = sanitizeExportFileName(`${'长'.repeat(200)}.txt`);
    expect(name.endsWith('.txt')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(120);
  });
});

describe('同名候选', () => {
  it('第一次用原名，之后 -2/-3', () => {
    expect(candidateExportName('站会-清理版.txt', 0)).toBe('站会-清理版.txt');
    expect(candidateExportName('站会-清理版.txt', 1)).toBe('站会-清理版-2.txt');
    expect(candidateExportName('站会-清理版.txt', 2)).toBe('站会-清理版-3.txt');
  });
});

describe('导出到指定目录（原文所在文件夹这条路）', () => {
  it('写出 UTF-8 文件并返回绝对路径', () => {
    const res = exportTextToDirectory(tmpDir, '站会-清理版.txt', '清理后的正文\n第二行');
    expect(res.ok).toBe(true);
    expect(res.path).toBe(path.join(tmpDir, '站会-清理版.txt'));
    expect(fs.readFileSync(res.path as string, 'utf8')).toBe('清理后的正文\n第二行');
  });

  it('绝不覆盖同名文件：冲突自动落 -2、-3', () => {
    const first = exportTextToDirectory(tmpDir, 'a-清理版.txt', '第一份');
    const second = exportTextToDirectory(tmpDir, 'a-清理版.txt', '第二份');
    const third = exportTextToDirectory(tmpDir, 'a-清理版.txt', '第三份');
    expect(first.path).toBe(path.join(tmpDir, 'a-清理版.txt'));
    expect(second.path).toBe(path.join(tmpDir, 'a-清理版-2.txt'));
    expect(third.path).toBe(path.join(tmpDir, 'a-清理版-3.txt'));
    expect(fs.readFileSync(first.path as string, 'utf8')).toBe('第一份');
  });

  it('目录不存在返回显式失败（不抛、不静默）', () => {
    const res = exportTextToDirectory(path.join(tmpDir, 'missing'), 'a.txt', 'x');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('E_EXPORT_DIR');
  });

  it('目录不是绝对路径直接拒绝', () => {
    expect(exportTextToDirectory('relative/dir', 'a.txt', 'x').code).toBe('E_EXPORT_DIR');
  });

  it('空内容拒绝导出（避免生成一个空文件让人以为保存成功）', () => {
    expect(exportTextToDirectory(tmpDir, 'a.txt', '').code).toBe('E_EXPORT_EMPTY');
  });
});

describe('导出到用户选定路径（系统保存框这条路）', () => {
  it('允许覆盖——保存框里用户已经明确回答了"就用这个名字"', () => {
    const target = path.join(tmpDir, '自定义名.txt');
    fs.writeFileSync(target, '旧内容', 'utf8');
    const res = exportTextToPath(target, '新内容');
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('新内容');
  });

  it('目录不存在返回显式失败', () => {
    expect(exportTextToPath(path.join(tmpDir, 'nope', 'a.txt'), 'x').code).toBe('E_EXPORT_DIR');
  });
});

describe('写入敏感路径', () => {
  it('authorized_keys / LaunchAgents 这类写入被拦', () => {
    const sshKey = path.join(os.homedir(), '.ssh', 'authorized_keys');
    expect(exportTextToPath(sshKey, 'x').code).toBe('E_EXPORT_SENSITIVE');
    const agent = path.join(os.homedir(), 'Library', 'LaunchAgents', 'x.plist');
    expect(exportTextToPath(agent, 'x').code).toBe('E_EXPORT_SENSITIVE');
  });

  it('用户导出到桌面**不该**被拦（读侧清单含 Desktop，这正是不能复用它的原因）', () => {
    const desktopFile = path.join(os.homedir(), 'Desktop', '会议', '站会-清理版.txt');
    expect(sensitiveWritePathReasons(desktopFile)).toEqual([]);
    expect(sensitivePathReasons(desktopFile, 'write')).toEqual(['sensitive_path']);
  });
});

describe('内容上限', () => {
  it('超限拒绝（判异常而不是硬写）', () => {
    const tooBig = 'x'.repeat(MAX_EXPORT_BYTES + 1);
    expect(exportTextToDirectory(tmpDir, 'a.txt', tooBig).code).toBe('E_EXPORT_TOO_LARGE');
  });
});
