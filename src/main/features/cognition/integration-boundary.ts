/** KSTAR 双向隔离是产品边界，不提供启用开关。旧来源只用于历史追溯。 */
export function cognitionIntegrationIsolated(): boolean { return true; }
export function isKstarCognitionSource(input: {
  sourceRefs?: readonly { kind?: string; subtype?: string; id?: string }[];
  evidenceRefs?: readonly { kind?: string; subtype?: string; id?: string }[];
  learningProvenance?: unknown;
  learningSignal?: { source?: string };
}): boolean {
  return !!input.learningProvenance || ['review', 'preference_scan'].includes(input.learningSignal?.source || '')
    || [...(input.sourceRefs || []), ...(input.evidenceRefs || [])].some(ref => ref.kind === 'kstar'
      || ref.subtype === 'kstar' || /^(?:kse|kstar|episode|requirement|task-aggregate)[-:]/i.test(ref.id || ''));
}
