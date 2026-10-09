// Source-aware candidate review view models.
(function () {
  'use strict';

  function reviewText(key, fallback) {
    try {
      if (typeof t === 'function') {
        const value = t(key);
        if (value && value !== key) return value;
      }
    } catch (_) { /* locale failure is rendered with fallback */ }
    return fallback;
  }

  function reviewItemModel(item) {
    const source = item && typeof item === 'object' ? item : {};
    const origin = source.source && typeof source.source === 'object' ? source.source : {};
    const evidence = Array.isArray(source.evidence) ? source.evidence.filter((entry) => entry && typeof entry === 'object') : [];
    const title = String(origin.title || reviewText('personal_context_center.source_unknown', '未知来源'));
    const type = String(origin.type || 'resource');
    return Object.freeze({
      candidateId: String(source.candidateId || ''),
      summary: String(source.summary || ''),
      state: String(source.state || 'pending'),
      sourceLabel: `${title} · ${type}`,
      sourceUpdatedAt: String(origin.updatedAt || ''),
      evidenceCount: evidence.length,
      evidence: evidence.map((entry) => Object.freeze({ excerpt: String(entry.excerpt || ''), sourceUrl: String(entry.sourceUrl || '') })),
      sourceInvalid: source.sourceValidity === 'invalidated' || source.sourceValidity === 'deleted',
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { reviewItemModel };
  if (typeof window !== 'undefined') window.PersonalContextReview = Object.freeze({ reviewItemModel });
})();
