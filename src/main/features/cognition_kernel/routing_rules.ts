/**
 * cognition_kernel/routing_rules — 归属规则数据层。
 *
 * 定位：**归属规则不写在代码里**。本模块只做两件事：
 *   ① 读用户自己的归属规则与「纠正样例」，交给判定模型当依据；
 *   ② 记录用户的每一次纠正（"这条不该放这个家"），成为下一次判定的样例。
 *
 * 归属规则和纠正样例作为数据提供给判定器，不能由静态类型映射替代。
 * 判定与写入门控由 judge.ts 负责，本模块只管理用户明确给出的规则。
 *
 * 存储：`<uid>/cloud/cognition/routing-rules.json`（与 personal-ontology.json 同
 * 目录、同耐久级别：参与云同步、原子写、schemaVersion）。坏档按空规则处理并记
 * 警告——规则读不到只影响判定质量，绝不影响内容本身的写入路径。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { userCognitionDir } from '../../paths';
import { genId12, nowIso, readJsonSync, safeId, writeTextAtomicSync } from '../../storage';
import type { ContentHome } from './types';

const log = createLogger('cognition-routing-rules');

export const ROUTING_RULES_SCHEMA_VERSION = 1;
export const MAX_RULES = 200;
export const MAX_CORRECTIONS = 100;
export const MAX_NOTE_CHARS = 300;
export const MAX_STATEMENT_CHARS = 500;

const HOMES: ReadonlySet<string> = new Set<ContentHome>([
  'cognition',
  'personal_fact',
  'rule',
  'template',
  'method',
  'task_local',
  'experience',
]);

function isHome(value: unknown): value is ContentHome {
  return typeof value === 'string' && HOMES.has(value);
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 用户给某类内容指定的归属（人话写给模型看，不做模式匹配）。 */
export interface RoutingRule {
  id: string;
  home: ContentHome;
  /** 什么时候用这条规则（用户原话或整理后的一句话）。 */
  note: string;
  origin: 'user';
  createdAt: string;
}

/** 用户的一次纠正：这条内容被判到了 fromHome，用户改成了 toHome。 */
export interface RoutingCorrection {
  statement: string;
  fromHome: ContentHome | null;
  toHome: ContentHome;
  note?: string;
  at: string;
}

export interface RoutingRulesDoc {
  schemaVersion: typeof ROUTING_RULES_SCHEMA_VERSION;
  rules: RoutingRule[];
  corrections: RoutingCorrection[];
}

export function routingRulesPath(uid: string): string {
  return path.join(userCognitionDir(uid), 'routing-rules.json');
}

function emptyDoc(): RoutingRulesDoc {
  return { schemaVersion: ROUTING_RULES_SCHEMA_VERSION, rules: [], corrections: [] };
}

function normalizeDoc(raw: unknown): RoutingRulesDoc {
  const doc = (raw ?? {}) as Partial<RoutingRulesDoc>;
  const rules = Array.isArray(doc.rules)
    ? doc.rules
        .map((rule) => {
          const r = (rule ?? {}) as Partial<RoutingRule>;
          if (!isHome(r.home)) return null;
          const note = clip(r.note, MAX_NOTE_CHARS);
          if (!note) return null;
          return {
            id: String(r.id || genId12()),
            home: r.home,
            note,
            origin: 'user' as const,
            createdAt: String(r.createdAt || nowIso()),
          };
        })
        .filter((rule): rule is RoutingRule => rule !== null)
        .slice(-MAX_RULES)
    : [];
  const corrections = Array.isArray(doc.corrections)
    ? doc.corrections
        .map((item) => {
          const c = (item ?? {}) as Partial<RoutingCorrection>;
          if (!isHome(c.toHome)) return null;
          const statement = clip(c.statement, MAX_STATEMENT_CHARS);
          if (!statement) return null;
          return {
            statement,
            fromHome: isHome(c.fromHome) ? c.fromHome : null,
            toHome: c.toHome,
            ...(clip(c.note, MAX_NOTE_CHARS) ? { note: clip(c.note, MAX_NOTE_CHARS) } : {}),
            at: String(c.at || nowIso()),
          };
        })
        .filter((item): item is RoutingCorrection => item !== null)
        .slice(-MAX_CORRECTIONS)
    : [];
  return { schemaVersion: ROUTING_RULES_SCHEMA_VERSION, rules, corrections };
}

/** 读规则（容错：缺失/坏档 → 空规则 + 警告，绝不抛给调用方）。 */
export function readRoutingRules(uid: string): RoutingRulesDoc {
  if (!safeId(uid)) return emptyDoc();
  const file = routingRulesPath(uid);
  try {
    if (!fs.existsSync(file)) return emptyDoc();
    return normalizeDoc(readJsonSync<unknown>(file));
  } catch (error) {
    log.warn('routing rules unreadable; judging without user rules', {
      uid,
      error: String((error as Error)?.message || error),
    });
    return emptyDoc();
  }
}

function writeDoc(uid: string, doc: RoutingRulesDoc): void {
  writeTextAtomicSync(routingRulesPath(uid), JSON.stringify(doc, null, 2));
}

/** 记一条纠正 → 下次判定带上的样例（学习就发生在这里）。 */
export function learnFromCorrection(
  uid: string,
  input: { statement: string; fromHome?: ContentHome | null; toHome: ContentHome; note?: string },
): RoutingCorrection | null {
  if (!safeId(uid) || !isHome(input?.toHome)) return null;
  const statement = clip(input.statement, MAX_STATEMENT_CHARS);
  if (!statement) return null;
  const correction: RoutingCorrection = {
    statement,
    fromHome: isHome(input.fromHome) ? input.fromHome : null,
    toHome: input.toHome,
    ...(clip(input.note, MAX_NOTE_CHARS) ? { note: clip(input.note, MAX_NOTE_CHARS) } : {}),
    at: nowIso(),
  };
  const doc = readRoutingRules(uid);
  doc.corrections = [...doc.corrections, correction].slice(-MAX_CORRECTIONS);
  writeDoc(uid, doc);
  return correction;
}

/** 用户显式给出的一条归属规则（"以后这类都放 X"）。 */
export function addRoutingRule(
  uid: string,
  input: { home: ContentHome; note: string },
): RoutingRule | null {
  if (!safeId(uid) || !isHome(input?.home)) return null;
  const note = clip(input.note, MAX_NOTE_CHARS);
  if (!note) return null;
  const rule: RoutingRule = { id: genId12(), home: input.home, note, origin: 'user', createdAt: nowIso() };
  const doc = readRoutingRules(uid);
  doc.rules = [...doc.rules, rule].slice(-MAX_RULES);
  writeDoc(uid, doc);
  return rule;
}
