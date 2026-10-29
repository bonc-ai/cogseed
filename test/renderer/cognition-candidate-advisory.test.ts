import { nightlyFormation } from './helpers/nightly-candidate';
/** Nonblocking advisories remain visible above confirmation in editable and
 * read-only details. Eligible, blocked, empty and unknown advisories do not
 * manufacture messages or change the confirmation authority. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCognitionAssets, renderCognition } from './helpers/cognition-renderer';

const zh: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'),
);

const ACTIONABLE = {
  canView: true, canEdit: true, canConfirm: true, canPromote: true, canReject: true,
  canDefer: true, canRetry: false, canBatchSelect: true, needsUserAction: true,
  countsAsPending: true, isSnoozed: false, isTerminal: false,
};

function candidate(capabilities: Record<string, unknown>) {
  return {
    ...nightlyFormation(), id: 'cand-soft',
    status: 'pending_review',
    summary: '带软提醒的候选',
    judgment: '发布前用双清单核对交付物。',
    suggestedType: 'rule',
    suggestedScope: 'product',
    suggestedAction: 'create',
    risk: 'low',
    sourceRefs: [...nightlyFormation().sourceRefs, { kind: 'memory', id: 'mem-1' }],
    evidenceRefs: [{ kind: 'memory', id: 'mem-1' }],
    capabilities,
  };
}

function renderDetail(caps: Record<string, unknown>): string {
  return renderCognition(
    { name: 'review', candidateId: 'cand-soft' },
    { candidates: [candidate(caps)] },
  );
}

describe('候选确认前的准入软提醒（soft_warning）', () => {
  it('soft_warning 且有欠缺时：渲染提醒，逐条列出，且在确认按钮上方', () => {
    const html = renderDetail({
      ...ACTIONABLE,
      displayState: 'needs_review',
      eligibility: 'soft_warning',
      ineligibleReasons: [],
      eligibilityAdvisories: ['rule_missing_boundary', 'statement_over_soft_budget'],
    });

    // 词条落在真实 zh 词条上——同时证明新键确实存在于语言文件。
    expect(zh['cognition.candidate_advisory_prefix']).toBeTruthy();
    expect(html).toContain(zh['cognition.candidate_advisory_prefix']);
    expect(html).toContain(zh['cognition.candidate_advisory_rule_missing_boundary']);
    expect(html).toContain(zh['cognition.candidate_advisory_statement_over_soft_budget']);
    // 「不阻止确认」与「按最近一次读取」的口径必须在场（快照口径如实说明）。
    expect(zh['cognition.candidate_advisory_prefix']).toContain('不阻止确认');
    expect(zh['cognition.candidate_advisory_prefix']).toContain('最近一次读取');
    // 提醒在确认按钮上方最后可见，不挡按钮。
    const noteAt = html.indexOf(zh['cognition.candidate_advisory_prefix']);
    const confirmAt = html.lastIndexOf('data-act="cand-adopt-with-form"');
    expect(noteAt).toBeGreaterThan(-1);
    expect(confirmAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(confirmAt);
  });

  it('只读分支（终态候选）也补一行简版提醒，不静默', () => {
    const html = renderDetail({
      ...ACTIONABLE,
      canEdit: false, canConfirm: false, canPromote: false, canReject: false,
      canDefer: false, canBatchSelect: false, needsUserAction: false,
      countsAsPending: false, isTerminal: true,
      displayState: 'confirmed',
      eligibility: 'soft_warning',
      ineligibleReasons: [],
      eligibilityAdvisories: ['fact_not_stable'],
    });

    expect(zh['cognition.candidate_block_fact_not_stable']).toBeTruthy();
    expect(html).toContain(zh['cognition.candidate_advisory_prefix']);
    expect(html).toContain(zh['cognition.candidate_block_fact_not_stable']);
  });

  it('eligible 候选不渲染提醒（不制造噪音）', () => {
    const html = renderDetail({
      ...ACTIONABLE,
      displayState: 'needs_review',
      eligibility: 'eligible',
      ineligibleReasons: [],
      eligibilityAdvisories: [],
    });

    expect(html).not.toContain(zh['cognition.candidate_advisory_prefix']);
  });

  it('ineligible 候选走阻断原因块，不叠加软提醒', () => {
    const html = renderDetail({
      ...ACTIONABLE,
      canConfirm: false, canPromote: false,
      displayState: 'needs_review',
      eligibility: 'ineligible',
      ineligibleReasons: ['judgment_is_meta_commentary'],
      eligibilityAdvisories: ['rule_missing_boundary'],
    });

    expect(html).toContain(zh['cognition.detail_block_title']);
    expect(html).not.toContain(zh['cognition.candidate_advisory_prefix']);
  });

  it('soft_warning 但欠缺列表为空时不渲染（前端不猜）', () => {
    const html = renderDetail({
      ...ACTIONABLE,
      displayState: 'needs_review',
      eligibility: 'soft_warning',
      ineligibleReasons: [],
      eligibilityAdvisories: [],
    });

    expect(html).not.toContain(zh['cognition.candidate_advisory_prefix']);
  });

  it('未知码不上屏（内部标识不直接展示）', () => {
    const html = renderDetail({
      ...ACTIONABLE,
      displayState: 'needs_review',
      eligibility: 'soft_warning',
      ineligibleReasons: [],
      eligibilityAdvisories: ['made_up_future_code'],
    });

    expect(html).not.toContain('made_up_future_code');
    expect(html).not.toContain(zh['cognition.candidate_advisory_prefix']);
  });
});

it('shows formation comparison reason, exact baseline and incomplete coverage in the existing review detail', () => {
  const item = { ...candidate(ACTIONABLE), formationComparison: { relation: 'exception', reason: '保留周报默认结构，只补临时简报的例外。',
    targetVersion: '2', targetQuote: '周报先给结论。', coverage: { truncated: true, unavailable: 0 } } };
  const html = renderCognition({ name: 'review', candidateId: item.id }, { candidates: [item] });
  expect(html).toContain(item.formationComparison.reason);
  expect(html).toContain(item.formationComparison.targetQuote);
  expect(html).toContain(zh['cognition.formation_comparison_partial']);
  expect(html).toContain('v2');
  expect(html.split(item.formationComparison.reason)).toHaveLength(2);
  const loaded = loadCognitionAssets({ candidates: [item] });
  const compact = loaded.ns.candidate.formCard(item, { compact: true });
  expect(compact.split(item.formationComparison.reason)).toHaveLength(2);
  expect(compact.split(item.formationComparison.targetQuote)).toHaveLength(2);
});

it('labels host-confirmed conversational creation without making it a nightly activity proposal', () => {
  const item = { ...candidate(ACTIONABLE), captureProvenance: undefined,
    humanInstructionProvenance: { schemaVersion: 1, pipeline: 'human_instruction' } };
  const loaded = loadCognitionAssets({ candidates: [item] });
  const html = loaded.ns.candidate.card(item, false);
  expect(html).toContain(zh['cognition.source_immediate']);
  expect(html).not.toContain(zh['cognition.source_capture']);
  expect(loaded.ns.candidate.attentionReady(item)).toBe(false);
});
