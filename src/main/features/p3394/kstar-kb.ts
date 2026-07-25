import * as path from 'node:path';

import { writeContextFileForUser } from '../contexts';
import {
  getExperienceCandidate,
  getKStarRun,
  markExperienceCandidateKnowledgePromotion,
  type ExperienceCandidate,
  type KStarRun,
} from './kstar-runtime';

function mdEscape(value: unknown): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function truncate(value: unknown, max = 4000): string {
  const text = mdEscape(value);
  return text.length > max ? `${text.slice(0, max)}\n\n…[truncated]` : text;
}

function yearMonthFromIso(iso: string | undefined): { year: string; month: string } {
  const d = iso ? new Date(iso) : new Date();
  const ok = Number.isFinite(d.getTime()) ? d : new Date();
  return { year: String(ok.getUTCFullYear()), month: String(ok.getUTCMonth() + 1).padStart(2, '0') };
}

function buildKnowledgePath(candidate: ExperienceCandidate): string {
  const { year, month } = yearMonthFromIso(candidate.updated_at || candidate.created_at);
  return path.posix.join('kstar-experiences', year, month, `${candidate.id}.md`);
}

function summarizeEngine(run: KStarRun): string {
  const engine = run.kstar_engine;
  if (!engine) return '- Engine: not run yet';
  const lines = [
    `- Engine status: ${engine.status}`,
    engine.reason ? `- Engine note: ${engine.reason}` : '',
    engine.patch_status ? `- Patch status: ${engine.patch_status}` : '',
  ].filter(Boolean);
  const route = engine.route_recommendation;
  if (route && typeof route === 'object') {
    const action = (route as Record<string, unknown>).action;
    const message = (route as Record<string, unknown>).message;
    if (action) lines.push(`- Route action: ${String(action)}`);
    if (message) lines.push(`- Route message: ${String(message)}`);
  }
  return lines.join('\n');
}

export function buildKStarExperienceKnowledgeMarkdown(candidate: ExperienceCandidate, run: KStarRun): string {
  const episode = run.kstar_episode;
  const verification = run.verification;
  return [
    `# KSTAR Experience: ${candidate.id}`,
    '',
    '## Summary',
    truncate(candidate.summary, 1200) || 'No summary recorded.',
    '',
    '## Source',
    `- Conversation: ${run.conversation_id}`,
    `- Agent: ${run.agent_id}`,
    `- KSTAR run: ${run.id}`,
    `- Experience candidate: ${candidate.id}`,
    `- Review status: ${run.status}`,
    verification ? `- Human verification: ${verification.status}${verification.notes ? ` — ${verification.notes}` : ''}` : '- Human verification: not recorded',
    '',
    '## Situation',
    truncate(episode?.situation || run.kstar_decision?.expectation?.situation || ''),
    '',
    '## Task',
    truncate(episode?.task || run.kstar_decision?.expectation?.task || ''),
    '',
    '## Expected Action',
    truncate(episode?.action_hat || run.kstar_decision?.expectation?.action_hat || ''),
    '',
    '## Expected Result',
    truncate(episode?.result_hat || run.kstar_decision?.expectation?.result_hat || ''),
    '',
    '## Actual Action',
    truncate(episode?.actual_action || ''),
    '',
    '## Actual Result',
    truncate(run.actual_result),
    '',
    '## Engine Analysis',
    summarizeEngine(run),
    '',
    '## Reuse Guidance',
    '- Reuse this only for tasks with a similar situation and deliverable type.',
    '- Treat this as user-approved experience, not as a universal policy.',
    '- For durable deliverables, keep using KSTAR Review Gate before final delivery.',
    '',
  ].join('\n');
}

export async function promoteExperienceCandidateToKnowledgeBase(
  uid: string,
  candidateId: string,
): Promise<{ ok: true; candidate: ExperienceCandidate; path: string } | { ok: false; error: string }> {
  const candidate = await getExperienceCandidate(uid, candidateId);
  if (!candidate) return { ok: false, error: 'experience candidate not found' };
  if (candidate.status !== 'approved') return { ok: false, error: `experience candidate must be approved before KB promotion (current: ${candidate.status})` };
  if (candidate.kb_path && candidate.promotion_status === 'promoted') {
    return { ok: true, candidate, path: candidate.kb_path };
  }
  const run = await getKStarRun(uid, candidate.source_run_id);
  if (!run) return { ok: false, error: 'source KSTAR run not found' };
  const relPath = buildKnowledgePath(candidate);
  const content = buildKStarExperienceKnowledgeMarkdown(candidate, run);
  const write = writeContextFileForUser(uid, relPath, content);
  if (!write.ok) {
    const error = 'error' in write ? write.error : 'failed to write KB context file';
    await markExperienceCandidateKnowledgePromotion(uid, candidate.id, {
      status: 'failed',
      error,
    });
    return { ok: false, error };
  }
  const updated = await markExperienceCandidateKnowledgePromotion(uid, candidate.id, {
    status: 'promoted',
    path: relPath,
  });
  return { ok: true, candidate: updated, path: relPath };
}
