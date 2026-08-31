/**
 * Model-id recognition — map an arbitrary model id (typically from a
 * third-party OpenAI-compatible relay's /models listing) to the capability
 * metadata CogSeed knows from its curated catalog.
 *
 * Why: the standard list-models response carries ONLY ids — no context
 * window, no reasoning/vision flags (that gap is industry-wide, not a
 * CogSeed omission). Relays overwhelmingly resell the same official models
 * under their official ids, so recognizing the id against the built-in
 * pi-ai catalog recovers real data for most rows.
 *
 * Resolution order:
 *   1. pi-ai catalog exact hit (full id)
 *   2. prefix-stripped hit — relays often namespace ids
 *      ("deepseek/deepseek-v4-flash", "accounts/fireworks/models/…")
 *   3. family rules (conservative regex table for well-known model
 *      families; capability flags only, NEVER invented numbers — window
 *      sizes come from the catalog or stay unset)
 *
 * The catalog index is built once per process (lazy, async — pi-ai loads
 * on demand). Family rules work synchronously without it.
 */

export interface RecognizedModelInfo {
  /** Where the answer came from — catalog hits are authoritative, family
   *  matches are conservative inference. */
  source: 'catalog' | 'family';
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
}

type CatalogRow = { contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: Array<'text' | 'image'> };

let _indexPromise: Promise<Map<string, CatalogRow>> | null = null;

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

async function buildCatalogIndex(): Promise<Map<string, CatalogRow>> {
  const index = new Map<string, CatalogRow>();
  try {
    // pi-ai 是 ESM-only 包：必须走动态 import（主进程 tsx/esm loader 支持），
    // 顶层值导入在 CJS 加载路径下会整体失败。
    const pi = (await import('@earendil-works/pi-ai')) as typeof import('@earendil-works/pi-ai');
    // pi-ai's registry is lazy — make sure the builtin providers are
    // registered (idempotent) before enumerating.
    pi.registerBuiltInApiProviders();
    for (const provider of pi.getProviders()) {
      for (const model of pi.getModels(provider) || []) {
        if (!model || typeof model.id !== 'string' || !model.id) continue;
        if (index.has(model.id)) continue;
        const rawInput: unknown = model.input;
        const input = Array.isArray(rawInput)
          ? rawInput.filter((x): x is 'text' | 'image' => x === 'text' || x === 'image')
          : undefined;
        index.set(model.id, {
          contextWindow: toNumber(model.contextWindow),
          maxTokens: toNumber(model.maxTokens),
          reasoning: model.reasoning === true ? true : model.reasoning === false ? false : undefined,
          input: input?.length ? input : undefined,
        });
      }
    }
  } catch {
    // Catalog unavailable (exotic startup order / test env) — family rules
    // below still answer, just with less data.
  }
  return index;
}

/** Warm the catalog index. Safe to call repeatedly; callers that want
 *  catalog-grade answers await this once before recognizing. */
export function ensureModelRecognitionReady(): Promise<Map<string, CatalogRow>> {
  if (!_indexPromise) _indexPromise = buildCatalogIndex();
  return _indexPromise;
}

/** Test hook — drop the cached index so a fresh build can be forced. */
export function _resetModelRecognitionForTest(): void {
  _indexPromise = null;
}

/** Relays namespace official ids with prefixes; strip the common shapes. */
function stripIdPrefix(id: string): string {
  // "vendor/model-id" → "model-id"; keep the LAST segment so
  // "deepseek/deepseek-v4-flash" → "deepseek-v4-flash".
  const slashed = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  // OpenAI Responses-style "accounts/<owner>/models/<id>" already handled by
  // the last-segment rule; "models/<id>" (Gemini) likewise.
  return slashed.trim();
}

// Family rules — capability flags only. Conservative by design: an unknown
// variant inside a known family gets the family's always-true capabilities
// (e.g. every Claude 3+ reasons and sees images); anything version-dependent
// (e.g. DeepSeek vision) requires the variant hint in the id.
interface FamilyRule {
  re: RegExp;
  reasoning?: (id: string) => boolean;
  vision?: (id: string) => boolean;
}

const FAMILY_RULES: FamilyRule[] = [
  {
    re: /^claude-(sonnet|opus|haiku|fable)-/i,
    reasoning: () => true,
    vision: () => true,
  },
  {
    re: /^(gpt-5|gpt-4\.5|o[134]-)/i,
    reasoning: () => true,
    vision: () => true,
  },
  {
    re: /^gemini-/i,
    reasoning: (id) => /pro|thinking/i.test(id),
    vision: () => true,
  },
  {
    re: /^deepseek/i,
    reasoning: () => true,
    vision: (id) => /vision|vl/i.test(id),
  },
  {
    re: /^(glm|chatglm)/i,
    reasoning: (id) => /thinking/i.test(id),
    vision: (id) => /vl|vision/i.test(id),
  },
  {
    re: /^(qwen|qwq)/i,
    reasoning: (id) => /thinking|qwq/i.test(id),
    vision: (id) => /vl|vision/i.test(id),
  },
  {
    re: /^(kimi|moonshot)/i,
    reasoning: (id) => /k\d|thinking/i.test(id),
    vision: (id) => /vl|vision/i.test(id),
  },
  {
    re: /^grok-/i,
    reasoning: () => true,
    vision: () => true,
  },
];

function familyMatch(id: string): RecognizedModelInfo | null {
  for (const rule of FAMILY_RULES) {
    if (!rule.re.test(id)) continue;
    return {
      source: 'family',
      reasoning: rule.reasoning ? rule.reasoning(id) : undefined,
      vision: rule.vision ? rule.vision(id) : undefined,
    };
  }
  return null;
}

function fromCatalogRow(row: CatalogRow, source: 'catalog' | 'family'): RecognizedModelInfo {
  return {
    source,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    reasoning: row.reasoning,
    vision: row.input ? row.input.includes('image') : undefined,
  };
}

/** Recognize a model id by family rules ONLY (synchronous, no catalog).
 *  Callers that can await should prefer `recognizeModelByIdReady`, which
 *  additionally resolves against the full pi-ai catalog. */
export function recognizeModelById(rawId: string): RecognizedModelInfo | null {
  const id = String(rawId || '').trim().toLowerCase();
  if (!id) return null;
  return familyMatch(id) || familyMatch(stripIdPrefix(id));
}

/** Recognize with the catalog ready (the normal entry point for callers
 *  that can await — listModels, the custom runtime builder). */
export async function recognizeModelByIdReady(rawId: string): Promise<RecognizedModelInfo | null> {
  const index = await ensureModelRecognitionReady();
  const id = String(rawId || '').trim().toLowerCase();
  if (!id) return null;
  const direct = index.get(id);
  if (direct) return fromCatalogRow(direct, 'catalog');
  const stripped = stripIdPrefix(id);
  const strippedHit = stripped !== id ? index.get(stripped) : undefined;
  if (strippedHit) return fromCatalogRow(strippedHit, 'catalog');
  return familyMatch(id) || familyMatch(stripped);
}
