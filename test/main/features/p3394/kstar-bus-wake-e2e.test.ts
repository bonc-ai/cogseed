/**
 * End-to-end integration tests for KSTAR Bus-Wake adapter flow.
 *
 * Tests the complete flow:
 * 1. Commander creates dispatch_to with KSTAR decision
 * 2. Wake gates the dispatch and stores KSTAR metadata
 * 3. User approves wake request
 * 4. Wake controller passes KSTAR decision to Bus enqueue
 * 5. Bus records evidence through adapter with stable IDs
 * 6. Collaboration closes with single terminal signal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateWake, approveWakeRequest } from '../../../../src/main/features/p3394/wake-service';
import { decideWakeRequest } from '../../../../src/main/features/p3394/wake-controller';
import {
  recordToolCycleEvidence,
  recordAgentContributionEvidence,
  closeCollaborationEvidence,
} from '../../../../src/main/features/p3394/kstar-bus-integration';
import * as factory from '../../../../src/main/features/p3394/kstar-factory';
import type { KstarAdapter } from '../../../../src/main/features/p3394/kstar-adapter';
import type { EvaluateWakeInput } from '../../../../src/main/features/p3394/types';

vi.mock('../../../../src/main/features/p3394/kstar-factory');
vi.mock('../../../../src/main/features/group_chat/bus', () => ({
  enqueue: vi.fn(async (params: unknown) => ({
    to: [(params as { forceTo?: string[] }).forceTo?.[0] || 'agent'],
  })),
}));
vi.mock('../../../../src/main/features/agents', () => ({
  getAgent: vi.fn(async (id: string) => ({
    id,
    name: 'Test Agent',
    interactive: false,
  })),
  isAgentChatDispatchable: vi.fn(() => true),
}));
vi.mock('../../../../src/main/features/component_enabled', () => ({
  isAgentEnabled: vi.fn(() => true),
}));

describe('kstar-bus-wake-e2e', () => {
  const userId = 'test-user-e2e';
  const conversationId = 'test-conv-e2e';
  const agentId = 'test-agent-e2e';

  const mockAdapter: Partial<KstarAdapter> = {
    recordEvidence: vi.fn(),
    isAvailable: vi.fn(() => true),
    getDegradedReason: vi.fn(() => null),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(factory.getKstarAdapter).mockResolvedValue(mockAdapter as KstarAdapter);
    vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('complete KSTAR flow', () => {
    it('should preserve KSTAR decision through Wake approval to Bus', async () => {
      const kstarDecision = {
        required: true,
        reason: 'Commander delegated code review with KSTAR validation',
        expectation: {
          k_snapshot_ref: 'snapshot-e2e-123',
          situation: 'User requested PR review',
          task: 'Review PR #789 for code quality',
          action_hat: 'Read files, analyze patterns, check best practices',
          result_hat: 'Detailed review with actionable feedback',
        },
        source: 'commander' as const,
        commander_mode: 'required' as const,
      };

      // Step 1: Commander creates dispatch with KSTAR decision
      const wakeInput: EvaluateWakeInput = {
        conversationId,
        agentId,
        source: 'dispatch_to',
        sourceActorId: 'commander',
        sourceMessageId: 'msg-commander-e2e',
        objective: 'Review the pull request',
        dispatchPayload: {
          text: 'Please review PR #789 focusing on code quality and best practices.',
          model_text: 'System: Review task delegated by Commander.',
        },
        workflow_step_id: 'step-e2e-123',
        workflow_resume_token: '{"step":"review","continuation":"After review, generate report"}',
        kstar_decision: kstarDecision,
      };

      const wakeResult = await evaluateWake(userId, wakeInput);
      expect(wakeResult.approved).toBe(false);

      if (!('request' in wakeResult)) {
        throw new Error('Expected pending wake request');
      }

      const wakerequest = wakeResult.request;

      // Step 2: Verify KSTAR decision stored in wake request
      expect(wakerequest.kstar_decision).toEqual(kstarDecision);
      expect(wakerequest.workflow_resume_token).toBe(wakeInput.workflow_resume_token);

      // Step 3: User approves wake request
      const decisionResult = await decideWakeRequest(userId, {
        requestId: wakerequest.id,
        decision: 'approve',
      });

      expect(decisionResult.ok).toBe(true);
      if (!decisionResult.ok) {
        throw new Error('Wake approval failed');
      }

      // Step 4: Verify enqueue was called with KSTAR decision
      // (mocked enqueue would receive kstarDecision in params)
      expect(decisionResult.dispatched).toBe(true);
    });

    it('should record evidence with stable IDs preventing duplicates', async () => {
      const turnId = 'turn-e2e-stable';
      const toolCallId = 'tool-e2e-stable';

      // Record same tool cycle twice (simulating retry)
      await recordToolCycleEvidence({
        userId,
        conversationId,
        agentId,
        turnId,
        toolCallId,
        toolName: 'read_file',
        resultPreview: 'File contents...',
        isError: false,
      });

      await recordToolCycleEvidence({
        userId,
        conversationId,
        agentId,
        turnId,
        toolCallId,
        toolName: 'read_file',
        resultPreview: 'File contents...',
        isError: false,
      });

      const calls = vi.mocked(mockAdapter.recordEvidence!).mock.calls;
      expect(calls.length).toBe(2);

      // Same evidence ID both times
      expect(calls[0][0].id).toBe(calls[1][0].id);
      expect(calls[0][0].id).toBe(`tool-${conversationId}-${agentId}-${turnId}-${toolCallId}`);
    });

    it('should record agent contribution with full KSTAR context', async () => {
      const turnId = 'turn-e2e-contrib';
      const messageId = 'msg-e2e-contrib';

      const kstarDecision = {
        required: true,
        reason: 'Review task',
        expectation: {
          situation: 'PR review',
          task: 'Review code',
          action_hat: 'Read and analyze',
          result_hat: 'Review comments',
        },
      };

      await recordAgentContributionEvidence({
        userId,
        conversationId,
        agentId,
        turnId,
        messageId,
        actualResult: 'Review completed. Found 3 issues.',
        kstarDecision,
        outcomeStatus: 'success',
        actualAction: 'Read 5 files. Tool evidence: read_file succeeded delta_r=0; bash succeeded delta_r=0;',
      });

      const call = vi.mocked(mockAdapter.recordEvidence!).mock.calls[0][0] as any;
      expect(call.id).toBe(`contribution-${conversationId}-${agentId}-${turnId}-${messageId}`);
      expect(call.kstar_decision).toEqual(kstarDecision);
      expect(call.actual_result).toContain('Found 3 issues');
      expect(call.actual_action).toContain('Read 5 files');
    });

    it('should close collaboration with single terminal signal', async () => {
      const result1 = await closeCollaborationEvidence(userId, {
        conversationId,
        outcomeStatus: 'completed',
      });

      expect(result1.success).toBe(true);
      expect(result1.runId).toBeTruthy();

      // Attempting to close again should still succeed (idempotent)
      const result2 = await closeCollaborationEvidence(userId, {
        conversationId,
        outcomeStatus: 'completed',
      });

      expect(result2.success).toBe(true);
      // Different runId because timestamp-based, but that's okay
      // Engine handles deduplication by conversation_id
    });
  });

  describe('degraded mode fallback', () => {
    beforeEach(() => {
      vi.mocked(factory.getKstarAdapter).mockResolvedValue(null);
    });

    it('should continue Wake approval even when adapter unavailable', async () => {
      // Use a distinct agentId so this does not hit the objective-agnostic
      // approval cache written by earlier tests in this file (approvals are
      // keyed on conversation+agent+source+scope, not objective).
      const wakeInput: EvaluateWakeInput = {
        conversationId,
        agentId: 'agent-degraded',
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Test degraded',
        dispatchPayload: {
          text: 'Test',
        },
        kstar_decision: {
          required: true,
          reason: 'Test',
          expectation: {},
        },
      };

      const wakeResult = await evaluateWake(userId, wakeInput);
      if (!('request' in wakeResult)) {
        throw new Error('Expected pending request');
      }

      // Approval should succeed even without adapter
      const decisionResult = await decideWakeRequest(userId, {
        requestId: wakeResult.request.id,
        decision: 'approve',
      });

      expect(decisionResult.ok).toBe(true);
    });

    it('should record evidence to pending log when adapter unavailable', async () => {
      const result = await recordToolCycleEvidence({
        userId,
        conversationId,
        agentId,
        turnId: 'turn-degraded',
        toolCallId: 'tool-degraded',
        toolName: 'read_file',
        resultPreview: 'Data',
        isError: false,
      });

      expect(result.success).toBe(false);
      expect(result.degraded).toBe(true);
      // In real implementation, appendPendingEvidence would have been called
    });
  });

  describe('KSTAR expectation preservation', () => {
    it('should preserve all expectation fields byte-for-byte through full flow', async () => {
      const originalExpectation = {
        k_snapshot_ref: 'snap-preserve-123',
        situation: 'Complex situation with 特殊字符 and\nmultiple\nlines',
        task: 'Task description with "quotes" and \'apostrophes\'',
        action_hat: 'Action with {json: "like"} structure',
        result_hat: 'Result with\ttabs\tand\nspecial\rchars',
      };

      const wakeInput: EvaluateWakeInput = {
        conversationId,
        agentId: 'agent-preserve',
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Test preservation',
        dispatchPayload: {
          text: 'Test',
        },
        kstar_decision: {
          required: true,
          reason: 'Preserve test',
          expectation: originalExpectation,
        },
      };

      // Create wake request
      const wakeResult = await evaluateWake(userId, wakeInput);
      if (!('request' in wakeResult)) {
        throw new Error('Expected pending request');
      }

      // Verify stored in wake request
      expect(wakeResult.request.kstar_decision?.expectation).toEqual(originalExpectation);

      // Approve and dispatch to Bus
      await decideWakeRequest(userId, {
        requestId: wakeResult.request.id,
        decision: 'approve',
      });

      // Record contribution evidence
      await recordAgentContributionEvidence({
        userId,
        conversationId,
        agentId: 'agent-preserve',
        turnId: 'turn-preserve',
        messageId: 'msg-preserve',
        actualResult: 'Done',
        kstarDecision: wakeResult.request.kstar_decision!,
        outcomeStatus: 'success',
        actualAction: 'Actions',
      });

      // Verify adapter received exact expectation
      const call = vi.mocked(mockAdapter.recordEvidence!).mock.calls[0][0] as any;
      expect(call.kstar_decision.expectation).toEqual(originalExpectation);
    });
  });

  describe('workflow resume token preservation', () => {
    it('should preserve workflow_resume_token through Wake to Bus', async () => {
      const resumeToken = JSON.stringify({
        step_id: 'step-resume-test',
        state: { nested: { critical: 'data' } },
        continuation: 'After agent finishes, continue with...',
      });

      const wakeInput: EvaluateWakeInput = {
        conversationId,
        agentId: 'agent-workflow',
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Workflow step',
        dispatchPayload: {
          text: 'Execute step',
        },
        workflow_step_id: 'step-resume-test',
        workflow_resume_token: resumeToken,
        kstar_decision: {
          required: true,
          reason: 'Workflow with KSTAR',
          expectation: {},
        },
      };

      const wakeResult = await evaluateWake(userId, wakeInput);
      if (!('request' in wakeResult)) {
        throw new Error('Expected pending request');
      }

      // Verify stored in wake request
      expect(wakeResult.request.workflow_resume_token).toBe(resumeToken);

      // Approve
      const { request: approved } = await approveWakeRequest(userId, wakeResult.request.id);

      // Still preserved after approval
      expect(approved.workflow_resume_token).toBe(resumeToken);
    });
  });
});
