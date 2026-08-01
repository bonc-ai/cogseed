import { describe, expect, it, vi } from 'vitest';
import { KstarAdapter } from '../../../../src/main/features/p3394/kstar-adapter';

const result = (value: any) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

describe('KSTAR execution boundary', () => {
  it('reports real only after protocol initialization', async () => {
    const connection: any = {
      callTool: vi.fn().mockResolvedValue(result({
        engine_version: '2.0.0',
        protocol_version: '1.0',
        capabilities: [],
      })),
    };
    const adapter = new KstarAdapter({ userId: 'u1', connection, minProtocolVersion: '1.0' });

    expect(adapter.getBoundary()).toMatchObject({
      mode: 'degraded',
      provider: 'meta-skill-engine-mcp',
    });
    await adapter.initialize();
    expect(adapter.getBoundary()).toEqual({ mode: 'real', provider: 'meta-skill-engine-mcp' });
  });

  it('reports degraded with reason when initialization fails', async () => {
    const connection: any = { callTool: vi.fn().mockRejectedValue(new Error('offline')) };
    const adapter = new KstarAdapter({ userId: 'u1', connection, minProtocolVersion: '1.0' });

    await adapter.initialize();

    expect(adapter.getBoundary()).toMatchObject({
      mode: 'degraded',
      provider: 'meta-skill-engine-mcp',
    });
    expect(adapter.getBoundary().reason).toMatch(/offline/i);
  });

  it('attaches the real boundary to recorded evidence results', async () => {
    const connection: any = {
      callTool: vi.fn()
        .mockResolvedValueOnce(result({
          engine_version: '2.0.0',
          protocol_version: '1.0',
          capabilities: ['evidence'],
        }))
        .mockResolvedValueOnce(result({ success: true })),
    };
    const adapter = new KstarAdapter({ userId: 'u1', connection, minProtocolVersion: '1.0' });

    await adapter.initialize();

    expect(await adapter.recordEvidence({ id: 'ev-1', type: 'tool_cycle' })).toMatchObject({
      success: true,
      boundary: { mode: 'real', provider: 'meta-skill-engine-mcp' },
    });
    expect(connection.callTool).toHaveBeenLastCalledWith(
      'record_evidence',
      expect.objectContaining({
        boundary: { mode: 'real', provider: 'meta-skill-engine-mcp' },
      }),
      expect.any(Object),
    );
  });
});
