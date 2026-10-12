/** Tunable catalog parameters. Values are provisional until labelled replay. */
export const CATALOG_RETRIEVAL = Object.freeze({
  rrfK: 20,
  semanticRankFloor: 0.25,
  // 词面通道入场下限（P7，2026-09-30）：覆盖低于此值的泛词级重合不得进词面
  // 通道——否则 RRF 名次制会把「垃圾证据的第一名」放大到近满分（实测 0.88），
  // 短查询下主题相邻但不相关的资产被顶到相关节前排。与 semanticRankFloor
  // 同构：只在通道入口设绝对门槛，不动 ★ 阈值与融合公式。
  lexicalRankFloor: 0.2,
  strongLexicalCoverage: 0.35,
  strongSemanticCosine: 0.5,
  strongExactMatch: 0.7,
});

export const CATALOG_PRESENTATION = Object.freeze({
  maxStars: 5,
  maxPromptEntries: 12,
  promptTokenBudget: 900,
});

export const CATALOG_FEEDBACK = Object.freeze({
  appliedCountCap: 8,
  recentApplicationBonus: 0.05,
  halfLifeDays: 14,
});
