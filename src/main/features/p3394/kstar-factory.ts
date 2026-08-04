/**
 * kstar-factory.ts — Factory for creating KstarAdapter with stdio MCP connection
 *
 * Provides a single entry point for creating the Engine adapter with the correct
 * MCP stdio transport configuration. This is the only approved spawn path for the
 * KSTAR Engine MCP server in the P3394 feature domain.
 *
 * Singleton management: One adapter instance per userId. Bus and Wake callers use
 * getKstarAdapter() which creates on first use and returns the cached instance.
 */

import { createLogger } from '../../logger';
import { metaSkillEnginePackageDir } from '../../paths';
import { McpConnection } from '../connectors/mcp-client';
import { KstarAdapter, type KstarAdapterConfig } from './kstar-adapter';
import type { StdioTransport } from '../connectors/types';
import * as path from 'node:path';

const log = createLogger('p3394.kstar-factory');

export interface CreateKstarAdapterOptions {
  userId: string;
  /** Path to the Engine MCP server executable (node script or binary) */
  engineCommand: string;
  /** Arguments for the Engine command */
  engineArgs?: string[];
  /** Environment variables for the Engine process */
  engineEnv?: Record<string, string>;
  /** Working directory for the Engine process */
  engineCwd?: string;
  /** Minimum protocol version required by PC */
  minProtocolVersion?: string;
}

const DEFAULT_MIN_PROTOCOL_VERSION = '1.0';
const DEFAULT_ENGINE_COMMAND = 'node';

function defaultEngineConfig(): Pick<CreateKstarAdapterOptions, 'engineCommand' | 'engineArgs' | 'engineCwd' | 'engineEnv'> {
  const engineDir = metaSkillEnginePackageDir();
  return {
    engineCommand: process.env.ORKAS_KSTAR_ENGINE_COMMAND || DEFAULT_ENGINE_COMMAND,
    engineArgs: process.env.ORKAS_KSTAR_ENGINE_ARGS
      ? JSON.parse(process.env.ORKAS_KSTAR_ENGINE_ARGS)
      : [path.join(engineDir, 'dist', 'index.js'), '--stdio'],
    engineCwd: process.env.ORKAS_KSTAR_ENGINE_CWD || engineDir,
    engineEnv: {
      NSEAP_ONTOLOGY_DIR: process.env.ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR || path.join(engineDir, 'ontologies'),
    },
  };
}

// Singleton storage: one adapter per userId
const adapters = new Map<string, KstarAdapter | null>();
const initializationPromises = new Map<string, Promise<KstarAdapter | null>>();

/**
 * Create a KstarAdapter with stdio MCP connection to the Engine.
 *
 * This is the canonical factory for P3394 Engine connections. The Engine MCP
 * server is spawned via the McpConnection stdio transport, following the same
 * pattern as other MCP connectors in the system.
 */
export async function createKstarAdapter(
  options: CreateKstarAdapterOptions,
): Promise<KstarAdapter> {
  const transport: StdioTransport = {
    kind: 'stdio',
    command: options.engineCommand,
    args: options.engineArgs || [],
    env: options.engineEnv,
    cwd: options.engineCwd,
  };

  const connection = new McpConnection(`p3394-engine-${options.userId}`, transport);

  const config: KstarAdapterConfig = {
    userId: options.userId,
    connection,
    minProtocolVersion: options.minProtocolVersion || DEFAULT_MIN_PROTOCOL_VERSION,
  };

  const adapter = new KstarAdapter(config);
  await connection.connect();
  await adapter.initialize();

  return adapter;
}

/**
 * Get or create the singleton KSTAR adapter for a user.
 *
 * Returns null if the Engine is unavailable or initialization fails. Callers
 * should check for null and handle degraded mode (e.g., append to pending log).
 *
 * This is the primary entry point for Bus and Wake integration.
 */
export async function getKstarAdapter(userId: string): Promise<KstarAdapter | null> {
  // Check if already initialized
  const existing = adapters.get(userId);
  if (existing !== undefined) {
    return existing;
  }

  // Check if initialization in progress
  const pending = initializationPromises.get(userId);
  if (pending) {
    return pending;
  }

  // Start new initialization
  const promise = (async () => {
    try {
      const adapter = await createKstarAdapter({
        userId,
        ...defaultEngineConfig(),
        minProtocolVersion: DEFAULT_MIN_PROTOCOL_VERSION,
      });

      if (!adapter.isAvailable()) {
        log.warn('engine adapter initialized but unavailable', {
          userId,
          reason: adapter.getDegradedReason(),
        });
        adapters.set(userId, null);
        initializationPromises.delete(userId);
        return null;
      }

      adapters.set(userId, adapter);
      initializationPromises.delete(userId);
      log.info('engine adapter initialized', { userId });
      return adapter;
    } catch (err) {
      log.error('engine adapter initialization failed', {
        userId,
        error: (err as Error).message,
      });
      adapters.set(userId, null);
      initializationPromises.delete(userId);
      return null;
    }
  })();

  initializationPromises.set(userId, promise);
  return promise;
}

/**
 * Close and remove the adapter for a user.
 * Called on user logout or when the Engine needs to be restarted.
 */
export async function closeKstarAdapter(userId: string): Promise<void> {
  const adapter = adapters.get(userId);
  if (adapter) {
    await adapter.close();
  }
  adapters.delete(userId);
  initializationPromises.delete(userId);
  log.info('engine adapter closed', { userId });
}
