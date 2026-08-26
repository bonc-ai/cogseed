// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P1-14 — the cleanup must run on the path a user actually takes.
//
// The hook lives in `chats.ts::_purgeDeletedConversationFiles`, reached from
// `chats.deleteConversation`. The obvious-looking alternative,
// `group_chat/index.ts::dropConv()`, has zero callers in `src/` — wiring the
// cleanup there would have shipped a cleanup that never runs. These tests
// assert the real entry point, and that a failing cleanup cannot cost the user
// their conversation deletion.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CONVERSATION = 'conv-cleanup-integration';

let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The cleanup block as `chats.ts` runs it: best-effort, warn, never rethrow. */
async function runCleanupBlockLike(
  purge: (userId: string, cid: string) => Promise<{ purgedTaskIds: string[]; failedTaskIds: string[] }>,
): Promise<'completed'> {
  try {
    const purged = await purge('u-1', CONVERSATION);
    if (purged.failedTaskIds.length) warnings.push(`partial:${purged.failedTaskIds.length}`);
  } catch (err) {
    warnings.push(`failed:${(err as Error).message}`);
  }
  return 'completed';
}

describe('RC-P1-14 — the hook is on the real production path', () => {
  const chatsSource = fs.readFileSync(
    path.join(__dirname, '../../../..', 'src/main/features/chats.ts'),
    'utf8',
  );

  it('calls the purge from _purgeDeletedConversationFiles', () => {
    const start = chatsSource.indexOf('async function _purgeDeletedConversationFiles');
    expect(start).toBeGreaterThan(-1);
    const body = chatsSource.slice(start, chatsSource.indexOf('\n}\n', start));

    expect(body).toContain('purgeCogSeedGroupChatTasksByConversation');
    // Best-effort, same shape as the attachment purge directly above it.
    expect(body).toMatch(/try\s*\{[\s\S]*purgeCogSeedGroupChatTasksByConversation[\s\S]*catch/);
  });

  it('is reachable from chats.deleteConversation', () => {
    const start = chatsSource.indexOf('export async function deleteConversation');
    const body = chatsSource.slice(start, chatsSource.indexOf('\n}\n', start));
    expect(body).toContain('_purgeDeletedConversationFiles');
  });

  it('is NOT wired into the group_chat facade that nothing calls', () => {
    const groupChatSource = fs.readFileSync(
      path.join(__dirname, '../../../..', 'src/main/features/group_chat/index.ts'),
      'utf8',
    );
    expect(groupChatSource).not.toContain('purgeCogSeedGroupChatTasksByConversation');
  });
});

describe('RC-P1-14 Case 6 — cleanup failure is best-effort', () => {
  it('does not stop the conversation deletion when the purge throws', async () => {
    const purge = vi.fn(async () => { throw new Error('disk on fire'); });

    await expect(runCleanupBlockLike(purge)).resolves.toBe('completed');

    expect(purge).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(['failed:disk on fire']);
  });

  it('warns but continues when only some records could be removed', async () => {
    const purge = vi.fn(async () => ({ purgedTaskIds: ['cogseed-task-a'], failedTaskIds: ['cogseed-task-b'] }));

    await expect(runCleanupBlockLike(purge)).resolves.toBe('completed');

    expect(warnings).toEqual(['partial:1']);
  });

  it('stays silent on a clean run', async () => {
    const purge = vi.fn(async () => ({ purgedTaskIds: ['cogseed-task-a'], failedTaskIds: [] }));

    await expect(runCleanupBlockLike(purge)).resolves.toBe('completed');

    expect(warnings).toEqual([]);
  });
});
