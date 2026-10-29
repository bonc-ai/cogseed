/**
 * S1 / B1 / E08 — CLI descendant prompt boundary.
 *
 * A commander reception can fan out to a CLI agent through a nested dispatch.
 * The child-process prompt is built by `_buildCliPrompt`; for a reception
 * descendant it must not carry host-private blocks: shared task context, space
 * instructions, the local transcript (bridge history) or the imported-session
 * digest, and it must not scan slice-wide attachments for local file paths.
 *
 * This test asserts the assembled CLI frame directly (`_buildCliPromptForTest`,
 * the builder's own test seam) so it does not need to spawn a CLI. The positive
 * control calls the same builder with `reception=false` and must keep every
 * private block — this is the red state for the same assertions.
 *
 * Reachability note (recorded in s1-implementation.md §10): the live external
 * agent path in this tree is the P3394 gateway; `_runCliAgentTurn` currently has
 * no call sites, so this gate is defence-in-depth for the retained builder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => {
  const log = () => {};
  return {
    createLogger: () => ({ debug: log, info: log, warn: log, error: log }),
    initLogger: () => {},
    logFromRenderer: () => {},
    redact: (value: unknown) => value,
    sweepLogs: () => ({ removed: 0, remaining: 0, totalBytes: 0 }),
  };
});

const UID = 'u-s1clidesc';
const CID = 'c-s1clidesc';
const AGENT_ID = 'a1b2c3d4e5f7';
const AGENT_NAME = 'CliDescendant';

// 合成标记：私有块内容、slice 里的本地内容、导入摘要、当前任务。
const SHARED_MARKER = 'S1CLIDESCENDANTSHARED3A7C';
const SPACE_INSTRUCTION_MARKER = 'S1CLIDESCENDANTSPACE4B8D';
const SLICE_MARKER = 'S1CLIDESCENDANTSLICE5C9E';
const IMPORTED_MARKER = 'S1CLIDESCENDANTIMPORTED6DAF';
const TASK_MARKER = 'S1CLIDESCENDANTTASK7EB0';

const ENV_KEYS = ['COGSEED_WORKSPACE_ROOT'] as const;
const previousEnv: Record<string, string | undefined> = {};
let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-s1-cli-'));
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  process.env.COGSEED_WORKSPACE_ROOT = tmpRoot;
  vi.resetModules();

  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);

  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(UID, { conversationId: CID, title: 'S1 CLI descendant' });

  const collaboration = await import('../../../../src/main/features/group_chat/collaboration');
  await collaboration.createWorkflowRun(UID, CID, {
    objective: `本地私有协作目标 ${SHARED_MARKER}`,
    kind: 'custom',
    created_by: 'commander',
  });

  // Imported-session digest: `_extractImportedCliContext` reads this
  // commander seed's model_text and would prepend it to the CLI prompt.
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const file = conversationMessageFile(UID, CID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    id: 'seed-import',
    ts: '2026-10-27T00:00:00.000Z',
    from: 'commander',
    to: ['user'],
    text: 'seed',
    model_text: `以下是用户从旧会话提炼简报\n\n${IMPORTED_MARKER}`,
  })}\n`, 'utf8');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function cliAgent(): any {
  return {
    agent_id: AGENT_ID,
    name: AGENT_NAME,
    description_en: 'CLI descendant synthetic agent',
    workflow: 'Do the task.',
    runtime: { kind: 'cli', cli: 'claude' },
    inputs: [],
  };
}

function dispatchItem(): any {
  return {
    llmPayload: `TASK-BODY ${TASK_MARKER}`,
    msgId: 'msg-cli-current',
    fromActorId: 'commander',
    to: [AGENT_ID],
    attachments: [],
  };
}

function localSlice(): any[] {
  return [{
    id: 'm1',
    ts: '2026-10-27T00:00:01.000Z',
    from: 'user',
    to: [AGENT_ID],
    text: `LOCAL-SLICE ${SLICE_MARKER}`,
  }];
}

describe('a2a reception › CLI descendant prompt boundary', () => {
  it('drops private host blocks from a reception descendant CLI prompt and keeps them for a local dispatch', async () => {
    const spaces = await import('../../../../src/main/features/spaces');
    const created = await spaces.createSpace(UID, {
      name: 'S1 CLI descendant space',
      instructions: `SPACE-INSTRUCTION ${SPACE_INSTRUCTION_MARKER}`,
    });
    expect(created.ok, 'fixture: the space must be created').toBe(true);
    const spaceId = created.ok ? created.space.space_id : undefined;

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agent = cliAgent();
    const item = dispatchItem();
    const slice = localSlice();

    // 正对照（本地 nested dispatch）：私有块全部保留。
    const localPrompt = await bus._buildCliPromptForTest(
      UID, CID, agent, item, slice, true, spaceId, false,
    );
    for (const marker of [SHARED_MARKER, SPACE_INSTRUCTION_MARKER, SLICE_MARKER, IMPORTED_MARKER]) {
      expect(localPrompt, `positive control: the local CLI prompt must carry ${marker}`)
        .toContain(marker);
    }
    expect(localPrompt).toContain(TASK_MARKER);

    // 接待后代：只保留任务正文。
    const receptionPrompt = await bus._buildCliPromptForTest(
      UID, CID, agent, item, slice, true, spaceId, true,
    );
    expect(receptionPrompt, 'the reception CLI prompt must still carry the dispatch task')
      .toContain(TASK_MARKER);
    for (const marker of [SHARED_MARKER, SPACE_INSTRUCTION_MARKER, SLICE_MARKER, IMPORTED_MARKER]) {
      expect(receptionPrompt, `reception descendant CLI prompt leaked ${marker}`)
        .not.toContain(marker);
    }
    expect(receptionPrompt).not.toContain('## Conversation so far');
  }, 120_000);
});
