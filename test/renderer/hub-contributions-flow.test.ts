import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modelSource = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/hub-contributions-model.js'), 'utf8');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/hub-contributions.js'), 'utf8');

type Handler = (event: any) => unknown;

// A minimal DOM: each page host keeps its rendered HTML, and lookups answer from
// that HTML plus the values a test "typed". It is enough to drive the real page
// module through clicks and inputs without a browser.
function makeHost() {
  const handlers: Record<string, Handler[]> = {};
  const nodes = new Map<string, any>();
  let html = '';
  const host: any = {
    style: { display: 'none' },
    dataset: {} as Record<string, string>,
    values: {} as Record<string, { value?: string; checked?: boolean }>,
    focusInside: '' as string,
    focusSpy: vi.fn(),
    get innerHTML() { return html; },
    set innerHTML(value: string) {
      html = value;
      nodes.clear();
    },
    addEventListener(type: string, handler: Handler) { (handlers[type] ||= []).push(handler); },
    node(selector: string) {
      if (!nodes.has(selector)) {
        const classes = new Set<string>(
          /<button[^>]*class="[^"]*\bis-disabled\b[^"]*"[^>]*data-hubc-action="submit"/.test(html) ? ['is-disabled'] : [],
        );
        nodes.set(selector, {
          disabled: /<button[^>]*data-hubc-action="submit"[^>]*disabled/.test(html),
          classList: {
            toggle(name: string, force?: boolean) {
              const on = force ?? !classes.has(name);
              if (on) classes.add(name); else classes.delete(name);
              return on;
            },
            contains: (name: string) => classes.has(name),
          },
          hidden: false, textContent: '', innerHTML: '', focus() {},
          contains: () => host.focusInside === selector,
          querySelector: () => ({ focus: host.focusSpy }),
        });
      }
      return nodes.get(selector);
    },
    querySelector(selector: string) {
      if (selector.startsWith('#')) {
        const id = selector.slice(1);
        if (!html.includes(`id="${id}"`)) return null;
        const typed = host.values[id] || {};
        return { id, value: typed.value ?? '', checked: typed.checked ?? false, focus() {}, setSelectionRange() {} };
      }
      if (selector === '[data-hubc-action="submit"]' && !html.includes('data-hubc-action="submit"')) return null;
      const known = ['[data-hubc-action="submit"]', '[data-hubc-missing]', '[data-hubc-file-content]', '[data-hubc-origin-refs]',
        '[data-hubc-list]', '[data-hubc-detail]', '[data-hubc-filters]'];
      return known.includes(selector) ? host.node(selector) : null;
    },
    querySelectorAll(selector: string) {
      if (selector !== '[data-ui-select]') return [];
      return Array.from(html.matchAll(/id="([^"]+)" data-ui-select/g)).map((match) => ({ id: match[1] }));
    },
    async dispatch(type: string, event: any) {
      await Promise.all((handlers[type] || []).map((handler) => handler(event)));
    },
    text() {
      return [html, ...Array.from(nodes.values()).map((node) => `${node.innerHTML} ${node.textContent}`)].join(' ');
    },
  };
  return host;
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

type Options = {
  skills?: Array<{ id: string; name: string }>;
  choice?: (options: any) => Promise<string | null>;
  confirm?: (options: any) => Promise<boolean>;
  fakeTimers?: boolean;
};

const pages: Array<{ root: Record<string, any> }> = [];

function loadPage(invoke: (channel: string, payload: any) => Promise<any>, options: Options = {}) {
  if (options.fakeTimers) vi.useFakeTimers();
  const listeners = new Map<string, (payload: unknown) => void>();
  const hosts = { contribute: makeHost(), mine: makeHost() };
  const grid = { style: { display: 'flex' } };
  const detail = { style: { display: 'none' } };
  const selects: Record<string, string> = {};
  const attrs = (map: Record<string, unknown> = {}) => Object.entries(map)
    .filter(([, value]) => value !== false && value != null)
    .map(([key, value]) => `${key}="${value === true ? '' : value}"`).join(' ');
  const root: Record<string, any> = {
    cogseed: {
      invoke: vi.fn(invoke),
      onPushEvent(channel: string, handler: (payload: unknown) => void) {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      },
    },
    t: (key: string) => key,
    getCustomContributionSkills: () => options.skills ?? [{ id: 'skill-a', name: 'Skill A' }],
    uiConfirm: vi.fn(options.confirm ?? (async () => true)),
    uiConfirmDanger: vi.fn(async () => true),
    uiAlert: vi.fn(async () => undefined),
    uiChoice: vi.fn(options.choice ?? (async (choiceOptions: any) => choiceOptions.choices?.[0]?.id ?? 'original')),
    uiPrompt: vi.fn(async () => 'fixture reason'),
    uiToast: vi.fn(),
    uiModal: vi.fn(() => Promise.resolve({ value: 'close' })),
    uiButton: vi.fn(({ label, disabled, loading, attrs: buttonAttrs }: any) =>
      `<button class="ui-button${disabled || loading ? ' is-disabled' : ''}" ${attrs(buttonAttrs)}${disabled || loading ? ' disabled' : ''}>${label}</button>`),
    uiIconHtml: () => '',
    uiForm: vi.fn(({ fields }: any) => fields.map((field: any) => field.html).join('')),
    uiField: vi.fn(({ id, control }: any) => (control?.kind === 'select'
      ? `<div id="${id}" data-ui-select></div>`
      : `<div id="${id}" data-field></div>`)),
    uiCheckbox: vi.fn(({ id }: any) => `<input id="${id}" type="checkbox">`),
    uiInput: vi.fn(({ id }: any) => `<input id="${id}">`),
    uiSegmentedControl: vi.fn(({ items }: any) => items.map((item: any) => `<b data-hubc-filter="${item.value}">${item.label}</b>`).join('')),
    hydrateUiFormSelects: vi.fn((container: any) => container.querySelectorAll('[data-ui-select]')
      .map((host: any) => ({ getValue: () => selects[host.id] || '' }))),
    uiSkeleton: vi.fn(() => '<div role="status">skeleton</div>'),
    uiStatusPill: vi.fn(({ label }: any) => `<span role="status">${label}</span>`),
    uiResourceCard: vi.fn(({ title, description }: any) => `<article>${title} ${description}</article>`),
    uiResourceGrid: vi.fn(({ bodyHtml }: any) => `<section>${bodyHtml}</section>`),
    uiEmptyState: vi.fn(({ title }: any) => `<p>${title}</p>`),
  };
  const document = {
    activeElement: null,
    getElementById(id: string) {
      if (id === 'skills-contribute-view') return hosts.contribute;
      if (id === 'skills-contributions-view') return hosts.mine;
      if (id === 'skills-grid-view') return grid;
      if (id === 'skills-detail-view') return detail;
      return null;
    },
    querySelector: () => null,
  };
  const renderMarkdown = vi.fn((markdown: string) => `<p data-rendered-markdown>${markdown}</p>`);
  const context = vm.createContext({
    window: root, document, renderMarkdown, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    // Mirrors skills.js: showing the grid again also hides the contribution pages.
    _showSkillsGridView() { root.hideContributionViews(); grid.style.display = 'flex'; },
  });
  vm.runInContext(modelSource, context);
  vm.runInContext(source, context);
  const page = {
    root, hosts, grid, selects, renderMarkdown,
    emit: (channel: string, payload: unknown) => listeners.get(channel)?.(payload),
    async click(kind: 'contribute' | 'mine', action: string, extra: Record<string, string> = {}) {
      const dataset = { hubcAction: action, ...extra };
      await hosts[kind].dispatch('click', {
        target: { closest: (selector: string) => (selector.includes('data-hubc-action') ? { dataset } : null) },
      });
      await settle();
    },
    async clickFilter(filter: string) {
      await hosts.mine.dispatch('click', {
        target: { closest: (selector: string) => (selector.includes('data-hubc-filter') ? { dataset: { hubcFilter: filter } } : null) },
      });
    },
    async input(kind: 'contribute' | 'mine', id: string, value?: string) {
      await hosts[kind].dispatch('input', { target: { id, value } });
      await settle();
    },
    calls: () => (root.cogseed.invoke as ReturnType<typeof vi.fn>).mock.calls.map(([channel, payload]: any[]) => ({ channel, payload })),
  };
  pages.push(page);
  return page;
}

type Page = ReturnType<typeof loadPage>;

function openTerms() {
  return { state: { status: 'open', terms: { version: '2026-09-24', body_markdown: 'Terms' } } };
}

function passState(overrides: Record<string, unknown> = {}) {
  return {
    admission: {
      outcome: 'pass',
      issues: [],
      components: { ruleset: { version: '1.0.0', ready: true }, sentry: { version: '2.1.0', ready: true }, declaration: { version: '1.3.0', ready: true }, ontologyVersion: '1.1.1' },
      scan: { outcome: 'pass', isolated: true, instructionRisk: 'clean' },
      declaration: { outcome: 'pass', findings: [] },
    },
    completion: { missing: [], conflicts: [], present: { name: 'Skill A', description: 'Preview description', version: '1.1.0' } },
    preview: { digest: 'a'.repeat(64), files: [{ path: 'SKILL.md', size: 8, sha256: 'b'.repeat(64) }] },
    originPrefill: { locked: false, type: null, forked_from: null },
    ...overrides,
  };
}

const mineSuccess = {
  ok: true,
  stale: false,
  cache: {
    generated_at: '2026-09-20T09:00:00Z',
    last_success_at: '2026-09-20T09:00:00Z',
    items: {
      a: {
        entry_id: 'a', content_id: '8a4f01c29d7e', name: 'Meeting Notes', content_status: 'published', current_published_version: '1.0.0',
        latest_submission: { submission_id: 'sub_pending', status: 'PENDING_REVIEW', version: '1.1.0', submitted_at: '2026-09-20T08:00:10Z', declarations_origin: { type: 'original', note: null, forked_from: null } },
        withdrawal_request: null, updated_at: '2026-09-20T08:00:10Z',
      },
    },
  },
};

function withItem(patch: Record<string, unknown>, latestPatch: Record<string, unknown> = {}) {
  const base = mineSuccess.cache.items.a;
  return {
    ...mineSuccess,
    cache: { ...mineSuccess.cache, items: { a: { ...base, ...patch, latest_submission: { ...base.latest_submission, ...latestPatch } } } },
  };
}

function router(overrides: Record<string, (payload: any) => any> = {}) {
  return async (channel: string, payload: any) => {
    if (overrides[channel]) return overrides[channel](payload);
    if (channel === 'contribution.preflight') return { identity: { outcome: 'ready', displayName: 'Fixture Contributor' } };
    if (channel === 'contribution.terms') return openTerms();
    if (channel === 'contribution.start') return { ...passState(), token: 'abc123def456' };
    if (channel === 'contribution.recheck') return passState();
    if (channel === 'contribution.readFile') return { content: '# Skill A body', binary: false };
    if (channel === 'contribution.confirm') return { confirmed: true };
    if (channel === 'contribution.submit') return { ok: true };
    if (channel === 'contribution.mine') return mineSuccess;
    return { ok: true };
  };
}

async function reachPreview(page: Page) {
  await page.root.startSkillContribution('skill-a', 'Skill A');
  await settle();
  expect(page.hosts.contribute.innerHTML).toContain('data-hubc-stage="preview"');
}

async function acceptDeclarations(page: Page, origin = 'original') {
  page.selects['hubc-origin-type'] = origin;
  page.hosts.contribute.values['hubc-accept-terms'] = { checked: true };
  page.hosts.contribute.values['hubc-accept-maintenance'] = { checked: true };
  await page.input('contribute', 'hubc-accept-terms');
}

afterEach(() => {
  // Leaving the pages stops any My contributions polling a test left running.
  for (const page of pages.splice(0)) page.root.hideContributionViews();
  vi.useRealTimers();
});

describe('Hub contribution page: stages', () => {
  it('shows the contribution page in place of the grid and walks check → preview', async () => {
    const page = loadPage(router());
    await reachPreview(page);

    const html = page.hosts.contribute.innerHTML;
    expect(page.hosts.contribute.style.display).toBe('flex');
    expect(page.grid.style.display).toBe('none');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('Preview and declarations');
    expect(html).toContain('SKILL.md');
    expect(page.calls().map((call) => call.channel).slice(0, 5)).toEqual([
      'contribution.preflight', 'contribution.terms', 'contribution.start', 'contribution.recheck', 'contribution.readFile',
    ]);
    expect(page.calls().find((call) => call.channel === 'contribution.start')?.payload).toEqual({ skill_id: 'skill-a', defer_check: true });
  });

  it('opens each preview file read-only and shows the submitted metadata', async () => {
    const page = loadPage(router());
    await reachPreview(page);

    expect(page.calls().find((call) => call.channel === 'contribution.readFile')?.payload)
      .toEqual({ token: 'abc123def456', path: 'SKILL.md' });
    expect(page.hosts.contribute.node('[data-hubc-file-content]').textContent).toBe('# Skill A body');
    for (const expected of ['Skill A', '1.1.0', 'Fixture Contributor', '2026-09-24', 'Preview description']) {
      expect(page.hosts.contribute.innerHTML).toContain(expected);
    }
    expect(page.calls().some((call) => call.channel === 'contribution.submit')).toBe(false);
  });

  it('shows binary files as size-only text', async () => {
    const page = loadPage(router({ 'contribution.readFile': () => ({ binary: true, size: 42 }) }));
    await reachPreview(page);

    expect(page.hosts.contribute.node('[data-hubc-file-content]').textContent).toBe('Binary file (42 bytes)');
  });

  it('shows the Hub terms through the shared Markdown seam in a shared modal', async () => {
    const page = loadPage(router());
    await reachPreview(page);
    await page.click('contribute', 'read-terms');

    expect(page.renderMarkdown).toHaveBeenCalledWith('Terms');
    const dialog = page.root.uiModal.mock.calls[0][0];
    expect(dialog.title).toBe('Community Contribution Terms');
    expect(dialog.bodyHtml).toContain('data-rendered-markdown');
  });

  it('collects simple security choices instead of raw YAML and rechecks before preview', async () => {
    let completed = false;
    const page = loadPage(router({
      'contribution.start': () => ({
        ...passState(),
        token: 'abc123def456',
        admission: { outcome: 'pending', issues: [] },
        completion: { missing: ['version', 'security_manifest'], conflicts: [], present: { name: 'Skill A', description: 'Preview description' } },
      }),
      'contribution.complete': () => { completed = true; return passState(); },
      'contribution.recheck': () => (completed ? passState() : { admission: { outcome: 'pending' } }),
    }));
    await page.root.startSkillContribution('skill-a', 'Skill A');
    await settle();

    const html = page.hosts.contribute.innerHTML;
    expect(html).toContain('data-hubc-stage="complete"');
    expect(html).toContain('contrib-network-access');
    expect(html).not.toContain('security-manifest');
    expect(html).toContain('Version: required.');

    // Missing answers keep the form open and never reach the main process.
    await page.click('contribute', 'complete-save');
    expect(page.root.uiAlert).toHaveBeenCalledWith('Choose an answer for every security item.');
    expect(page.calls().some((call) => call.channel === 'contribution.complete')).toBe(false);

    Object.assign(page.selects, {
      'contrib-network-access': 'restricted', 'contrib-file-access': 'read_selected',
      'contrib-command-access': 'declared_tools', 'contrib-sensitive-data': 'none',
    });
    Object.assign(page.hosts.contribute.values, {
      'contrib-name': { value: 'Skill A' }, 'contrib-description': { value: 'Preview description' }, 'contrib-version': { value: '1.1.0' },
      'contrib-network-allowlist': { value: 'api.example.com' }, 'contrib-external-tools': { value: 'git' },
    });
    await page.click('contribute', 'complete-save');

    expect(page.calls().find((call) => call.channel === 'contribution.complete')?.payload).toEqual({
      token: 'abc123def456', name: 'Skill A', description: 'Preview description', version: '1.1.0',
      security_declaration: {
        network_access: 'restricted', network_allowlist: 'api.example.com', file_access: 'read_selected',
        command_access: 'declared_tools', external_tools: 'git', sensitive_data: 'none',
      },
    });
    const channels = page.calls().map((call) => call.channel);
    expect(channels.indexOf('contribution.recheck')).toBeGreaterThan(channels.indexOf('contribution.complete'));
    expect(page.hosts.contribute.innerHTML).toContain('data-hubc-stage="preview"');
  });

  it('requires a domain when network access is restricted and a tool when commands are declared', async () => {
    const page = loadPage(router({
      'contribution.start': () => ({
        ...passState(), token: 'abc123def456', admission: { outcome: 'pending' },
        completion: { missing: ['security_manifest'], conflicts: [], present: { name: 'Skill A', description: 'd', version: '1.0.0' } },
      }),
    }));
    await page.root.startSkillContribution('skill-a', 'Skill A');
    Object.assign(page.selects, {
      'contrib-network-access': 'restricted', 'contrib-file-access': 'none', 'contrib-command-access': 'none', 'contrib-sensitive-data': 'none',
    });
    await page.click('contribute', 'complete-save');
    expect(page.root.uiAlert).toHaveBeenLastCalledWith('List at least one allowed domain.');

    page.selects['contrib-network-access'] = 'none';
    page.selects['contrib-command-access'] = 'declared_tools';
    await page.click('contribute', 'complete-save');
    expect(page.root.uiAlert).toHaveBeenLastCalledWith('List at least one command or external tool.');
    expect(page.calls().some((call) => call.channel === 'contribution.complete')).toBe(false);
  });

  it('returns to the details stage with security fields when the declaration check needs input', async () => {
    const page = loadPage(router({
      'contribution.recheck': () => passState({
        admission: { outcome: 'blocked', reason: 'declaration_absent', issues: [], declaration: { outcome: 'blocked', reason: 'declaration_absent', findings: [] }, components: {} },
      }),
    }));
    await page.root.startSkillContribution('skill-a', 'Skill A');
    await settle();

    const html = page.hosts.contribute.innerHTML;
    expect(html).toContain('data-hubc-stage="complete"');
    expect(html).toContain('contrib-sensitive-data');
    expect(html).toContain('Security declaration: required.');
  });

  it('shows blocking findings per check row and lets the contributor check again', async () => {
    const page = loadPage(router({
      'contribution.recheck': () => passState({
        admission: {
          outcome: 'blocked', reason: 'local_red_lines',
          issues: [{ path: 'scripts/run.sh', rule_id: 'R1', message: 'Absolute path' }],
          components: passState().admission.components, scan: null, declaration: null,
        },
        preview: null,
      }),
    }));
    await page.root.startSkillContribution('skill-a', 'Skill A');
    await settle();

    const html = page.hosts.contribute.innerHTML;
    expect(html).toContain('data-hubc-stage="check"');
    expect(html).toContain('Local checks found blocking issues');
    expect(html).toContain('data-check-state="blocked"');
    expect(html).toContain('data-check-state="skipped"');
    expect(html).toContain('scripts/run.sh · R1 · Absolute path');
    expect(html).toContain('data-hubc-action="recheck"');
    expect(page.calls().some((call) => call.channel === 'contribution.submit')).toBe(false);

    await page.click('contribute', 'recheck');
    expect(page.calls().filter((call) => call.channel === 'contribution.recheck')).toHaveLength(2);
  });

  it('reports an unfinished check as unavailable rather than passed or dangerous', async () => {
    const page = loadPage(router({
      'contribution.recheck': () => passState({
        admission: { outcome: 'blocked', reason: 'scan_unavailable', issues: [], components: passState().admission.components, scan: { outcome: 'unknown', isolated: false, instructionRisk: null }, declaration: null },
        preview: null,
      }),
    }));
    await page.root.startSkillContribution('skill-a', 'Skill A');
    await settle();

    const html = page.hosts.contribute.innerHTML;
    expect(html).toContain('Local checks could not finish');
    expect(html).toContain('Check unavailable');
    expect(html).not.toContain('Local checks found blocking issues');
  });

  it('cancels local checks without previewing or submitting', async () => {
    let releaseCheck: (value: unknown) => void = () => {};
    const page = loadPage(router({
      'contribution.recheck': () => new Promise((resolve) => { releaseCheck = resolve; }),
    }));
    const started = page.root.startSkillContribution('skill-a', 'Skill A');
    await settle();
    expect(page.hosts.contribute.innerHTML).toContain('aria-busy="true"');

    await page.click('contribute', 'cancel-check');
    await started;
    releaseCheck(passState());
    await settle();

    expect(page.calls().filter((call) => call.channel === 'contribution.cancel')).toHaveLength(1);
    expect(page.calls().some((call) => call.channel === 'contribution.submit')).toBe(false);
    expect(page.grid.style.display).toBe('flex');
    expect(page.hosts.contribute.style.display).toBe('none');
  });

  it('returns from preview to editable details', async () => {
    const page = loadPage(router());
    await reachPreview(page);
    await page.click('contribute', 'edit-draft');

    expect(page.hosts.contribute.innerHTML).toContain('data-hubc-stage="complete"');
    expect(page.hosts.contribute.innerHTML).toContain('contrib-version');
  });

  it('ends the session when the page is left through the Skills grid', async () => {
    const page = loadPage(router());
    await reachPreview(page);
    await page.click('contribute', 'back');

    expect(page.calls().filter((call) => call.channel === 'contribution.cancel').map((call) => call.payload))
      .toEqual([{ token: 'abc123def456' }]);
    expect(page.grid.style.display).toBe('flex');
    expect(page.hosts.contribute.innerHTML).toBe('');
  });
});

describe('Hub contribution page: login and terms gates', () => {
  it('keeps the selected Skill context and resumes after a successful web login callback', async () => {
    let signedIn = false;
    const page: Page = loadPage(router({
      'contribution.preflight': () => (signedIn
        ? { identity: { outcome: 'ready', displayName: 'Fixture Contributor' } }
        : { identity: { outcome: 'blocked', reason: 'not_signed_in' } }),
      'hub-account.start_login': () => { signedIn = true; setImmediate(() => page.emit('hub-account:login-result', { result: 'success' })); return { ok: true }; },
    }));
    await page.root.startSkillContribution('skill-a', 'Skill A');
    await settle();

    expect(page.root.uiConfirm).toHaveBeenCalledWith(expect.objectContaining({ okLabel: 'Go to web sign-in' }));
    expect(page.hosts.contribute.innerHTML).toContain('data-hubc-stage="preview"');
  });

  it('does not continue contribution when login is cancelled or fails', async () => {
    const notSignedIn = () => ({ identity: { outcome: 'blocked', reason: 'not_signed_in' } });
    const cancelled = loadPage(router({ 'contribution.preflight': notSignedIn }), { confirm: async () => false });
    await cancelled.root.startSkillContribution('skill-a', 'Skill A');
    expect(cancelled.calls().map((call) => call.channel)).toEqual(['contribution.preflight']);
    expect(cancelled.hosts.contribute.innerHTML).toBe('');

    const failed: Page = loadPage(router({
      'contribution.preflight': notSignedIn,
      'hub-account.start_login': () => { setImmediate(() => failed.emit('hub-account:login-result', { result: 'failed' })); return { ok: true }; },
    }));
    await failed.root.startSkillContribution('skill-a', 'Skill A');
    expect(failed.calls().some((call) => call.channel === 'contribution.start')).toBe(false);
  });

  it('shows a closed-terms notice without starting local checks', async () => {
    const page = loadPage(router({ 'contribution.terms': () => ({ state: { status: 'closed' } }) }));
    await page.root.startSkillContribution('skill-a', 'Skill A');

    expect(page.root.uiAlert).toHaveBeenCalledWith('Contribution is not open right now.');
    expect(page.calls().some((call) => call.channel === 'contribution.start')).toBe(false);
  });
});

describe('Hub contribution page: declarations and submission', () => {
  it('keeps submission unavailable and names what is missing until origin, terms and maintenance are given', async () => {
    const page = loadPage(router());
    await reachPreview(page);
    await page.input('contribute', 'hubc-origin-note');

    const submit = page.hosts.contribute.node('[data-hubc-action="submit"]');
    expect(submit.disabled).toBe(true);
    expect(submit.classList.contains('is-disabled')).toBe(true);
    expect(page.hosts.contribute.node('[data-hubc-missing]').textContent)
      .toBe('Still needed: origin declaration, accept the terms, confirm maintenance responsibility');

    await acceptDeclarations(page);
    expect(submit.disabled).toBe(false);
    // The class carries pointer-events:none in the real stylesheet, so it must clear with the attribute.
    expect(submit.classList.contains('is-disabled')).toBe(false);
    expect(page.hosts.contribute.node('[data-hubc-missing]').textContent).toBe('');
    expect(page.calls().some((call) => call.channel === 'contribution.declare')).toBe(false);
  });

  it('offers a manual Hub-derived origin and sends its association', async () => {
    const page = loadPage(router());
    await reachPreview(page);
    await acceptDeclarations(page, 'derived_from_hub');
    Object.assign(page.hosts.contribute.values, {
      'hubc-origin-content-id': { value: '22f1238eb8e5' }, 'hubc-origin-version': { value: '1.0.0' }, 'hubc-origin-note': { value: 'source note' },
    });
    await page.input('contribute', 'hubc-origin-note');
    await page.click('contribute', 'submit');

    expect(page.calls().find((call) => call.channel === 'contribution.declare' && call.payload.kind === 'origin')?.payload).toEqual({
      token: 'abc123def456', kind: 'origin', origin_type: 'derived_from_hub', note: 'source note',
      forked_from: { content_id: '22f1238eb8e5', version: '1.0.0' },
    });
  });

  it('requires a valid Hub content ID and SemVer before a derived origin can be submitted', async () => {
    const page = loadPage(router());
    await reachPreview(page);
    await acceptDeclarations(page, 'derived_from_hub');
    Object.assign(page.hosts.contribute.values, { 'hubc-origin-content-id': { value: 'NOT-AN-ID' }, 'hubc-origin-version': { value: '1.0.0' } });
    await page.input('contribute', 'hubc-origin-content-id');
    expect(page.hosts.contribute.node('[data-hubc-action="submit"]').disabled).toBe(true);

    page.hosts.contribute.values['hubc-origin-content-id'] = { value: '22f1238eb8e5' };
    await page.input('contribute', 'hubc-origin-content-id');
    expect(page.hosts.contribute.node('[data-hubc-action="submit"]').disabled).toBe(false);
  });

  it('locks a derived Hub origin and shows its immutable link in the preview', async () => {
    const forkedFrom = { content_id: '22f1238eb8e5', version: '1.0.0' };
    const page = loadPage(router({
      'contribution.start': () => ({ ...passState(), token: 'abc123def456', originPrefill: { locked: true, type: 'derived_from_hub', forked_from: forkedFrom } }),
    }));
    await reachPreview(page);

    expect(page.hosts.contribute.innerHTML).toContain('Derived from Hub content 22f1238eb8e5 v1.0.0; type and link cannot be changed.');
    Object.assign(page.hosts.contribute.values, { 'hubc-accept-terms': { checked: true }, 'hubc-accept-maintenance': { checked: true } });
    await page.input('contribute', 'hubc-accept-terms');
    await page.click('contribute', 'submit');

    expect(page.calls().find((call) => call.channel === 'contribution.declare' && call.payload.kind === 'origin')?.payload)
      .toEqual({ token: 'abc123def456', kind: 'origin', origin_type: 'derived_from_hub', note: '' });
  });

  it('records the three declarations, confirms the previewed digest and submits once', async () => {
    const page = loadPage(router());
    await reachPreview(page);
    await acceptDeclarations(page);
    await page.click('contribute', 'submit');

    const sequence = page.calls().map((call) => call.channel)
      .filter((channel) => ['contribution.declare', 'contribution.confirm', 'contribution.submit'].includes(channel));
    expect(sequence).toEqual(['contribution.declare', 'contribution.declare', 'contribution.declare', 'contribution.confirm', 'contribution.submit']);
    expect(page.calls().filter((call) => call.channel === 'contribution.declare').map((call) => call.payload.kind))
      .toEqual(['origin', 'terms', 'maintenance']);
    expect(page.calls().find((call) => call.channel === 'contribution.confirm')?.payload).toEqual({ token: 'abc123def456', digest: 'a'.repeat(64) });
    expect(page.root.uiToast).toHaveBeenCalledWith('Submitted for review. Track progress in My contributions.', { variant: 'success' });
    // After a delivered submission the page moves on to My contributions without cancelling the session.
    expect(page.calls().some((call) => call.channel === 'contribution.cancel')).toBe(false);
    expect(page.hosts.mine.style.display).toBe('flex');
    expect(page.hosts.contribute.style.display).toBe('none');
  });

  it('shows the details Hub returned when a submission is rejected, not just the message', async () => {
    const page = loadPage(router({
      'contribution.submit': () => ({
        ok: false,
        error: {
          code: 'SUBMISSION_REJECTED', message: 'Rejected by server check. See blockers.', retryable: false,
          details: { blockers: [{ rule_id: 'SEC-102', path: 'scripts/run.sh', message: 'Uses a network call' }] },
        },
      }),
    }));
    await reachPreview(page);
    await acceptDeclarations(page);
    await page.click('contribute', 'submit');

    expect(page.root.uiAlert).toHaveBeenCalledWith(
      'Rejected by server check. See blockers.\n· Uses a network call (scripts/run.sh)',
    );
  });

  it('keeps the details in the retry prompt when Hub did not confirm receipt', async () => {
    const page = loadPage(router({
      'contribution.submit': () => ({
        ok: false,
        error: { code: 'UNKNOWN_ERROR', message: 'Hub did not confirm.', retryable: true, details: { request: 'timed out' } },
      }),
    }));
    page.root.uiConfirm.mockResolvedValue(false);
    await reachPreview(page);
    await acceptDeclarations(page);
    await page.click('contribute', 'submit');

    expect(page.root.uiConfirm).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Hub did not confirm.\nrequest: timed out',
    }));
  });

  it('rechecks instead of submitting when the preview digest no longer matches', async () => {
    const page = loadPage(router({ 'contribution.confirm': () => ({ confirmed: false }) }));
    await reachPreview(page);
    await acceptDeclarations(page);
    await page.click('contribute', 'submit');

    expect(page.root.uiAlert).toHaveBeenCalledWith('The submission no longer matches the preview. Check and preview it again.');
    expect(page.calls().some((call) => call.channel === 'contribution.submit')).toBe(false);
    expect(page.calls().filter((call) => call.channel === 'contribution.recheck')).toHaveLength(2);
  });

  it('aborts an in-flight upload and returns to the preview', async () => {
    let releaseUpload: (value: unknown) => void = () => {};
    const page = loadPage(router({
      'contribution.submit': () => new Promise((resolve) => { releaseUpload = resolve; }),
    }));
    await reachPreview(page);
    await acceptDeclarations(page);
    await page.click('contribute', 'submit');
    expect(page.hosts.contribute.innerHTML).toContain('data-hubc-action="cancel-submit"');

    await page.click('contribute', 'cancel-submit');
    releaseUpload({ ok: false });
    await settle();

    const channels = page.calls().map((call) => call.channel);
    expect(channels).toContain('contribution.abortUpload');
    expect(channels).not.toContain('contribution.cancel');
    expect(page.root.uiToast).toHaveBeenCalledWith('Submission cancelled. The preview stays on this device.');
    expect(page.hosts.contribute.innerHTML).toContain('data-hubc-stage="preview"');
    expect(page.hosts.contribute.innerHTML).not.toContain('data-hubc-action="cancel-submit"');
  });

  it('confirms pending replacement and retries the same session with an explicit acknowledgement', async () => {
    const page = loadPage(router({
      'contribution.submit': (payload) => (payload.replace_confirmed ? { ok: true } : { ok: false, reason: 'replacement_confirmation_required' }),
    }));
    await reachPreview(page);
    await acceptDeclarations(page);
    await page.click('contribute', 'submit');

    expect(page.calls().filter((call) => call.channel === 'contribution.submit').map((call) => call.payload)).toEqual([
      { token: 'abc123def456' },
      { token: 'abc123def456', replace_confirmed: true },
    ]);
    expect(page.root.uiConfirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('replace your pending submission') }));
  });

  it('offers a retry of the exact package when delivery was not confirmed', async () => {
    let attempts = 0;
    const page = loadPage(router({
      'contribution.submit': () => { attempts += 1; return attempts === 1 ? { ok: false, error: { retryable: true, message: 'Not delivered' } } : { ok: true }; },
    }));
    await reachPreview(page);
    await acceptDeclarations(page);
    await page.click('contribute', 'submit');

    expect(attempts).toBe(2);
    expect(page.root.uiConfirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Not delivered', okLabel: 'Retry' }));
  });

  it('explains local version rejections without retrying', async () => {
    const page = loadPage(router({
      'contribution.submit': () => ({ ok: false, reason: 'version_not_higher', current_version: '1.2.0' }),
    }));
    await reachPreview(page);
    await acceptDeclarations(page);
    await page.click('contribute', 'submit');

    expect(page.root.uiAlert).toHaveBeenCalledWith('The version must be higher than 1.2.0.');
    expect(page.calls().filter((call) => call.channel === 'contribution.submit')).toHaveLength(1);
  });
});

describe('My contributions page', () => {
  async function openMine(page: Page) {
    await page.root.openMyContributions();
    await settle();
  }

  it('shows summary, last sync and the selected contribution detail', async () => {
    const page = loadPage(router());
    await openMine(page);

    const text = page.hosts.mine.text();
    expect(page.hosts.mine.style.display).toBe('flex');
    expect(text).toContain('Meeting Notes');
    expect(text).toContain('pending review');
    expect(text).toContain('Last synced');
    expect(text).toContain('Operations is reviewing this submission.');
    expect(text).toContain('data-hubc-action="withdraw-pending"');
    expect(page.calls().find((call) => call.channel === 'contribution.mine')?.payload).toEqual({ refresh: true });
  });

  it('asks for login before showing history and never lists data when it is cancelled', async () => {
    const page = loadPage(router({
      'contribution.preflight': () => ({ identity: { outcome: 'blocked', reason: 'not_signed_in' } }),
    }), { confirm: async () => false });
    await openMine(page);

    expect(page.calls().some((call) => call.channel === 'contribution.mine')).toBe(false);
    expect(page.hosts.mine.innerHTML).toBe('');
  });

  it('filters by status and searches names without calling the main process again', async () => {
    const items = {
      ...mineSuccess.cache.items,
      b: { entry_id: 'b', name: 'Returned Skill', latest_submission: { submission_id: 'sub_b', status: 'RETURNED', returned_reason: 'Rename it' }, updated_at: '2026-09-19T08:00:00Z' },
    };
    const page = loadPage(router({ 'contribution.mine': () => ({ ...mineSuccess, cache: { ...mineSuccess.cache, items } }) }));
    await openMine(page);
    const mineCalls = () => page.calls().filter((call) => call.channel === 'contribution.mine').length;
    const before = mineCalls();
    const list = () => page.hosts.mine.node('[data-hubc-list]').innerHTML;

    await page.clickFilter('rejected');
    expect(list()).toContain('Returned Skill');
    expect(list()).not.toContain('Meeting Notes');

    await page.clickFilter('all');
    await page.hosts.mine.dispatch('input', { target: { id: 'hubc-mine-search', value: 'meeting' } });
    expect(list()).toContain('Meeting Notes');
    expect(list()).not.toContain('Returned Skill');

    await page.hosts.mine.dispatch('input', { target: { id: 'hubc-mine-search', value: 'nothing-matches' } });
    expect(list()).toContain('No matching contributions');
    expect(mineCalls()).toBe(before);
  });

  it('keeps keyboard focus on the selected row when the list is rebuilt', async () => {
    const items = {
      ...mineSuccess.cache.items,
      b: { entry_id: 'b', name: 'Returned Skill', latest_submission: { submission_id: 'sub_b', status: 'RETURNED' }, updated_at: '2026-09-19T08:00:00Z' },
    };
    const page = loadPage(router({ 'contribution.mine': () => ({ ...mineSuccess, cache: { ...mineSuccess.cache, items } }) }));
    await openMine(page);
    page.hosts.mine.focusSpy.mockClear();

    // Focus outside the list (for example the search box) is left alone.
    await page.click('mine', 'select-row', { hubcKey: 'b' });
    expect(page.hosts.mine.focusSpy).not.toHaveBeenCalled();

    page.hosts.mine.focusInside = '[data-hubc-list]';
    await page.click('mine', 'select-row', { hubcKey: 'a' });
    expect(page.hosts.mine.focusSpy).toHaveBeenCalledTimes(1);
  });

  it('labels the new-version action as resubmission after Hub returns a content submission', async () => {
    const page = loadPage(router({ 'contribution.mine': () => withItem({}, { status: 'RETURNED', returned_reason: 'Fix the version' }) }));
    await openMine(page);

    const text = page.hosts.mine.text();
    expect(text).toContain('Revise and resubmit');
    expect(text).toContain('Fix the version');
    expect(text).not.toContain('Submit new version');
  });

  it('refreshes while foregrounded and stops once the page is left', async () => {
    const page = loadPage(router(), { fakeTimers: true });
    await page.root.openMyContributions();
    await vi.advanceTimersByTimeAsync(0);
    const count = () => page.calls().filter((call) => call.channel === 'contribution.mine').length;
    expect(count()).toBe(1);

    await vi.advanceTimersByTimeAsync(55_000);
    expect(count()).toBe(2);

    page.root.hideContributionViews();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(count()).toBe(2);
  });

  it('renders stale data with a notice and withdraws only the selected pending submission', async () => {
    const page = loadPage(router({
      'contribution.mine': () => ({ ...mineSuccess, ok: false, stale: true, error: { message: 'offline' } }),
      'contribution.withdrawPending': () => ({ ok: true }),
    }));
    await openMine(page);
    expect(page.hosts.mine.innerHTML).toContain('Hub could not be refreshed; showing the last saved result.');

    await page.click('mine', 'withdraw-pending', { hubcKey: 'a' });
    expect(page.root.uiConfirmDanger).toHaveBeenCalled();
    expect(page.calls().find((call) => call.channel === 'contribution.withdrawPending')?.payload).toEqual({ submission_id: 'sub_pending' });
    expect(page.calls().filter((call) => call.channel === 'contribution.mine')).toHaveLength(2);
  });

  it('sends a content-level governance withdrawal without a version field', async () => {
    const page = loadPage(router({
      'contribution.mine': () => withItem({}, { status: 'ACCEPTED' }),
      'contribution.requestWithdrawal': () => ({ ok: true }),
    }));
    await openMine(page);
    expect(page.hosts.mine.text()).toContain('data-hubc-action="request-withdrawal"');

    await page.click('mine', 'request-withdrawal', { hubcKey: 'a' });
    const request = page.calls().find((call) => call.channel === 'contribution.requestWithdrawal');
    expect(request?.payload).toEqual({ content_id: '8a4f01c29d7e', reason: 'fixture reason' });
    expect(Object.keys(request?.payload)).not.toContain('version');
    expect(page.root.uiConfirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('governance review') }));
  });

  it('does not offer a second withdrawal request while one is pending', async () => {
    const page = loadPage(router({
      'contribution.mine': () => withItem({ withdrawal_request: { status: 'PENDING', reason: 'Retire it' } }, { status: 'ACCEPTED' }),
    }));
    await openMine(page);

    expect(page.hosts.mine.text()).not.toContain('data-hubc-action="request-withdrawal"');
    expect(page.hosts.mine.text()).toContain('Retire it');
  });

  it('shows disabled-content recovery guidance and starts a new version from the selected local Skill', async () => {
    const page = loadPage(router({
      'contribution.mine': () => withItem({ content_status: 'disabled' }, { status: 'ACCEPTED' }),
    }), { skills: [{ id: 'skill-a', name: 'Skill A' }, { id: 'skill-b', name: 'Skill B' }], choice: async () => 'skill-b' });
    await openMine(page);
    expect(page.hosts.mine.text()).toContain('This content is disabled.');
    expect(page.hosts.mine.text()).toContain('governance role to restore availability');

    await page.click('mine', 'new-version', { hubcKey: 'a' });

    expect(page.calls().find((call) => call.channel === 'contribution.start')?.payload).toEqual({ skill_id: 'skill-b', defer_check: true });
    expect(page.hosts.contribute.innerHTML).toContain('data-hubc-stage="preview"');
    expect(page.hosts.contribute.innerHTML).toContain('Submit a new version of 8a4f01c29d7e from');
    expect(page.hosts.mine.style.display).toBe('none');

    await acceptDeclarations(page);
    await page.click('contribute', 'submit');
    expect(page.calls().find((call) => call.channel === 'contribution.submit')?.payload)
      .toEqual({ token: 'abc123def456', target_content_id: '8a4f01c29d7e' });
  });

  it('tells the contributor when no local Skill can supply a new version', async () => {
    const page = loadPage(router(), { skills: [] });
    await openMine(page);
    await page.click('mine', 'new-version', { hubcKey: 'a' });

    expect(page.root.uiAlert).toHaveBeenCalledWith('Create or import a local Skill before submitting a new version.');
    expect(page.calls().some((call) => call.channel === 'contribution.start')).toBe(false);
  });

  it('shows withdrawal history in a shared modal', async () => {
    const page = loadPage(router({
      'contribution.withdrawalHistory': () => ({ ok: true, result: { items: [{ status: 'REJECTED', requested_at: '2026-09-21', rejected_reason: 'Still needed' }] } }),
    }));
    await openMine(page);
    await page.click('mine', 'withdrawal-history', { hubcKey: 'a' });

    expect(page.calls().find((call) => call.channel === 'contribution.withdrawalHistory')?.payload).toEqual({ content_id: '8a4f01c29d7e' });
    expect(page.root.uiModal.mock.calls[0][0].bodyHtml).toContain('Still needed');
  });
});
