/**
 * OpenCode task (todo) list + import.
 *
 * OpenCode has NO scheduled-task feature — its `todo` table is an in-session
 * task checklist (content / status / priority), not a recurring scheduler.
 * This module lists those real todos and imports them as ONE-TIME tasks in
 * the in-app auto-task module (ScheduleOneTime), honestly labeled: there is
 * no cadence in the source, so nothing is invented.
 *
 * ## Hard boundaries
 *
 *   1. READ-ONLY on OpenCode's DB (`~/.local/share/opencode/opencode.db`).
 *   2. Fixed path only.
 *   3. Schema-tolerant: missing table → empty list.
 *   4. Never fabricates a schedule; every imported task is `one_time` with
 *      an explicit "imported from OpenCode todo" default run time the user
 *      can edit afterwards in the task module.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { createLogger } from '../../logger';

const log = createLogger('opencode-tasks');

export interface OpencodeTodo {
  id: string;
  content: string;
  status: string;
  priority: string;
  sessionTitle: string;
  timeCreated: number;
  timeUpdated: number;
}

function opencodeDbPath(home = os.homedir()): string {
  return path.join(home, '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * List OpenCode todos (READ-ONLY). `todo` rows without a resolvable session
 * still appear with an empty session title. Missing DB/table → [].
 */
export async function listOpencodeTodos(home = os.homedir()): Promise<OpencodeTodo[]> {
  const dbPath = opencodeDbPath(home);
  if (!fs.existsSync(dbPath)) return [];

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='todo'`)
      .get() as { name: string } | undefined;
    if (!tbl) return [];

    const rows = db
      .prepare(
        `SELECT t.rowid AS id, t.content, t.status, t.priority, t.time_created, t.time_updated, s.title AS session_title
           FROM todo t
           LEFT JOIN session s ON s.id = t.session_id
          ORDER BY t.time_updated DESC`,
      )
      .all() as Array<{
        id: number;
        content: string;
        status: string;
        priority: string;
        time_created: number;
        time_updated: number;
        session_title: string | null;
      }>;

    return rows.map((r) => ({
      id: String(r.id),
      content: (r.content || '').trim(),
      status: (r.status || '').trim(),
      priority: (r.priority || '').trim(),
      sessionTitle: (r.session_title || '').trim(),
      timeCreated: r.time_created || 0,
      timeUpdated: r.time_updated || 0,
    }));
  } catch (err) {
    log.warn('failed to read opencode todos', { error: (err as Error).message });
    return [];
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

export interface OpencodeTodoImportResult {
  imported: number;
  skipped: number;
  failed: number;
  items: Array<{ id: string; content: string; status: 'imported' | 'skipped' | 'failed'; reason?: string }>;
}

/**
 * Import selected OpenCode todos as one-time tasks in the auto-task module.
 * `todoIds` defaults to ALL todos when omitted. Idempotent per (title,
 * content) pair. There is no cadence in OpenCode's todo, so every task is
 * created as `one_time` scheduled for ~1 hour from now — the user edits the
 * time in the task module afterwards. Never fabricates a recurring schedule.
 */
export async function importOpencodeTodos(
  userId: string,
  todoIds?: string[],
  home = os.homedir(),
): Promise<OpencodeTodoImportResult> {
  const result: OpencodeTodoImportResult = { imported: 0, skipped: 0, failed: 0, items: [] };
  const all = await listOpencodeTodos(home);
  const selected = todoIds && todoIds.length ? all.filter((t) => todoIds.includes(t.id)) : all;
  if (!selected.length) return result;

  const { createTask, listTasks } = await import('../auto_tasks');
  const existing = await listTasks(userId);
  const existingByContent = new Set(existing.map((t) => `${t.title || ''}\u0000${t.content}`));

  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  for (const t of selected) {
    if (!t.content) continue;
    const title = t.content.length > 40 ? `${t.content.slice(0, 40)}…` : t.content;
    if (existingByContent.has(`${title}\u0000${t.content}`)) {
      result.skipped += 1;
      result.items.push({ id: t.id, content: t.content, status: 'skipped', reason: '已存在相同任务' });
      continue;
    }
    try {
      const out = await createTask(userId, {
        schedule: { type: 'one_time', at: runAt },
        content: t.content,
        title,
        enabled: t.status !== 'completed',
      });
      if (out.ok) {
        result.imported += 1;
        result.items.push({ id: t.id, content: t.content, status: 'imported' });
      } else {
        result.failed += 1;
        const reason = (out as { ok: false; error: string }).error;
        result.items.push({ id: t.id, content: t.content, status: 'failed', reason });
      }
    } catch (err) {
      result.failed += 1;
      result.items.push({ id: t.id, content: t.content, status: 'failed', reason: (err as Error).message });
    }
  }

  log.info('opencode todos import done', { selected: selected.length, imported: result.imported, skipped: result.skipped, failed: result.failed });
  return result;
}
