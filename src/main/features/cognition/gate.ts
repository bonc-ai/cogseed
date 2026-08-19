/**
 * Cognition candidate admission gate.
 *
 * Every precipitated candidate (沉淀候选) passes through here before it can
 * become an asset. The gate has two layers with deliberately unequal
 * authority:
 *
 *   1. Code baseline (this module, synchronous, deterministic) — DECIDES.
 *      Regex/red-flag scanning of the candidate's content. Always runs, always
 *      returns the same verdict for the same input.
 *
 *   2. Semantic review (an agent, asynchronous, best-effort) — ADVISES ONLY.
 *      Catches what regex cannot: prompt-injection payloads carried in from a
 *      poisoned conversation, sensitive facts that shouldn't be recorded.
 *
 * Why the asymmetry: the code layer cannot fail (no network, no model, no
 * timeout), so it is safe to gate on. The agent layer can time out, be
 * offline, or lack an API key, and a model's verdict is not reproducible for
 * the same input. Giving a component that can fail the power to *clear* a
 * finding means the gate opens exactly when that component breaks. So the
 * agent may only ADD findings, never clear them — see `mergeSemanticReview`.
 *
 * This mirrors the split the security spec draws between 安全检查 (a
 * deterministic verdict) and its presentation/explanation layer.
 */
import { scanRedFlags } from '../../quality/rules/red-flags';
import { createLogger } from '../../logger';
import type { CognitionCandidateType, CognitionSecurityView } from './types';

const log = createLogger('cognition-gate');

/** Deterministic verdict of the code baseline. Ordered by increasing severity. */
export type CandidateGateVerdict = 'pass' | 'risk' | 'blocked';

export interface CandidateFinding {
  /** Stable rule id, e.g. `no_credential_path_read` or `injection_marker`. */
  rule: string;
  level: 'EXTREME' | 'MEDIUM' | 'LOW';
  /** Where in the candidate the finding sits (`summary`, `title`, …). */
  field: string;
  snippet: string;
  suggested_fix: string;
  /** Which layer produced it. Semantic findings are advisory by construction. */
  source: 'code' | 'semantic';
}

export interface CandidateGateDecision {
  verdict: CandidateGateVerdict;
  findings: CandidateFinding[];
  /** True once a semantic review has been merged in. */
  semanticReviewed: boolean;
  /**
   * Set when the semantic layer was expected but unavailable. The verdict is
   * still authoritative — the code baseline ran — but callers may surface
   * "deep review unavailable" so the user is not told the content is clean
   * when only half the checks ran.
   */
  semanticDegraded?: string;
}

/** Text fields of a candidate that are worth scanning. */
export interface CandidateContent {
  title?: string;
  summary?: string;
  /** Free-form payload (experience body, rule text, ontology fact, …). */
  body?: string;
  type?: CognitionCandidateType;
}

// ── Injection markers ────────────────────────────────────────────────────
// A candidate is distilled from user conversations. If that conversation was
// poisoned, the distilled "experience" carries the payload, and it later gets
// injected into a system prompt as reference material — which is precisely
// how a stored prompt-injection becomes persistent.
//
// `memory.ts` already scans stored memories for these markers; precipitation
// had no equivalent check, so the same payload could enter through this path.
// Kept narrow and high-signal: instruction-override phrasing, role
// redefinition, and system-prompt exfiltration attempts.
const INJECTION_PATTERNS: ReadonlyArray<{ rule: string; pattern: RegExp; fix: string }> = [
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

function _excerpt(text: string, at: number): string {
  const start = Math.max(0, at - 40);
  return text.slice(start, start + 160).replace(/\s+/g, ' ').trim();
}

function _scanInjection(text: string, field: string): CandidateFinding[] {
  const out: CandidateFinding[] = [];
  for (const { rule, pattern, fix } of INJECTION_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    out.push({
      rule,
      // Injection phrasing in stored knowledge is not a "maybe": it will be
      // replayed into a prompt. Treated as blocking.
      level: 'EXTREME',
      field,
      snippet: _excerpt(text, m.index),
      suggested_fix: fix,
      source: 'code',
    });
  }
  return out;
}

function _verdictOf(findings: readonly CandidateFinding[]): CandidateGateVerdict {
  if (findings.some((f) => f.level === 'EXTREME')) return 'blocked';
  if (findings.length > 0) return 'risk';
  return 'pass';
}

/**
 * Run the deterministic code baseline over a candidate.
 *
 * Never throws and never depends on IO beyond the passed-in content, so it is
 * safe to call on every candidate decision.
 */
export function evaluateCandidate(content: CandidateContent): CandidateGateDecision {
  const findings: CandidateFinding[] = [];
  const fields: Array<[string, string | undefined]> = [
    ['title', content.title],
    ['summary', content.summary],
    ['body', content.body],
  ];

  for (const [field, text] of fields) {
    if (!text) continue;
    findings.push(..._scanInjection(text, field));
    // Reuse the same red-flag rules the install path uses, so a payload that
    // would be rejected on install cannot enter by way of precipitation.
    // `skill_md` kind extracts fenced code blocks first, which matches how a
    // candidate body carries snippets.
    for (const v of scanRedFlags({ content: text, kind: 'skill_md', field })) {
      findings.push({
        rule: v.rule,
        level: v.level,
        field: v.field,
        snippet: v.snippet,
        suggested_fix: v.suggested_fix,
        source: 'code',
      });
    }
  }

  return { verdict: _verdictOf(findings), findings, semanticReviewed: false };
}

/**
 * Merge an agent's semantic review into a code-baseline decision.
 *
 * The agent may only escalate. Concretely:
 *   - it can add findings (raising `pass` → `risk`/`blocked`);
 *   - it cannot remove a code finding;
 *   - it cannot lower the verdict below what the code baseline decided.
 *
 * `advisoryOnly` (default) additionally caps agent findings at MEDIUM so a
 * model cannot single-handedly block a candidate — useful while the semantic
 * layer is still being tuned. Set it to false once its precision is
 * established and blocking on it is acceptable.
 */
/** Result handed back by the semantic (agent) layer. */
export type SemanticReviewResult =
  | { ok: true; findings: Array<Omit<CandidateFinding, 'source'>> }
  | { ok: false; reason: string };

export function mergeSemanticReview(
  base: CandidateGateDecision,
  review: SemanticReviewResult,
  opts: { advisoryOnly?: boolean } = {},
): CandidateGateDecision {
  if (review.ok !== true) {
    log.warn('semantic review unavailable', { reason: review.reason });
    // Degraded, not failed: the code baseline already produced a verdict.
    return { ...base, semanticDegraded: review.reason };
  }

  const advisoryOnly = opts.advisoryOnly !== false;
  const added: CandidateFinding[] = review.findings.map((f) => ({
    ...f,
    level: advisoryOnly && f.level === 'EXTREME' ? 'MEDIUM' : f.level,
    source: 'semantic',
  }));

  const findings = [...base.findings, ...added];
  const merged = _verdictOf(findings);
  // Monotonic: never below the code baseline's verdict.
  const rank: Record<CandidateGateVerdict, number> = { pass: 0, risk: 1, blocked: 2 };
  const verdict = rank[merged] >= rank[base.verdict] ? merged : base.verdict;

  return { ...base, verdict, findings, semanticReviewed: true };
}

/** True when the candidate must not be written as an asset. */
export function isCandidateBlocked(decision: CandidateGateDecision): boolean {
  return decision.verdict === 'blocked';
}

/**
 * Validate an untrusted semantic-review payload (e.g. from the renderer).
 *
 * Returns `undefined` when absent or malformed rather than throwing: a broken
 * review must degrade to "no review", never block the decision path. Levels
 * are clamped to the known set and strings are length-capped so a hostile
 * payload cannot inflate the persisted decision.
 */
export function parseSemanticReview(raw: unknown): SemanticReviewResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  if (obj.ok === false) {
    const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : 'unspecified';
    return { ok: false, reason };
  }
  if (obj.ok !== true || !Array.isArray(obj.findings)) return undefined;

  const levels = new Set(['EXTREME', 'MEDIUM', 'LOW']);
  const findings = obj.findings
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .slice(0, 50)
    .map((f) => ({
      rule: typeof f.rule === 'string' ? f.rule.slice(0, 80) : 'semantic_unspecified',
      level: (levels.has(String(f.level)) ? String(f.level) : 'MEDIUM') as CandidateFinding['level'],
      field: typeof f.field === 'string' ? f.field.slice(0, 80) : 'body',
      snippet: typeof f.snippet === 'string' ? f.snippet.slice(0, 200) : '',
      suggested_fix: typeof f.suggested_fix === 'string' ? f.suggested_fix.slice(0, 300) : '',
    }));

  return { ok: true, findings };
}

/**
 * Project a gate decision into the compact shape the UI consumes.
 *
 * Kept lossy on purpose: list rendering needs a status and a one-line reason,
 * not the full finding set. Snippets are excluded so candidate content (which
 * may itself contain the payload) is not fanned out into list payloads.
 */
export function toSecurityView(decision: CandidateGateDecision): CognitionSecurityView {
  const rank: Record<CandidateFinding['level'], number> = { EXTREME: 0, MEDIUM: 1, LOW: 2 };
  const top = [...decision.findings].sort((a, b) => rank[a.level] - rank[b.level])[0];
  return {
    status: decision.verdict,
    findingCount: decision.findings.length,
    ...(top ? { topRule: top.rule } : {}),
    semanticReviewed: decision.semanticReviewed,
    ...(decision.semanticDegraded ? { degradedReason: decision.semanticDegraded } : {}),
  };
}
