/**
 * S1 / B1 / E08 — commander-reception Recall boundary + agent inherited cognition.
 *
 * A trusted commander reception is reachable through the commander fallback in
 * `resolveReceptionAssistant`. Its host-private Recall context (authorized
 * assets / profile assets / catalog / experience catalog) must not be injected
 * into the visitor-visible prompt; a local commander turn must keep it.
 * Agent receptions likewise must not receive the agent's birth-inherited
 * cognition (same "automatic private assets" class).
 *
 * The Recall/inheritance producers are mocked at their module boundary: this
 * test asserts the *host wiring* (which injections run for which turn), not the
 * Recall pipeline internals. A deterministic real-asset fixture would need the
 * candidate/review-decision/projection pipeline; the wiring is the contract
 * under test here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

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

const probe = vi.hoisted(() => ({
  recallCalls: 0,
  catalogCalls: 0,
  inheritedCalls: 0,
  modelCalls: [] as Array<{
    sessionId: string;
    agentId?: string;
    systemPrompt: string;
    message: string;
    receptionScope: any;
  }>,
}));

const RECALL_MARKER = 'S1RECALLPRIVATEA1B2';
const CATALOG_MARKER = 'S1CATALOGPRIVATE3C4D';
const INHERITED_MARKER = 'S1INHERITEDPRIVATE5E6F';
const LOCAL_MARKER = 'S1PRIVATELOCALTURN7A8B';
const PEER_QUESTION = 'S1PEERQUESTION9C0D';

vi.mock('../../../../src/main/features/recall/prompt-injection', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildRecallTurnPromptContext: vi.fn(async () => {
      probe.recallCalls += 1;
      return {
        promptBlock: 'RECALL-BLOCK-PLACEHOLDER',
        authorizedAssetsBlock: `### Authorized assets\n${RECALL_MARKER}`,
        profileAssetsBlock: '',
        citations: [],
        profileMemoryEntries: [],
      };
    }),
  };
});

vi.mock('../../../../src/main/features/recall/asset-catalog-hint', () => ({
  assetCatalogForPromptWithRelevance: vi.fn(async () => {
    probe.catalogCalls += 1;
    return {
      text: `Asset catalog (synthetic)\n${CATALOG_MARKER}`,
      relevantIds: new Set<string>(),
      shown: [],
    };
  }),
}));

vi.mock('../../../../src/main/features/recall/cognition-selection', () => ({
  selectInheritedCognition: vi.fn(async () => {
    probe.inheritedCalls += 1;
    return { selected: [], withheld: [], glossary: [] };
  }),
}));

vi.mock('../../../../src/main/features/recall/inherited-cognition-prompt', () => ({
  buildInheritedCognitionPrompt: vi.fn(() => ({
    promptBlock: `## Inherited cognition (synthetic)\n${INHERITED_MARKER}`,
    reuseRefsForTurn: () => [],
  })),
  reuseRefsForTurn: () => [],
  truncatedByBudget: () => false,
}));

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    probe.modelCalls.push({
      sessionId: String(opts?.sessionId || ''),
      ...(opts?.agentId ? { agentId: String(opts.agentId) } : {}),
      systemPrompt: String(opts?.systemPrompt || ''),
      message: String(opts?.message || ''),
      receptionScope: opts?.receptionScope,
    });
    yield { type: 'final', text: 'synthetic answer' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));

const UID = 'u-s1recall';
const AGENT_ID = 'b2c3d4e5f6a7';
const AGENT_NAME = 'RecallAgent';
const PEER_USER_ID = 'cs_s1recallpeer';
const PEER_ACTOR_ID = 'a2a_cs_s1recallpeer';

const ENV_KEYS = [
  'COGSEED_WORKSPACE_ROOT',
  'COGSEED_KSTAR_HOST_ROUTING',
  'COGSEED_P3394_WAKE_GATE',
  'COGSEED_LEGACY_RUN_WORKER_TEST',
] as const;
const previousEnv: Record<string, string | undefined> = {};
let tmpRoot = '';
let grantRoot = '';
const createdCids = new Set<string>();

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-s1-recall-'));
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  process.env.COGSEED_WORKSPACE_ROOT = tmpRoot;
  process.env.COGSEED_KSTAR_HOST_ROUTING = '0';
  process.env.COGSEED_P3394_WAKE_GATE = '0';
  process.env.COGSEED_LEGACY_RUN_WORKER_TEST = '0';
  probe.recallCalls = 0;
  probe.catalogCalls = 0;
  probe.inheritedCalls = 0;
  probe.modelCalls.length = 0;
  createdCids.clear();
  vi.resetModules();

  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);

  const paths = await import('../../../../src/main/paths');
  const agentDir = paths.agentDir(UID, AGENT_ID);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
    agent_id: AGENT_ID,
    name: AGENT_NAME,
    description: 'S1 recall boundary synthetic agent',
    workflow: 'Answer synthetically.',
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
  }));

  const grantRaw = path.join(tmpRoot, 'reception-workspace');
  fs.mkdirSync(grantRaw, { recursive: true });
  grantRoot = fs.realpathSync(grantRaw);
});

afterEach(async () => {
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    for (const cid of createdCids) await bus.dropConv(UID, cid);
  } catch {
    /* teardown is best effort */
  }
  await drainMainRuntimeForTest(UID);
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function createReceptionConversation(cid: string): Promise<void> {
  createdCids.add(cid);
  const chats = await import('../../../../src/main/features/chats');
  const groupState = await import('../../../../src/main/features/group_chat/state');
  await chats.createConversation(UID, { conversationId: cid, title: `S1 recall ${cid}` });
  const withMarker = await chats.updateConversation(UID, cid, {
    a2a: {
      inbound: true,
      peer_user_id: PEER_USER_ID,
      peer_name: 'S1 Recall Peer',
      state: 'active',
      workspace: grantRoot,
      assistant_agent_id: AGENT_ID,
      exchange_id: `a2a-${cid}`,
    },
  });
  expect(withMarker, 'fixture: the A2A inbound marker must persist').not.toBeNull();
  await groupState.addMember(UID, cid, { kind: 'agent', id: AGENT_ID, name: AGENT_NAME });
}

async function waitForQuiescent(cid: string, timeoutMs = 30_000): Promise<void> {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (bus.isQuiescent(UID, cid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`group chat bus did not quiesce within ${timeoutMs}ms`);
}

describe('a2a reception › commander Recall and agent inherited-cognition boundary', () => {
  it('keeps commander Recall/asset context out of a trusted commander reception and keeps it for a local commander turn', async () => {
    const cid = 'c-s1recall-commander';
    await createReceptionConversation(cid);
    const bus = await import('../../../../src/main/features/group_chat/bus');

    // 本地 commander 正对照：Recall + 目录注入都发生。
    await bus.enqueue({
      uid: UID,
      cid,
      fromActorId: 'user',
      forceTo: ['commander'],
      text: `本地任务 ${LOCAL_MARKER}`,
    });
    await waitForQuiescent(cid);

    const localCall = probe.modelCalls.find((call) => call.message.includes(LOCAL_MARKER));
    expect(localCall, 'positive control: the local commander turn must reach the model').toBeTruthy();
    expect(localCall!.systemPrompt, `positive control: missing ${RECALL_MARKER}`).toContain(RECALL_MARKER);
    expect(localCall!.systemPrompt, `positive control: missing ${CATALOG_MARKER}`).toContain(CATALOG_MARKER);
    expect(localCall!.receptionScope).toBeUndefined();
    expect(probe.recallCalls, 'positive control: Recall builder must run for a local commander turn')
      .toBeGreaterThan(0);
    expect(probe.catalogCalls, 'positive control: catalog builder must run for a local commander turn')
      .toBeGreaterThan(0);

    // 可信外部接待到 commander：两个注入器都不得运行，provider 请求也不得带标记。
    const recallBefore = probe.recallCalls;
    const catalogBefore = probe.catalogCalls;
    await bus.enqueue({
      uid: UID,
      cid,
      fromActorId: PEER_ACTOR_ID,
      forceTo: ['commander'],
      externalInbound: true,
      text: `公开问题 ${PEER_QUESTION}`,
    });
    await waitForQuiescent(cid);

    const externalCall = probe.modelCalls.find((call) => call.message.includes(PEER_QUESTION));
    expect(externalCall, 'no model call observed for the trusted commander reception').toBeTruthy();
    expect(externalCall!.systemPrompt).not.toContain(RECALL_MARKER);
    expect(externalCall!.systemPrompt).not.toContain(CATALOG_MARKER);
    // 不是空 system：接待回合仍有 commander 基础提示词。
    expect(externalCall!.systemPrompt.length).toBeGreaterThan(0);
    expect(externalCall!.receptionScope, 'the reception turn must carry the frozen scope').toMatchObject({
      sourceActorId: PEER_ACTOR_ID,
      conversationId: cid,
      root: grantRoot,
    });
    expect(probe.recallCalls, 'Recall injection ran for a trusted commander reception').toBe(recallBefore);
    expect(probe.catalogCalls, 'asset catalog injection ran for a trusted commander reception').toBe(catalogBefore);
  }, 120_000);

  it('keeps inherited cognition out of a trusted agent reception and keeps it for a local agent turn', async () => {
    const cid = 'c-s1recall-agent';
    await createReceptionConversation(cid);
    const bus = await import('../../../../src/main/features/group_chat/bus');

    await bus.enqueue({
      uid: UID,
      cid,
      fromActorId: 'user',
      forceTo: [AGENT_ID],
      text: `本地 agent 任务 ${LOCAL_MARKER}-AGENT`,
    });
    await waitForQuiescent(cid);

    const localCall = probe.modelCalls.find((call) => call.message.includes(`${LOCAL_MARKER}-AGENT`));
    expect(localCall, 'positive control: the local agent turn must reach the model').toBeTruthy();
    expect(localCall!.systemPrompt, `positive control: missing ${INHERITED_MARKER}`).toContain(INHERITED_MARKER);
    expect(localCall!.receptionScope).toBeUndefined();
    expect(probe.inheritedCalls, 'positive control: inherited-cognition selection must run for a local agent turn')
      .toBeGreaterThan(0);

    const inheritedBefore = probe.inheritedCalls;
    await bus.enqueue({
      uid: UID,
      cid,
      fromActorId: PEER_ACTOR_ID,
      forceTo: [AGENT_ID],
      externalInbound: true,
      text: `公开问题 ${PEER_QUESTION}-AGENT`,
    });
    await waitForQuiescent(cid);

    const externalCall = probe.modelCalls.find((call) => call.message.includes(`${PEER_QUESTION}-AGENT`));
    expect(externalCall, 'no model call observed for the trusted agent reception').toBeTruthy();
    expect(externalCall!.systemPrompt).not.toContain(INHERITED_MARKER);
    expect(
      probe.inheritedCalls,
      'inherited-cognition selection ran for a trusted agent reception',
    ).toBe(inheritedBefore);
    expect(externalCall!.receptionScope).toMatchObject({
      sourceActorId: PEER_ACTOR_ID,
      conversationId: cid,
      root: grantRoot,
    });
  }, 120_000);
});
