/**
 * Answer verification (COGSEED-39 ① Phase 5) — citation reconciliation.
 *
 * Turns the Phase 1 "answer only from materials" rule from a prompt-level
 * convention into a checkable mechanism: given a draft answer and the
 * evidence package that `ask_materials` returned, verify that every
 * `path#chunk N` citation in the answer really exists in the evidence
 * (hallucinated anchors are rejected) and, optionally, that uncited claims
 * are semantically supported by the evidence snippets (via an injectable
 * LLM judge).
 *
 * MVP scope:
 *   - structural anchor reconciliation (deterministic, no LLM);
 *   - optional per-claim semantic judgement through `judgeClaim` (the
 *     caller supplies the model call; tests inject a fake);
 *   - a final verdict: grounded / mixed / unsupported.
 */

import type { MaterialHit } from './material-search';

export type ClaimVerdict = 'grounded' | 'unsupported' | 'unverifiable';

export interface CitationCheck {
  /** The literal citation text found in the answer (e.g. `AST.pdf#chunk 12`). */
  cited: string;
  /** Parsed anchor; null when the citation text does not match `path#chunk N`. */
  parsed: { path: string; chunkIdx: number } | null;
  /** True when the parsed anchor exists in the evidence package. */
  exists: boolean;
}

export interface ClaimCheck {
  claim: string;
  verdict: ClaimVerdict;
}

export interface VerificationResult {
  verdict: 'grounded' | 'mixed' | 'unsupported';
  citations: CitationCheck[];
  claims: ClaimCheck[];
}

export interface AnswerVerificationOptions {
  /** The LLM draft answer to verify. */
  answer: string;
  /** Evidence anchors from `ask_materials` (hasEvidence=true case). */
  evidence: MaterialHit[];
  /**
   * Optional semantic judge: given an uncited claim and the evidence
   * snippets, decide whether the evidence supports it. Absent → uncited
   * claims are marked `unverifiable`.
   */
  judgeClaim?: (claim: string, evidenceTexts: string[]) => Promise<ClaimVerdict>;
}

/** Filename chars: letters/digits/dot/hyphen/underscore. Brackets/parens excluded. */
const CITATION_SRC = '([A-Za-z0-9._-]+)#chunk\\s*(\\d+)';
const CITATION_RE_G = new RegExp(CITATION_SRC, 'g');
const CITATION_RE = new RegExp(CITATION_SRC);

function splitClaims(answer: string): string[] {
  return answer
    // Sentence boundary = sentence punctuation FOLLOWED BY whitespace. A bare
    // "." inside a filename ("AST.pdf") or at end-of-string does not split.
    .split(/(?<=[。！？!?.])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function evidenceAnchorSet(evidence: MaterialHit[]): Set<string> {
  const set = new Set<string>();
  for (const h of evidence) {
    set.add(`${h.path}#chunk ${h.chunkIdx}`);
    // Accept a leading scope/source label, e.g. "[global] AST.pdf#chunk 12".
    set.add(`[${h.scope}] ${h.path}#chunk ${h.chunkIdx}`);
    if (h.source === 'attachment') {
      set.add(`[attachment] ${h.path}#chunk ${h.chunkIdx}`);
    }
  }
  return set;
}

/**
 * Verify a draft answer against the evidence package.
 * Structural citation reconciliation always runs; `judgeClaim` (when
 * supplied) additionally grades uncited claims against evidence snippets.
 */
export async function verifyAnswer(opts: AnswerVerificationOptions): Promise<VerificationResult> {
  const anchors = evidenceAnchorSet(opts.evidence ?? []);

  const citations: CitationCheck[] = [];
  const seen = new Set<string>();
  for (const match of opts.answer.matchAll(CITATION_RE_G)) {
    const cited = match[0];
    if (seen.has(cited)) continue;
    seen.add(cited);
    const path = match[1];
    const chunkIdx = Number(match[2]);
    const canonical = `${path}#chunk ${chunkIdx}`;
    citations.push({
      cited,
      parsed: { path, chunkIdx },
      exists: anchors.has(canonical) || anchors.has(cited),
    });
  }

  const evidenceTexts = (opts.evidence ?? []).map((h) => h.snippet);
  const claims: ClaimCheck[] = [];
  for (const claim of splitClaims(opts.answer)) {
    const hasCitation = CITATION_RE.test(claim);
    if (hasCitation) {
      claims.push({ claim, verdict: 'grounded' });
      continue;
    }
    if (opts.judgeClaim) {
      let verdict: ClaimVerdict;
      try {
        verdict = await opts.judgeClaim(claim, evidenceTexts);
      } catch {
        verdict = 'unverifiable';
      }
      claims.push({ claim, verdict });
    } else {
      claims.push({ claim, verdict: 'unverifiable' });
    }
  }

  const hallucinated = citations.some((c) => c.parsed && !c.exists);
  const unsupported = claims.some((c) => c.verdict === 'unsupported');
  const unverifiable = claims.some((c) => c.verdict === 'unverifiable');

  let verdict: VerificationResult['verdict'];
  if (hallucinated || unsupported) verdict = 'unsupported';
  else if (unverifiable) verdict = 'mixed';
  else verdict = 'grounded';

  return { verdict, citations, claims };
}

/** Policy helper for the caller: what to do with a verification result. */
export function dispositionFor(result: VerificationResult): 'pass' | 'rewrite' | 'strip-citations' {
  const hallucinated = result.citations.some((c) => c.parsed && !c.exists);
  if (hallucinated) return 'strip-citations'; // fake anchors — never ship as-is
  if (result.verdict === 'unsupported') return 'rewrite';
  return 'pass';
}
