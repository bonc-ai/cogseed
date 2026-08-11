import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeCollaborationEvidence,
  recordAgentContributionEvidence,
  recordAgentRunStartEvidence,
  recordToolCycleEvidence,
} from '../../../../src/main/features/p3394/kstar-bus-integration';
import { getPendingEvidencePath } from '../../../../src/main/features/p3394/kstar-store';

async function readEvidence(userId: string): Promise<Array<Record<string, any>>> {
  const content = await fs.readFile(getPendingEvidencePath(userId), 'utf8');
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('kstar-bus-integration', () => {
  let previousRoot: string | undefined;
  let root: string;
  const userId = 'user-123';

  beforeEach(async () => {
    previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-kstar-bus-'));
    process.env.ORKAS_WORKSPACE_ROOT = root;
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
    else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('records tool cycles into the CogSeed backend evidence journal with a stable id', async () => {
    const input = {
      userId,
      conversationId: 'conv-456',
      agentId: 'agent-789',
      turnId: 'turn-abc',
      toolCallId: 'tool-def',
      toolName: 'read_file',
      resultPreview: 'File contents...',
      isError: false,
    };

    const first = await recordToolCycleEvidence(input);
    const second = await recordToolCycleEvidence(input);

    expect(first).toMatchObject({ success: true, boundary: { mode: 'real', provider: 'cogseed-backend' } });
    expect(second).toMatchObject({ success: true, deduplicated: true });
    const rows = await readEvidence(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'tool-conv-456-agent-789-turn-abc-tool-def',
      type: 'tool_cycle',
      tool_name: 'read_file',
      status: 'succeeded',
      boundary: { mode: 'real', provider: 'cogseed-backend' },
    });
  });

  it('records failed tool status and agent run starts without a standalone adapter', async () => {
    await recordToolCycleEvidence({
      userId,
      conversationId: 'conv-456',
      agentId: 'agent-789',
      turnId: 'turn-abc',
      toolCallId: 'tool-err',
      toolName: 'bash',
      resultPreview: 'Command failed',
      isError: true,
    });
    await recordAgentRunStartEvidence({
      userId,
      conversationId: 'conv-456',
      agentId: 'agent-789',
      turnId: 'turn-abc',
      data: { model: 'gpt', runtime: 'cogseed' },
    });

    const rows = await readEvidence(userId);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_cycle', status: 'failed', is_error: true }),
      expect.objectContaining({ id: 'run-start-conv-456-agent-789-turn-abc', type: 'agent_run_result', runtime: 'cogseed' }),
    ]));
  });

  it('preserves KSTAR expectation metadata on contribution evidence', async () => {
    const expectation = {
      situation: 'Need review',
      task: 'Review branch',
      action_hat: 'Inspect diff',
      result_hat: 'Actionable comments',
    };

    await recordAgentContributionEvidence({
      userId,
      conversationId: 'conv-456',
      agentId: 'agent-789',
      turnId: 'turn-abc',
      messageId: 'msg-1',
      actualResult: 'Looks good',
      kstarDecision: { required: true, reason: 'review gate', expectation, source: 'commander', commander_mode: 'required' },
      outcomeStatus: 'success',
      actualAction: 'Reviewed files',
    });

    const [row] = await readEvidence(userId);
    expect(row).toMatchObject({
      id: 'contribution-conv-456-agent-789-turn-abc-msg-1',
      type: 'conversation_message',
      kstar_decision: { expectation },
    });
  });

  it('closes collaboration through the same CogSeed backend journal after contribution evidence exists', async () => {
    await recordAgentContributionEvidence({
      userId,
      conversationId: 'conv-456',
      agentId: 'agent-789',
      turnId: 'turn-abc',
      messageId: 'msg-1',
      actualResult: 'Done',
      outcomeStatus: 'success',
      actualAction: 'Completed task',
    });

    const result = await closeCollaborationEvidence(userId, {
      conversationId: 'conv-456',
      commanderId: 'commander',
      outcomeStatus: 'completed',
    });

    expect(result).toMatchObject({ success: true, runId: 'collab-conv-456-commander', boundary: { provider: 'cogseed-backend' } });
    const rows = await readEvidence(userId);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'collab-conv-456-commander', type: 'collaboration_close' }),
    ]));
  });
});
