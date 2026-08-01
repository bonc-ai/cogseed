/**
 * Integration tests for KSTAR Bus evidence recording through the adapter.
 *
 * Tests:
 * 1. Tool cycle evidence recording with stable IDs (deduplication)
 * 2. Agent run start evidence recording
 * 3. Agent contribution evidence recording
 * 4. Collaboration close evidence recording
 * 5. Degraded mode (adapter unavailable, pending log fallback)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordToolCycleEvidence,
  recordAgentRunStartEvidence,
  recordAgentContributionEvidence,
  closeCollaborationEvidence,
} from '../../../../src/main/features/p3394/kstar-bus-integration';
import * as factory from '../../../../src/main/features/p3394/kstar-factory';
import type { KstarAdapter } from '../../../../src/main/features/p3394/kstar-adapter';

vi.mock('../../../../src/main/features/p3394/kstar-factory');

describe('kstar-bus-integration', () => {
  const mockAdapter: Partial<KstarAdapter> = {
    recordEvidence: vi.fn(),
    isAvailable: vi.fn(() => true),
    getDegradedReason: vi.fn(() => null),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(factory.getKstarAdapter).mockResolvedValue(mockAdapter as KstarAdapter);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordToolCycleEvidence', () => {
    it('should record tool cycle with stable evidence ID', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      const result = await recordToolCycleEvidence({
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        toolCallId: 'tool-def',
        toolName: 'read_file',
        resultPreview: 'File contents...',
        isError: false,
      });

      expect(result.success).toBe(true);
      expect(mockAdapter.recordEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'tool-conv-456-agent-789-turn-abc-tool-def',
          type: 'tool_cycle',
          tool_name: 'read_file',
          status: 'succeeded',
          is_error: false,
        }),
      );
    });

    it('should use same evidence ID for retry (deduplication)', async () => {
      vi.mocked(mockAdapter.recordEvidence!)
        .mockResolvedValueOnce({ success: true, deduplicated: false })
        .mockResolvedValueOnce({ success: true, deduplicated: true });

      const input = {
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        toolCallId: 'tool-def',
        toolName: 'write_file',
        resultPreview: 'Success',
        isError: false,
      };

      await recordToolCycleEvidence(input);
      const result2 = await recordToolCycleEvidence(input);

      const calls = vi.mocked(mockAdapter.recordEvidence!).mock.calls;
      expect(calls[0][0].id).toBe(calls[1][0].id);
      expect(result2.success).toBe(true);
    });

    it('should mark error status for failed tools', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      await recordToolCycleEvidence({
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        toolCallId: 'tool-err',
        toolName: 'bash',
        resultPreview: 'Command failed',
        isError: true,
      });

      expect(mockAdapter.recordEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          is_error: true,
        }),
      );
    });
  });

  describe('recordAgentRunStartEvidence', () => {
    it('should record agent run start with stable evidence ID', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      const result = await recordAgentRunStartEvidence({
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        data: { model: 'opus-4', runtime: 'node' },
      });

      expect(result.success).toBe(true);
      expect(mockAdapter.recordEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'run-start-conv-456-agent-789-turn-abc',
          type: 'agent_run_result',
          phase: 'start',
          model: 'opus-4',
          runtime: 'node',
        }),
      );
    });
  });

  describe('recordAgentContributionEvidence', () => {
    it('should record agent contribution with KSTAR decision metadata', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      const kstarDecision = {
        required: true,
        reason: 'Commander delegated with KSTAR review',
        expectation: {
          situation: 'User requested code review',
          task: 'Review PR #123',
          action_hat: 'Read files and analyze',
          result_hat: 'Review comments',
        },
        source: 'commander' as const,
        commander_mode: 'required' as const,
      };

      const result = await recordAgentContributionEvidence({
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        messageId: 'msg-xyz',
        actualResult: 'Review completed: found 3 issues.',
        kstarDecision,
        outcomeStatus: 'success',
        actualAction: 'Read 5 files. Tool evidence: read_file succeeded delta_r=0;',
      });

      expect(result.success).toBe(true);
      expect(mockAdapter.recordEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'contribution-conv-456-agent-789-turn-abc-msg-xyz',
          type: 'conversation_message',
          kstar_decision: kstarDecision,
          actual_result: 'Review completed: found 3 issues.',
          actual_action: expect.stringContaining('read_file succeeded'),
        }),
      );
    });

    it('should preserve expectation fields byte-for-byte', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      const kstarDecision = {
        required: true,
        reason: 'Test',
        expectation: {
          k_snapshot_ref: 'snapshot-123',
          situation: 'Original situation',
          task: 'Original task',
          action_hat: 'Original action',
          result_hat: 'Original result',
        },
      };

      await recordAgentContributionEvidence({
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        messageId: 'msg-xyz',
        actualResult: 'Done',
        kstarDecision,
        outcomeStatus: 'success',
        actualAction: 'No tools',
      });

      const call = vi.mocked(mockAdapter.recordEvidence!).mock.calls[0][0] as any;
      expect(call.kstar_decision.expectation).toEqual(kstarDecision.expectation);
    });
  });

  describe('closeCollaborationEvidence', () => {
    it('should record collaboration close for completed outcome', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      const result = await closeCollaborationEvidence('user-123', {
        conversationId: 'conv-456',
        commanderId: 'commander',
        outcomeStatus: 'completed',
      });

      expect(result.success).toBe(true);
      expect(result.runId).toMatch(/^collab-conv-456-commander-/);
      expect(mockAdapter.recordEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'collaboration_close',
          outcome_status: 'completed',
        }),
      );
    });

    it('should record failed outcome', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      await closeCollaborationEvidence('user-123', {
        conversationId: 'conv-456',
        outcomeStatus: 'failed',
      });

      expect(mockAdapter.recordEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome_status: 'failed',
        }),
      );
    });

    it('should use default commander ID if not provided', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      const result = await closeCollaborationEvidence('user-123', {
        conversationId: 'conv-456',
        outcomeStatus: 'completed',
      });

      expect(result.runId).toContain('commander');
    });

    it('marks a failed close fallback as degraded while preserving the Engine boundary', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({
        success: false,
        boundary: { mode: 'real', provider: 'meta-skill-engine-mcp' },
      });

      const result = await closeCollaborationEvidence('user-123', {
        conversationId: 'conv-456',
        outcomeStatus: 'completed',
      });

      expect(result).toMatchObject({
        success: false,
        degraded: true,
        boundary: { mode: 'real', provider: 'meta-skill-engine-mcp' },
      });
    });
  });

  describe('degraded mode', () => {
    beforeEach(() => {
      vi.mocked(factory.getKstarAdapter).mockResolvedValue(null);
    });

    it('should return degraded flag when adapter unavailable', async () => {
      const result = await recordToolCycleEvidence({
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        toolCallId: 'tool-def',
        toolName: 'read_file',
        resultPreview: 'Data',
        isError: false,
      });

      expect(result.success).toBe(false);
      expect(result.degraded).toBe(true);
    });

    it('should not throw when recording in degraded mode', async () => {
      await expect(
        recordAgentContributionEvidence({
          userId: 'user-123',
          conversationId: 'conv-456',
          agentId: 'agent-789',
          turnId: 'turn-abc',
          messageId: 'msg-xyz',
          actualResult: 'Done',
          outcomeStatus: 'success',
          actualAction: 'Nothing',
        }),
      ).resolves.toMatchObject({ success: false, degraded: true });
    });
  });

  describe('evidence ID stability', () => {
    it('should generate deterministic IDs from same inputs', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      const input = {
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        toolCallId: 'tool-def',
        toolName: 'read_file',
        resultPreview: 'Data',
        isError: false,
      };

      await recordToolCycleEvidence(input);
      await recordToolCycleEvidence(input);

      const calls = vi.mocked(mockAdapter.recordEvidence!).mock.calls;
      expect(calls[0][0].id).toBe(calls[1][0].id);
      expect(calls[0][0].id).toBe('tool-conv-456-agent-789-turn-abc-tool-def');
    });

    it('should generate unique IDs for different turns', async () => {
      vi.mocked(mockAdapter.recordEvidence!).mockResolvedValue({ success: true });

      await recordToolCycleEvidence({
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-abc',
        toolCallId: 'tool-def',
        toolName: 'read_file',
        resultPreview: 'Data',
        isError: false,
      });

      await recordToolCycleEvidence({
        userId: 'user-123',
        conversationId: 'conv-456',
        agentId: 'agent-789',
        turnId: 'turn-xyz', // Different turn
        toolCallId: 'tool-def',
        toolName: 'read_file',
        resultPreview: 'Data',
        isError: false,
      });

      const calls = vi.mocked(mockAdapter.recordEvidence!).mock.calls;
      expect(calls[0][0].id).not.toBe(calls[1][0].id);
    });
  });
});
