// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P1-18 — front/back contract closure.
//
// The rule this file enforces: no field may be computed by the backend, never
// read by the renderer, and left without an explanation. Every projection
// field is DELETE, KEEP+DISPLAY, or KEEP+RESERVED-with-a-comment.
//
// DELETE is asserted here (the field is gone from real projection objects and
// from the types). DISPLAY is asserted in test/renderer/run-center-contract.
// RESERVED is asserted here too — the field must still exist, and the type
// definition must still carry its justification.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createCogSeedIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';
import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../../..', 'src/main/features/cogseed_backend/ipc-service.ts'),
  'utf8',
);

function task(overrides: Partial<CogSeedTaskRecord> & { taskId: string }): CogSeedTaskRecord {
  const createdAt = overrides.createdAt ?? '2026-08-26T00:00:00.000Z';
  return {
    schemaVersion: 1,
    taskId: overrides.taskId,
    sessionId: 'cogseed-session-1',
    requestId: `req-${overrides.taskId}`,
    ownerId: 'u-1',
    status: 'running',
    task: 'objective text',
    executionKind: 'group-chat',
    conversationId: 'conv-abcdef123456',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as CogSeedTaskRecord;
}

function serviceFor(records: CogSeedTaskRecord[]) {
  const sessionRecord = {
    schemaVersion: 1,
    sessionId: 'cogseed-session-1',
    ownerId: 'u-1',
    conversationId: 'conv-abcdef123456',
    createdAt: records[0].createdAt,
    updatedAt: records.at(-1)!.updatedAt,
  };
  return createCogSeedIpcService({
    listTasks: async () => records,
    listSessions: async () => [sessionRecord] as never,
    readSession: async () => sessionRecord as never,
    readTask: async (_u: string, taskId: string) => records.find((r) => r.taskId === taskId) ?? null,
    readEvents: async () => [],
    isConversationAvailable: async () => true,
  } as never);
}

const RECORDS = [
  task({ taskId: 'cogseed-task-run-1' }),
  task({ taskId: 'cogseed-task-turn-1', parentTaskId: 'cogseed-task-run-1', groupChatTurnId: 't1', createdAt: '2026-08-26T00:00:10.000Z' }),
  task({ taskId: 'cogseed-task-done', status: 'completed', createdAt: '2026-08-26T00:00:20.000Z' }),
];

describe('RC-P1-18 DELETE — board.counts', () => {
  it('is gone from the real board projection', async () => {
    const board = await serviceFor(RECORDS).boardProjection('u-1');

    expect(board).not.toHaveProperty('counts');
    // What replaced it: the renderer counts the tasks it actually shows. A
    // server-side count computed before filtering disagreed with the screen.
    expect(board.tasks).toHaveLength(3);
    // The one count that survives is the retention explainer, which the
    // renderer genuinely reads (RC-P2-19).
    expect(board).toHaveProperty('retentionHiddenCount');
  });

  it('is gone from the type definition', () => {
    expect(SOURCE).not.toMatch(/counts:\s*Record<CogSeedRendererBoardColumn/);
  });
});

describe('RC-P1-18 DELETE — actions.skip', () => {
  it('is absent from every projected action set', async () => {
    const service = serviceFor(RECORDS);
    const board = await service.boardProjection('u-1');
    const snapshot = await service.collaborationSnapshot('u-1', { taskId: 'cogseed-task-run-1' });

    for (const actions of [...board.tasks.map((t) => t.actions), snapshot.actions]) {
      expect(actions).not.toHaveProperty('skip');
      // The real actions are untouched.
      expect(Object.keys(actions).sort()).toEqual(['abort', 'resume', 'retry']);
    }
  });

  it('is no longer accepted as an action input', async () => {
    // It used to be accepted and then thrown on with a workflow-scope message,
    // which read like "wrong scope, try elsewhere" — there was no elsewhere.
    await expect(serviceFor(RECORDS).action('u-1', { action: 'skip', taskId: 'cogseed-task-run-1' }))
      .rejects.toThrow(/invalid CogSeed task action/);
  });

  it('leaves no dead workflow-step plumbing behind', () => {
    // `hasWorkflowStep` / `workflowStepIds` existed only to compute `skip`.
    expect(SOURCE).not.toContain('hasWorkflowStep');
    expect(SOURCE).not.toContain('workflowStepIds');
  });
});

describe('RC-P1-18 KEEP + RESERVED — still present, and explained', () => {
  it('keeps board.updatedAt and says who will consume it', async () => {
    const board = await serviceFor(RECORDS).boardProjection('u-1');
    expect(typeof board.updatedAt).toBe('string');

    const comment = SOURCE.slice(0, SOURCE.indexOf('updatedAt?: string;'));
    expect(comment).toContain('RESERVED');
    expect(comment).toMatch(/incremental refresh|push/i);
  });

  it('keeps the group header fields and says who will consume them', async () => {
    const board = await serviceFor(RECORDS).boardProjection('u-1');
    const group = board.groups[0];
    expect(group).toMatchObject({ status: expect.any(String), titleKey: expect.any(String) });

    const block = SOURCE.slice(
      SOURCE.indexOf('export interface CogSeedRendererBoardGroup'),
      SOURCE.indexOf('export interface CogSeedRendererBoardProjection'),
    );
    expect(block).toContain('RESERVED');
    expect(block).toMatch(/group header/i);
  });

  it('keeps skillVersionPinStatus and names its owner', () => {
    const block = SOURCE.slice(0, SOURCE.indexOf("skillVersionPinStatus?: 'pinned' | 'unpinned';"));
    expect(block).toContain('RESERVED');
    expect(block).toMatch(/skill/i);
  });

  // The rule, stated as a test: a RESERVED marker without a stated consumer is
  // exactly the "nobody knows why it's here" case this phase exists to remove.
  it('never marks a field RESERVED without saying who consumes it', () => {
    const reserved = SOURCE.split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('RESERVED'));

    expect(reserved.length).toBeGreaterThan(0);
    for (const { index } of reserved) {
      const block = SOURCE.split('\n').slice(index, index + 8).join(' ');
      expect(block).toMatch(/consumer|consumed|Re-review/i);
    }
  });
});

describe('RC-P1-18 KEEP + DISPLAY — the backend actually supplies values', () => {
  it('supplies session counts the list can render', async () => {
    const sessions = await serviceFor(RECORDS).sessionListProjection('u-1');

    expect(sessions[0]).toMatchObject({ taskCount: 3, activeTaskCount: 2 });
    expect(typeof sessions[0].hasRecovery).toBe('boolean');
  });

  it('reports hasRecovery from real task state, not a constant', async () => {
    const recoverable = [...RECORDS, task({ taskId: 'cogseed-task-rec', status: 'recoverable', executionKind: 'cogseed-native' })];
    const sessions = await serviceFor(recoverable).sessionListProjection('u-1');

    expect(sessions[0].hasRecovery).toBe(true);
  });

  it('supplies a recovery block driven by task state', async () => {
    const recoverable = [...RECORDS, task({ taskId: 'cogseed-task-rec', status: 'recoverable', executionKind: 'cogseed-native' })];
    const snapshot = await serviceFor(recoverable).collaborationSnapshot('u-1', { sessionId: 'cogseed-session-1' });

    expect(snapshot.recovery.recoverable).toBe(true);
    expect(snapshot.recovery.taskIds).toContain('cogseed-task-rec');
  });

  it('ships review gates as an i18n key, never as backend prose', async () => {
    // The gate name used to be the hardcoded English literal 'Review gate'.
    expect(SOURCE).not.toContain("name: 'Review gate'");
    expect(SOURCE).toContain("nameKey: 'run_center.review_gate'");
  });

  it('keeps reviews and conflicts structured — ids, enums, timestamps only', async () => {
    const snapshot = await serviceFor(RECORDS).collaborationSnapshot('u-1', { taskId: 'cogseed-task-run-1' });

    expect(Array.isArray(snapshot.reviews)).toBe(true);
    expect(Array.isArray(snapshot.conflicts)).toBe(true);
    // No free-text field is declared on either shape.
    const block = SOURCE.slice(
      SOURCE.indexOf('export interface CogSeedRendererReviewSummary'),
      SOURCE.indexOf('export interface CogSeedRendererCollaborationActivity'),
    );
    expect(block).not.toMatch(/\b(summary|description|text|body|content|message)\??:/);
  });
});

describe('RC-P1-18 privacy — display adds no new exposure', () => {
  it('leaks no objective or working directory through the newly shown fields', async () => {
    const secret = 'SENTINEL rewrite the severance agreement';
    const records = RECORDS.map((record) => ({ ...record, task: secret, workingDir: `/x/${secret}` }));
    const service = serviceFor(records);

    const payloads = [
      JSON.stringify(await service.boardProjection('u-1')),
      JSON.stringify(await service.sessionListProjection('u-1')),
      JSON.stringify(await service.collaborationSnapshot('u-1', { taskId: 'cogseed-task-run-1' })),
    ];

    for (const payload of payloads) {
      expect(payload).not.toContain('SENTINEL');
      expect(payload).not.toContain('severance');
    }
  });

  it('keeps the session summary to counts and ids', async () => {
    const sessions = await serviceFor(RECORDS).sessionListProjection('u-1');
    const ALLOWED = new Set([
      'sessionId', 'title', 'titleKey', 'latestTaskId', 'conversationId',
      'createdAt', 'updatedAt', 'taskCount', 'activeTaskCount', 'latestStatus', 'hasRecovery',
    ]);

    expect(Object.keys(sessions[0]).filter((key) => !ALLOWED.has(key))).toEqual([]);
    expect(typeof sessions[0].taskCount).toBe('number');
    expect(typeof sessions[0].activeTaskCount).toBe('number');
  });
});
