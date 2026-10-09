/** L3 cognition persistence gate. Credentials must never become candidates or assets. */

export type CognitionSensitivityLevel = 'L3' | 'unclassified';

export interface CognitionSensitivityVerdict {
  level: CognitionSensitivityLevel;
  reason?: string;
}

const CREDENTIAL_FIELD = '(?:api_?key|access_?token|refresh_?token|id_?token|session_?id|client_?secret|private_?key|password|passwd|pwd|secret|token|authorization|cookie|set-cookie)';
const CREDENTIAL_ASSIGNMENT_RE = new RegExp(
  `\\b${CREDENTIAL_FIELD}\\b["']?\\s*[:=]\\s*["']?[^\\s"',;]+`,
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
