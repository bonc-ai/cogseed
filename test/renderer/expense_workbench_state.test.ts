import { describe, expect, it } from 'vitest';

import state from '../../src/renderer/modules/expense-workbench-state.js';

describe('expense workbench pure state', () => {
  it('normalizes state without retaining invalid pages or mutable collection references', () => {
    const applications = [{ application_id: 'APP-1' }];
    const value = state.createState({ page: 'not-a-page', applications });
    applications.push({ application_id: 'APP-2' });

    expect(value.page).toBe('assistant');
    expect(value.applications).toEqual([{ application_id: 'APP-1' }]);
    expect(value.loading).toBe(false);
    expect(value.busy).toEqual({});
  });

  it('invalidates stale page results through a monotonic epoch', () => {
    const value = state.createState();
    const first = state.nextPageEpoch(value, 'applications');
    const second = state.nextPageEpoch(value, 'audit');

    expect(second).toBe(first + 1);
    expect(state.isCurrentEpoch(value, first)).toBe(false);
    expect(state.isCurrentEpoch(value, second)).toBe(true);
    expect(value.loading).toBe(true);
  });

  it('rejects malformed drafts and accepts bounded positive expense items', () => {
    expect(state.parseDraftText('{')).toMatchObject({ ok: false, code: 'draft_invalid_json' });
    expect(state.validateDraftPayload({ expense_items: [] })).toMatchObject({ ok: false, code: 'draft_missing_items' });
    expect(state.validateDraftPayload({ expense_items: [{ amount: 0 }] })).toMatchObject({ ok: false, code: 'draft_invalid_amount' });
    expect(state.parseDraftText(JSON.stringify({ expense_items: [{ amount: 12.5 }] }))).toMatchObject({ ok: true });
  });

  it('records stale response conflicts and bounded recoverable errors', () => {
    const value = state.createState();
    expect(state.applyVersionGuard(value, 4, 3)).toBe(false);
    expect(value.conflict).toMatchObject({ expectedVersion: 4, incomingVersion: 3, kind: 'stale_response' });

    expect(state.normalizeError({ code: 'component_unavailable', message: 'offline', retryable: true }, 'fallback'))
      .toEqual({ code: 'component_unavailable', message: 'offline', retryable: true });
  });

  it('tracks busy operations and clears transient state deterministically', () => {
    const value = state.createState({ message: 'old', error: { code: 'x' } });
    state.setBusy(value, 'save', true);
    state.setProgress(value, 'save', 'Saving', 'running');
    expect(state.isBusy(value, 'save')).toBe(true);
    state.clearTransient(value);
    state.setBusy(value, 'save', false);
    expect(value).toMatchObject({ message: '', error: null, conflict: null, recovery: null, progress: null });
    expect(state.isBusy(value, 'save')).toBe(false);
  });
});
