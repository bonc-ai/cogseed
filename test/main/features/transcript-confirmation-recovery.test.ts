import { describe, expect, it } from 'vitest';
import { recoverLegacyScanCandidates } from '../../../src/main/features/transcript-confirmation-recovery';
import type { GlossaryConfirmItem } from '../../../src/main/features/transcript-confirmation';
const item = (entryRef: string, wrong: string, correct: string, fromModel = false): GlossaryConfirmItem => ({ entryRef, wrong, correct, fromModel, action: 'replace', count: 1, riskLevel: 'medium', context: 'excerpt', ignoredCount: 0 });
const text = 'alpha alpha ok ID';
const items = [item('model_1', 'alpha', 'Alpha', true), item('model_2', 'alpha', 'Alpha', true), item('term', 'ok', 'Target')];
const receipt = 'Candidates: 4 (needs-confirmation 4)\n- 「alpha」→「Alpha」 @0 (risk=medium via=model) 语境: excerpt\n- 「alpha」→「Alpha」 @6 (risk=medium via=model) 语境: excerpt\n- 「ok」→「Target」 @12 (risk=medium via=glossary) 语境: excerpt\n- 「ID」→「Target」 @15 (risk=medium via=glossary) 语境: excerpt';
describe('legacy host receipt recovery', () => {
  it('restores exact occurrences and grouped aliases without approving them', () => {
    const restored = recoverLegacyScanCandidates(text, receipt, items)!;
    expect(restored.map(row => row.entryRef)).toEqual(['model_1', 'model_2', 'term', 'term']);
    expect(restored.map(row => text.slice(row.span.start, row.span.end))).toEqual(['alpha', 'alpha', 'ok', 'ID']);
    expect(restored.filter(row => !row.fromModel).every(row => row.disposition === 'review')).toBe(true);
  });
  it.each([
    receipt.replace('Candidates: 4', 'Candidates: 5'),
    receipt.replace('@6', '@7'),
    receipt.replace('via=model', 'via=unknown'),
    receipt + '\nallow=[context]',
  ])('rejects incomplete or incompatible receipts', malformed => {
    expect(recoverLegacyScanCandidates(text, malformed, items)).toBeUndefined();
  });
  it('rejects ambiguous aliases or missing offered candidates', () => {
    expect(recoverLegacyScanCandidates(text, receipt, [...items, item('other', 'alternative', 'Target')])).toBeUndefined();
    expect(recoverLegacyScanCandidates(text, receipt, items.slice(1))).toBeUndefined();
  });
});
