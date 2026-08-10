(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RecallInformationArchitecture = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CATEGORY_ORDER = Object.freeze(['personal', 'rule', 'template', 'skill_method']);

  function normalizeRecallLocation(page) {
    const value = typeof page === 'string' ? page.trim() : '';
    if (value === 'sources' || value === 'captures' || value === 'candidates') {
      return { page: 'deposition', subview: value };
    }
    if (value === 'brain') return { page: 'assets', subview: 'tree' };
    if (value === 'context' || value === 'receipts') return { page: 'assets', subview: 'reuse' };
    if (value === 'ontology') return { page: 'assets', subview: 'list', category: 'personal' };
    if (value === 'assets') return { page: 'assets', subview: 'list' };
    if (value === 'deposition') return { page: 'deposition', subview: 'candidates' };
    return { page: 'overview', subview: '' };
  }

  function normalizeAbilityCategory(value) {
    const category = typeof value === 'string' ? value.trim() : '';
    if (category === 'personal' || category === 'preference' || category === 'ontology') return 'personal';
    if (category === 'rule') return 'rule';
    if (category === 'template') return 'template';
    if (category === 'skill_method' || category === 'skill_evolution' || category === 'experience') return 'skill_method';
    return '';
  }

  return Object.freeze({ CATEGORY_ORDER, normalizeRecallLocation, normalizeAbilityCategory });
});
