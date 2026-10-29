/**
 * 结构性不变量审计（specs/009-meeting-output-archive tasks T039 / T040）。
 *
 * 为什么用源码投影断言而不是时序测量：
 *   规格 SC-006 要求"沉淀不延长会议主流程的用户可感知耗时 **或** 完全异步于主流程"。
 *   后者是**结构性质**，比在 CI 里量耗时更稳（耗时断言在共享跑测机上必然抖动）。
 *   本仓库既有反漂移测试（`recall/*-guard.test.ts`）就是用源码投影钉不变量的同一手法。
 *
 * 同时审计两条"必须不发生"（spec §Must-not-happen）：
 *   - **不迁移**：沉淀模块不得出现 move / rename / delete / migrate 类调用（FR-011）；
 *   - **不递归**：沉淀不得发出环节事件（否则事件-沉淀互相触发会成环）。
 * 以及隐私边界：账本模块不得把正文写进记录（FR-027 / 宪章 §III）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const PRECIPITATE = path.join(ROOT, 'src/main/features/meeting_kb_precipitate.ts');
const EVENTS = path.join(ROOT, 'src/main/features/meeting_stage_events.ts');
const LEDGER = path.join(ROOT, 'src/main/features/meeting_artifact_ledger.ts');
const TARGET = path.join(ROOT, 'src/main/features/meeting_archive_target.ts');

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** 去掉注释与字符串字面量，避免把说明文字误判成代码。 */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

describe('结构性不变量：沉淀不迁移、不递归、不阻塞', () => {
  it('沉淀模块不得移动 / 重命名 / 删除**知识库内容**（FR-011 不迁移）', () => {
    const code = stripCommentsAndStrings(read(PRECIPITATE));

    // 移动 / 重命名 / 迁移：一律禁止 —— 它们能改变既有条目的位置。
    for (const re of [/\brenameSync\b/, /\brename\b/, /\brename\(/, /\bmoveFile\b/, /\bmigrate\w*\(/]) {
      expect(code, `不应出现 ${re}`).not.toMatch(re);
    }

    // 删除：允许，但**只能删自己刚建的临时目录**。
    // 精确性很重要：二进制分支会把内容先落到临时目录再交给既有拷贝原语，
    // 不清理就会在用户知识库根下留垃圾 —— 那是 bug 不是守规矩。
    // 因此断言的是"删除目标必须是临时路径"，而不是"不许出现删除"。
    const rmCalls = [...code.matchAll(/\brmSync\s*\(([^)]*)/g)].map((m) => m[1]);
    for (const arg of rmCalls) {
      expect(arg, `rmSync 只应作用于临时目录，实际作用于: ${arg.slice(0, 60)}`).toMatch(/tmp/i);
    }

    // 不得出现"删除知识库条目"的调用（那需要库内相对路径参与）。
    expect(code).not.toMatch(/deleteContextTarget/);
    expect(code).not.toMatch(/\bdeleteFile\b/);
  });

  it('沉淀模块不发出环节事件（否则事件↔沉淀成环）', () => {
    const code = stripCommentsAndStrings(read(PRECIPITATE));
    expect(code).not.toMatch(/\bemitMeetingStage\s*\(/);
  });

  it('环节事件模块不导入沉淀模块（依赖方向单向）', () => {
    const code = read(EVENTS);
    expect(code).not.toContain('meeting_kb_precipitate');
    expect(code).not.toContain('meeting_artifact_ledger');
    expect(code).not.toContain('meeting_archive_target');
  });

  it('orchestrator 的监听器不同步执行沉淀（SC-006：完全异步于主流程）', () => {
    const code = stripCommentsAndStrings(read(PRECIPITATE));
    // 监听器必须把沉淀推到下一个 tick，而不是直接 await。
    // 这一条是"不阻塞会议主流程"的结构保证；行为层另有
    // `meeting_stage_hooks.test.ts` 的"emit 后同步阶段 calls 为空"用例佐证。
    expect(code).toMatch(/Promise\.resolve\(\)\.then/);
  });

  it('沉淀模块不使用 fs.watch（仓库既有约定：靠事件与 reconcile，不做文件系统监听）', () => {
    const code = stripCommentsAndStrings(read(PRECIPITATE));
    expect(code).not.toMatch(/\bwatch\s*\(/);
    expect(code).not.toContain('fs.watch');
  });

  it('账本模块的字段白名单不含任何正文类键名', () => {
    const code = read(LEDGER);
    const allowListBlock = code.slice(code.indexOf('const ALLOWED_KEYS'), code.indexOf('const MAX_FIELD_CHARS'));
    for (const key of ['content', 'text', 'transcript', 'minutes', 'body', 'summary']) {
      expect(allowListBlock, `白名单不应含正文类键 ${key}`).not.toContain(`'${key}'`);
    }
  });

  it('目标判定模块不导出任何移动 / 删除能力（FR-011 的结构保证）', () => {
    const code = stripCommentsAndStrings(read(TARGET));
    const exported = [...code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(/move|rename|delete|migrate/i.test(name), `不应导出 ${name}`).toBe(false);
    }
  });

  it('沉淀模块不向外部服务发送任何内容（FR-027）', () => {
    const code = stripCommentsAndStrings(read(PRECIPITATE));
    for (const re of [/\bfetch\s*\(/, /https?:\/\//, /\bnet\./, /\bhttp\./, /\brequest\s*\(/]) {
      expect(code, `不应出现网络调用 ${re}`).not.toMatch(re);
    }
  });
});
