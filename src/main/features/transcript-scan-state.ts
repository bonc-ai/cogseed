/** Short-lived host-owned scan snapshots. Apply and confirmation resume use
 * the exact candidates the user saw, never a fresh nondeterministic AI scan.
 * Keys bind user, conversation, document, text and scan options; no raw text
 * is retained. Expiry requires a fresh scan and fresh human decisions. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { userTranscriptInteractionDir } from '../paths';
import { readJsonSync, writeJsonSync, safeId } from '../storage';
import type { CorrectionCandidate } from './transcript_auto_correct';

export interface TranscriptScanState {
  candidates: CorrectionCandidate[];
  blocked: boolean;
  decisions: Map<string, boolean>;
  /** Human-supplied replacement text for accepted refs (「X 是 Y」). */
  rewrites?: Record<string, string>;
  /** Output files named at scan time; apply (including the host's replay
   * after confirmation) uses them when it is not given its own. */
  outputPath?: string;
  rawOutputPath?: string;
  confirmationToken?: string;
  /** Idempotency receipt: this exact source was already fully applied.
   * A repeated apply with no new human decision returns this receipt instead
   * of re-running the rules (which used to surface a second, smaller draft
   * with previously-decided high-risk items and looked like a regression). */
  appliedReceipt?: {
    at: number;
    textSha256: string;
    correctedPath?: string;
    rawPath?: string;
    appliedTotal: number;
    entries: Array<{ wrong: string; correct: string; count: number }>;
  };
  expiresAt: number;
}
const states = new Map<string, TranscriptScanState>();
const TTL_MS = 30 * 60_000;
function scanFile(key: string): string {
  const uid = JSON.parse(key)[0];
  if (!safeId(uid)) throw new Error('Invalid transcript scan owner');
  return path.join(userTranscriptInteractionDir(uid), `scan-${createHash('sha256').update(key).digest('hex')}.json`);
}
export function persistTranscriptScan(key: string, state: TranscriptScanState): void {
  states.set(key, state);
  writeJsonSync(scanFile(key), { key, ...state, decisions: [...state.decisions] });
}
export function transcriptScanKey(userId: string, cid: string | undefined, docId: string, text: string,
  input: Record<string, unknown>): string {
  return JSON.stringify([userId, cid ?? null, docId, createHash('sha256').update(text).digest('hex'),
    input.includeDelete === true, Array.isArray(input.scenarioTags) ? [...input.scenarioTags].sort() : []]);
}
export function readTranscriptScan(key: string): TranscriptScanState | undefined {
  let state = states.get(key);
  if (!state) {
    const saved = readJsonSync<any>(scanFile(key));
    if (saved?.key === key && Array.isArray(saved.candidates) && Array.isArray(saved.decisions)
      && saved.expiresAt > Date.now()) {
      state = { ...saved, decisions: new Map(saved.decisions) };
      states.set(key, state!);
    }
  }
  if (state && state.expiresAt <= Date.now()) { states.delete(key); return; }
  return state;
}
export function saveTranscriptScan(key: string, candidates: CorrectionCandidate[], blocked: boolean): TranscriptScanState {
  for (const [oldKey, value] of states) if (value.expiresAt <= Date.now()) states.delete(oldKey);
  if (states.size >= 64) states.delete(states.keys().next().value!);
  const state = { candidates, blocked, decisions: new Map<string, boolean>(), expiresAt: Date.now() + TTL_MS };
  persistTranscriptScan(key, state);
  return state;
}
export function deleteTranscriptScan(key: string): void {
  states.delete(key);
  writeJsonSync(scanFile(key), { key, expiresAt: 0 });
}
