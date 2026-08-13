import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const start = conversationSource.indexOf('function _renderKStarReviewCard');
const end = conversationSource.indexOf('\nfunction _wakeRequestHost', start);
const p3394CardSource = conversationSource.slice(start, end);

describe('P3394 KSTAR experience controls', () => {
  it('hydrates persisted KSTAR and experience states over stale message snapshots', async () => {
    const card: any = {
      dataset: { kstarRunId: 'run-1', busy: '1' },
      className: 'chat-kstar-review is-needs_review',
      innerHTML: '',
      querySelectorAll: vi.fn(() => []),
    };
    const apiFetch = vi.fn(async () => ({
      json: async () => ({
        ok: true,
        runs: [{
          id: 'run-1',
          status: 'completed',
          agent_id: 'agent-1',
          turn_id: 'turn-1',
          verification: { status: 'passed' },
          experience_candidate_id: 'exp-1',
        }],
        experience_candidates: [{ id: 'exp-1', source_run_id: 'run-1', status: 'pending' }],
      }),
    }));
    const sandbox: any = {
      apiFetch,
      currentCid: 'cid-1',
      document: {
        querySelectorAll: vi.fn((selector: string) => {
          expect(selector).toBe('#chat-history .chat-kstar-review[data-kstar-run-id]');
          return [card];
        }),
      },
      encodeURIComponent,
      escapeHtml: (value: unknown) => String(value ?? ''),
      t: (key: string) => key,
      _convLog: { warn: vi.fn() },
      uiAlert: vi.fn(async () => undefined),
      console,
    };
    vm.runInNewContext(p3394CardSource, sandbox, { filename: 'conversation-p3394-card.js' });

    await sandbox._hydrateKStarReviews('cid-1');

    expect(apiFetch).toHaveBeenCalledWith('/api/conversations/cid-1/kstar');
    expect(card.className).toBe('chat-kstar-review is-completed');
    expect(card.dataset.busy).toBe('');
    expect(card.innerHTML).toContain('p3394.kstar.status.completed');
    expect(card.innerHTML).toContain('p3394.experience.approve');
    expect(card.innerHTML).toContain('p3394.experience.reject');
  });

  it('clears the review busy state before enabling an experience decision', async () => {
    const candidate = { id: 'exp-1', status: 'pending' };
    const experienceButton: any = {
      dataset: { experienceDecision: 'reject' },
      addEventListener: vi.fn((_type: string, listener: () => Promise<void>) => {
        experienceButton.listener = listener;
      }),
    };
    const card: any = {
      dataset: {},
      className: '',
      innerHTML: '',
      querySelectorAll(selector: string) {
        if (selector === '[data-experience-decision]' && this.innerHTML.includes('experience.reject')) {
          return [experienceButton];
        }
        return [];
      },
    };
    const apiFetch = vi.fn(async () => {
      if (apiFetch.mock.calls.length === 1) {
        return {
          json: async () => ({
            ok: true,
            run: { status: 'passed' },
            experience_candidate: candidate,
          }),
        };
      }
      return { json: async () => ({ ok: true, candidate: { ...candidate, status: 'rejected' } }) };
    });
    const sandbox: any = {
      apiFetch,
      encodeURIComponent,
      escapeHtml: (value: unknown) => String(value ?? ''),
      t: (key: string) => key,
      _convLog: { warn: vi.fn() },
      uiAlert: vi.fn(async () => undefined),
      console,
    };
    vm.runInNewContext(p3394CardSource, sandbox, { filename: 'conversation-p3394-card.js' });

    await sandbox._resolveKStarReview(card, { run_id: 'run-1', status: 'needs_review' }, 'cid-1', 'pass');
    expect(experienceButton.listener).toBeTypeOf('function');

    await experienceButton.listener();

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[1][0]).toContain('/experience/exp-1/decision');
    expect(card.dataset.busy).toBe('');
  });

  it('syncs promoted experience candidates to Notion and re-renders the returned state', async () => {
    const card: any = {
      dataset: {},
      className: '',
      innerHTML: '',
      querySelectorAll: vi.fn(() => []),
    };
    const apiFetch = vi.fn(async () => ({
      json: async () => ({
        ok: true,
        candidate: {
          id: 'exp-1',
          status: 'approved',
          promotion_status: 'promoted',
          kb_path: 'kstar-experiences/2026/07/exp-1.md',
          notion_sync: { status: 'synced', url: 'https://notion.test/page' },
        },
      }),
    }));
    const sandbox: any = {
      apiFetch,
      encodeURIComponent,
      escapeHtml: (value: unknown) => String(value ?? ''),
      t: (key: string) => key,
      _convLog: { warn: vi.fn() },
      uiAlert: vi.fn(async () => undefined),
      console,
    };
    vm.runInNewContext(p3394CardSource, sandbox, { filename: 'conversation-p3394-card.js' });

    await sandbox._syncExperienceCandidateToNotion(card, { run_id: 'run-1', status: 'completed' }, { id: 'exp-1' }, 'cid-1');

    expect(apiFetch).toHaveBeenCalledWith('/api/conversations/cid-1/experience/exp-1/notion-sync', expect.objectContaining({ method: 'POST' }));
    expect(card.dataset.busy).toBe('');
    expect(card.innerHTML).toContain('p3394.experience.notion_synced');
    expect(card.innerHTML).toContain('https://notion.test/page');
  });

  it('shows the Notion failure reason returned by the backend', async () => {
    const card: any = {
      dataset: {},
      className: '',
      innerHTML: '',
      querySelectorAll: vi.fn(() => []),
    };
    const apiFetch = vi.fn(async () => ({
      json: async () => ({
        ok: false,
        error: 'Notion sync target is not configured. Set ORKAS_KSTAR_NOTION_PARENT_ID.',
        candidate: {
          id: 'exp-1',
          status: 'approved',
          promotion_status: 'promoted',
          kb_path: 'kstar-experiences/2026/07/exp-1.md',
          notion_sync: { status: 'failed', error: 'Notion sync target is not configured. Set ORKAS_KSTAR_NOTION_PARENT_ID.' },
        },
      }),
    }));
    const uiAlert = vi.fn(async () => undefined);
    const sandbox: any = {
      apiFetch,
      encodeURIComponent,
      escapeHtml: (value: unknown) => String(value ?? ''),
      t: (key: string) => key,
      _convLog: { warn: vi.fn() },
      uiAlert,
      console,
    };
    vm.runInNewContext(p3394CardSource, sandbox, { filename: 'conversation-p3394-card.js' });

    await sandbox._syncExperienceCandidateToNotion(card, { run_id: 'run-1', status: 'completed' }, { id: 'exp-1' }, 'cid-1');

    expect(card.dataset.busy).toBe('');
    expect(card.innerHTML).toContain('ORKAS_KSTAR_NOTION_PARENT_ID');
    expect(uiAlert).toHaveBeenCalledWith(expect.stringContaining('ORKAS_KSTAR_NOTION_PARENT_ID'));
  });

});
