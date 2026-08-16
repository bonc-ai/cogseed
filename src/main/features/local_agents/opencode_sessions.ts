/**
 * OpenCode session scanner.
 *
 * Reads OpenCode's local session database (~/.local/share/opencode/opencode.db)
 * READ-ONLY and returns a list of sessions with metadata for import preview.
 *
 * ## Hard boundaries
 *
 *   1. READ-ONLY. Opened with `readonly:true` + `fileMustExist:true`.
 *   2. Fixed path only: `~/.local/share/opencode/opencode.db`
 *   3. Schema-tolerant: validates table/column existence
 *   4. No silent bulk import: returns preview only
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { createLogger } from '../../logger';

const log = createLogger('opencode-sessions');

export interface OpencodeSession {
  /** Session ID (e.g., ses_02af5cf97ffeuSBiLKL2l0RPmm) */
  id: string;
  /** Session title */
  title: string;
  /** Project ID this session belongs to */
  projectId: string | null;
  /** Workspace ID */
  workspaceId: string | null;
  /** Message count in this session */
  messageCount: number;
  /** Created timestamp (ms) */
  timeCreated: number;
  /** Last updated timestamp (ms) */
  timeUpdated: number;
  /** Model info */
  model: {
    providerID: string;
    modelID: string;
    variant?: string;
  } | null;
  /** Total cost */
  cost: number;
  /** Token stats */
  tokens: {
    input: number;
    output: number;
    reasoning: number;
  };
}

export interface OpencodeSessionScanResult {
  sessions: OpencodeSession[];
  totalCount: number;
}

export interface OpencodeProbe {
  available: boolean;
  reason?: 'not_installed' | 'unreadable' | 'bad_schema';
  dbPath: string;
}

/** Fixed OpenCode DB path */
export function opencodeDbPath(home = os.homedir()): string {
  return path.join(home, '.local', 'share', 'opencode', 'opencode.db');
}

/** Probe OpenCode database existence and readability */
export function probeOpencode(home = os.homedir()): OpencodeProbe {
  const dbPath = opencodeDbPath(home);
  try {
    fs.accessSync(dbPath, fs.constants.R_OK);
  } catch {
    return { available: false, reason: 'not_installed', dbPath };
  }
  return { available: true, dbPath };
}

/**
 * Read OpenCode sessions from ~/.local/share/opencode/opencode.db
 * Returns sessions sorted by most recent first.
 */
export function listOpencodeSessions(
  home = os.homedir(),
  limit = 100,
): OpencodeSessionScanResult | { error: string } {
  const probe = probeOpencode(home);
  if (!probe.available) {
    return { error: probe.reason || 'not_installed' };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(probe.dbPath, { readonly: true, fileMustExist: true });

    // Schema tolerance: verify session table + required columns
    const cols = db.prepare(`PRAGMA table_info(session)`).all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    const required = ['id', 'title', 'time_created', 'time_updated'];
    if (!required.every((c) => colNames.has(c))) {
      log.warn('opencode schema mismatch', { have: [...colNames] });
      return { error: 'bad_schema' };
    }

    // Check message table exists
    const messageCols = db.prepare(`PRAGMA table_info(message)`).all() as Array<{ name: string }>;
    if (messageCols.length === 0) {
      return { error: 'bad_schema' };
    }

    // Read sessions with message counts
    const rows = db.prepare(`
      SELECT
        s.id,
        s.title,
        s.project_id,
        s.workspace_id,
        s.time_created,
        s.time_updated,
        s.model,
        s.cost,
        s.tokens_input,
        s.tokens_output,
        s.tokens_reasoning,
        COUNT(m.id) as message_count
      FROM session s
      LEFT JOIN message m ON m.session_id = s.id
      WHERE s.time_archived IS NULL OR s.time_archived = 0
      GROUP BY s.id
      ORDER BY s.time_updated DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string;
      title: string;
      project_id: string | null;
      workspace_id: string | null;
      time_created: number;
      time_updated: number;
      model: string | null;
      cost: number;
      tokens_input: number;
      tokens_output: number;
      tokens_reasoning: number;
      message_count: number;
    }>;

    const sessions: OpencodeSession[] = rows.map((r) => {
      let modelParsed: OpencodeSession['model'] = null;
      if (r.model) {
        try {
          modelParsed = JSON.parse(r.model);
        } catch {
          // ignore invalid JSON
        }
      }

      return {
        id: r.id,
        title: r.title || r.id,
        projectId: r.project_id,
        workspaceId: r.workspace_id,
        messageCount: r.message_count,
        timeCreated: r.time_created,
        timeUpdated: r.time_updated,
        model: modelParsed,
        cost: r.cost || 0,
        tokens: {
          input: r.tokens_input || 0,
          output: r.tokens_output || 0,
          reasoning: r.tokens_reasoning || 0,
        },
      };
    });

    const totalCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM session
      WHERE time_archived IS NULL OR time_archived = 0
    `).get() as { count: number }).count;

    return { sessions, totalCount };
  } catch (err) {
    log.warn('opencode read failed', { error: (err as Error).message });
    return { error: 'unreadable' };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

/**
 * Read full message history for a specific OpenCode session.
 * Returns messages in chronological order.
 */
export function readOpencodeSessionMessages(
  sessionId: string,
  home = os.homedir(),
): Array<{ id: string; time: number; data: unknown }> | { error: string } {
  const probe = probeOpencode(home);
  if (!probe.available) {
    return { error: probe.reason || 'not_installed' };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(probe.dbPath, { readonly: true, fileMustExist: true });

    const rows = db.prepare(`
      SELECT id, time_created, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC
    `).all(sessionId) as Array<{
      id: string;
      time_created: number;
      data: string;
    }>;

    return rows.map((r) => {
      let dataParsed: unknown = null;
      try {
        dataParsed = JSON.parse(r.data);
      } catch {
        dataParsed = r.data;
      }
      return {
        id: r.id,
        time: r.time_created,
        data: dataParsed,
      };
    });
  } catch (err) {
    log.warn('opencode message read failed', { error: (err as Error).message });
    return { error: 'unreadable' };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

/**
 * Read OpenCode message parts for a session (the `part` table). Returns
 * human text / reasoning parts keyed by the owning message's role. Used by
 * the session importer to distill a summary from real user prose — the
 * message.data blob does NOT carry the text (only role/model/summary).
 */
export function readOpencodeSessionParts(
  sessionId: string,
  home = os.homedir(),
): Array<{ messageId: string; role: string; type: string; text: string }> | { error: string } {
  const probe = probeOpencode(home);
  if (!probe.available) {
    return { error: probe.reason || 'not_installed' };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(probe.dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT p.message_id, m.data AS message_data, p.data AS part_data
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE p.session_id = ?
      ORDER BY p.time_created ASC
    `).all(sessionId) as Array<{
      message_id: string;
      message_data: string;
      part_data: string;
    }>;

    const out: Array<{ messageId: string; role: string; type: string; text: string }> = [];
    for (const row of rows) {
      let role = '';
      try {
        const md = JSON.parse(row.message_data);
        role = typeof md.role === 'string' ? md.role : '';
      } catch { /* keep '' */ }
      let type = '';
      let text = '';
      try {
        const pd = JSON.parse(row.part_data);
        type = typeof pd.type === 'string' ? pd.type : '';
        if (type === 'text' && typeof pd.text === 'string') text = pd.text;
      } catch { /* skip unparseable part */ }
      if (type === 'text' && text) {
        out.push({ messageId: row.message_id, role, type, text });
      }
    }
    return out;
  } catch (err) {
    log.warn('opencode part read failed', { error: (err as Error).message });
    return { error: 'unreadable' };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}
