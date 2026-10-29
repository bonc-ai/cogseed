import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as paths from '../../../../src/main/paths';
import * as chats from '../../../../src/main/features/chats';
import { COGSEED_RUNTIME_TOOL_POLICY } from '../../../../src/main/features/cogseed_runtime/kernel/config';
import {
  deriveRuntimeToolPolicy,
  resolveRuntimeToolPolicyForRun,
  shouldAutoApproveRuntimeAction,
} from '../../../../src/main/features/cogseed_backend/runtime-tool-policy';
import { getOrCreateCogSeedCommanderSession } from '../../../../src/main/features/cogseed_backend/session-store';
import { createCogSeedTask } from '../../../../src/main/features/cogseed_backend/task-store';

const UID = 'cogseed-runtime-policy-user';
const CID = 'conversation-policy';
let workspace = '';

function makeWorkspace(): string {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-policy-'));
  return workspace;
}

afterEach(() => {
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

async function conversationWithMode(permissionMode?: 'full' | 'auto_approve' | 'ask'): Promise<void> {
  await chats.createConversation(UID, { conversationId: CID, title: CID });
  if (permissionMode) await chats.updateConversation(UID, CID, { permission_mode: permissionMode });
}

async function commanderTask(requestId: string) {
  const session = await getOrCreateCogSeedCommanderSession(UID, CID);
  const record = (await createCogSeedTask(UID, {
    requestId,
    task: 'Do the work',
    sessionId: session.sessionId,
    conversationId: CID,
    ...(workspace ? { workingDir: workspace } : {}),
  })).task;
  return record;
}

describe('CogSeed Runtime tool policy derivation', () => {
  it('grants workspace-bounded write and approved shell for every permission mode', () => {
    for (const mode of ['full', 'auto_approve', 'ask'] as const) {
      const policy = deriveRuntimeToolPolicy(mode, '/tmp/cogseed-workspace');
      expect(policy).toMatchObject({
        fileRead: 'explicit_roots',
        fileWrite: 'explicit_writable_roots',
        shell: 'allow_with_confirmation',
        // Skill execution stays exactly as allowlisted as before.
        skillRun: 'none',
        network: 'none',
        connectors: 'enabled',
      });
    }
  });

  it('maps danger_full_access to all-file read/write without changing approval semantics', () => {
    const policy = deriveRuntimeToolPolicy('danger_full_access', '/tmp/cogseed-workspace');
    expect(policy).toMatchObject({
      fileRead: 'all',
      fileWrite: 'all',
      shell: 'allow_with_confirmation',
      skillRun: 'none',
      network: 'none',
      connectors: 'enabled',
    });
  });

  it('does not advertise write tools when the run has no writable workspace', () => {
    expect(deriveRuntimeToolPolicy('full', undefined).fileWrite).toBe('none');
  });

  it('derives the policy from the persisted conversation permission mode', async () => {
    makeWorkspace();
    await conversationWithMode('ask');
    await expect(resolveRuntimeToolPolicyForRun(UID, CID, workspace)).resolves.toMatchObject({
      fileWrite: 'explicit_writable_roots',
      shell: 'allow_with_confirmation',
    });

    // Legacy conversations without the field behave like the CLI path: unknown is
    // the same as `ask`, which still prompts for high-risk actions.
    await chats.createConversation(UID, { conversationId: 'conversation-legacy', title: 'legacy' });
    await expect(resolveRuntimeToolPolicyForRun(UID, 'conversation-legacy', workspace)).resolves.toEqual(
      deriveRuntimeToolPolicy('ask', workspace),
    );

    // No conversation at all stays on the conservative default.
    await expect(resolveRuntimeToolPolicyForRun(UID, undefined, workspace)).resolves.toEqual(COGSEED_RUNTIME_TOOL_POLICY);
  });

  it('auto-approves sensitive Runtime actions only for full/auto_approve conversations', async () => {
    makeWorkspace();
    await conversationWithMode('full');
    const full = await commanderTask('req-policy-full');
    await expect(shouldAutoApproveRuntimeAction(UID, full.requestId, full.runtimeSessionId)).resolves.toBe(true);

    await chats.updateConversation(UID, CID, { permission_mode: 'ask' });
    await expect(shouldAutoApproveRuntimeAction(UID, full.requestId, full.runtimeSessionId)).resolves.toBe(false);

    await chats.updateConversation(UID, CID, { permission_mode: 'auto_approve' });
    await expect(shouldAutoApproveRuntimeAction(UID, full.requestId, full.runtimeSessionId)).resolves.toBe(true);

    // A worker cannot borrow another runtime session, and an unknown request
    // never auto-approves.
    await expect(shouldAutoApproveRuntimeAction(UID, full.requestId, 'mruntime-other')).resolves.toBe(false);
    await expect(shouldAutoApproveRuntimeAction(UID, 'req-unknown', full.runtimeSessionId)).resolves.toBe(false);
  });

  it('narrows the run policy inside an active receiving A2A conversation', async () => {
    makeWorkspace();
    await conversationWithMode('full');
    await chats.updateConversation(UID, CID, {
      a2a: { role: 'receiver', peer_user_id: 'cs_alice', state: 'active' },
    });
    const policy = await resolveRuntimeToolPolicyForRun(UID, CID, workspace);
    // 写与执行按设计保留，但只能经由接收方逐次审批；网络/连接器/技能仍关。
    expect(policy).toMatchObject({
      fileRead: 'explicit_roots',
      fileWrite: 'explicit_writable_roots',
      shell: 'allow_with_confirmation',
      skillRun: 'none',
      network: 'none',
      connectors: 'none',
    });
  });

  it('never auto-approves inside a reception conversation, even at full permission', async () => {
    makeWorkspace();
    await conversationWithMode('full');
    const task = await commanderTask('req-a2a-reception');
    await expect(shouldAutoApproveRuntimeAction(UID, task.requestId, task.runtimeSessionId)).resolves.toBe(true);

    await chats.updateConversation(UID, CID, {
      a2a: { role: 'receiver', peer_user_id: 'cs_alice', state: 'active' },
    });
    // 对端的请求不是本人授权：每次都要接收方本人点（R-03）。
    await expect(shouldAutoApproveRuntimeAction(UID, task.requestId, task.runtimeSessionId)).resolves.toBe(false);

    await chats.updateConversation(UID, CID, {
      a2a: { role: 'initiator', peer_user_id: 'cs_bob', state: 'active' },
    });
    await expect(shouldAutoApproveRuntimeAction(UID, task.requestId, task.runtimeSessionId)).resolves.toBe(true);
  });
});

describe('CogSeed Runtime › which runs count as a reception', () => {
  it('classifies by the run source message, not by the conversation alone', async () => {
    const { isA2AReceptionRequest } = await import('../../../../src/main/features/cogseed_backend/runtime-tool-policy');
    const { userChatsDir } = await import('../../../../src/main/paths');
    const cid = 'a2a-single-thread';
    await chats.createConversation(UID, { conversationId: cid, title: cid });
    await chats.updateConversation(UID, cid, {
      a2a: { inbound: true, peer_user_id: 'cs_peer', state: 'active', exchange_id: cid },
    });
    const dir = userChatsDir(UID);
    fs.mkdirSync(dir, { recursive: true });
    const rows = [
      { id: 'm-peer-question', from: 'a2a_cs_peer', to: ['commander'], text: '你们几点上班？', ts: new Date().toISOString() },
      { id: 'm-my-question', from: 'user', to: ['commander'], text: '你们呢？', ts: new Date().toISOString() },
    ];
    fs.writeFileSync(path.join(dir, `${cid}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

    const session = await getOrCreateCogSeedCommanderSession(UID, cid);
    const makeTask = async (requestId: string, sourceId?: string) => (await createCogSeedTask(UID, {
      requestId,
      task: 'answer',
      sessionId: session.sessionId,
      conversationId: cid,
      ...(sourceId ? { groupChatSourceMessageId: sourceId } : {}),
    })).task;

    // 对端问我的那条触发的运行 = 接待（受 L2 收口）。
    const peerRun = await makeTask('req-peer', 'm-peer-question');
    await expect(isA2AReceptionRequest(UID, peerRun.requestId, peerRun.runtimeSessionId)).resolves.toBe(true);

    // 我自己提问触发的运行 = 普通运行，即便这条会话里也接待过对方。
    const mine = await makeTask('req-mine', 'm-my-question');
    await expect(isA2AReceptionRequest(UID, mine.requestId, mine.runtimeSessionId)).resolves.toBe(false);
  });
});
