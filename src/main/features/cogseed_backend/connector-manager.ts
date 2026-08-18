import { McpConnection } from '../connectors/mcp-client';
import type { ToolSchema, Transport } from '../connectors/types';
import { listCogSeedConnectors, readCogSeedConnector, updateCogSeedConnectorTools } from './connector-store';
import { assertCogSeedConnectorId, assertCogSeedUserId } from './paths';
import { assertCapabilityScope, canAccessConnector, canAccessConnectorTool, type CogSeedCapabilityScope } from './capability-scope';
import { capCapabilityValue } from './capability-result';

export interface CogSeedConnectorConnection {
  isConnected: boolean;
  connect(): Promise<void>;
  listTools(opts?: { signal?: AbortSignal }): Promise<ToolSchema[]>;
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
}

export interface CogSeedConnectorTool extends ToolSchema {
  connectorId: string;
  exposedName: string;
}

export interface CogSeedConnectorManagerOptions {
  connectionFactory?: (id: string, transport: Transport) => CogSeedConnectorConnection;
}

export interface CogSeedConnectorCallOptions {
  signal?: AbortSignal;
  scope?: CogSeedCapabilityScope;
}

function exposedName(connectorId: string, toolName: string): string {
  return `cogseed_connector__${connectorId}__${toolName}`;
}

function createConnection(id: string, transport: Transport): CogSeedConnectorConnection {
  return new McpConnection(id, transport);
}

export function createCogSeedConnectorManager(options: CogSeedConnectorManagerOptions = {}) {
  const connectionFactory = options.connectionFactory ?? createConnection;
  const connections = new Map<string, CogSeedConnectorConnection>();

  async function connection(userId: string, connectorId: string, scope?: CogSeedCapabilityScope): Promise<{ connector: Awaited<ReturnType<typeof readCogSeedConnector>>; connection: CogSeedConnectorConnection }> {
    assertCogSeedUserId(userId);
    const id = assertCogSeedConnectorId(connectorId);
    assertCapabilityScope(userId, scope);
    if (!canAccessConnector(scope, id)) throw new Error('CogSeed connector is outside the current capability scope');
    const connector = await readCogSeedConnector(userId, id);
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
        await updateCogSeedConnectorTools(userId, id, connector.toolsCache, 'error').catch(() => undefined);
        throw error;
      }
    }
    return { connector, connection: current };
  }

  async function listToolsForConnector(userId: string, connectorId: string, opts: CogSeedConnectorCallOptions = {}): Promise<CogSeedConnectorTool[]> {
    const { connector, connection: current } = await connection(userId, connectorId, opts.scope);
    const tools = await current.listTools(opts);
    await updateCogSeedConnectorTools(userId, connector.id, tools, 'connected');
    const allowed = connector.enabledSubtools;
    return tools
      .filter((tool) => (allowed === null || allowed.includes(tool.name)) && canAccessConnectorTool(opts.scope, connector.id, tool.name))
      .map((tool) => ({ ...tool, connectorId: connector.id, exposedName: exposedName(connector.id, tool.name) }));
  }

  return {
    async listTools(userId: string, connectorId: string, opts: CogSeedConnectorCallOptions = {}): Promise<CogSeedConnectorTool[]> {
      return listToolsForConnector(userId, connectorId, opts);
    },

    async listAllTools(userId: string, opts: CogSeedConnectorCallOptions = {}): Promise<CogSeedConnectorTool[]> {
      assertCogSeedUserId(userId);
      assertCapabilityScope(userId, opts.scope);
      const connectors = (await listCogSeedConnectors(userId)).filter((connector) => canAccessConnector(opts.scope, connector.id));
      const all: CogSeedConnectorTool[] = [];
      for (const connector of connectors) all.push(...await listToolsForConnector(userId, connector.id, opts));
      return all;
    },

    async callTool(userId: string, connectorId: string, toolName: string, args: Record<string, unknown>, opts: CogSeedConnectorCallOptions = {}): Promise<unknown> {
      const { connector, connection: current } = await connection(userId, connectorId, opts.scope);
      const tools = connector.toolsCache.length ? connector.toolsCache : await current.listTools(opts);
      const selected = tools.find((tool) => tool.name === toolName);
      if (!selected) throw new Error('CogSeed connector tool not found');
      if (connector.enabledSubtools !== null && !connector.enabledSubtools.includes(toolName)) throw new Error('CogSeed connector tool is not enabled');
      if (!canAccessConnectorTool(opts.scope, connector.id, toolName)) throw new Error('CogSeed connector tool is outside the current capability scope');
      if (!connector.toolsCache.length) await updateCogSeedConnectorTools(userId, connector.id, tools, 'connected');
      const result = await current.callTool(toolName, args, opts);
      return capCapabilityValue(result, `${connector.id}.${toolName}`);
    },

    async close(userId: string, connectorId: string): Promise<void> {
      assertCogSeedUserId(userId);
      const id = assertCogSeedConnectorId(connectorId);
      const key = `${userId}:${id}`;
      const current = connections.get(key);
      connections.delete(key);
      await current?.close();
    },

    async closeAll(userId: string): Promise<void> {
      assertCogSeedUserId(userId);
      const prefix = `${userId}:`;
      const closing: Promise<void>[] = [];
      for (const [key, current] of connections) if (key.startsWith(prefix)) { connections.delete(key); closing.push(current.close()); }
      await Promise.all(closing);
    },
  };
}

export type CogSeedConnectorManager = ReturnType<typeof createCogSeedConnectorManager>;

export const cogseedConnectorManager = createCogSeedConnectorManager();
