/** KSTAR 可关闭，认知资产权威层与 recall 不得反向导入 KSTAR。
 * 静态和动态 import 都受约束，分类纯函数由认知层提供给 KSTAR 消费。 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..', 'src', 'main', 'features');
const COGNITION_DIRS = ['cognition', 'cognition_kernel', 'recall'] as const;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 抽掉块/行注释，避免注释里的路径误报。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 文件里引用 kstar 模块路径的 import（静态 + 动态）。 */
function kstarImports(code: string): string[] {
  const pattern = /(?:from\s+'|import\(\s*['"])([^'"]*features\/kstar\/[^'"]+)/g;
  const hits: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) hits.push(match[1]);
  return hits;
}

describe('KSTAR 可关闭：认知资产层依赖方向钉子', () => {
  it('cognition/cognition_kernel/recall 不得 import features/kstar（KSTAR 只能是消费者）', () => {
    const offenders: string[] = [];
    for (const dir of COGNITION_DIRS) {
      const full = path.join(ROOT, dir);
      if (!fs.existsSync(full)) continue;
      for (const file of listTsFiles(full)) {
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        const hits = kstarImports(code);
        if (hits.length) offenders.push(`${path.relative(ROOT, file)} -> ${hits.join(', ')}`);
      }
    }
    expect(offenders, `认知资产层反向依赖 KSTAR：${offenders.join(' ; ')}——关闭 KSTAR 即断链（FR-001/AC-011）；KSTAR 只能作为统一提取管线的适配器单向依赖认知层，共享符号放认知层（如 recall/experience-taxonomy）`).toEqual([]);
  });
});
