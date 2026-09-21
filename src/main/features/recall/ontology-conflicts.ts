/**
 * ontology-conflicts — 本体分组同字段值矛盾检测（2026-09-19 本体增强）。
 *
 * 对应蓝图 R32 conflict_policy：矛盾暴露成复核项，不静默消解——本模块
 * 只「查出并记账」，永不改写/删除任何字段值，删除权在用户。
 *
 * 检测两级（计划拍板 ④）：
 *   1. embedding 余弦相似 ≥ 0.60（与判族 FAMILY_SEMANTIC_THRESHOLD 同值同
 *      依赖）——先「在谈同一件事」才谈得上矛盾，避免「常住北京」和「喜欢
 *      简洁」这种不相干值对浪费模型调用。
 *   2. LLM 二元判定（buildRunner.runReflection，semantic-review 同款轻量
 *      单轮）：两条值是否互斥。只有模型明确判「矛盾」才记账。
 *
 * 降级矩阵（与查重降级哲学对齐但更宽：检测是增强，不能卡写入）：
 *   - embedding 不可用（embedForDedup → null）→ 整体跳过本轮检测；
 *   - 单条既有值向量缺失 → 跳过该值对；
 *   - LLM 不可用/回复不可解析 → 跳过该值对，不记账（不制造假冲突）。
 *
 * 调用约定：调用方 fire-and-forget（void promise）——保存与检查互相独立，
 * 保存动作的「成功」从不承诺「查过没问题」，检查结论只报忧不报喜。
 *
 * 台账：`<uid>/cloud/contexts/.personal_ontology_groups/conflicts.md`（台账
 * 模式先例 groups.md / candidates.md；markdown 人读）。读取时自愈——值已
 * 被用户删掉的冲突行顺手清除，台账只留仍然成立的矛盾。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { userOntologyGroupsDir } from '../../paths';
import { safeId, nowIso, genId12, writeTextAtomicSync } from '../../storage';
// groups 不反向依赖本模块（写值挂点用动态 import），这里静态单向依赖安全。
import {
  collectTemplateFileFields,
  isTemplateFileText,
  parseGroupContent,
  readGroupContent,
} from '../personal_ontology_groups';

const log = createLogger('ontology-conflicts');

/** 与判族 FAMILY_SEMANTIC_THRESHOLD 同值：值对先「在谈同一件事」。 */
export const CONFLICT_SEMANTIC_THRESHOLD = 0.60;
/** 新值 vs 既有值逐对，超长字段截断（防爆调用）。 */
export const MAX_PAIRS_PER_CHECK = 8;
/** 单条值送检长度上限（prompt 体积守恒）。 */
const MAX_VALUE_FOR_PROMPT = 300;

export interface OntologyConflictRecord {
  conflict_id: string;
  group_id: string;
  field: string;
  value_a: string;
  value_b: string;
  detected_at: string;
  status: 'open';
}

function conflictsMdPath(uid: string): string {
  return path.join(userOntologyGroupsDir(uid), 'conflicts.md');
}

function parseConflictsMd(text: string): OntologyConflictRecord[] {
  const records: OntologyConflictRecord[] = [];
  const blocks = text.split(/\n(?=###\s+\S)/);
  for (const block of blocks) {
    const header = block.match(/^###\s+(\S+)/);
    if (!header) continue;
    const get = (key: string): string => {
      const m = block.match(new RegExp(`^- ${key}: (.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const groupId = get('分组');
    const field = get('字段');
    const valueA = get('值A');
    const valueB = get('值B');
    if (!groupId || !field || !valueA || !valueB) continue;
    records.push({
      conflict_id: header[1],
      group_id: groupId,
      field,
      value_a: valueA,
      value_b: valueB,
      detected_at: get('检出') || nowIso(),
      status: 'open',
    });
  }
  return records;
}

function serializeConflictsMd(records: OntologyConflictRecord[]): string {
  const lines: string[] = ['# 本体分组字段值冲突台账', ''];
  for (const r of records) {
    lines.push(`### ${r.conflict_id}`);
    lines.push(`- 分组: ${r.group_id}`);
    lines.push(`- 字段: ${r.field}`);
    lines.push(`- 值A: ${r.value_a}`);
    lines.push(`- 值B: ${r.value_b}`);
    lines.push(`- 检出: ${r.detected_at}`);
    lines.push('');
  }
  return lines.join('\n');
}

function readConflicts(uid: string): OntologyConflictRecord[] {
  try {
    const text = fs.readFileSync(conflictsMdPath(uid), 'utf8');
    return parseConflictsMd(text);
  } catch {
    return [];
  }
}

function writeConflicts(uid: string, records: OntologyConflictRecord[]): void {
  writeTextAtomicSync(conflictsMdPath(uid), serializeConflictsMd(records));
}

function dedupeKey(r: { group_id: string; field: string; value_a: string; value_b: string }): string {
  const pair = [r.value_a, r.value_b].sort().join('\u0000');
  return `${r.group_id}\u0000${r.field}\u0000${pair}`;
}

async function llmJudgeMutuallyExclusive(
  userId: string,
  field: string,
  valueA: string,
  valueB: string,
): Promise<'conflict' | 'no_conflict' | 'unavailable'> {
  try {
    const { buildRunner } = await import('../../model/core-agent/runner');
    const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // session id 前缀须在 session-store 白名单（semantic-review 同款教训）
    const { runner } = await buildRunner({
      sessionId: `memory-extract-recall-ontology-conflict-${tail}`,
      userId,
    });
    const prompt = [
      '你是个人本体数据的质检员。同一个字段下有两条值，判断它们是否互相矛盾（互斥：不能同时为真）。',
      '',
      `字段：${field}`,
      `值一：${valueA.slice(0, MAX_VALUE_FOR_PROMPT)}`,
      `值二：${valueB.slice(0, MAX_VALUE_FOR_PROMPT)}`,
      '',
      '判定标准：只有两条值在陈述同一个维度上不能同时成立（如「常住北京」vs「常住上海」）才算矛盾；',
      '只是详略不同、角度不同、或讲的是不同维度（如「常住北京」vs「喜欢旅行」）都不算。',
      '只输出 JSON：{"conflict": true} 或 {"conflict": false}，不要输出任何其他内容。',
    ].join('\n');
    const reply = await runner.runReflection(prompt);
    const match = String(reply || '').match(/\{[^}]*\}/);
    if (!match) return 'unavailable';
    const parsed = JSON.parse(match[0]) as { conflict?: unknown };
    if (parsed.conflict === true) return 'conflict';
    if (parsed.conflict === false) return 'no_conflict';
    return 'unavailable';
  } catch (err) {
    log.debug('conflict llm judge unavailable', { userId, error: (err as Error)?.message });
    return 'unavailable';
  }
}

export interface ConflictCheckOptions {
  /** Test seam（先例：semantic-review 的 buildRunnerFn）。 */
  judgeFn?: typeof llmJudgeMutuallyExclusive;
  /** 判定超时上限（测试缝；默认 180s——真机实测模型队列 3~90s 波动）。 */
  judgeTimeoutMs?: number;
}

/**
 * 台账串行队列（per-uid）：记账（read→push→write）与自愈（read→heal→write）
 * 都是读改写三步，并发交错时后写者会覆盖掉先写者刚落的记录——真机验证曾
 * 观察到「检测记账后、长轮询窗口内被自愈写回抹掉」的丢行。单主进程内一条
 * promise 链即可保证任意时刻每个用户只有一个台账事务在跑。
 */
const ledgerQueues = new Map<string, Promise<unknown>>();

function withLedger<T>(uid: string, task: () => Promise<T> | T): Promise<T> {
  const prev = ledgerQueues.get(uid) || Promise.resolve();
  const next = prev.then(task, task);
  ledgerQueues.set(uid, next.catch(() => {}));
  return next;
}

/** 判定超时上限：模型队列忙时 runReflection 可能吊数分钟——超时按
 *  unavailable 处理（跳过、不记账、不悬挂检测链）。 */
export const CONFLICT_JUDGE_TIMEOUT_MS = 180_000;

/**
 * 写值后的矛盾检查（fire-and-forget 调用，本函数自身也永不 throw）。
 * existingValues = 该字段写入前的既有值列表（调用方在写入事务里拍快照）。
 */
export async function checkNewValueAgainst(
  userId: string,
  groupId: string,
  fieldName: string,
  newValue: string,
  existingValues: string[],
  opts: ConflictCheckOptions = {},
): Promise<void> {
  try {
    if (!safeId(userId) || !safeId(groupId)) return;
    const others = (existingValues || []).filter((v) => v && v !== newValue);
    if (!others.length) return;

    const { embedForDedup, cosineScore } = await import('./similarity');
    const newVec = await embedForDedup(userId, newValue);
    if (!newVec) {
      log.info('conflict check skipped: embedding unavailable', { userId, groupId, field: fieldName });
      return;
    }
    const judge = opts.judgeFn ?? llmJudgeMutuallyExclusive;
    const timeoutMs = opts.judgeTimeoutMs ?? CONFLICT_JUDGE_TIMEOUT_MS;
    for (const existing of others.slice(0, MAX_PAIRS_PER_CHECK)) {
      const existingVec = await embedForDedup(userId, existing);
      if (!existingVec) continue;
      if (cosineScore(newVec, existingVec) < CONFLICT_SEMANTIC_THRESHOLD) continue;
      const verdict = await Promise.race([
        Promise.resolve(judge(userId, fieldName, existing, newValue))
          .catch(() => 'unavailable' as const),
        new Promise<'unavailable'>((resolve) => {
          setTimeout(() => resolve('unavailable'), timeoutMs).unref?.();
        }),
      ]);
      if (verdict !== 'conflict') continue;
      const record: OntologyConflictRecord = {
        conflict_id: `oc-${genId12()}`,
        group_id: groupId,
        field: fieldName,
        value_a: existing,
        value_b: newValue,
        detected_at: nowIso(),
        status: 'open',
      };
      await withLedger(userId, () => {
        const current = readConflicts(userId);
        const key = dedupeKey(record);
        if (current.some((r) => dedupeKey(r) === key)) return; // 同值对不重复记账
        current.push(record);
        writeConflicts(userId, current);
      });
      log.info('ontology field conflict recorded', { userId, groupId, field: fieldName, conflictId: record.conflict_id });
    }
  } catch (err) {
    log.warn('conflict check failed (non-blocking)', { userId, groupId, error: (err as Error)?.message });
  }
}

/**
 * 读冲突台账（UI/时间线消费口）。自带自愈：逐条校验两条值仍存在于该组该
 * 字段——值已被用户删除的冲突行顺手清除，台账只留仍然成立的矛盾。
 */
export async function listConflicts(
  userId: string,
  groupId?: string,
): Promise<OntologyConflictRecord[]> {
  // 自愈的读改写与记账并发会互相覆盖（见 withLedger 注释）——整段进队列。
  return withLedger(userId, async () => {
    const all = readConflicts(userId);
    if (!all.length) return [];
    const live: OntologyConflictRecord[] = [];
    // 写回集合必须包含「本次未校验」的其它组记录：按 groupId 过滤读时它们
    // 不在自愈范围内，写回若只按 live 过滤，打开任一组的子页就会清空其它
    // 组的冲突台账（live 只装了本组记录）。
    const keep: OntologyConflictRecord[] = [];
    let healed = 0;
    for (const record of all) {
      if (groupId && record.group_id !== groupId) {
        keep.push(record);
        continue;
      }
      let values: string[] = [];
      try {
        const content = await readGroupContent(userId, record.group_id);
        if (content.content) {
          // 模板组文件是 `## 分节`+`### 字段` 结构，parseGroupContent 只认
          // 双区格式、对分节式解出空 fields（自愈会永远判失效，模板组的
          // 冲突记上就被下次读取清掉）。按文件标记分流，字段名跨分节合并，
          // 与记账挂点同口径。
          if (isTemplateFileText(content.content)) {
            for (const f of collectTemplateFileFields(content.content)) {
              if (f.name === record.field) values.push(...f.values.map((fv) => fv.value));
            }
          } else {
            values = (parseGroupContent(content.content).fields[record.field] || []).map((fv) => fv.value);
          }
        }
      } catch {
        values = [];
      }
      const stillThere = values.includes(record.value_a) && values.includes(record.value_b);
      if (stillThere) {
        live.push(record);
        keep.push(record);
      } else {
        healed += 1;
      }
    }
    if (healed > 0) {
      writeConflicts(userId, keep);
      log.info('conflict ledger self-healed', { userId, healed });
    }
    return live;
  });
}
