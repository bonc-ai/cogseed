/**
 * Structured child result contract.
 *
 * A delegated child ends its final reply with one host-only block:
 *
 * ```cogseed-result
 * {"status":"completed","summary":"...","files":["/abs/path"],"open_questions":[]}
 * ```
 *
 * The parent gets a validated object instead of parsing prose, and the block is
 * stripped from the visible result so it never leaks into a user-facing answer.
 * Invalid blocks degrade to the cleaned text plus an explicit error code — the
 * parent can decide; the host never guesses a status.
 */

import * as path from 'node:path';

const RESULT_BLOCK = /```cogseed-result[ \t]*\r?\n([\s\S]*?)```/gi;
const MAX_BLOCK_CHARS = 16_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_FILES = 20;
const MAX_QUESTIONS = 10;

export type CogSeedChildStatus = 'completed' | 'partial' | 'failed';

export interface CogSeedChildStructuredResult {
  status: CogSeedChildStatus;
  summary: string;
  files: string[];
  openQuestions: string[];
  nextStep?: string;
}

export interface ParsedChildResult {
  /** Final text with every result block removed. */
  text: string;
  structured?: CogSeedChildStructuredResult;
  error?: 'invalid_json' | 'invalid_shape' | 'too_large';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export function parseChildResult(raw: string): ParsedChildResult {
  const source = typeof raw === 'string' ? raw : '';
  const matches = [...source.matchAll(RESULT_BLOCK)];
  if (!matches.length) return { text: source.trim() };

  const body = (matches[matches.length - 1][1] || '').trim();
  // Strip every block, not only the last one: a malformed earlier block must
  // not survive into the parent's visible summary.
  const text = source.replace(RESULT_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length > MAX_BLOCK_CHARS) return { text, error: 'too_large' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { text, error: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text, error: 'invalid_shape' };
  }
  const record = parsed as Record<string, unknown>;
  const status = record.status;
  if (status !== 'completed' && status !== 'partial' && status !== 'failed') {
    return { text, error: 'invalid_shape' };
  }

  const files = [...new Set(strings(record.files).filter((file) => path.isAbsolute(file)))]
    .slice(0, MAX_FILES);
  const openQuestions = strings(record.open_questions)
    .map((question) => question.trim().slice(0, 500))
    .slice(0, MAX_QUESTIONS);
  const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, MAX_SUMMARY_CHARS) : '';
  const nextStep = typeof record.next_step === 'string' && record.next_step.trim()
    ? record.next_step.trim().slice(0, 500)
    : undefined;

  return {
    text,
    structured: {
      status,
      summary,
      files,
      openQuestions,
      ...(nextStep ? { nextStep } : {}),
    },
  };
}

/** The contract appended to every delegated child brief. */
export const CHILD_RESULT_CONTRACT = [
  '',
  '## Final result contract',
  'End your final reply with exactly one fenced block (and nothing after it):',
  '```cogseed-result',
  '{"status":"completed|partial|failed","summary":"<=600 chars","files":["absolute paths you wrote"],"open_questions":["..."]}',
  '```',
  'Use `partial` when work is incomplete but usable, `failed` when it is not. The block is for the host; do not repeat it elsewhere.',
].join('\n');
