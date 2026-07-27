/**
 * kstar-factory.test.ts — Factory pattern for Engine adapter creation
 *
 * Contract tests:
 * 1. Creates adapter with stdio MCP connection
 * 2. Initializes adapter and validates handshake
 * 3. Uses default protocol version when not specified
 * 4. Passes through all transport configuration
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createKstarAdapter, getKstarAdapter } from '../../../../src/main/features/p3394/kstar-factory';
import { KstarAdapter } from '../../../../src/main/features/p3394/kstar-adapter';

// Mock the McpConnection and KstarAdapter
vi.mock('../../../../src/main/features/connectors/mcp-client', () => ({
  McpConnection: vi.fn().mockImplementation(function () { return {
    isConnected: false,
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            engine_version: '2.0.0',
            protocol_version: '1.0',
            capabilities: ['snapshot', 'evidence', 'attribution'],
          }),
        },
      ],
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }; }),
}));

vi.mock('../../../../src/main/features/p3394/kstar-adapter', () => ({
  KstarAdapter: vi.fn().mockImplementation(function () { return {
    initialize: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockReturnValue(true),
    getDegradedReason: vi.fn().mockReturnValue(null),
    runCasTransaction: vi.fn().mockResolvedValue({ success: true }),
    recordEvidence: vi.fn().mockResolvedValue({ success: true }),
    callEngineTool: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  }; }),
}));

describe('kstar-factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createKstarAdapter', () => {
    test('creates adapter with stdio transport configuration', async () => {
      const adapter = await createKstarAdapter({
        userId: 'test-user',
        engineCommand: 'node',
        engineArgs: ['./engine-server.js'],
        engineEnv: { NODE_ENV: 'test' },
        engineCwd: '/opt/meta-skill-engine',
      });

      expect(adapter).toBeDefined();
      expect(KstarAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user',
          minProtocolVersion: '1.0',
        }),
      );
    });

    test('initializes adapter during creation', async () => {
      const adapter = await createKstarAdapter({
        userId: 'test-user',
        engineCommand: 'npx',
        engineArgs: ['-y', '@orkas/meta-skill-engine'],
      });

      expect(adapter.initialize).toHaveBeenCalled();
    });

    test('uses default protocol version when not specified', async () => {
      await createKstarAdapter({
        userId: 'test-user',
        engineCommand: 'node',
        engineArgs: ['engine.js'],
      });

      expect(KstarAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          minProtocolVersion: '1.0',
        }),
      );
    });

    test('accepts custom protocol version', async () => {
      await createKstarAdapter({
        userId: 'test-user',
        engineCommand: 'node',
        engineArgs: ['engine.js'],
        minProtocolVersion: '2.0',
      });

      expect(KstarAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          minProtocolVersion: '2.0',
        }),
      );
    });

    test('creates stdio transport with all options', async () => {
      const { McpConnection } = await import(
        '../../../../src/main/features/connectors/mcp-client'
      );

      await createKstarAdapter({
        userId: 'test-user',
        engineCommand: '/usr/bin/meta-skill-engine',
        engineArgs: ['--port', '8080'],
        engineEnv: { DEBUG: '1', LOG_LEVEL: 'info' },
        engineCwd: '/var/kstar',
      });

      expect(McpConnection).toHaveBeenCalledWith(
        'p3394-engine-test-user',
        expect.objectContaining({
          kind: 'stdio',
          command: '/usr/bin/meta-skill-engine',
          args: ['--port', '8080'],
          env: { DEBUG: '1', LOG_LEVEL: 'info' },
          cwd: '/var/kstar',
        }),
      );
    });
  });

  describe('getKstarAdapter', () => {
    test('defaults to the repository Meta Skill Engine stdio process', async () => {
      const { McpConnection } = await import(
        '../../../../src/main/features/connectors/mcp-client'
      );

      await getKstarAdapter('default-user');

      expect(McpConnection).toHaveBeenCalledWith(
        'p3394-engine-default-user',
        expect.objectContaining({
          kind: 'stdio',
          command: 'node',
          args: expect.arrayContaining([
            expect.stringContaining('packages/nseap-meta-skill-engine/dist/index.js'),
            '--stdio',
          ]),
          cwd: expect.stringContaining('packages/nseap-meta-skill-engine'),
          env: expect.objectContaining({
            NSEAP_ONTOLOGY_DIR: expect.stringContaining('packages/nseap-meta-skill-engine/ontologies'),
          }),
        }),
      );
    });
  });
});
