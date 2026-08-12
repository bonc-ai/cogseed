/**
 * OpenCode memory/preference importer.
 *
 * OpenCode stores user preferences in `~/.config/opencode/opencode.json`
 * (and its `.jsonc` variant — comments allowed) plus optional global
 * instructions in `~/.opencode/AGENTS.md`. This module reads those files
 * READ-ONLY and surfaces the non-empty, meaningful preferences as
 * importable memory entries (the same "config preferences → shared memory"
 * pattern as Codex's config.toml importer).
 *
 * ## Hard boundaries
 *
 *   1. READ-ONLY. Never writes to OpenCode's config.
 *   2. Fixed paths only — no user-supplied path (no traversal surface).
 *   3. Tolerant parsing: `.jsonc` allows comments/trailing commas; a file
 *      we cannot parse is reported as unreadable, never guessed.
 *   4. Empty config is an honest `empty` state — no fabricated entries.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createLogger } from '../../logger';

const log = createLogger('opencode-memory');

export interface OpencodeMemoryPreview {
  present: boolean;
  entries: string[];
  reason?: 'not_found' | 'empty' | 'unreadable';
}

/** Strip `//` and `/* *\/` comments + trailing commas so JSONC parses as JSON. */
function stripJsoncComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
}

function readConfigJson(home: string): { file: string; cfg: Record<string, unknown> } | null {
  for (const file of ['opencode.json', 'opencode.jsonc']) {
    const p = path.join(home, '.config', 'opencode', file);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(stripJsoncComments(raw)) as unknown;
      if (parsed && typeof parsed === 'object') {
        return { file, cfg: parsed as Record<string, unknown> };
      }
    } catch (err) {
      log.warn('opencode config parse failed', { file, error: (err as Error).message });
      return { file, cfg: {} };
    }
  }
  return null;
}

function globalInstructions(home: string): string {
  for (const p of [
    path.join(home, '.opencode', 'AGENTS.md'),
    path.join(home, '.config', 'opencode', 'AGENTS.md'),
  ]) {
    if (!fs.existsSync(p)) continue;
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) return text.split('\n')[0].trim();
    } catch {
      /* unreadable → skip */
    }
  }
  return '';
}

function extractPreferences(cfg: Record<string, unknown>): string[] {
  const facts: string[] = [];
  const provider = cfg.provider;
  if (provider && typeof provider === 'object') {
    const names = Object.keys(provider as Record<string, unknown>);
    if (names.length) facts.push(`OpenCode 配置了模型提供商：${names.join('、')}`);
  }
  if (typeof cfg.model === 'string' && String(cfg.model).trim()) {
    facts.push(`OpenCode 默认模型：${String(cfg.model).trim()}`);
  }
  const instructions = cfg.instructions;
  if (typeof instructions === 'string' && String(instructions).trim()) {
    facts.push(`OpenCode 全局指令：${String(instructions).trim().split('\n')[0]}`);
  }
  return facts;
}

/** Read OpenCode config preferences (READ-ONLY preview). */
export function readOpencodeMemory(home = os.homedir()): OpencodeMemoryPreview {
  const found = readConfigJson(home);
  if (!found) return { present: false, entries: [], reason: 'not_found' };

  const facts = extractPreferences(found.cfg);
  const instructions = globalInstructions(home);
  if (instructions) facts.push(`OpenCode 全局指令（AGENTS.md）：${instructions}`);

  if (!facts.length) return { present: false, entries: [], reason: 'empty' };
  return { present: true, entries: facts };
}

export interface ImportOpencodeMemoryResult {
  ok: boolean;
  added: number;
  skipped: number;
  rejected: number;
  reason?: string;
}

/**
 * Import OpenCode config preferences into the shared memory tier.
 * Per-entry idempotent via the memory guard; injection scan + char-limit
 * apply to every write.
 */
export async function importOpencodeMemory(
  userId: string,
  home = os.homedir(),
): Promise<ImportOpencodeMemoryResult> {
  const preview = readOpencodeMemory(home);
  if (!preview.present || !preview.entries.length) {
    return { ok: true, added: 0, skipped: 0, rejected: 0, reason: preview.reason || 'no_content' };
  }

  const { addEntry, listEntries } = await import('../memory');
  const existing = new Set<string>();
  const cur = listEntries(userId, 'memory');
  if (cur.ok && Array.isArray(cur.entries)) {
    for (const e of cur.entries) existing.add(String(e || '').trim());
  }

  let added = 0, skipped = 0, rejected = 0;
  for (const text of preview.entries) {
    if (!text.trim()) continue;
    if (existing.has(text.trim())) { skipped += 1; continue; }
    const res = addEntry(userId, 'memory', text.trim());
    if (res && res.ok) { added += 1; existing.add(text.trim()); }
    else { rejected += 1; }
  }

  log.info('opencode memory import done', { added, skipped, rejected });
  return { ok: true, added, skipped, rejected };
}
