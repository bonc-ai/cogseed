import { describe, expect, it } from 'vitest';

import type { CreatorInspectSnapshot } from '../../../../src/main/features/creator/inspect-service';
import type { CreatorPresetDraft } from '../../../../src/main/features/creator/store';
import {
  sanitizeCreatorAgentInspection,
  type CreatorAgentCheckSummary,
  type CreatorAgentInspectionSummary,
  type CreatorAgentTurn,
  type CreatorAgentTurnStatus,
} from '../../../../src/main/features/creator/creator-agent-types';

function draft(): CreatorPresetDraft {
  return {} as CreatorPresetDraft;
}

function inspection(): CreatorInspectSnapshot {
  return {
    schemaVersion: 1,
    flags: { creatorMode: true, publish: false },
    capabilities: [{
      capabilityId: 'tool.search',
      version: '1',
      kind: 'tool',
      displayName: 'Search',
      available: true,
      permissions: ['read'],
      sourceRef: 'agent-capability.search',
      health: 'ready',
    }],
    sandboxProfiles: ['creator-read-only-v1'],
    limits: { maxCapabilities: 64 },
  };
}

describe('Creator Agent turn contract', () => {
  it('accepts exactly the three host-facing turn outcomes', () => {
    const statuses: CreatorAgentTurnStatus[] = [
      'draft_ready',
      'needs_clarification',
      'blocked',
    ];
    const check: CreatorAgentCheckSummary = {
      checkId: 'typecheck',
      status: 'passed',
      summary: 'Typecheck passed.',
    };
    const turns: CreatorAgentTurn[] = [
      {
        schemaVersion: 1,
        status: 'draft_ready',
        message: 'Draft ready.',
        draft: draft(),
        inspection: inspection(),
        checks: [check],
      },
      {
        schemaVersion: 1,
        status: 'needs_clarification',
        message: 'More information is required.',
        clarification: {
          question: 'Which model should be used?',
          reason: 'The request names multiple models.',
          risk: 'low',
        },
      },
      {
        schemaVersion: 1,
        status: 'blocked',
        message: 'The requested operation is not available.',
      },
    ];

    expect(statuses).toEqual(['draft_ready', 'needs_clarification', 'blocked']);
    expect(turns.map((turn) => turn.status)).toEqual(statuses);
  });

  it('returns an allow-listed inspection summary without sensitive transport data', () => {
    const unsafeSnapshot = {
      ...inspection(),
      endpoint: 'https://private.example/runtime',
      token: 'runtime-secret-token',
      rawHeaders: { authorization: 'Bearer private-header' },
      socket: { id: 'socket-handle' },
      capabilities: [{
        capabilityId: 'tool.search',
        version: '1',
        kind: 'tool',
        displayName: 'https://private.example/capability',
        available: true,
        permissions: ['read'],
        sourceRef: '/Users/private/workspace/capability.ts',
        health: 'ready',
        command: 'npm run test:js -- private',
        transportHandle: 'transport-handle',
      }],
    } as unknown as CreatorInspectSnapshot;

    const summary: CreatorAgentInspectionSummary = sanitizeCreatorAgentInspection(unsafeSnapshot);
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      schemaVersion: 1,
      flags: { creatorMode: true, publish: false },
      sandboxProfiles: ['creator-read-only-v1'],
      limits: { maxCapabilities: 64 },
    });
    expect(summary.capabilities).toHaveLength(1);
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('runtime-secret-token');
    expect(serialized).not.toContain('private-header');
    expect(serialized).not.toContain('socket-handle');
    expect(serialized).not.toContain('/Users/private/workspace');
    expect(serialized).not.toContain('npm run private');
    expect(serialized).not.toContain('transport-handle');
    expect(serialized).not.toContain('session-handle');
    expect(summary).not.toHaveProperty('endpoint');
    expect(summary).not.toHaveProperty('token');
    expect(summary.capabilities[0]).not.toHaveProperty('command');
    expect(summary.capabilities[0]).not.toHaveProperty('transportHandle');
  });
});
