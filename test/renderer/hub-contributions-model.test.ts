import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const model = createRequire(__filename)('../../src/renderer/modules/hub-contributions-model.js');

const passAdmission = {
  outcome: 'pass',
  reason: null,
  issues: [],
  components: {
    ruleset: { version: '1.0.0', ready: true },
    sentry: { version: '2.1.0', ready: true },
    declaration: { version: '1.3.0', ready: true },
    ontologyVersion: '1.1.1',
  },
  scan: { outcome: 'pass', recommendation: 'ALLOW', rulesDegraded: false, isolated: true, instructionRisk: 'clean' },
  declaration: { outcome: 'pass', reason: null, findings: [] },
};

describe('Hub contribution view model: admission', () => {
  it('separates passed, fixable declaration, unavailable and blocking outcomes', () => {
    expect(model.classifyAdmission(passAdmission)).toBe('passed');
    for (const reason of ['declaration_absent', 'declaration_needs_input', 'declaration_mismatch']) {
      expect(model.classifyAdmission({ outcome: 'blocked', reason })).toBe('needs_declaration');
    }
    for (const reason of ['scan_unavailable', 'scanner_absent', 'rules_degraded', 'instruction_unavailable', 'components_not_ready', 'declaration_unavailable']) {
      expect(model.classifyAdmission({ outcome: 'blocked', reason })).toBe('unavailable');
    }
    expect(model.classifyAdmission({ outcome: 'incomplete' })).toBe('unavailable');
    expect(model.classifyAdmission({ outcome: 'blocked', reason: 'local_red_lines' })).toBe('blocked');
    expect(model.classifyAdmission({ outcome: 'blocked', reason: 'scan_restricted' })).toBe('blocked');
    expect(model.classifyAdmission({ outcome: 'blocked', reason: 'instruction_risk' })).toBe('blocked');
    expect(model.classifyAdmission(undefined)).toBe('unavailable');
  });

  it('never reports a missing check as passed', () => {
    const rows = model.checkRows({ outcome: 'blocked', reason: 'local_red_lines', issues: [{ rule_id: 'R1' }], scan: null, declaration: null, components: passAdmission.components });
    expect(rows.map((row: any) => [row.id, row.state])).toEqual([
      ['local', 'blocked'], ['ruleset', 'ok'], ['scan', 'skipped'], ['instruction', 'skipped'], ['declaration', 'skipped'],
    ]);
    expect(rows[0].count).toBe(1);
  });

  it('reports the engine, ruleset and ontology versions of a finished check', () => {
    const rows = model.checkRows(passAdmission);
    expect(rows.every((row: any) => row.state === 'ok')).toBe(true);
    expect(rows.find((row: any) => row.id === 'ruleset').version).toBe('1.0.0');
    expect(rows.find((row: any) => row.id === 'scan').version).toBe('2.1.0');
    const declaration = rows.find((row: any) => row.id === 'declaration');
    expect(declaration.version).toBe('1.3.0');
    expect(declaration.ontologyVersion).toBe('1.1.1');
  });

  it('marks scan, instruction and declaration problems on their own rows', () => {
    const rows = model.checkRows({
      ...passAdmission,
      outcome: 'blocked',
      scan: { outcome: 'restricted', rulesDegraded: true, isolated: false, instructionRisk: 'suspicious' },
      declaration: { outcome: 'blocked', reason: 'declaration_unavailable', findings: [{ ruleId: 'D1' }] },
    });
    const state = (id: string) => rows.find((row: any) => row.id === id).state;
    expect(state('scan')).toBe('blocked');
    expect(state('instruction')).toBe('blocked');
    expect(state('declaration')).toBe('unavailable');
    expect(state('ruleset')).toBe('unavailable');
  });

  it('treats a component that is not ready as unavailable even when no scan ran', () => {
    const rows = model.checkRows({
      outcome: 'blocked',
      reason: 'components_not_ready',
      issues: [],
      components: { ruleset: { version: null, ready: false }, sentry: { version: null, ready: false }, declaration: { version: '1.3.0', ready: true }, ontologyVersion: null },
      scan: null,
      declaration: null,
    });
    expect(rows.find((row: any) => row.id === 'ruleset').state).toBe('unavailable');
    expect(rows.find((row: any) => row.id === 'scan').state).toBe('unavailable');
  });
});

const items = {
  a: {
    entry_id: 'a', content_id: 'aaaaaaaaaaaa', name: 'Alpha', content_status: 'published', current_published_version: '1.0.0',
    latest_submission: { submission_id: 'sub-a', status: 'PENDING_REVIEW', version: '1.1.0', submitted_at: '2026-09-20T08:00:00Z', declarations_origin: { type: 'original' } },
    withdrawal_request: null, updated_at: '2026-09-20T08:00:00Z',
  },
  b: {
    entry_id: 'b', name: 'Beta',
    latest_submission: { submission_id: 'sub-b', status: 'RETURNED', returned_reason: 'Fix the name', version: '1.0.0' },
    updated_at: '2026-09-22T08:00:00Z',
  },
  c: {
    entry_id: 'c', content_id: 'cccccccccccc', name: 'Gamma', content_status: 'disabled', current_published_version: '2.0.0',
    latest_submission: { status: 'ACCEPTED' },
    withdrawal_request: { status: 'pending', reason: 'Retire it' }, updated_at: '2026-09-21T08:00:00Z',
  },
  broken: 'not-a-record',
  empty: {},
};

describe('Hub contribution view model: My contributions', () => {
  it('normalizes cached items, skips non-records and orders newest first', () => {
    const list = model.normalizeItems(items);
    expect(list.map((entry: any) => entry.title)).toEqual(['Beta', 'Gamma', 'Alpha', '#4']);
    expect(list[0]).toMatchObject({ status: 'RETURNED', returnedReason: 'Fix the name', submissionId: 'sub-b' });
    expect(list[1].withdrawal).toEqual({ status: 'PENDING', reason: 'Retire it', rejectedReason: '' });
  });

  it('tolerates items with every field missing', () => {
    const [entry] = model.normalizeItems({ x: { entry_id: 'only' } });
    expect(entry).toMatchObject({ key: 'only', title: 'only', status: '', publishedVersion: '', version: '', submittedAt: '', withdrawal: null, origin: null });
    expect(model.normalizeItems(undefined)).toEqual([]);
  });

  it('counts total, pending review and published contributions', () => {
    expect(model.historyStats(model.normalizeItems(items))).toEqual({ total: 4, pending: 1, published: 2 });
  });

  it('filters by status and searches names and ids', () => {
    const list = model.normalizeItems(items);
    const titles = (options: any) => model.filterHistory(list, options).map((entry: any) => entry.title);
    expect(titles({ filter: 'all' })).toHaveLength(4);
    expect(titles({ filter: 'pending' })).toEqual(['Alpha']);
    expect(titles({ filter: 'rejected' })).toEqual(['Beta']);
    expect(titles({ filter: 'published' })).toEqual(['Gamma', 'Alpha']);
    expect(titles({ filter: 'withdrawal' })).toEqual(['Gamma']);
    expect(titles({ filter: 'all', query: ' ALPHA ' })).toEqual(['Alpha']);
    expect(titles({ filter: 'all', query: 'cccccc' })).toEqual(['Gamma']);
    expect(titles({ filter: 'pending', query: 'beta' })).toEqual([]);
  });

  it('offers only the detail actions the contract allows', () => {
    const [beta, gamma, alpha] = model.normalizeItems(items);
    expect(model.detailActions(alpha)).toEqual({
      newVersion: true, resubmit: false, withdrawPending: true, requestWithdrawal: true, withdrawalHistory: true,
    });
    // C-FR-024a: a pending withdrawal request blocks a second one; disabled content is not "published".
    expect(model.detailActions(gamma).requestWithdrawal).toBe(false);
    // A returned submission with no Hub content ID can only be resubmitted.
    expect(model.detailActions(beta)).toMatchObject({ newVersion: false, resubmit: true, withdrawPending: false, requestWithdrawal: false });
  });
});

describe('Hub contribution view model: API error details', () => {
  it('keeps the message and expands array, object and scalar details', () => {
    const text = model.describeApiError({
      message: 'Submission rejected. See server_check blockers.',
      details: {
        blockers: [
          { rule_id: 'SEC-102', path: 'scripts/run.sh', message: 'Uses a network call', fix: 'Remove the call' },
          'Missing artifact.yaml',
        ],
        server_check: { reason: 'stricter_than_local' },
        attempt: 2,
      },
    }, 'fallback');
    expect(text.split('\n')).toEqual([
      'Submission rejected. See server_check blockers.',
      '· Uses a network call (scripts/run.sh) → Remove the call',
      '· Missing artifact.yaml',
      'server_check: stricter_than_local',
      'attempt: 2',
    ]);
  });

  it('falls back to the given message and ignores empty or non-object details', () => {
    expect(model.describeApiError({ details: null }, 'fallback')).toBe('fallback');
    expect(model.describeApiError({ message: '  ', details: 'x' }, 'fallback')).toBe('fallback');
    expect(model.describeApiError(undefined, 'fallback')).toBe('fallback');
    expect(model.describeApiError({ message: 'm', details: { a: [] } }, 'fb')).toBe('m');
  });

  it('bounds the number and length of detail lines', () => {
    const many = Array.from({ length: 30 }, (_, index) => `item ${index}`);
    const lines = model.detailLines({ items: many, long: 'x'.repeat(500) });
    expect(lines).toHaveLength(8);
    expect(model.detailLines({ long: 'x'.repeat(500) })[0].length).toBeLessThanOrEqual(206);
  });
});
