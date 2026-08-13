import { McpConnection } from '../connectors/mcp-client';
import type { ToolSchema, Transport } from '../connectors/types';
import { listMateConnectors, readMateConnector, updateMateConnectorTools } from './connector-store';
import { assertMateConnectorId, assertMateUserId } from './paths';
import { assertCapabilityScope, canAccessConnector, canAccessConnectorTool, type MateCapabilityScope } from './capability-scope';
import { capCapabilityValue } from './capability-result';

export interface MateConnectorConnection {
  isConnected: boolean;
  connect(): Promise<void>;
  listTools(opts?: { signal?: AbortSignal }): Promise<ToolSchema[]>;
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
}

export interface MateConnectorTool extends ToolSchema {
  connectorId: string;
  exposedName: string;
}

export interface MateConnectorManagerOptions {
  connectionFactory?: (id: string, transport: Transport) => MateConnectorConnection;
}

export interface MateConnectorCallOptions {
  signal?: AbortSignal;
  scope?: MateCapabilityScope;
}

function exposedName(connectorId: string, toolName: string): string {
  return `mate_connector__${connectorId}__${toolName}`;
}

function createConnection(id: string, transport: Transport): MateConnectorConnection {
  return new McpConnection(id, transport);
}

export function createMateConnectorManager(options: MateConnectorManagerOptions = {}) {
  const connectionFactory = options.connectionFactory ?? createConnection;
  const connections = new Map<string, MateConnectorConnection>();

  async function connection(userId: string, connectorId: string, scope?: MateCapabilityScope): Promise<{ connector: Awaited<ReturnType<typeof readMateConnector>>; connection: MateConnectorConnection }> {
    assertMateUserId(userId);
    const id = assertMateConnectorId(connectorId);
    assertCapabilityScope(userId, scope);
    if (!canAccessConnector(scope, id)) throw new Error('CogSeed connector is outside the current capability scope');
    const connector = await readMateConnector(userId, id);
    const key = `${userId}:${id}`;
    let current = connections.get(key);
    if (!current) {
      current = connectionFactory(id, connector.transport);
      connections.set(key, current);
    }
    if (!current.isConnected) {
      try {
        await current.connect();
      } catch (error) {
        connections.delete(key);
        await updateMateConnectorTools(userId, id, connector.toolsCache, 'error').catch(() => undefined);
        throw error;
      }
    }
    return { connector, connection: current };
  }

  async function listToolsForConnector(userId: string, connectorId: string, opts: MateConnectorCallOptions = {}): Promise<MateConnectorTool[]> {
    const { connector, connection: current } = await connection(userId, connectorId, opts.scope);
    const tools = await current.listTools(opts);
    await updateMateConnectorTools(userId, connector.id, tools, 'connected');
    const allowed = connector.enabledSubtools;
    return tools
      .filter((tool) => (allowed === null || allowed.includes(tool.name)) && canAccessConnectorTool(opts.scope, connector.id, tool.name))
      .map((tool) => ({ ...tool, connectorId: connector.id, exposedName: exposedName(connector.id, tool.name) }));
  }

  return {
    async listTools(userId: string, connectorId: string, opts: MateConnectorCallOptions = {}): Promise<MateConnectorTool[]> {
      return listToolsForConnector(userId, connectorId, opts);
    },

    async listAllTools(userId: string, opts: MateConnectorCallOptions = {}): Promise<MateConnectorTool[]> {
      assertMateUserId(userId);
      assertCapabilityScope(userId, opts.scope);
      const connectors = (await listMateConnectors(userId)).filter((connector) => canAccessConnector(opts.scope, connector.id));
      const all: MateConnectorTool[] = [];
      for (const connector of connectors) all.push(...await listToolsForConnector(userId, connector.id, opts));
      return all;
    },

    async callTool(userId: string, connectorId: string, toolName: string, args: Record<string, unknown>, opts: MateConnectorCallOptions = {}): Promise<unknown> {
      const { connector, connection: current } = await connection(userId, connectorId, opts.scope);
      const tools = connector.toolsCache.length ? connector.toolsCache : await current.listTools(opts);
      const selected = tools.find((tool) => tool.name === toolName);
      if (!selected) throw new Error('CogSeed connector tool not found');
      if (connector.enabledSubtools !== null && !connector.enabledSubtools.includes(toolName)) throw new Error('CogSeed connector tool is not enabled');
      if (!canAccessConnectorTool(opts.scope, connector.id, toolName)) throw new Error('CogSeed connector tool is outside the current capability scope');
      if (!connector.toolsCache.length) await updateMateConnectorTools(userId, connector.id, tools, 'connected');
      const result = await current.callTool(toolName, args, opts);
      return capCapabilityValue(result, `${connector.id}.${toolName}`);
    },

    async close(userId: string, connectorId: string): Promise<void> {
      assertMateUserId(userId);
      const id = assertMateConnectorId(connectorId);
      const key = `${userId}:${id}`;
      const current = connections.get(key);
      connections.delete(key);
      await current?.close();
    },

    async closeAll(userId: string): Promise<void> {
      assertMateUserId(userId);
      const prefix = `${userId}:`;
      const closing: Promise<void>[] = [];
      for (const [key, current] of connections) if (key.startsWith(prefix)) { connections.delete(key); closing.push(current.close()); }
      await Promise.all(closing);
    },
  };
}

export type MateConnectorManager = ReturnType<typeof createMateConnectorManager>;

export const mateConnectorManager = createMateConnectorManager();
