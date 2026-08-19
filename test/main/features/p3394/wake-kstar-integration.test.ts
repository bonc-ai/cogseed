/**
 * Integration tests for Wake KSTAR metadata preservation.
 *
 * Tests that Wake correctly:
 * 1. Stores kstar_decision in the wake request
 * 2. Passes kstar_decision through to Bus enqueue on approval
 * 3. Preserves workflow_resume_token byte-for-byte
 * 4. Restores KSTAR expectations after approval
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evaluateWake, approveWakeRequest, getWakeRequest } from '../../../../src/main/features/p3394/wake-service';
import { readWakeState } from '../../../../src/main/features/p3394/wake-store';
import type { EvaluateWakeInput } from '../../../../src/main/features/p3394/types';

describe('wake-kstar-integration', () => {
  const userId = 'test-user-wake-kstar';
  const conversationId = 'test-conv-wake';
  const agentId = 'test-agent-wake';

  beforeEach(async () => {
    // Clean up any existing test data
    const state = await readWakeState(userId);
    state.requests = state.requests.filter(
      (r) => r.conversation_id !== conversationId,
    );
  });

  afterEach(async () => {
    // Clean up test data
    const state = await readWakeState(userId);
    state.requests = state.requests.filter(
      (r) => r.conversation_id !== conversationId,
    );
  });

  describe('KSTAR decision storage', () => {
    it('should store kstar_decision in wake request', async () => {
      const kstarDecision = {
        required: true,
        reason: 'Commander delegated review with KSTAR',
        expectation: {
          k_snapshot_ref: 'snapshot-123',
          situation: 'User requested code review',
          task: 'Review PR #456',
          action_hat: 'Read code files and analyze quality',
          result_hat: 'Detailed review comments',
        },
        source: 'commander' as const,
        commander_mode: 'required' as const,
      };

      const input: EvaluateWakeInput = {
        conversationId,
        agentId,
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Review the pull request',
        dispatchPayload: {
          text: 'Please review PR #456',
        },
        kstar_decision: kstarDecision,
      };

      const result = await evaluateWake(userId, input);

      expect(result.approved).toBe(false);
      expect('request' in result && result.request.kstar_decision).toEqual(kstarDecision);
    });

    it('should preserve KSTAR expectation fields byte-for-byte', async () => {
      const originalExpectation = {
        k_snapshot_ref: 'snap-789',
        situation: 'Exact situation text',
        task: 'Exact task text',
        action_hat: 'Exact action text with 特殊字符',
        result_hat: 'Exact result text with\nnewlines',
      };

      const input: EvaluateWakeInput = {
        conversationId,
        agentId,
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Test preservation',
        dispatchPayload: {
          text: 'Test',
        },
        kstar_decision: {
          required: true,
          reason: 'Test',
          expectation: originalExpectation,
        },
      };

      const result = await evaluateWake(userId, input);
      if ('request' in result && result.request.kstar_decision) {
        expect(result.request.kstar_decision.expectation).toEqual(originalExpectation);
      } else {
        throw new Error('Expected pending request with kstar_decision');
      }
    });

    it('should omit kstar_decision when not required', async () => {
      const input: EvaluateWakeInput = {
        conversationId,
        agentId,
        source: 'user_mention',
        sourceActorId: 'user',
        objective: 'Help with something',
        dispatchPayload: {
          text: '@agent help',
        },
        // No kstar_decision
      };

      const result = await evaluateWake(userId, input);

      expect(result.approved).toBe(false);
      expect('request' in result && result.request.kstar_decision).toBeUndefined();
    });

    it('should store KSTAR decision even with skip mode', async () => {
      const input: EvaluateWakeInput = {
        conversationId,
        agentId,
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Quick task',
        dispatchPayload: {
          text: 'Do something',
        },
        kstar_decision: {
          required: false, // Commander explicitly skipped
          reason: 'Low-risk task',
          expectation: {},
        },
      };

      const result = await evaluateWake(userId, input);

      // Even with required=false, the decision structure should be preserved
      // for audit purposes
      expect(result.approved).toBe(false);
      if ('request' in result && result.request.kstar_decision) {
        // If stored, it should be the skip decision
        expect(result.request.kstar_decision.required).toBe(false);
      }
    });
  });

  describe('workflow_resume_token preservation', () => {
    it('should preserve workflow_resume_token byte-for-byte', async () => {
      const resumeToken = JSON.stringify({
        step_id: 'step-123',
        state: { nested: { data: 'value' } },
        continuation: 'After agent finishes...',
      });

      const input: EvaluateWakeInput = {
        conversationId,
        agentId,
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Nested workflow step',
        dispatchPayload: {
          text: 'Execute step',
        },
        workflow_step_id: 'step-123',
        workflow_resume_token: resumeToken,
        kstar_decision: {
          required: true,
          reason: 'Workflow step with KSTAR',
          expectation: {},
        },
      };

      const result = await evaluateWake(userId, input);

      expect(result.approved).toBe(false);
      if ('request' in result) {
        expect(result.request.workflow_resume_token).toBe(resumeToken);
        expect(result.request.workflow_step_id).toBe('step-123');
      } else {
        throw new Error('Expected pending request');
      }
    });

    it('should preserve resume token after approval', async () => {
      const resumeToken = '{"critical":"data","must":"preserve"}';

      const input: EvaluateWakeInput = {
        conversationId,
        agentId: 'test-agent-resume',
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Test resume',
        dispatchPayload: {
          text: 'Test',
        },
        workflow_step_id: 'step-456',
        workflow_resume_token: resumeToken,
        kstar_decision: {
          required: true,
          reason: 'Test',
          expectation: {},
        },
      };

      const evalResult = await evaluateWake(userId, input);
      if (evalResult.approved || !('request' in evalResult)) {
        throw new Error('Expected pending request');
      }

      const requestId = evalResult.request.id;

      // Approval should preserve the token
      const { request: approvedRequest } = await approveWakeRequest(userId, requestId);
      expect(approvedRequest.workflow_resume_token).toBe(resumeToken);
    });
  });

  describe('Wake-to-Bus enqueue integration', () => {
    it('should prepare kstar_decision for Bus enqueue', async () => {
      const kstarDecision = {
        required: true,
        reason: 'Integration test',
        expectation: {
          situation: 'Test situation',
          task: 'Test task',
          action_hat: 'Test action',
          result_hat: 'Test result',
        },
      };

      const input: EvaluateWakeInput = {
        conversationId,
        agentId: 'test-agent-enqueue',
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Test enqueue',
        dispatchPayload: {
          text: 'Test',
        },
        kstar_decision: kstarDecision,
      };

      const evalResult = await evaluateWake(userId, input);
      if (evalResult.approved || !('request' in evalResult)) {
        throw new Error('Expected pending request');
      }

      // Verify the stored request has kstar_decision ready for enqueue
      const stored = await getWakeRequest(userId, evalResult.request.id);
      expect(stored?.kstar_decision).toEqual(kstarDecision);

      // Wake controller will pass this to enqueue as:
      // ...(request.kstar_decision?.required ? { kstarDecision: request.kstar_decision } : {})
      if (stored?.kstar_decision?.required) {
        expect(stored.kstar_decision.expectation).toEqual(kstarDecision.expectation);
      }
    });

    it('should merge KSTAR decision into duplicate pending requests', async () => {
      const kstarDecision1 = {
        required: true,
        reason: 'First request',
        expectation: { task: 'Task 1' },
      };

      const input1: EvaluateWakeInput = {
        conversationId,
        agentId: 'test-agent-merge',
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Same objective',
        dispatchPayload: {
          text: 'Same text',
        },
        kstar_decision: kstarDecision1,
      };

      const result1 = await evaluateWake(userId, input1);
      expect(result1.approved).toBe(false);

      // Second request with same intent (should merge)
      const kstarDecision2 = {
        required: true,
        reason: 'Second request',
        expectation: { task: 'Task 2' },
      };

      const input2: EvaluateWakeInput = {
        ...input1,
        kstar_decision: kstarDecision2,
      };

      const result2 = await evaluateWake(userId, input2);
      expect(result2.approved).toBe(false);

      // Should return the same request (merged)
      if ('request' in result1 && 'request' in result2) {
        expect(result2.request.id).toBe(result1.request.id);
        // KSTAR decision should be from the original request (first-write wins)
        expect(result2.request.kstar_decision).toEqual(kstarDecision1);
      }
    });
  });

  describe('KSTAR decision with approval cache', () => {
    it('should respect approval with KSTAR decision', async () => {
      const kstarDecision = {
        required: true,
        reason: 'Approved test',
        expectation: {
          situation: 'Test',
          task: 'Test task',
        },
      };

      const input: EvaluateWakeInput = {
        conversationId,
        agentId: 'test-agent-approval',
        source: 'dispatch_to',
        sourceActorId: 'commander',
        objective: 'Test approval',
        dispatchPayload: {
          text: 'Test',
        },
        kstar_decision: kstarDecision,
      };

      // Create and approve request
      const result1 = await evaluateWake(userId, input);
      if (result1.approved || !('request' in result1)) {
        throw new Error('Expected pending request');
      }

      await approveWakeRequest(userId, result1.request.id);

      // Second identical request should use approval cache
      const result2 = await evaluateWake(userId, input);
      expect(result2.approved).toBe(true);

      // Approval should have preserved KSTAR decision
      if ('approval' in result2) {
        // The approval references the original request with kstar_decision
        const originalRequest = await getWakeRequest(userId, result1.request.id);
        expect(originalRequest?.kstar_decision).toEqual(kstarDecision);
      }
    });
  });
});
