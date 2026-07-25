import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const start = conversationSource.indexOf('function _renderPatchCandidateCard');
const end = conversationSource.indexOf('\nfunction _wakeRequestHost', start);
const patchCandidateSource = conversationSource.slice(start, end);

function loadSandbox(overrides: Record<string, unknown> = {}) {
  const sandbox: any = {
    apiFetch: vi.fn(),
    currentCid: 'cid-1',
    document: { querySelectorAll: vi.fn(() => []) },
    encodeURIComponent,
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    _convLog: { warn: vi.fn() },
    uiAlert: vi.fn(async () => undefined),
    console,
    ...overrides,
  };
  vm.runInNewContext(patchCandidateSource, sandbox, { filename: 'conversation-patch-candidates.js' });
  return sandbox;
}

describe('P3394 patch candidate review center', () => {
  it('renders a candidate with summary, type, status, details, and approve/reject controls', () => {
    const approveButton: any = { dataset: { patchCandidateReview: 'approve' }, addEventListener: vi.fn() };
    const rejectButton: any = { dataset: { patchCandidateReview: 'reject' }, addEventListener: vi.fn() };
    const card: any = {
      dataset: {},
      className: '',
      innerHTML: '',
      querySelectorAll(selector: string) {
        if (selector === '[data-patch-candidate-review]') return [approveButton, rejectButton];
        return [];
      },
      querySelector: vi.fn(() => null),
    };
    const sandbox = loadSandbox();

    sandbox._renderPatchCandidateCard(card, 'cid-1', {
      id: 'patch-1',
      type: 'skill_patch',
      status: 'needs_review',
      source_run_id: 'run-1',
      proposal: {
        title: 'Improve writing skill',
        summary: 'Add chunked writing guidance',
        rationale: 'Long papers need staged drafting',
        proposed_content: 'Use staged section drafting before final synthesis',
      },
      engine: { route_action: 'propose_skill_patch', attribution_id: 'attr-1' },
      review: { notes: 'reviewed by KSTAR' },
    });

    expect(card.className).toBe('chat-patch-candidate is-needs_review');
    expect(card.dataset.patchCandidateId).toBe('patch-1');
    expect(card.dataset.busy).toBe('');
    expect(card.innerHTML).toContain('Improve writing skill');
    expect(card.innerHTML).toContain('Add chunked writing guidance');
    expect(card.innerHTML).toContain('skill_patch');
    expect(card.innerHTML).toContain('needs_review');
    expect(card.innerHTML).toContain('p3394.patch.details');
    expect(card.innerHTML).toContain('Long papers need staged drafting');
    expect(card.innerHTML).toContain('Use staged section drafting before final synthesis');
    expect(card.innerHTML).toContain('propose_skill_patch');
    expect(card.innerHTML).toContain('attr-1');
    expect(card.innerHTML).toContain('reviewed by KSTAR');
    expect(card.innerHTML).toContain('p3394.patch.approve');
    expect(card.innerHTML).toContain('p3394.patch.reject');
    expect(approveButton.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    expect(rejectButton.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('approves a candidate through the conversation patch-candidate endpoint', async () => {
    const card: any = {
      dataset: {},
      className: '',
      innerHTML: '',
      querySelectorAll: vi.fn(() => []),
      querySelector: vi.fn((selector: string) => (
        selector === '.chat-patch-candidate-notes' ? { value: 'review note' } : null
      )),
    };
    const apiFetch = vi.fn(async () => ({
      json: async () => ({ ok: true, patch_candidate: { id: 'patch-1', status: 'approved', proposal: { title: 'done' } } }),
    }));
    const sandbox = loadSandbox({ apiFetch });

    await sandbox._resolvePatchCandidateReview(card, 'cid-1', { id: 'patch-1', status: 'needs_review' }, 'approve');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/conversations/cid-1/patch-candidates/patch-1/review',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body).toEqual({ decision: 'approve', notes: 'review note' });
    expect(card.className).toBe('chat-patch-candidate is-approved');
    expect(card.dataset.busy).toBe('');
    expect(card.innerHTML).toContain('done');
  });

  it('clears busy and alerts when a successful review response has no candidate payload', async () => {
    const card: any = {
      dataset: {},
      className: 'chat-patch-candidate is-needs_review',
      innerHTML: 'original',
      querySelectorAll: vi.fn(() => []),
      querySelector: vi.fn(() => null),
    };
    const apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    const uiAlert = vi.fn(async () => undefined);
    const sandbox = loadSandbox({ apiFetch, uiAlert });

    await sandbox._resolvePatchCandidateReview(card, 'cid-1', { id: 'patch-1', status: 'needs_review' }, 'approve');

    expect(card.dataset.busy).toBe('');
    expect(card.className).toBe('chat-patch-candidate is-needs_review');
    expect(card.innerHTML).toBe('original');
    expect(uiAlert).toHaveBeenCalledWith('p3394.patch.review_failed');
  });

  it('hydrates patch candidates into the review center host for the current conversation', async () => {
    const children: any[] = [];
    const host: any = {
      id: 'chat-patch-candidates-host',
      className: 'chat-patch-candidates-host',
      innerHTML: '',
      dataset: {},
      appendChild(node: any) { children.push(node); return node; },
    };
    const document = {
      querySelector: vi.fn((selector: string) => (selector === '#chat-patch-candidates-host' ? host : null)),
      createElement: vi.fn(() => ({
        dataset: {},
        className: '',
        innerHTML: '',
        querySelectorAll: vi.fn(() => []),
        querySelector: vi.fn(() => null),
      })),
      querySelectorAll: vi.fn(() => []),
    };
    const apiFetch = vi.fn(async () => ({
      json: async () => ({
        ok: true,
        patch_candidates: [{
          id: 'patch-1',
          status: 'needs_review',
          type: 'skill_patch',
          proposal: { title: 'Patch 1', summary: 'Summary 1' },
        }],
      }),
    }));
    const sandbox = loadSandbox({ apiFetch, document });

    await sandbox._hydratePatchCandidates('cid-1');

    expect(apiFetch).toHaveBeenCalledWith('/api/conversations/cid-1/patch-candidates');
    expect(host.innerHTML).toContain('p3394.patch.center_title');
    expect(children).toHaveLength(1);
    expect(children[0].dataset.patchCandidateId).toBe('patch-1');
  });

  it('creates a review center host when one does not already exist', async () => {
    const historyChildren: any[] = [];
    let createdHost: any = null;
    const history = { appendChild: vi.fn((node: any) => { historyChildren.push(node); return node; }) };
    const document = {
      querySelector: vi.fn((selector: string) => (selector === '#chat-patch-candidates-host' ? null : null)),
      getElementById: vi.fn((id: string) => (id === 'chat-history' ? history : null)),
      createElement: vi.fn(() => {
        createdHost = {
          id: '',
          className: '',
          innerHTML: '',
          dataset: {},
          setAttribute: vi.fn(),
          appendChild: vi.fn(),
        };
        return createdHost;
      }),
      querySelectorAll: vi.fn(() => []),
    };
    const sandbox = loadSandbox({ document });

    const host = sandbox._patchCandidateHost('cid-1', { create: true });

    expect(host).toBe(createdHost);
    expect(host.id).toBe('chat-patch-candidates-host');
    expect(host.className).toBe('chat-patch-candidates-host');
    expect(host.setAttribute).toHaveBeenCalledWith('role', 'region');
    expect(host.setAttribute).toHaveBeenCalledWith('aria-live', 'polite');
    expect(history.appendChild).toHaveBeenCalledWith(host);
    expect(historyChildren).toEqual([host]);
  });

  it('defines patch candidate styles and locale keys', () => {
    const styleSource = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');
    const en = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
    const zh = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'));
    const ja = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/ja.json'), 'utf8'));
    const pt = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/pt.json'), 'utf8'));

    expect(styleSource).toContain('.chat-patch-candidates-host');
    expect(styleSource).toContain('.chat-patch-candidate {');
    expect(en['p3394.patch.center_title']).toBe('KSTAR Review Center');
    expect(en['p3394.patch.approve']).toBe('Approve');
    expect(zh['p3394.patch.center_title']).toBeTruthy();
    expect(zh['p3394.patch.approve']).toBeTruthy();
    expect(ja['p3394.patch.center_title']).toBeTruthy();
    expect(pt['p3394.patch.center_title']).toBeTruthy();
  });
});
