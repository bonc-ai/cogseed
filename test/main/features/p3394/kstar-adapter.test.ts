/**
 * kstar-adapter.test.ts — Engine adapter via MCP stdio connection
 *
 * Contract tests:
 * 1. Handshake with protocol version check
 * 2. CAS transaction: load→import→mutate→export→verify→write
 * 3. Degraded state on Engine unavailable
 * 4. Evidence recording with deduplication
 * 5. Tool call routing through MCP connection
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  KstarAdapter,
  type KstarAdapterConfig,
} from '../../../../src/main/features/p3394/kstar-adapter';
import {
  writeKstarSnapshot,
  readKstarSnapshot,
} from '../../../../src/main/features/p3394/kstar-store';
import type { McpConnection } from '../../../../src/main/features/connectors/mcp-client';

describe('kstar-adapter', () => {
  let testRoot: string;
  let testUid: string;
  let mockConnection: McpConnection;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kstar-adapter-test-'));
    testUid = 'test-user-001';
    process.env.ORKAS_WORKSPACE_ROOT = testRoot;

    // Mock MCP connection
    mockConnection = {
      isConnected: true,
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([
        { name: 'get_engine_info', description: 'Get engine version', input_schema: {} },
        { name: 'snapshot_export', description: 'Export snapshot', input_schema: {} },
        { name: 'snapshot_import', description: 'Import snapshot', input_schema: {} },
        { name: 'record_evidence', description: 'Record evidence', input_schema: {} },
      ]),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpConnection;
  });

  afterEach(async () => {
    delete process.env.ORKAS_WORKSPACE_ROOT;
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  describe('initialization', () => {
    test('performs handshake and validates protocol version', async () => {
      vi.mocked(mockConnection.callTool).mockResolvedValue({
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
      });

      const config: KstarAdapterConfig = {
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      };

      const adapter = new KstarAdapter(config);
      await adapter.initialize();

      expect(mockConnection.callTool).toHaveBeenCalledWith(
        'get_engine_info',
        {},
        expect.any(Object),
      );
      expect(adapter.isAvailable()).toBe(true);
    });

    test('enters degraded state on protocol version mismatch', async () => {
      vi.mocked(mockConnection.callTool).mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              engine_version: '2.0.0',
              protocol_version: '0.9',
              capabilities: [],
            }),
          },
        ],
      });

      const config: KstarAdapterConfig = {
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      };

      const adapter = new KstarAdapter(config);
      await adapter.initialize();

      expect(adapter.isAvailable()).toBe(false);
      expect(adapter.getDegradedReason()).toContain('protocol version');
    });

    test('enters degraded state when connection fails', async () => {
      vi.mocked(mockConnection.callTool).mockRejectedValue(
        new Error('connection refused'),
      );

      const config: KstarAdapterConfig = {
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      };

      const adapter = new KstarAdapter(config);
      await adapter.initialize();

      expect(adapter.isAvailable()).toBe(false);
      expect(adapter.getDegradedReason()).toContain('connection');
    });

    test('hydrates the Engine from the on-disk snapshot', async () => {
      // A freshly spawned Engine holds no state. Without hydration the first
      // evidence write would export a single-record snapshot over this history.
      const onDisk = { schema_version: 1, generation: 7, evidence: [{ id: 'old-1' }] };
      await writeKstarSnapshot(testUid, onDisk);

      vi.mocked(mockConnection.callTool)
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine_version: '2.0.0',
                protocol_version: '1.0',
                capabilities: ['snapshot'],
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ success: true, generation: 7 }) }],
        });

      const adapter = new KstarAdapter({
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      });
      await adapter.initialize();

      expect(mockConnection.callTool).toHaveBeenCalledWith(
        'snapshot_import',
        { snapshot: onDisk },
        expect.any(Object),
      );
      expect(adapter.isAvailable()).toBe(true);
    });

    test('stays degraded when the Engine rejects the on-disk snapshot', async () => {
      // Proceeding here would let later writes export partial state over a
      // snapshot we could not load, destroying history.
      await writeKstarSnapshot(testUid, { schema_version: 1, generation: 3, evidence: [] });

      vi.mocked(mockConnection.callTool)
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine_version: '2.0.0',
                protocol_version: '1.0',
                capabilities: ['snapshot'],
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, error: 'snapshot_hash mismatch' }),
            },
          ],
        });

      const adapter = new KstarAdapter({
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      });
      await adapter.initialize();

      expect(adapter.isAvailable()).toBe(false);
      expect(adapter.getDegradedReason()).toContain('snapshot_hash mismatch');
    });

    test('skips hydration when the user has no snapshot yet', async () => {
      vi.mocked(mockConnection.callTool).mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              engine_version: '2.0.0',
              protocol_version: '1.0',
              capabilities: ['snapshot'],
            }),
          },
        ],
      });

      const adapter = new KstarAdapter({
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      });
      await adapter.initialize();

      expect(adapter.isAvailable()).toBe(true);
      expect(mockConnection.callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('CAS transaction', () => {
    test('performs full load→import→mutate→export→verify→write cycle', async () => {
      // Setup mock responses
      vi.mocked(mockConnection.callTool)
        .mockResolvedValueOnce({
          // get_engine_info
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine_version: '2.0.0',
                protocol_version: '1.0',
                capabilities: ['snapshot', 'evidence'],
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          // snapshot_export
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                snapshot: { _opaque: 'engine-v2', gen: 1, data: 'test' },
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          // snapshot_import (after mutation)
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                generation: 2,
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          // snapshot_export (verify)
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                snapshot: { _opaque: 'engine-v2', gen: 2, data: 'mutated' },
              }),
            },
          ],
        });

      const config: KstarAdapterConfig = {
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      };

      const adapter = new KstarAdapter(config);
      await adapter.initialize();

      const result = await adapter.runCasTransaction(async (snapshot) => {
        // Mutation happens in the engine; we just verify the cycle
        return { mutated: true };
      });

      expect(result.success).toBe(true);
      expect(mockConnection.callTool).toHaveBeenCalledWith(
        'snapshot_export',
        {},
        expect.any(Object),
      );
    });

    test('aborts transaction on export failure', async () => {
      vi.mocked(mockConnection.callTool)
        .mockResolvedValueOnce({
          // get_engine_info
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine_version: '2.0.0',
                protocol_version: '1.0',
                capabilities: ['snapshot'],
              }),
            },
          ],
        })
        .mockRejectedValueOnce(new Error('export failed'));

      const config: KstarAdapterConfig = {
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      };

      const adapter = new KstarAdapter(config);
      await adapter.initialize();

      const result = await adapter.runCasTransaction(async () => ({ ok: true }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('export');
    });
  });

  describe('evidence recording', () => {
    test('records evidence with stable ID deduplication', async () => {
      vi.mocked(mockConnection.callTool)
        .mockResolvedValueOnce({
          // get_engine_info
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine_version: '2.0.0',
                protocol_version: '1.0',
                capabilities: ['evidence'],
              }),
            },
          ],
        })
        .mockResolvedValue({
          // record_evidence calls
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, deduplicated: false }),
            },
          ],
        });

      const config: KstarAdapterConfig = {
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      };

      const adapter = new KstarAdapter(config);
      await adapter.initialize();

      const evidence = {
        id: 'ev-001',
        type: 'tool_cycle' as const,
        tool_name: 'read_file',
        status: 'succeeded' as const,
        delta_r: 0.8,
      };

      await adapter.recordEvidence(evidence);

      expect(mockConnection.callTool).toHaveBeenCalledWith(
        'record_evidence',
        expect.objectContaining({ id: 'ev-001' }),
        expect.any(Object),
      );
    });

    test('skips duplicate evidence by stable ID', async () => {
      vi.mocked(mockConnection.callTool)
        .mockResolvedValueOnce({
          // get_engine_info
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine_version: '2.0.0',
                protocol_version: '1.0',
                capabilities: ['evidence'],
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          // first record_evidence
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, deduplicated: false }),
            },
          ],
        })
        .mockResolvedValueOnce({
          // second record_evidence (duplicate)
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, deduplicated: true }),
            },
          ],
        });

      const config: KstarAdapterConfig = {
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      };

      const adapter = new KstarAdapter(config);
      await adapter.initialize();

      const evidence = {
        id: 'ev-001',
        type: 'tool_cycle' as const,
        tool_name: 'read_file',
        status: 'succeeded' as const,
        delta_r: 0.8,
      };

      await adapter.recordEvidence(evidence);
      const result = await adapter.recordEvidence(evidence);

      expect(result.deduplicated).toBe(true);
    });

    test('persists the snapshot the Engine returns', async () => {
      // Engine state is in-memory only, so an unpersisted record is lost on
      // the next Engine restart.
      const engineSnapshot = {
        schema_version: 1,
        generation: 1,
        evidence: [{ id: 'ev-001', type: 'tool_cycle' }],
      };

      vi.mocked(mockConnection.callTool)
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine_version: '2.0.0',
                protocol_version: '1.0',
                capabilities: ['evidence'],
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                deduplicated: false,
                snapshot: engineSnapshot,
              }),
            },
          ],
        });

      const adapter = new KstarAdapter({
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      });
      await adapter.initialize();

      const result = await adapter.recordEvidence({ id: 'ev-001', type: 'tool_cycle' });

      expect(result.success).toBe(true);
      expect(await readKstarSnapshot(testUid)).toEqual(engineSnapshot);
    });

    test('does not rewrite the snapshot for deduplicated evidence', async () => {
      const existing = { schema_version: 1, generation: 4, evidence: [{ id: 'ev-001' }] };
      await writeKstarSnapshot(testUid, existing);

      vi.mocked(mockConnection.callTool)
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                engine_version: '2.0.0',
                protocol_version: '1.0',
                capabilities: ['evidence'],
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: JSON.stringify({ success: true, generation: 4 }) }],
        })
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                deduplicated: true,
                snapshot: { schema_version: 1, generation: 4, evidence: [{ id: 'ev-001' }] },
              }),
            },
          ],
        });

      const adapter = new KstarAdapter({
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      });
      await adapter.initialize();

      const result = await adapter.recordEvidence({ id: 'ev-001', type: 'tool_cycle' });

      expect(result.deduplicated).toBe(true);
      // The .previous backup only appears on a second write; its absence shows
      // the deduplicated call did not touch disk.
      const previousExists = await fs
        .access(path.join(testRoot, testUid, 'local', 'kstar', 'snapshot.json.previous'))
        .then(() => true)
        .catch(() => false);
      expect(previousExists).toBe(false);
      expect(await readKstarSnapshot(testUid)).toEqual(existing);
    });
  });

  describe('degraded operation', () => {
    test('returns no-op results when engine unavailable', async () => {
      vi.mocked(mockConnection.callTool).mockRejectedValue(
        new Error('engine unavailable'),
      );

      const config: KstarAdapterConfig = {
        userId: testUid,
        connection: mockConnection,
        minProtocolVersion: '1.0',
      };

      const adapter = new KstarAdapter(config);
      await adapter.initialize();

      expect(adapter.isAvailable()).toBe(false);

      const result = await adapter.recordEvidence({
        id: 'ev-001',
        type: 'tool_cycle',
        tool_name: 'test',
        status: 'succeeded',
        delta_r: 0.5,
      });

      expect(result.success).toBe(false);
      expect(result.degraded).toBe(true);
    });
  });
});
