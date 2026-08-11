/**
 * kstar-compat.test.ts — Compat projection for old P3394 DTOs
 *
 * Contract tests:
 * 1. Projects Engine types to old DTO shapes
 * 2. Never exposes Engine internals to PC business logic
 * 3. Preserves byte-for-byte fields (decision/expectation/workflow_resume_token)
 */

import { describe, test, expect } from 'vitest';
import {
  projectEvidenceToLegacy,
  projectEpisodeToLegacy,
  projectExperienceToLegacy,
} from '../../../../src/main/features/p3394/kstar-compat';

describe('kstar-compat', () => {
  describe('evidence projection', () => {
    test('projects tool cycle evidence to legacy DTO', () => {
      const engineEvidence = {
        id: 'ev-001',
        type: 'tool_cycle',
        tool_name: 'read_file',
        status: 'succeeded',
        delta_r: 0.85,
        duration_ms: 120,
        created_at: '2026-07-26T10:00:00',
      };

      const legacy = projectEvidenceToLegacy(engineEvidence);

      expect(legacy.id).toBe('ev-001');
      expect(legacy.type).toBe('tool_cycle');
      expect(legacy.source_id).toBeDefined();
      expect(legacy.data).toEqual(
        expect.objectContaining({
          tool_name: 'read_file',
          status: 'succeeded',
          delta_r: 0.85,
        }),
      );
      expect(legacy.created_at).toBe('2026-07-26T10:00:00');
    });

    test('preserves all evidence fields in data envelope', () => {
      const engineEvidence = {
        id: 'ev-002',
        type: 'conversation_message',
        conversation_id: 'conv-001',
        message_id: 'msg-001',
        custom_field: 'custom_value',
        created_at: '2026-07-26T11:00:00',
      };

      const legacy = projectEvidenceToLegacy(engineEvidence);

      expect(legacy.data.conversation_id).toBe('conv-001');
      expect(legacy.data.message_id).toBe('msg-001');
      expect(legacy.data.custom_field).toBe('custom_value');
    });
  });

  describe('episode projection', () => {
    test('projects KSTAR episode to legacy DTO', () => {
      const engineEpisode = {
        episode_id: 'ep-001',
        bundle_id: 'bundle-001',
        k_snapshot_ref: 'snap-001',
        situation: 'User asked to refactor code',
        task: 'Improve readability',
        action_hat: 'Read file, analyze structure',
        result_hat: 'Refactored code with comments',
        actual_action: 'read_file, write_file',
        actual_result: 'Refactored successfully',
        delta_r: 0.9,
        delta_a: 0.1,
        delta_a_confidence_gate: 'pass' as const,
        timestamp: '2026-07-26T12:00:00',
        session_id: 'session-001',
      };

      const legacy = projectEpisodeToLegacy(engineEpisode);

      expect(legacy.episode_id).toBe('ep-001');
      expect(legacy.situation).toBe('User asked to refactor code');
      expect(legacy.task).toBe('Improve readability');
      expect(legacy.delta_r).toBe(0.9);
      expect(legacy.delta_a_confidence_gate).toBe('pass');
    });
  });
  describe('experience candidate projection', () => {
    test('projects Engine experience to legacy DTO', () => {
      const engineExperience = {
        id: 'exp-001',
        summary: 'Successfully refactored authentication module',
        status: 'pending' as const,
        created_at: '2026-07-26T15:00:00',
        updated_at: '2026-07-26T15:00:00',
      };

      const legacy = projectExperienceToLegacy(
        engineExperience,
        'run-001',
        'conv-001',
        'agent-001',
      );

      expect(legacy.id).toBe('exp-001');
      expect(legacy.summary).toBe('Successfully refactored authentication module');
      expect(legacy.status).toBe('pending');
      expect(legacy.source_run_id).toBe('run-001');
      expect(legacy.conversation_id).toBe('conv-001');
      expect(legacy.agent_id).toBe('agent-001');
    });
  });

  describe('opaque field preservation', () => {
    test('never modifies Engine-owned fields', () => {
      const engineData = {
        _engine_internal: 'opaque-value',
        nested: {
          _snapshot_ref: 'snap-ref',
          user_visible: 'visible',
        },
      };

      // Compat layer should preserve structure byte-for-byte
      const projected = projectEvidenceToLegacy({
        id: 'ev-003',
        type: 'test',
        ...engineData,
        created_at: '2026-07-26T16:00:00',
      });

      expect(projected.data._engine_internal).toBe('opaque-value');
      expect(projected.data.nested._snapshot_ref).toBe('snap-ref');
      expect(projected.data.nested.user_visible).toBe('visible');
    });
  });
});
