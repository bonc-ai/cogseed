/** 退役注释必须与源码事实一致：已删除的服务不再导出，仍保留的读取函数
 * 与实际消费范围相符。完成态说明不得退回待处理表述。 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../../..');
const IPC_INDEX_REL = 'src/main/ipc/index.ts';

/** 收集 dir 下所有源文件里含 needle 的命中（相对路径:行号），可排除指定文件。 */
function grepLines(dir: string, needle: string, exclude: string[] = []): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|js|mjs)$/.test(entry.name)) continue;
      // Repo-relative hits are compared against `/`-joined constants below, so
      // normalize the Windows separator instead of comparing native paths.
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (exclude.includes(rel)) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes(needle)) out.push(`${rel}:${i + 1}`);
      });
    }
  };
  walk(dir);
  return out;
}

describe('退役注释与代码事实一致', () => {
  const indexSource = fs.readFileSync(path.join(root, IPC_INDEX_REL), 'utf8');

  it('注释是完成态：服务文件「已随通道退役删除」，不得回漂成待办口径', () => {
    // 服务已删除，说明不能继续写成待处理状态。
    expect(indexSource).toContain('dashboard/decideCognitionCandidate 的服务文件已随通道退役删除');
    expect(indexSource).not.toContain('随「通道退役大批」处置');
  });

  it('被声明删除的确实不在：decideCognitionCandidate 除该注释外零命中', () => {
    // 排除 ipc/index.ts（退役注释本身）与本测试文件（注释/断言里引用该名）。
    const SELF = 'test/main/ipc/retired-comment-consistency.test.ts';
    const outside = [
      ...grepLines(path.join(root, 'src'), 'decideCognitionCandidate', [IPC_INDEX_REL]),
      ...grepLines(path.join(root, 'test'), 'decideCognitionCandidate', [SELF]),
    ];
    expect(outside).toEqual([]);
    expect(fs.existsSync(path.join(root, 'src/main/features/cognition/dashboard.ts'))).toBe(false);
  });

  it('被声明保留的确实还在：listCognitionCandidates 定义仍在（仅测试直测的保留登记）', () => {
    // skill-summary 与 assets-adapter 的运行时消费已删除，说明应为「运行时零消费、
    // 仅测试直测」。这里钉住：定义仍在（cognition.test.ts 直测其读取映射
    // 与排序），且 cognition 目录内对它的引用只出现在定义文件自身——
    // 若将来出现新消费点，注释账本必须同步改写。
    const hits = grepLines(path.join(root, 'src/main/features/cognition'), 'listCognitionCandidates');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((line) => line.startsWith('src/main/features/cognition/candidates-adapter.ts:'))).toBe(true);
  });
});
