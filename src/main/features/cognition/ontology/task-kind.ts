/** Conservative task-kind labels for automatic ontology rule matching.
 * Specific categories are checked first so an overlapping phrase such as
 * “写一份本周周报” resolves to weekly_report rather than writing. Ordinary
 * text that matches no category stays unknown. */
export type OntologyTaskKind =
  | 'review'
  | 'weekly_report'
  | 'meeting'
  | 'research'
  | 'writing'
  | 'coding'
  | 'planning'
  | 'decision';

const RULES: ReadonlyArray<{ kind: OntologyTaskKind; patterns: readonly RegExp[] }> = [
  { kind: 'weekly_report', patterns: [/周报/i, /\bweekly\s+report\b/i] },
  { kind: 'review', patterns: [/评审/i, /审查/i, /复核/i, /审阅/i, /\breview\b/i, /\baudit\b/i] },
  { kind: 'meeting', patterns: [/会议/i, /开会/i, /\bmeeting\b/i] },
  { kind: 'research', patterns: [/调研/i, /研究/i, /\bresearch\b/i] },
  { kind: 'writing', patterns: [/撰写/i, /起草/i, /写一份/i, /文案/i, /\bdraft\b/i, /\bwrite\b/i] },
  { kind: 'coding', patterns: [/修复/i, /实现/i, /开发/i, /重构/i, /调试/i, /\bbug\b/i, /\bfix\b/i, /\bimplement\b/i, /\brefactor\b/i, /\bdebug\b/i] },
  { kind: 'planning', patterns: [/规划/i, /计划/i, /排期/i, /\bplanning\b/i, /\bplan\b/i] },
  { kind: 'decision', patterns: [/决策/i, /选型/i, /取舍/i, /\bdecision\b/i] },
];

export function inferOntologyTaskKind(text: string | undefined | null): OntologyTaskKind | undefined {
  const value = String(text || '').toLowerCase().trim();
  if (!value) return undefined;
  return RULES.find(rule => rule.patterns.some(pattern => pattern.test(value)))?.kind;
}
