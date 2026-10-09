/**
 * P3394 outbound session store — keeps one stable session_id per
 * (scope, peer) so multi-turn collaboration with the same peer keeps the
 * SAME P3394 session (guide §5.2: session spans multiple turns/tasks).
 *
 * Scope semantics: a conversation path call scopes by conversation id
 * ("this conversation's collaboration with hermes"), the host-tool path
 * scopes by user id. Sessions persist to disk (atomic tmp+rename) so they
 * survive restarts.
 */
import { p3394StateFile } from './runtime-paths';
import { genId12, readJsonSync, writeJsonSync } from '../../storage';

const SCHEMA_VERSION = 1 as const;

interface P3394SessionFile {
  schema_version: number;
  /** 绑定键 → session_id。键形态：`scope\u0000peer`（默认）或
   *  `scope\u0000peer\u0000goal`（Goal 隔离会话，指南 §5.3）。 */
  sessions: Record<string, string>;
  /** session_id → 最近使用时间。 */
  updated: Record<string, string>;
}

function sessionFile(): string {
  return p3394StateFile('p3394-sessions.json');
}

function load(): P3394SessionFile {
  const raw = readJsonSync<Partial<P3394SessionFile>>(sessionFile());
  if (raw && raw.schema_version === SCHEMA_VERSION && raw.sessions && typeof raw.sessions === 'object') {
    return {
      schema_version: SCHEMA_VERSION,
      sessions: raw.sessions as Record<string, string>,
      updated: raw.updated && typeof raw.updated === 'object' ? raw.updated as Record<string, string> : {},
    };
  }
  return { schema_version: SCHEMA_VERSION, sessions: {}, updated: {} };
}

function persist(file: P3394SessionFile): void {
  writeJsonSync(sessionFile(), { ...file, saved_at: new Date().toISOString() });
}

/** Goal 归一化：去首尾空白、压缩内部空白、截断。 */
export function normalizeGoal(goal: string): string {
  return String(goal || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function keyFor(scopeKey: string, peer: string): string {
  return (scopeKey || 'global') + '\u0000' + peer;
}

/**
 * Returns the stable session id for (scope, peer), allocating + persisting
 * one on first use. Safe for concurrent callers (single-threaded event loop;
 * read-modify-write within one tick is atomic enough for this use).
 */
export function sessionFor(scopeKey: string, peer: string): string {
  const file = load();
  const key = keyFor(scopeKey, peer);
  const existing = file.sessions[key];
  if (existing) {
    file.updated[existing] = new Date().toISOString();
    persist(file);
    return existing;
  }
  const fresh = 'ses-' + genId12();
  file.sessions[key] = fresh;
  file.updated[fresh] = new Date().toISOString();
  persist(file);
  return fresh;
}

/** Goal 自动隔离（指南 §5.3 规则 4/5）：同一 (scope, peer) 下相同 Goal
 *  复用同一 P3394 会话，不同 Goal 开新会话；无 Goal 走默认会话。
 *  Goal 编入绑定键，默认会话与各 Goal 会话互不覆盖。 */
export function sessionForGoal(scopeKey: string, peer: string, goal?: string): string {
  const normalized = normalizeGoal(goal || '');
  if (!normalized) return sessionFor(scopeKey, peer);
  const file = load();
  const key = keyFor(scopeKey, peer) + '\u0000' + normalized;
  const existing = file.sessions[key];
  if (existing) {
    file.updated[existing] = new Date().toISOString();
    persist(file);
    return existing;
  }
  const fresh = 'ses-' + genId12();
  file.sessions[key] = fresh;
  file.updated[fresh] = new Date().toISOString();
  persist(file);
  return fresh;
}

/** 供 p3394_sessions 工具展示：某 scope 下的全部 P3394 会话（session / peer / goal / 最近使用）。 */
export function listSessions(scopeKey: string): Array<{ session_id: string; peer: string; goal: string; updated_at: string }> {
  const file = load();
  const prefix = (scopeKey || 'global') + '\u0000';
  const out: Array<{ session_id: string; peer: string; goal: string; updated_at: string }> = [];
  for (const [key, sessionId] of Object.entries(file.sessions)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const separator = rest.indexOf('\u0000');
    out.push({
      session_id: sessionId,
      peer: separator >= 0 ? rest.slice(0, separator) : rest,
      goal: separator >= 0 ? rest.slice(separator + 1) : '',
      updated_at: file.updated[sessionId] || '',
    });
  }
  return out;
}

/** Test/diagnostic helper — clears one binding. */
export function clearSessionForTest(scopeKey: string, peer: string): void {
  const file = load();
  delete file.sessions[keyFor(scopeKey, peer)];
  persist(file);
}
