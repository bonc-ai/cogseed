import { describe, expect, it } from 'vitest';
import { renderCognition } from './helpers/cognition-renderer';

const terminalCapabilities = (displayState: string) => ({
  canView: true,
  canEdit: false,
  canConfirm: false,
  canPromote: false,
  canReject: false,
  canDefer: false,
  canRetry: false,
  canBatchSelect: false,
  needsUserAction: false,
  countsAsPending: false,
  isSnoozed: false,
  isTerminal: true,
  displayState,
});

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-done',
    status: 'confirmed',
    judgment: 'Prefer answers grounded in current project materials.',
    value: 'Prefer answers grounded in current project materials.',
    summary: 'Use project evidence',
    suggestedType: 'personal',
    suggestedScope: 'general',
    suggestedAction: 'create',
    risk: 'low',
    sourceRefs: [],
    evidenceRefs: [],
    capabilities: terminalCapabilities('confirmed'),
    ...overrides,
  };
}

describe('candidate detail reflects the candidate lifecycle', () => {
  it('shows a saved candidate as saved and links to the asset users can edit or pause', () => {
    const html = renderCognition(
      { name: 'review', candidateId: 'candidate-done' },
      { candidates: [candidate({ promotedAssetId: 'asset-saved' })] },
    );

    expect(html).toContain('已保存');
    expect(html).not.toContain('待确认');
    expect(html).toContain('已保存为正式资产');
    expect(html).toContain('data-act="go-inbox-asset"');
    expect(html).toContain('data-id="asset-saved"');
    expect(html).toContain('建议详情');
    expect(html).not.toContain('确认内容，也确认它该在什么范围生效');
  });

  it('shows an ignored duplicate as processed and links to the surviving suggestion', () => {
    const html = renderCognition(
      { name: 'review', candidateId: 'candidate-done' },
      {
        candidates: [candidate({
          status: 'ignored',
          mergedInto: 'candidate-survivor',
          capabilities: terminalCapabilities('ignored'),
        })],
      },
    );

    expect(html).toContain('已忽略');
    expect(html).not.toContain('待确认');
    expect(html).toContain('data-act="open-candidate"');
    expect(html).toContain('data-id="candidate-survivor"');
    expect(html).toContain('查看合并后的建议');
  });
});
