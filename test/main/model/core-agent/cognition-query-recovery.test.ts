import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }) }));
const userId = 'query-recovery-user', cid = 'query-recovery-chat';
let root: string, previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-query-recovery-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules(); warn.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const service = await import('../../../../src/main/features/cognition/ontology/service');
  const model = await import('../../../../src/main/features/cognition/ontology/model');
  const { createOntologyTools } = await import('../../../../src/main/model/core-agent/ontology-tools');
  const { createTranscriptMemoryTools } = await import('../../../../src/main/model/core-agent/transcript-memory-tools');
  const glossary = await import('../../../../src/main/features/transcript_glossary');
  const action = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'Synthetic fixture' });
  await service.commitOntologyCommand(userId, { commandId: 'query-recovery-seed', expectedRevision: 0, actions: [
    action('module-a', { kind: 'module', name: 'Synthetic Team', description: '', scope: { kind: 'project', id: 'project-a' } }),
    action('module-b', { kind: 'module', name: 'Other Synthetic Team', description: '', scope: { kind: 'project', id: 'project-b' } }),
    action('module-private', { kind: 'module', name: 'Synthetic Private Team', description: '', scope: { kind: 'personal' }, access: 'owner_only' }),
    action('type-a', { kind: 'definition', moduleId: 'module-a', name: 'Synthetic participant', description: '', definitionKind: 'type',
      subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    action('member-a', { kind: 'entity', moduleId: 'module-a', typeId: 'type-a', name: 'Example Member', description: '', aliases: [], identityStatus: 'confirmed' }),
  ] });
  glossary.upsertEntry(userId, { wrong: 'Example Mamber', correct: 'Example Member', kind: 'people',
    scope: { global: false, docIds: [], scenarioTags: ['ontology:module-a'] } });
  glossary.upsertEntry(userId, { wrong: 'Example Topik', correct: 'Example Topic', kind: 'term',
    scope: { global: false, docIds: [`chat:${cid}`], scenarioTags: [] } });
  const options = { userId, cid, context: { projectId: 'project-a' } };
  return { service, model, query: createOntologyTools(options)[0], transcript: createTranscriptMemoryTools(options)[0] };
}

function failure(result: { content: string; isError?: boolean }, code: string) {
  expect(result.isError).toBe(true);
  const payload = JSON.parse(result.content);
  expect(payload).toMatchObject({ status: 'blocked', code, reason: expect.any(String), recoveryHint: expect.any(String) });
  expect(payload.recoveryHint).toContain('does not establish absence');
  expect(payload.recoveryHint).toContain('Do not use create_cognition to bypass');
  expect(payload).not.toHaveProperty('records');
  expect(payload).not.toHaveProperty('entries');
  return payload;
}

describe('cognition query recovery', () => {
  it('rejects names and wrong module ID types, then reads the real ID returned by a scoped name query', async () => {
    const { query, transcript, service } = await setup();
    for (const moduleId of ['Synthetic Team', 7, false, null, {}, [], 'prototype']) {
      const error = failure(await transcript.execute({ moduleId }), 'invalid_input');
      expect(error.error).toBe(error.reason);
      expect(error.reason).toContain('moduleId');
      expect(error.recoveryHint).toContain('query set to that name');
      failure(await query.execute({ query: 'Synthetic Team', moduleId }), 'invalid_input');
    }
    const result = await query.execute({ query: 'Synthetic Team' });
    expect(result.isError).toBeUndefined();
    const { modules } = JSON.parse(result.content);
    expect(modules.map((row: { id: string }) => row.id)).toEqual(['module-a']);
    const corrected = await transcript.execute({ moduleId: modules[0].id });
    expect(corrected.isError).toBeUndefined();
    expect(JSON.parse(corrected.content)).toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ correct: 'Example Member' })]),
      canonicalNames: [expect.objectContaining({ id: 'member-a', name: 'Example Member' })],
    });
    expect(service.readOntologyDocument(userId).revision).toBe(1);
    // These tool descriptions are provider-bound; keep the existing 480-character budget.
    for (const tool of [query, transcript]) expect(tool.description.replace(/\s+/g, ' ').trim().length).toBeLessThanOrEqual(480);
  });

  it('preserves conversation-only reads without a module selector, including the legacy empty selector', async () => {
    const { transcript } = await setup();
    for (const input of [{}, { moduleId: '' }]) {
      const result = await transcript.execute(input);
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content);
      expect(payload.entries.map((row: { correct: string }) => row.correct)).toEqual(['Example Topic']);
      expect(payload.canonicalNames).toEqual([]);
      expect(payload).not.toHaveProperty('status');
    }
  });

  it('does not disclose whether an unavailable module is missing, private, or in another project', async () => {
    const { query, transcript } = await setup();
    const transcriptErrors = [], queryErrors = [];
    for (const moduleId of ['missing-module', 'module-private', 'module-b']) {
      transcriptErrors.push(failure(await transcript.execute({ moduleId }), 'not_authorized'));
      queryErrors.push(failure(await query.execute({ query: 'Synthetic Team', moduleId }), 'not_authorized'));
    }
    expect(new Set(transcriptErrors.map(row => JSON.stringify(row))).size).toBe(1);
    expect(new Set(queryErrors.map(row => JSON.stringify(row))).size).toBe(1);
    expect(transcriptErrors[0].error).toBe('module outside task scope');
    expect(queryErrors[0].recoveryHint).toContain('current task permissions');
  });

  it('preserves task query validation and inventory authorization instead of turning errors into empty results', async () => {
    const { query } = await setup();
    for (const input of [{ query: 7 }, { query: {} }, { query: 'Synthetic Team', mode: ['task'] }])
      failure(await query.execute(input), 'invalid_input');
    const inventory = failure(await query.execute({ mode: 'inventory', limit: 50 }), 'inventory_intent_required');
    expect(inventory.recoveryHint).toContain('explicit full-inventory instruction');
    const normal = await query.execute({ query: 'Unmatched Synthetic Topic' });
    expect(normal.isError).toBeUndefined();
    expect(JSON.parse(normal.content)).toMatchObject({ modules: [], records: [], facts: [], sourceCoverage: { complete: true } });
  });

  it('recovers an invalid content cursor with a fresh authorized read, without guessing a version', async () => {
    const { query } = await setup();
    const failed = failure(await query.execute({ query: 'Synthetic Team', contentCursor: 'invalid-cursor' }), 'invalid_cursor');
    expect(failed.recoveryHint).toContain('Restart the original authorized read');
    const result = await query.execute({ query: 'Synthetic Team' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({ revision: 1, modules: [expect.objectContaining({ id: 'module-a' })] });
  });

  it('keeps version and source failure codes with their distinct recovery instructions', async () => {
    const { query, service, model } = await setup();
    const read = vi.spyOn(service, 'readOntologyView');
    for (const [code, hint] of [
      ['baseline_changed', 'Restart the original authorized read'],
      ['inventory_snapshot_changed', 'Restart the original authorized read'],
      ['source_unavailable', 'Stop operations that depend on the unreadable content'],
      ['store_corrupt', 'Stop operations that depend on the unreadable content'],
      ['not_found', 'Recheck the exact target'],
    ]) {
      read.mockRejectedValueOnce(new model.OntologyError(code, 'Synthetic domain failure'));
      const payload = failure(await query.execute({ query: 'Synthetic Team' }), code);
      expect(payload.reason).toBe('Synthetic domain failure');
      expect(payload.recoveryHint).toContain(hint);
    }
  });

  it('preserves an incomplete successful query rather than claiming an empty or failed read', async () => {
    const { query } = await setup();
    const admission = await import('../../../../src/main/features/cognition/ontology/source-admission');
    const actual = admission.assessOntologySources;
    vi.spyOn(admission, 'assessOntologySources').mockImplementation(async (...args) => {
      const statuses = await actual(...args);
      statuses.set('member-a', 'unavailable');
      return statuses;
    });
    const result = await query.execute({ query: 'Synthetic Team' });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content);
    expect(payload.sourceCoverage.complete).toBe(false);
    expect(payload.modules).toEqual([expect.objectContaining({ id: 'module-a' })]);
    expect(payload.records.some((record: { id: string }) => record.id === 'member-a')).toBe(false);
    expect(payload).not.toHaveProperty('code');
  });

  it('returns a stable unknown-failure contract without exposing raw exception details', async () => {
    const { query, transcript, service } = await setup();
    const detail = 'SYNTHETIC_PRIVATE_EXCEPTION';
    const message = `Unable to read ${path.join(root, 'synthetic-record.json')} token=${detail}`;
    vi.spyOn(service, 'readOntologyView').mockRejectedValue(new Error(message));
    vi.spyOn(service, 'readOntologyDocument').mockImplementation(() => { throw new Error(message); });
    for (const [tool, input] of [[query, { query: 'Synthetic Team' }], [transcript, {}]] as const) {
      const result = await tool.execute(input);
      const payload = failure(result, 'query_failed');
      expect(result.content).not.toContain(detail);
      expect(payload.recoveryHint).toContain('local diagnostic log');
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(detail);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(userId);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-record.json');
    expect(JSON.stringify(warn.mock.calls)).toContain('Unable to read');
  });
});
