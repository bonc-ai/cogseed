/**
 * Usage ledger — the fact-flow persistence for model usage events.
 *
 * Unlike `workspace_meta` (a derived cache that can be dropped and rebuilt),
 * usage records are facts: once a model call happens, its token accounting
 * cannot be reconstructed if lost. So the ledger is append-only monthly
 * jsonl under `<uid>/local/usage/`:
 *
 *   usage-YYYY-MM.jsonl   one ModelUsageEvent per line, append-only
 *   since.json            stats origin marker written with the first record
 *                         (the UI surfaces it as 「统计自 … 起」 — old
 *                         consumption is explicitly not back-computable)
 *
 * Writes are buffered in memory and flushed on: 50-record batch threshold,
 * 5 s idle timer, or an explicit `flushUsageLedger()` (used by tests and by
 * app shutdown). `since` only ever moves earlier, never later.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { userLocalRoot } from '../paths';
import type { ModelUsageEvent } from '../model/core-agent/usage-events';

const BATCH_THRESHOLD = 50;
const FLUSH_IDLE_MS = 5_000;

export function usageLedgerDir(uid: string): string {
  return path.join(userLocalRoot(uid), 'usage');
}

function monthFileFor(uid: string, monthKey: string): string {
  return path.join(usageLedgerDir(uid), `usage-${monthKey}.jsonl`);
}

function sinceFileFor(uid: string): string {
  return path.join(usageLedgerDir(uid), 'since.json');
}

function monthKeyOf(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 7);
}

const buffers = new Map<string, ModelUsageEvent[]>();
const inflight = new Set<Promise<void>>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function trackInflight(p: Promise<void>): Promise<void> {
  inflight.add(p);
  void p.finally(() => inflight.delete(p)).catch(() => undefined);
  return p;
}

function bufferKey(uid: string, event: ModelUsageEvent): string {
  return `${uid}|${monthKeyOf(event.at)}`;
}

function disarmIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer(): void {
  disarmIdleTimer();
  idleTimer = setTimeout(() => {
    void flushUsageLedger();
  }, FLUSH_IDLE_MS);
}

function ensureSinceMarker(uid: string, atMs: number): void {
  try {
    const file = sinceFileFor(uid);
    const iso = new Date(atMs).toISOString();
    let existing: { since?: unknown } | undefined;
    if (fs.existsSync(file)) {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) as { since?: unknown };
    }
    if (existing && typeof existing.since === 'string') {
      // The origin may only move earlier — a late-arriving older record
      // extends history, a newer record never shifts it forward.
      if (Date.parse(existing.since) <= atMs) return;
    }
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ since: iso })}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // The ledger must never break the model call path it accounts for.
  }
}

export function appendUsageEvent(uid: string, event: ModelUsageEvent): void {
  const key = bufferKey(uid, event);
  const bucket = buffers.get(key) || [];
  bucket.push(event);
  buffers.set(key, bucket);
  ensureSinceMarker(uid, event.at);
  if (bucket.length >= BATCH_THRESHOLD) {
    void trackInflight(flushKey(key));
  } else {
    armIdleTimer();
  }
}

async function flushKey(key: string): Promise<void> {
  const bucket = buffers.get(key);
  if (!bucket || bucket.length === 0) return;
  buffers.set(key, []);
  const [uid, monthKey] = key.split('|');
  const file = monthFileFor(uid, monthKey);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${bucket.map((e) => JSON.stringify(e)).join('\n')}\n`);
  } catch {
    // On write failure put the records back so a later flush retries them.
    const retry = buffers.get(key) || [];
    buffers.set(key, [...bucket, ...retry]);
  }
}

export async function flushUsageLedger(): Promise<void> {
  disarmIdleTimer();
  await Promise.all([
    ...[...buffers.keys()].map((key) => trackInflight(flushKey(key))),
    ...inflight,
  ]);
}

export function usageStatsSince(uid: string): string | undefined {
  try {
    const file = sinceFileFor(uid);
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { since?: unknown };
    return typeof parsed.since === 'string' ? parsed.since : undefined;
  } catch {
    return undefined;
  }
}

export async function readUsageEvents(uid: string, fromMs: number, toMs: number): Promise<ModelUsageEvent[]> {
  const dir = usageLedgerDir(uid);
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => /^usage-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const fromMonth = monthKeyOf(fromMs);
  const toMonth = monthKeyOf(toMs);
  const out: ModelUsageEvent[] = [];
  for (const file of files) {
    const monthKey = file.replace(/^usage-/, '').replace(/\.jsonl$/, '');
    if (monthKey < fromMonth || monthKey > toMonth) continue;
    const text = await fsp.readFile(path.join(dir, file), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ModelUsageEvent;
        if (typeof parsed.at === 'number' && parsed.at >= fromMs && parsed.at <= toMs) {
          out.push(parsed);
        }
      } catch {
        // Skip malformed lines rather than failing the whole read.
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** Test hook: drop in-memory buffers and timers without touching disk. */
export function resetUsageLedgerForTests(): void {
  disarmIdleTimer();
  buffers.clear();
}
