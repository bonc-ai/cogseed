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
});
