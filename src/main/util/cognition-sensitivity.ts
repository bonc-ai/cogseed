/** L3 cognition persistence gate. Credentials must never become candidates or assets. */

import { createLogger } from '../logger';

const log = createLogger('cognition-sensitivity');

export type CognitionSensitivityLevel = 'L3' | 'unclassified';

export interface CognitionSensitivityVerdict {
  level: CognitionSensitivityLevel;
  reason?: string;
}

const CREDENTIAL_FIELD = '(?:api_?key|access_?token|refresh_?token|id_?token|session_?id|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie)';
const CREDENTIAL_ASSIGNMENT_RE = new RegExp(
  // A redaction placeholder is not a credential. A placeholder followed by
  // more value characters (e.g. `[REDACTED]bc123`) is a leaked suffix and must
  // still match, so the lookahead requires the placeholder to end the value.
  `\\b${CREDENTIAL_FIELD}\\b["']?\\s*[:=]\\s*["']?(?!\\[(?:REDACTED|受限值)\\](?=$|[\\s"',;}\\]]))[^\\s"',;]+`,
  'i',
);
const PEM_BLOCK_RE = /-----BEGIN[A-Z ]*(PRIVATE KEY|RSA PRIVATE KEY|OPENSSH PRIVATE KEY|CERTIFICATE)-----/i;
const KNOWN_TOKEN_PREFIX_RE = new RegExp([
  'AKIA[0-9A-Z]{12,}',
  'ASIA[0-9A-Z]{12,}',
  'AKID[0-9A-Za-z]{12,}',
  'LTAI[0-9A-Za-z]{12,}',
  'gh[pousr]_[0-9A-Za-z]{16,}',
  'github_pat_[0-9A-Za-z_]{16,}',
  'glpat-[0-9A-Za-z_-]{16,}',
  'gl(?:dt|rt|cbt|ptt)-[0-9A-Za-z_-]{16,}',
  'GR1348941[0-9A-Za-z_-]{16,}',
  'xox[baprs]-[0-9A-Za-z-]{10,}',
  'sk-[0-9A-Za-z_-]{20,}',
  'AIza[0-9A-Za-z_-]{20,}',
].join('|'));
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i;
const URL_CREDENTIAL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/i;

const L3_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: PEM_BLOCK_RE, reason: 'private_key_block' },
  { re: KNOWN_TOKEN_PREFIX_RE, reason: 'known_credential_prefix' },
  { re: URL_CREDENTIAL_RE, reason: 'credential_in_url' },
  { re: BEARER_RE, reason: 'bearer_token' },
  { re: CREDENTIAL_ASSIGNMENT_RE, reason: 'credential_assignment' },
];

export function classifyCognitionSensitivity(text: unknown): CognitionSensitivityVerdict {
  if (typeof text !== 'string' || !text.trim()) return { level: 'unclassified' };
  for (const rule of L3_RULES) {
    if (rule.re.test(text)) return { level: 'L3', reason: rule.reason };
  }
  return { level: 'unclassified' };
}

export function assertNotForbiddenToPersist(parts: unknown[]): void {
  for (const part of parts) {
    const verdict = classifyCognitionSensitivity(part);
    if (verdict.level === 'L3') {
      throw new Error(`cognition is forbidden to persist: ${verdict.reason}`);
    }
  }
}

// ── Prompt-injection phrasing (shared rule source) ────────────────────────
// Two layers consume these rules and must not drift apart:
//   - the candidate admission gate (`features/cognition/gate.ts`) matches them
//     on a zero-width-normalized view before promotion (EXTREME/blocked);
//   - the personal-profile prompt render (`features/memory.ts`) quarantines
//     matching asset statements out of the system prompt and wraps the rest.
// Kept in util because util must not import features; both consumers import
// this module. Deliberately narrow and high-signal: instruction-override
// phrasing, role redefinition, and system-prompt exfiltration attempts.
export interface PromptInjectionRule {
  rule: string;
  pattern: RegExp;
  fix: string;
}

export const PROMPT_INJECTION_RULES: ReadonlyArray<PromptInjectionRule> = [
  {
    rule: 'injection_instruction_override',
    pattern: /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|system)\s+(instruction|prompt|rule|message|context)/i,
    fix: 'Remove instruction-override phrasing before storing this as an asset.',
  },
  {
    rule: 'injection_role_redefinition',
    pattern: /\byou\s+are\s+now\s+(a|an|the)\b|\bfrom\s+now\s+on,?\s+you\s+(will|must|shall)\b|\bact\s+as\s+(if\s+you\s+are\s+)?(a|an|the)\s+\w+\s+(with|that\s+has)\s+no\s+(restriction|limit|rule)/i,
    fix: 'Remove role-redefinition phrasing; a stored asset must not re-scope the agent.',
  },
  {
    rule: 'injection_prompt_exfiltration',
    pattern: /\b(reveal|print|output|repeat|show)\s+(your|the)\s+(system\s+prompt|initial\s+instruction|hidden\s+instruction)/i,
    fix: 'Remove prompt-exfiltration phrasing before storing this as an asset.',
  },
];

// Format (Cf) characters like ZWSP/ZWNJ/LRM/bidi overrides are NOT whitespace to
// `\s`: injection phrasing can slip past the patterns by separating words with
// `\u200B`. Matching and render-side quarantining run on a normalized view where
// those characters become a plain SPACE — deleting them would merge tokens
// (`ignore\u200Ball` → `ignoreall`) and defeat detection, while spacing restores
// the word boundary the attacker rendered invisibly. Deliberately NOT touched:
// C0/C1/DEL — newlines/tabs are real separators the `\s+` in the patterns must
// keep matching; replacing them could still join words across lines. Normal text
// carries none of these format characters, so its verdict is unchanged.
const ZERO_WIDTH_FORMAT_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Replace zero-width/bidi format characters with a plain space before matching.
 *  Deleting them would merge tokens (`ignore\u200Ball` → `ignoreall`) and defeat
 *  detection; spacing restores the word boundary the attacker rendered invisible.
 *  The normalized view is only used for match/quarantine decisions, never stored. */
export function normalizeZeroWidthChars(text: string): string {
  return text.replace(ZERO_WIDTH_FORMAT_RE, ' ');
}

/** Normalized injection-phrasing scan: zero-width format characters spaced out,
 *  then the shared rules are matched. Returns the matched rule id, or null. */
export function scanPromptInjectionPhrasing(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = normalizeZeroWidthChars(text);
  for (const { rule, pattern } of PROMPT_INJECTION_RULES) {
    if (pattern.test(normalized)) return rule;
  }
  return null;
}

/** Quarantine gate for prompt rendering: true when the entry must NOT enter a
 *  system prompt raw. Logs a content-free warn so the omission is observable. */
export function isPromptInjectionQuarantined(text: string, where: { userId: string; surface: string }): boolean {
  const rule = scanPromptInjectionPhrasing(text);
  if (!rule) return false;
  log.warn('prompt entry quarantined (injection phrasing)', {
    userId: where.userId, surface: where.surface, rule, chars: text.length,
  });
  return true;
}
