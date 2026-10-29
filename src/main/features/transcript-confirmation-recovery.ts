/** Recover pre-persistence confirmation snapshots from this actor's own host
 * tool receipts. Accept only a complete, hash-bound legacy scan with exact
 * source offsets and unambiguous candidate refs. Never rescan or manufacture
 * approval; the human ingress still resolves the recovered choices. */
import { createHash } from 'node:crypto';
import { readNativeRuntimeSession } from './cogseed_runtime/kernel/session-store';
import { readCogSeedTask } from './cogseed_backend/task-store';
import { createGlossaryConfirmation, hasScopedGlossaryConfirmation, type GlossaryConfirmItem } from './transcript-confirmation';
import { persistTranscriptScan, transcriptScanKey } from './transcript-scan-state';
import type { CorrectionCandidate } from './transcript_auto_correct';

export function recoverLegacyScanCandidates(text: string, receipt: string, items: GlossaryConfirmItem[]): CorrectionCandidate[] | undefined {
  const expected = /^Candidates: (\d+) /m.exec(receipt);
  if (!expected || /allow=\[/.test(receipt)) return;
  const rows = [...receipt.matchAll(/^- 「([^」]+)」→「([^」]*)」 @(\d+) \(risk=(low|medium|high) via=(model|glossary)(?: ignored=\d+)?\) 语境: (.*)$/gm)];
  if (!rows.length || rows.length !== Number(expected[1])) return;
  const usedModel = new Set<string>();
  const result: CorrectionCandidate[] = [];
  for (const row of rows) {
    const [, wrong, correct, offset, riskLevel, via, context] = row;
    const start = Number(offset);
    if (text.slice(start, start + wrong.length) !== wrong) return;
    let matches = items.filter(item => !!item.fromModel === (via === 'model') && item.correct === correct
      && item.action === 'replace' && (via !== 'model' || !usedModel.has(item.entryRef)));
    const exact = matches.filter(item => item.wrong === wrong);
    if (exact.length) matches = exact;
    // Model rows have per-occurrence refs in scan order. Glossary aliases may
    // share a grouped ref, but never guess between different target entries.
    if (!matches.length || (via !== 'model' && matches.length !== 1)) return;
    const item = matches[0];
    if (via === 'model') usedModel.add(item.entryRef);
    result.push({ entryRef: item.entryRef, wrong, correct, action: 'replace', confidence: 1,
      riskLevel: riskLevel as CorrectionCandidate['riskLevel'], context,
      span: { start, end: start + wrong.length }, ignoredCount: item.ignoredCount, contextAllow: [],
      ...(via === 'model' ? { fromModel: true, channel: 'model' as const } : { channel: 'recall' as const, disposition: 'review' as const }) });
  }
  if (items.some(item => !result.some(candidate => candidate.entryRef === item.entryRef))) return;
  return result;
}

export async function restoreLegacyGlossaryConfirmation(userId: string, cid: string, agentId: string, taskId: string): Promise<void> {
  if (hasScopedGlossaryConfirmation(userId, cid, agentId, taskId)) return;
  const task = await readCogSeedTask(userId, taskId);
  if (!task || task.conversationId !== cid || task.agentId !== agentId
    || !['waiting_user', 'recoverable'].includes(task.status)) return;
  const history = await readNativeRuntimeSession(userId, task.runtimeSessionId).catch(() => null);
  if (!history) return;
  const scans = new Map<string, Extract<typeof history.records[number], { type: 'turn' }>>();
  for (const row of history.records) {
    if (row.type !== 'turn' || !row.tool || row.tool.result.isError) continue;
    const evidence = row.tool.result.correction;
    if (!evidence) continue;
    const key = JSON.stringify([evidence.docId, evidence.sourceHash]);
    if (row.tool.name === 'transcript_glossary_scan' && evidence.state === 'needs_confirmation') scans.set(key, row);
    if (evidence.state === 'applied' || evidence.state === 'blocked') scans.delete(key);
  }
  if (scans.size !== 1) return;
  const row = [...scans.values()][0];
  if (Date.now() - new Date(row.created_at).getTime() > 30 * 60_000) return;
  const tool = row.tool!;
  const evidence = tool.result.correction!;
  const text = typeof tool.input.text === 'string' ? tool.input.text.trim() : '';
  if (!text || createHash('sha256').update(text).digest('hex') !== evidence.sourceHash) return;
  const items = evidence.confirmationItems || [];
  if (!Array.isArray(items) || !items.length || items.some(item => !item || typeof item.entryRef !== 'string'
    || typeof item.wrong !== 'string' || typeof item.correct !== 'string' || item.action !== 'replace'
    || !['low', 'medium', 'high'].includes(item.riskLevel))) return;
  const candidates = recoverLegacyScanCandidates(text, tool.result.content, items);
  if (!candidates) return;
  const card = await createGlossaryConfirmation({ userId, cid, agentId, taskId, text, docId: evidence.docId, items });
  persistTranscriptScan(transcriptScanKey(userId, cid, evidence.docId, text, tool.input), {
    candidates, blocked: false, decisions: new Map(), confirmationToken: card.token,
    expiresAt: new Date(row.created_at).getTime() + 30 * 60_000,
  });
}
