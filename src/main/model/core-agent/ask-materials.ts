/**
 * ask_materials — grounded Q&A evidence service (知识库问答 ① Phase 4a).
 *
 * One-call entry for "reliable Q&A within the material set": runs the hybrid
 * material search (Library vector + BM25, plus conversation attachments when
 * a cid is known), applies a fused-score threshold, and returns either a
 * citation-bearing evidence package for the LLM to answer from, or a
 * structured no-material / low-confidence marker so the model can say so
 * plainly instead of fabricating (Phase 1 protocol).
 *
 * The evidence package is deliberately just the retrieval result + a
 * citation contract; final wording stays with the LLM. The same package is
 * the comparison basis for Phase 5 answer verification.
 */

import { searchMaterials, type MaterialHit, type MaterialSearchOptions } from './material-search';

/**
 * Default fused-score floor. RRF scores: a perfect vector rank-1 ≈ 0.0115,
 * keyword rank-1 ≈ 0.0049. Values far below that are noise; calibrated
 * against real materials can tighten this.
 */
const DEFAULT_MIN_SCORE = 0.0015;

export type AskMaterialsReason = 'no_material' | 'low_confidence';

export interface AskMaterialsOptions extends MaterialSearchOptions {
  /** Fused-score floor below which weak matches are treated as no evidence. */
  minScore?: number;
}

export interface AskMaterialsResult {
  hasEvidence: boolean;
  reason?: AskMaterialsReason;
  /** Evidence anchors (empty when no material; retained on low confidence). */
  hits: MaterialHit[];
  query: string;
  summary: string[];
}

export async function askMaterials(opts: AskMaterialsOptions): Promise<AskMaterialsResult> {
  const query = (opts.query ?? '').trim();
  const minScore = Number(opts.minScore ?? DEFAULT_MIN_SCORE);
  const summary: string[] = [];

  const res = await searchMaterials(opts);
  summary.push(...res.summary);

  if (res.hits.length === 0) {
    summary.push('no relevant material found — answer that there is no material, do not fabricate.');
    return { hasEvidence: false, reason: 'no_material', hits: [], query, summary };
  }

  const best = res.hits[0].score;
  if (best < minScore) {
    summary.push(`weakest evidence below threshold (best=${best.toFixed(4)} < ${minScore}) — answer with caveat or say no material.`);
    return { hasEvidence: false, reason: 'low_confidence', hits: res.hits, query, summary };
  }

  summary.push('evidence ready — answer ONLY from the hits below and cite each claim as `path#chunk N`.');
  return { hasEvidence: true, hits: res.hits, query, summary };
}

/** Format the evidence package for the model-facing tool output. */
export function formatEvidence(result: AskMaterialsResult): string {
  const lines = [`ask_materials (${result.summary.join('; ')})`];
  if (result.hasEvidence) {
    for (const h of result.hits) {
      const anchor = `${h.path}#chunk ${h.chunkIdx}`;
      const src = h.source === 'attachment' ? 'attachment' : h.scope;
      lines.push(`- [${src}] ${anchor} score=${h.score.toFixed(4)}${h.title ? ` · ${h.title}` : ''}\n  ${h.snippet}`);
    }
    lines.push('Cite each claim as `path#chunk N`; do not add details the hits do not contain.');
  } else if (result.reason === 'low_confidence') {
    for (const h of result.hits) {
      lines.push(`- (weak) ${h.path}#chunk ${h.chunkIdx} score=${h.score.toFixed(4)}\n  ${h.snippet}`);
    }
    lines.push('Matches are weak — either answer with an explicit caveat or say no relevant material exists.');
  } else {
    lines.push('No relevant material found. Say plainly that the material set does not contain this; do not fabricate, do not switch to web search unless the user asks.');
  }
  return lines.join('\n');
}
