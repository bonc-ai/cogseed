import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'mate-connector-user-a';
const USER_B = 'mate-connector-user-b';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-connectors-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const transport = {
  kind: 'streamable-http' as const,
  url: 'https://mcp.example.test/mcp',
  headers: { Authorization: 'Bearer secret-token' },
};

function fakeConnection() {
  return {
    isConnected: false,
    connect: vi.fn(async function (this: { isConnected: boolean }) { this.isConnected = true; }),
    listTools: vi.fn(async () => [
      { name: 'search', description: 'Search records', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'delete', description: 'Delete records', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
    ]),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => ({ content: [{ type: 'text', text: `${name}:${String(args.query || '')}` }] })),
    close: vi.fn(async () => undefined),
  };
}

describe('Mate-owned Connector adapter', () => {
  it('stores connector metadata in Mate cloud and encrypted transport outside metadata', async () => {
    const store = await import('../../../../src/main/features/mate_agent_backend/connector-store');
    const paths = await import('../../../../src/main/features/mate_agent_backend/paths');

    const record = await store.createMateConnector(USER_A, {
      id: 'mate-connector-search',
      displayName: 'Private Search',
      transport,
      enabledSubtools: ['search'],
    });

    expect(record).toMatchObject({ id: 'mate-connector-search', displayName: 'Private Search', enabledSubtools: ['search'], transport });
    const metadata = JSON.parse(fs.readFileSync(paths.mateConnectorFile(USER_A, record.id), 'utf8'));
    expect(JSON.stringify(metadata)).not.toContain('secret-token');
    await expect(store.readMateConnector(USER_B, record.id)).rejects.toThrow(/not found|connector/i);
    expect(paths.mateConnectorSecretFile(USER_A, record.id)).toContain(`${path.sep}local${path.sep}mate_agent${path.sep}`);
  });

  it('lists only enabled tools and rejects calls to hidden tools', async () => {
    const store = await import('../../../../src/main/features/mate_agent_backend/connector-store');
    const manager = await import('../../../../src/main/features/mate_agent_backend/connector-manager');
    const connection = fakeConnection();
    await store.createMateConnector(USER_A, { id: 'mate-connector-search', displayName: 'Private Search', transport, enabledSubtools: ['search'] });
    const adapter = manager.createMateConnectorManager({ connectionFactory: () => connection });

    await expect(adapter.listTools(USER_A, 'mate-connector-search')).resolves.toEqual([
      expect.objectContaining({ connectorId: 'mate-connector-search', name: 'search', exposedName: 'mate_connector__mate-connector-search__search' }),
    ]);
    await expect(adapter.callTool(USER_A, 'mate-connector-search', 'search', { query: 'hello' })).resolves.toEqual({ content: [{ type: 'text', text: 'search:hello' }] });
    await expect(adapter.callTool(USER_A, 'mate-connector-search', 'delete', {})).rejects.toThrow(/not enabled|hidden/i);
    expect(connection.callTool).toHaveBeenCalledWith('search', { query: 'hello' }, expect.anything());
  });

  it('keeps connections user-scoped and closes only the Mate connector connection', async () => {
    const store = await import('../../../../src/main/features/mate_agent_backend/connector-store');
    const manager = await import('../../../../src/main/features/mate_agent_backend/connector-manager');
    const connections = [fakeConnection(), fakeConnection()];
    await store.createMateConnector(USER_A, { id: 'mate-connector-search', displayName: 'A', transport });
    await store.createMateConnector(USER_B, { id: 'mate-connector-search', displayName: 'B', transport });
    const adapter = manager.createMateConnectorManager({ connectionFactory: () => connections.shift()! });

    await adapter.listTools(USER_A, 'mate-connector-search');
    await adapter.listTools(USER_B, 'mate-connector-search');
    expect(connections).toHaveLength(0);
    await adapter.close(USER_A, 'mate-connector-search');
    expect((connections as unknown[])).toHaveLength(0);
  });
  it('routes the umbrella connector tools through the Mate Runtime Tool Runner', async () => {
    const { createRuntimeToolRunner } = await import('../../../../src/main/features/mate_agent_runtime/kernel/tools/runner');
    const runner = createRuntimeToolRunner({
      userId: USER_A, runtimeSessionId: 'mruntime-connector', allowedRoots: [],
      toolPolicy: { fileRead: 'none', fileWrite: 'none', shell: 'none', skillRun: 'none', network: 'none', connectors: 'enabled' },
      connectorManager: {
        async listTools() { return [{ connectorId: 'mate-connector-search', name: 'search', exposedName: 'mate_connector__mate-connector-search__search', description: 'Search', input_schema: { type: 'object' } }]; },
        async listAllTools() { return [{ connectorId: 'mate-connector-search', name: 'search', exposedName: 'mate_connector__mate-connector-search__search', description: 'Search', input_schema: { type: 'object' } }]; },
        async callTool() { return { ok: true }; },
        async close() {}, async closeAll() {},
      } as any,
    });
    await expect(runner.run('list_connector_tools', {})).resolves.toMatchObject({ content: expect.stringContaining('mate-connector-search') });
    await expect(runner.run('call_connector_tool', { connector_id: 'mate-connector-search', tool_name: 'search', arguments: { query: 'x' } })).resolves.toEqual({ content: JSON.stringify({ ok: true }) });
  });

});
