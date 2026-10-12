/**
 * meeting-guard — 会议引用层反漂移测试（specs/013 · Phase 9 · T059 / T061 / T062）
 *
 * T059 五条断言（tasks.md 原文），全部**从源码/常量派生**——运行时 import 常量 +
 * 对 src 的文本扫描，不抄任何"当前名单"：
 *   ① 引例判据只有 1 处定义（`QUOTE_MARKERS`），扫描链**引用而非复制**；
 *   ② 外发闸只有 1 处（`assertActionDraftSendable`），全部落点都必须过它；
 *   ③ 沉淀只有 1 个候选写口（`saveRecallCandidate`），不出现第二个
 *     `save*Candidate` 实现；
 *   ④ `tool-catalog.ts` 的 `recall` 组工具数按源码常量计数（013 自身新增 0）；
 *   ⑤ 会议侧不出现 tags/category 写入、不出现 `familyName`。
 *
 * T061（源码级边界断言，git 级"013 提交未触碰"的 diff 证据见
 * specs/013-会议引用层/implementation-log.md——git 历史无法在测试里派生，
 * 此处派生的是它的源码投影）：008/009/010/015 交付件零引用会议线。
 *
 * T062（读盘原文断言·补缺）：草稿盘上字段白名单 + 指标事件逐行字段白名单
 * （引用包/纪要/回执的"不含正文"读盘断言已分别在 meeting_refs.test.ts /
 * meeting_conclusions.test.ts / meeting_metrics.test.ts 落地，见实现日志对照表；
 * 本文件补齐草稿与指标事件两块）。
 *
 * 反向自证（T059 验收"故意改坏一处应让它变红"）：下方所有检测器都实现为
 * **纯函数**（输入 `{ 相对路径 → 文件内容 }` 表），另有专门一例把真实源码的
 * **内存副本**注入违规（第二份词表定义 / familyName 写入 / meeting 工具行）
 * 后喂给检测器、断言检测器报红——不改 src/ 一行，验证的是检测器本身的判别力
 * （下一次有人在真实源码里做同样的事，同一检测器就会让本文件变红）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { QUOTE_MARKERS } from '../../../src/main/features/transcript_rewrite';
import { isQuotedExampleSpan } from '../../../src/main/features/transcript_auto_correct';
import { TOOL_CATALOG } from '../../../src/main/model/core-agent/tool-catalog';
import {
  buildConclusionCandidateInput,
  precipitateMeetingConclusion,
} from '../../../src/main/features/meeting_conclusions';
import {
  saveActionDraft,
  confirmActionDraft,
  applyActionDraftTarget,
} from '../../../src/main/features/meeting_action_drafts';
import { recordMeetingMetric } from '../../../src/main/features/meeting_metrics';
import { docKeyForDocId } from '../../../src/main/features/meeting_doc';
import { userMeetingActionDraftsDir, userMeetingMetricsFile } from '../../../src/main/paths';

// ── 源码收集（派生的输入，不是名单） ─────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 收集 src/ 下全部 .ts/.js 源码为 `{ 相对路径 → 内容 }`（跳过 node_modules）。 */
function collectSourceFiles(rootDirs: string[]): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(name)) {
        files.set(path.relative(REPO_ROOT, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
      }
    }
  };
  for (const dir of rootDirs) walk(path.join(REPO_ROOT, dir));
  return files;
}

/** 全 src（主进程 + 渲染层：词表副本可能出现在任何一侧）。 */
function allSourceFiles(): Map<string, string> {
  return collectSourceFiles(['src']);
}

/** 只保留非注释行（行首 `//`、`*`、`/*` 的行视为注释；保守策略：宁可少删，
 *  也不碰字符串字面量内部）。 */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

// ── T059① 检测器：引例判据唯一处 ────────────────────────────────────────────

/** `QUOTE_MARKERS = [` 形态的定义处清单（引例判据的定义只能有一处）。 */
function detectQuoteMarkerDefinitions(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of files) {
    if (/(?:export\s+)?(?:const|let)\s+QUOTE_MARKERS\s*=/.test(source)) out.push(file);
  }
  return out;
}

/**
 * "引用而非复制"派生：以**运行时 import 的 QUOTE_MARKERS 常量**为词表，数每个
 * 文件里以引号字面量出现的**去重标记词数**。定义文件自身必然全量命中；任何
 * 复制了词表（≥3 个标记词写成引号字面量）的第二份实现都会被抓到——阈值 3
 * 是"一份可用词表"的下界（1~2 个普通中文词出现在别处是正常注释/文案）。
 */
function detectQuotedMarkerCopies(
  files: Map<string, string>,
  markers: readonly string[],
  definitionFiles: readonly string[],
  minHits: number,
): Array<{ file: string; hits: number }> {
  const out: Array<{ file: string; hits: number }> = [];
  for (const [file, source] of files) {
    if (definitionFiles.includes(file)) continue;
    let hits = 0;
    for (const marker of markers) {
      if (source.includes(`'${marker}'`) || source.includes(`"${marker}"`)) hits += 1;
    }
    if (hits >= minHits) out.push({ file, hits });
  }
  return out;
}

// ── T059② 检测器：外发闸唯一处 ──────────────────────────────────────────────

/** `export function assertActionDraftSendable(` 的定义文件清单。 */
function detectSendGateDefinitions(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of files) {
    if (/export\s+function\s+assertActionDraftSendable\s*\(/.test(source)) out.push(file);
  }
  return out;
}

/** `confirmedTarget: {` 值写入点（类型声明位是 `confirmedTarget?`，不匹配）。 */
function detectConfirmedTargetWriteSites(
  files: Map<string, string>,
): Array<{ file: string; index: number }> {
  const out: Array<{ file: string; index: number }> = [];
  for (const [file, source] of files) {
    const re = /\bconfirmedTarget\s*:\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) out.push({ file, index: match.index });
  }
  return out;
}

// ── T059③ 检测器：候选写口唯一 ──────────────────────────────────────────────

/** `save*Candidate*` 函数实现清单（定义在哪、叫什么）。 */
function detectSaveCandidateImplementations(
  files: Map<string, string>,
): Array<{ file: string; name: string; index: number }> {
  const out: Array<{ file: string; name: string; index: number }> = [];
  for (const [file, source] of files) {
    const re = /(?:export\s+)?(?:async\s+)?function\s+(save\w*[Cc]andidate\w*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      out.push({ file, name: match[1], index: match.index });
    }
  }
  return out;
}

/** 候选池记录写 API（`write/updateRecallJsonRecord`）的使用文件清单。 */
function detectRecallRecordWriteUsers(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of files) {
    if (/writeRecallJsonRecord|updateRecallJsonRecord/.test(source)) out.push(file);
  }
  return out;
}

// ── T059⑤ / T061① 检测器：会议侧 tags 边界 + 交付件零引用 ─────────────────────

/** 会议线源码文件（013 的新增面；按文件名前缀派生，不抄内容）。 */
function meetingLineFiles(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, source] of files) {
    const base = path.basename(file);
    if (/^meeting[\w-]*\.(ts|js)$/.test(base) || file === 'src/main/ipc/meeting.ts') {
      out.set(file, source);
    }
  }
  return out;
}

/** 非注释行里出现 `\bfamilyName\b` 的位置（会议侧任何出现都算违规）。 */
function detectFamilyNameInMeetingLine(
  files: Map<string, string>,
): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = [];
  for (const [file, source] of meetingLineFiles(files)) {
    for (const line of stripCommentLines(source).split('\n')) {
      if (/\bfamilyName\b/.test(line)) out.push({ file, line: line.trim() });
    }
  }
  return out;
}

/**
 * 非注释行的对象键 `tags:` / `category:`（"写入"的形态）。T048 的合法残留只有
 * 两形：入参接口的 `tags?: unknown;` / `category?: unknown;`（类型上保留键位
 * 只为"收到了"可判定、收到即拒）与拒绝循环里的 `['tags', 'category']` 字符串
 * 数组——两形都不是写入。其余任何键形态 = 违规。
 */
function detectTagKeyWritesInMeetingLine(
  files: Map<string, string>,
): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = [];
  for (const [file, source] of meetingLineFiles(files)) {
    for (const line of stripCommentLines(source).split('\n')) {
      if (!/\b(tags|category)\s*:/.test(line)) continue;
      if (/tags\?\s*:\s*unknown|category\?\s*:\s*unknown/.test(line)) continue; // T048 入参键位
      if (/\[\s*'tags'\s*,\s*'category'\s*\]/.test(line)) continue; // T048 拒绝循环
      out.push({ file, line: line.trim() });
    }
  }
  return out;
}

/** T061① 钩子位只有注释：`tags hook` 标记在非注释行里必须零出现。 */
function detectHookCodeInMeetingLine(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of meetingLineFiles(files)) {
    if (/tags\s+hook/.test(stripCommentLines(source))) out.push(file);
  }
  return out;
}

/** T060/T061 边界文件清单（tasks.md 原文点名；断言的是"零 meeting 引用"的
 *  源码投影，git 提交级证据在实现日志）。 */
const BOUNDARY_FILES: readonly string[] = [
  'src/main/features/recall/asset-service.ts',            // 008
  'src/main/features/recall/asset-approval-card.ts',      // 008
  'src/main/features/recall/asset-approval-service.ts',   // 008
  'src/main/features/recall/asset-retention-service.ts',  // 008
  'src/main/features/recall/formal-assets/promotion.ts',  // 008
  'src/main/features/recall/context-projection.ts',       // 015 投影记录
  'src/main/features/recall/prompt-injection.ts',         // 008/015
  'src/main/features/recall/projection-card.ts',          // 008/015
  'src/main/features/personal_ontology_groups.ts',        // 009
  'src/main/features/recall/formal-assets/inbox.ts',      // 010
];

function detectMeetingReferencesInBoundaryFiles(files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const file of BOUNDARY_FILES) {
    const source = files.get(file);
    if (source === undefined) { out.push(`${file}（文件缺失）`); continue; }
    if (/meeting/i.test(source)) out.push(file);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// T059 ① 引例判据只有 1 处定义，扫描链引用而非复制
// ═══════════════════════════════════════════════════════════════════════════

describe('T059① 引例判据唯一处（QUOTE_MARKERS）', () => {
  it('定义全 src 唯一：只有 transcript_rewrite.ts 一处（export 共享）', () => {
    const definitions = detectQuoteMarkerDefinitions(allSourceFiles());
    expect(definitions).toEqual(['src/main/features/transcript_rewrite.ts']);
  });

  it('扫描链引用而非复制：auto_correct 从唯一处 import，全 src 无第二份词表', () => {
    const files = allSourceFiles();
    // 引用：扫描链（scanText 的引例闸所在模块）import 唯一定义，不自建词表。
    const autoCorrect = files.get('src/main/features/transcript_auto_correct.ts') ?? '';
    expect(autoCorrect).toMatch(/import\s*\{[^}]*QUOTE_MARKERS[^}]*\}\s*from\s*'\.\/transcript_rewrite'/);
    // 而不是复制：以运行时常量为词表扫全 src——除定义文件外，任何文件以引号
    // 字面量写出 ≥3 个标记词 = 抄了一份词表。
    const definitions = detectQuoteMarkerDefinitions(files);
    const copies = detectQuotedMarkerCopies(files, QUOTE_MARKERS, definitions, 3);
    expect(copies).toEqual([]);
  });

  it('行为派生：共享词表驱动引例闸——事故原句「一会儿叫 coxy」命中，无标记词不命中', () => {
    const text = '张磊说：一会儿叫 coxy，先这样记。';
    const start = text.indexOf('coxy');
    expect(isQuotedExampleSpan(text, { start, end: start + 4 })).toBe(true);
    const plain = '我们今天用 coxy 上课。';
    const plainStart = plain.indexOf('coxy');
    expect(isQuotedExampleSpan(plain, { start: plainStart, end: plainStart + 4 })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T059 ② 外发闸只有 1 处，全部落点都必须过它
// ═══════════════════════════════════════════════════════════════════════════

describe('T059② 外发闸唯一处（assertActionDraftSendable）', () => {
  it('定义唯一：全 src 只有 meeting_action_drafts.ts 导出这一个闸', () => {
    const definitions = detectSendGateDefinitions(allSourceFiles());
    expect(definitions).toEqual(['src/main/features/meeting_action_drafts.ts']);
  });

  it('落点写入点全 src/main 唯一（confirmedTarget 值写入恰 1 处），且在闸调用之后', () => {
    const files = allSourceFiles();
    const sites = detectConfirmedTargetWriteSites(files);
    expect(sites).toHaveLength(1);
    expect(sites[0].file).toBe('src/main/features/meeting_action_drafts.ts');
    const source = files.get(sites[0].file) ?? '';
    const fnStart = source.indexOf('export function applyActionDraftTarget');
    const gateAt = source.indexOf('assertActionDraftSendable(draft)', fnStart);
    expect(fnStart).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(fnStart);
    expect(gateAt).toBeLessThan(sites[0].index); // 先过闸，再写落点
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T059 ③ 沉淀只有 1 个候选写口
// ═══════════════════════════════════════════════════════════════════════════

describe('T059③ 候选写口唯一（saveRecallCandidate）', () => {
  it('save*Candidate 实现要么在 candidate-service（唯一写口本体），要么必须委托它', () => {
    const files = allSourceFiles();
    const impls = detectSaveCandidateImplementations(files);
    expect(impls.length).toBeGreaterThan(0);
    for (const impl of impls) {
      if (impl.file === 'src/main/features/recall/candidate-service.ts') continue; // 本体（含其同文件锁内助手）
      // 别处的同名形态实现（如 kstar 桥）必须是**委托**：函数体（其后 4000 字内）
      // 调用唯一写口，而不是绕开它自写一套。
      const body = (files.get(impl.file) ?? '').slice(impl.index, impl.index + 4000);
      expect(body, `${impl.file} 的 ${impl.name} 必须委托 saveRecallCandidate`).toContain('saveRecallCandidate(');
    }
  });

  it('候选池记录写 API（write/updateRecallJsonRecord）不出 features/recall/；会议线只经唯一写口', () => {
    const files = allSourceFiles();
    const writers = detectRecallRecordWriteUsers(files).filter((file) => !file.startsWith('src/main/features/recall/'));
    expect(writers).toEqual([]);
    // 会议沉淀线（meeting_conclusions）import 唯一写口，而不是第二套池子。
    const conclusions = files.get('src/main/features/meeting_conclusions.ts') ?? '';
    expect(conclusions).toMatch(/import\s*\{\s*saveRecallCandidate\s*\}\s*from\s*'\.\/recall\/candidate-service'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T059 ④ tool-catalog 的 recall 组工具数（013 自身新增 0）
// ═══════════════════════════════════════════════════════════════════════════

describe('T059④ recall 组工具数（不新增模型工具）', () => {
  it(`recall 组工具数 = 14，按源码常量 TOOL_CATALOG 计数（013 新增 0）`, () => {
    // 计数从源码常量派生（import 后过滤 group），不是抄名单。
    // 数值口径（git 可核）：tasks.md 立项时 recall 组 = 11（2 基础 + 008 资产管家 9）；
    // 本合流分支上 016 经验目录（4d44add3，先于 013 首个提交 983ef317 落地）向同组
    // 加了 list_task_experiences / read_task_experience 两件 ⇒ 13。013 会议线全程
    // 未改 tool-catalog.ts（实现日志 T060 留证），自身新增 0。
    // 2026-09-28：13⇒14——09-27 本体切片的 list_ontology_graph（工厂与 catalog
    // 双侧注册），基线随树重算。
    // 下一次有人往 recall 组加/删工具，这里会红——那是本断言的本意（逼基线显式更新）。
    const recallTools = TOOL_CATALOG.filter((entry) => entry.group === 'recall');
    expect(recallTools).toHaveLength(14);
  });

  it('TOOL_CATALOG 不出现会议线工具（013 不新增任何模型工具）', () => {
    const meetingTools = TOOL_CATALOG.filter((entry) => /meeting/i.test(entry.name));
    expect(meetingTools.map((entry) => entry.name)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T059 ⑤ 会议侧零 tags/category 写入、零 familyName
// ═══════════════════════════════════════════════════════════════════════════

describe('T059⑤ 会议侧零 tags/category/familyName', () => {
  it('源码派生：非注释处零 familyName；tags/category 键只出现在 T048 拒绝位', () => {
    const files = allSourceFiles();
    expect(detectFamilyNameInMeetingLine(files)).toEqual([]);
    expect(detectTagKeyWritesInMeetingLine(files)).toEqual([]);
  });

  it('源码派生：T048 预留的打标钩子位只有注释（012 边界；钩子由 012 的资产管家接管）', () => {
    expect(detectHookCodeInMeetingLine(allSourceFiles())).toEqual([]);
  });

  it('运行时派生：buildConclusionCandidateInput 组装结果不带 tags/category/familyName 键', () => {
    const input = buildConclusionCandidateInput(
      {
        id: 'mc_guard_1',
        docId: 'kb/guard-privacy.md',
        summary: '结论摘要：排期改为下周三',
        transcriptRefs: [{ utteranceId: 'U0001', blockIndex: 0, from: 0, to: 6 }],
        assetRefs: [],
        status: 'confirmed',
        createdAt: '2026-09-25T00:00:00.000Z',
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
      { docId: 'kb/guard-privacy.md', title: '守卫会议' },
    );
    const keys = Object.keys(input);
    expect(keys).toEqual(expect.arrayContaining([
      'judgment', 'suggestedAction', 'sourceRefs', 'evidenceRefs', 'captureKey',
    ]));
    for (const banned of ['tags', 'category', 'familyName']) {
      expect(input, `候选组装不得带 ${banned} 键`).not.toHaveProperty(banned);
    }
  });

  it('运行时派生：precipitate 收到 tags / category ⇒ field_not_available（先于条目存在性检查）', async () => {
    const uid = `u_guard_${Date.now()}`;
    // T048 的键拒绝在读取条目之前——不需要存在真实的结论即可验证。
    await expect(precipitateMeetingConclusion(uid, 'kb/guard-privacy.md', 'mc_missing', { tags: ['急'] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'field_not_available' }));
    await expect(precipitateMeetingConclusion(uid, 'kb/guard-privacy.md', 'mc_missing', { category: '工作' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'field_not_available' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T061 边界（源码级）：008/009/010/015 交付件零引用会议线
// ═══════════════════════════════════════════════════════════════════════════

describe('T061 边界核对（源码投影）：008/009/010/015 交付件不引用会议线', () => {
  it('边界文件全部在位，且零 meeting 引用（不 import 会议模块、不含会议通道串）', () => {
    expect(detectMeetingReferencesInBoundaryFiles(allSourceFiles())).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T062 读盘原文断言（补缺）：草稿与指标事件的盘上字段白名单
// ═══════════════════════════════════════════════════════════════════════════

describe('T062 读盘原文断言：草稿盘上只有 id/摘要/来源/锚点/引用/状态/时间', () => {
  let uid = '';
  const DOC = 'kb/guard-privacy.md';
  beforeEach(() => {
    uid = `u_guard_drafts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    fs.rmSync(userMeetingActionDraftsDir(uid), { recursive: true, force: true });
  });

  it('save → confirm → applyTarget 后，盘上 JSON 的每一层字段都在白名单内（无任何正文字段位）', () => {
    const draft = saveActionDraft(uid, {
      docId: DOC,
      summary: '下周三前把排期表发给付平老师',
      owner: { speaker: '付平', anchor: { utteranceId: 'U0004', blockIndex: 3, from: 0, to: 12 } },
      transcriptRefs: [{ utteranceId: 'U0004', blockIndex: 3, from: 0, to: 12 }],
      assetRefs: [{ assetId: 'ast_guard', version: '3', title: '守卫资产', type: 'personal' }],
    });
    confirmActionDraft(uid, DOC, draft.id);
    applyActionDraftTarget(uid, DOC, draft.id, { kind: 'local', ref: 'todo://guard' });

    const file = path.join(userMeetingActionDraftsDir(uid), `${docKeyForDocId(DOC)}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const store = JSON.parse(raw) as Record<string, unknown>;
    // 盘上原文逐层断言：顶层 / 草稿 / 来源 / 锚点 / 资产引用 / 落点。
    expect(Object.keys(store).sort()).toEqual(['createdAt', 'docId', 'drafts', 'schemaVersion', 'updatedAt']);
    for (const item of store.drafts as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual([
        'assetRefs', 'confirmedAt', 'confirmedTarget', 'createdAt', 'docId',
        'id', 'owner', 'status', 'summary', 'transcriptRefs', 'updatedAt',
      ].sort());
      const owner = item.owner as Record<string, unknown>;
      expect(Object.keys(owner).sort()).toEqual(['anchor', 'speaker']);
      for (const anchor of [...(item.transcriptRefs as Array<Record<string, unknown>>), owner.anchor as Record<string, unknown>]) {
        expect(Object.keys(anchor).sort()).toEqual(['blockIndex', 'from', 'to', 'utteranceId']);
      }
      for (const ref of item.assetRefs as Array<Record<string, unknown>>) {
        expect(Object.keys(ref).sort()).toEqual(['assetId', 'title', 'type', 'version']);
      }
      expect(Object.keys(item.confirmedTarget as Record<string, unknown>).sort()).toEqual(['kind', 'ref']);
    }
  });
});

describe('T062 读盘原文断言：指标事件逐行只带 id/版本/计数', () => {
  it('五种事件全部落盘后，每一行的字段都在该 kind 的白名单内', () => {
    const uid = `u_guard_metrics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const docId = 'kb/guard-privacy.md';
    recordMeetingMetric(uid, { kind: 'meeting_scan', docId, candidates: 3, exact: 2, recall: 1, model: 0, quotedExample: 1, truncated: false, termCandidates: 2 });
    recordMeetingMetric(uid, { kind: 'meeting_decision', docId, itemId: 'ge_1', itemKind: 'correction', decision: 'accept', refs: 1, entryKind: 'term' });
    recordMeetingMetric(uid, { kind: 'meeting_asset_ref', docId, assetId: 'ast_guard', version: '3', via: 'attach' });
    recordMeetingMetric(uid, { kind: 'meeting_model_usage', docId, operation: 'review', inputTokens: 120, outputTokens: 30 });
    recordMeetingMetric(uid, { kind: 'meeting_revert', docId, runId: 'run_guard', acceptedCount: 1 });
    // 无 token 读数 ⇒ 不写事件（不写 0 假装测到）。
    recordMeetingMetric(uid, { kind: 'meeting_model_usage', docId, operation: 'review' });

    const allowed: Record<string, string[]> = {
      meeting_scan: ['kind', 'docId', 'candidates', 'exact', 'recall', 'model', 'quotedExample', 'truncated', 'termCandidates', 'at'],
      meeting_decision: ['kind', 'docId', 'itemId', 'itemKind', 'decision', 'refs', 'entryKind', 'at'],
      meeting_asset_ref: ['kind', 'docId', 'assetId', 'version', 'via', 'at'],
      meeting_model_usage: ['kind', 'docId', 'operation', 'inputTokens', 'outputTokens', 'totalTokens', 'at'],
      meeting_revert: ['kind', 'docId', 'runId', 'acceptedCount', 'at'],
    };
    const lines = fs.readFileSync(userMeetingMetricsFile(uid), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(5); // 第二条 model_usage（全缺失）不落盘
    for (const line of lines) {
      const event = JSON.parse(line) as { kind: string } & Record<string, unknown>;
      const extra = Object.keys(event).filter((key) => !allowed[event.kind]?.includes(key));
      expect(extra, `${event.kind} 出现白名单外字段：${extra.join(',')}`).toEqual([]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T059 反向自证：检测器对"故意改坏"必须变红（在内存副本上做，不动 src/）
// ═══════════════════════════════════════════════════════════════════════════

describe('T059 反向自证（检测器判别力，src/ 零改动）', () => {
  it('注入第二份 QUOTE_MARKERS 定义 ⇒ ①的检测器必须报出', () => {
    const files = allSourceFiles();
    const victim = 'src/main/features/meeting_conclusions.ts';
    files.set(victim, `${files.get(victim)}\nconst QUOTE_MARKERS = ['错形'];\n`);
    const definitions = detectQuoteMarkerDefinitions(files);
    expect(definitions).toContain(victim);
    expect(definitions.length).toBe(2); // 原唯一处 + 注入处 ⇒ 红
  });

  it('注入 familyName 写入与 tags 键 ⇒ ⑤的检测器必须报出', () => {
    const files = allSourceFiles();
    const victim = 'src/main/features/meeting_conclusions.ts';
    files.set(victim, `${files.get(victim)}\nconst tagWrite = { familyName: 'x', tags: ['急'] };\n`);
    expect(detectFamilyNameInMeetingLine(files).length).toBe(1);
    expect(detectTagKeyWritesInMeetingLine(files).length).toBe(1);
  });

  it('注入 meeting 工具行 ⇒ ④的检测器必须报出（TOOL_CATALOG 层面）', () => {
    const injected = [
      ...TOOL_CATALOG,
      { name: 'list_meeting_refs', group: 'recall' as const, summary: 'injected' },
    ];
    expect(injected.filter((entry) => entry.group === 'recall')).toHaveLength(15); // 14 基线 + 1 注入 ⇒ 红
    expect(injected.filter((entry) => /meeting/i.test(entry.name)).map((entry) => entry.name))
      .toEqual(['list_meeting_refs']);
  });

  it('边界文件里注入 meeting 引用 ⇒ T061 的检测器必须报出', () => {
    const files = allSourceFiles();
    const victim = 'src/main/features/recall/asset-service.ts';
    files.set(victim, `${files.get(victim)}\n// injected meeting reference\nimport { x } from '../meeting_refs';\n`);
    expect(detectMeetingReferencesInBoundaryFiles(files)).toContain(victim);
  });
});
