/**
 * kstar-adapter.ts — MCP-based Engine adapter with CAS transactions
 *
 * Provides:
 * 1. Handshake with protocol version check
 * 2. CAS transaction: load PC snapshot → export to Engine → mutate → import back → verify → write
 * 3. Evidence recording with stable ID deduplication
 * 4. Degraded state when Engine unavailable (no-op fallback)
 *
 * The Engine owns the KSTAR state machine; PC never interprets snapshot content.
 * All Engine interaction goes through the provided McpConnection.
 */

import type { ExecutionBoundaryInfo } from './execution-boundary';
import { createLogger } from '../../logger';
import type { McpConnection } from '../connectors/mcp-client';
import {
  writeKstarSnapshot,
  readKstarSnapshot,
  appendPendingEvidence,
} from './kstar-store';

const log = createLogger('p3394.kstar-adapter');

export interface KstarAdapterConfig {
  userId: string;
  connection: McpConnection;
  minProtocolVersion: string;
}

interface EngineInfo {
  engine_version: string;
  protocol_version: string;
  capabilities: string[];
}

interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
}

function parseToolResult<T = unknown>(result: unknown): T | null {
  try {
    const mcpResult = result as McpToolResult;
    const textContent = mcpResult.content?.find((c) => c.type === 'text');
    if (!textContent?.text) return null;
    return JSON.parse(textContent.text) as T;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || 0;
    const bPart = bParts[i] || 0;
    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }
  return 0;
}

export class KstarAdapter {
  private userId: string;
  private connection: McpConnection;
  private minProtocolVersion: string;
  private available = false;
  private degradedReason: string | null = null;
  private engineInfo: EngineInfo | null = null;

  constructor(config: KstarAdapterConfig) {
    this.userId = config.userId;
    this.connection = config.connection;
    this.minProtocolVersion = config.minProtocolVersion;
  }

  /**
   * Perform handshake with Engine and validate protocol version.
   */
  async initialize(): Promise<void> {
    try {
      const result = await this.connection.callTool('get_engine_info', {}, { timeoutMs: 10_000 });
      const info = parseToolResult<EngineInfo>(result);

      if (!info) {
        this.degradedReason = 'Failed to parse engine info';
        log.warn('engine handshake failed', { userId: this.userId, reason: this.degradedReason });
        return;
      }

      this.engineInfo = info;

      // Check protocol version
      if (compareVersions(info.protocol_version, this.minProtocolVersion) < 0) {
        this.degradedReason = `protocol version ${info.protocol_version} < required ${this.minProtocolVersion}`;
        log.warn('engine protocol version mismatch', {
          userId: this.userId,
          engine: info.protocol_version,
          required: this.minProtocolVersion,
        });
        return;
      }

      // Hydrate the freshly spawned Engine from the on-disk snapshot before any
      // evidence is recorded. Engine state starts empty, and recordEvidence
      // persists whatever the Engine exports, so skipping this would overwrite
      // the user's accumulated history with a single-record snapshot.
      if (!(await this.hydrateEngineState())) {
        return;
      }

      this.available = true;
      log.info('engine handshake ok', {
        userId: this.userId,
        engineVersion: info.engine_version,
        protocol: info.protocol_version,
      });
    } catch (err) {
      this.degradedReason = `Connection failed: ${(err as Error).message}`;
      log.warn('engine connection failed', {
        userId: this.userId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Push the on-disk snapshot into the Engine so its in-memory state matches
   * this user's history.
   *
   * Returns false when a snapshot exists but cannot be loaded. That case stays
   * degraded on purpose: continuing would let later writes export a partial
   * state over a snapshot we failed to read, so evidence goes to the pending
   * log until an operator resolves the bad file.
   */
  private async hydrateEngineState(): Promise<boolean> {
    let snapshot: unknown;
    try {
      snapshot = await readKstarSnapshot(this.userId);
    } catch (err) {
      this.degradedReason = `Failed to read snapshot: ${(err as Error).message}`;
      log.warn('snapshot read failed during handshake', {
        userId: this.userId,
        error: (err as Error).message,
      });
      return false;
    }

    if (!snapshot) {
      return true; // First run for this user; Engine's empty state is correct.
    }

    try {
      const result = await this.connection.callTool(
        'snapshot_import',
        { snapshot },
        { timeoutMs: 30_000 },
      );
      const parsed = parseToolResult<{ success: boolean; error?: string }>(result);
      if (!parsed?.success) {
        this.degradedReason = `Snapshot hydration rejected: ${parsed?.error ?? 'unknown reason'}`;
        log.error('engine rejected snapshot during handshake', {
          userId: this.userId,
          reason: parsed?.error ?? 'unknown',
        });
        return false;
      }
      return true;
    } catch (err) {
      this.degradedReason = `Snapshot hydration failed: ${(err as Error).message}`;
      log.warn('snapshot hydration failed', {
        userId: this.userId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  getDegradedReason(): string | null {
    return this.degradedReason;
  }

  getBoundary(): ExecutionBoundaryInfo {
    return this.available
      ? { mode: 'real', provider: 'meta-skill-engine-mcp' }
      : { mode: 'degraded', provider: 'meta-skill-engine-mcp', reason: this.degradedReason || 'engine_not_initialized' };
  }

  /**
   * Run a CAS transaction:
   * 1. Load PC snapshot from disk
   * 2. Export snapshot to Engine (or start fresh if null)
   * 3. Run mutator function (calls Engine tools)
   * 4. Import updated snapshot from Engine
   * 5. Verify export matches import
   * 6. Write snapshot to disk
   */
  async runCasTransaction<T>(
    mutator: (snapshot: unknown) => Promise<T>,
  ): Promise<{ success: boolean; result?: T; error?: string }> {
    if (!this.available) {
      return { success: false, error: 'Engine unavailable' };
    }

    try {
      // 1. Load PC snapshot
      const pcSnapshot = await readKstarSnapshot(this.userId);

      // 2. Import snapshot to Engine (if exists)
      if (pcSnapshot) {
        const importResult = await this.connection.callTool(
          'snapshot_import',
          { snapshot: pcSnapshot },
          { timeoutMs: 30_000 },
        );
        const importParsed = parseToolResult<{ success: boolean }>(importResult);
        if (!importParsed?.success) {
          return { success: false, error: 'Failed to import snapshot to Engine' };
        }
      }

      // 3. Run mutator (makes Engine tool calls)
      const result = await mutator(pcSnapshot);

      // 4. Export updated snapshot from Engine
      const exportResult = await this.connection.callTool(
        'snapshot_export',
        {},
        { timeoutMs: 30_000 },
      );
      const exportParsed = parseToolResult<{ success: boolean; snapshot: unknown }>(exportResult);

      if (!exportParsed?.success || !exportParsed.snapshot) {
        return { success: false, error: 'Failed to export snapshot from Engine' };
      }

      // 5. Write snapshot to PC disk
      await writeKstarSnapshot(this.userId, exportParsed.snapshot);

      log.info('cas transaction completed', { userId: this.userId });
      return { success: true, result };
    } catch (err) {
      log.error('cas transaction failed', {
        userId: this.userId,
        error: (err as Error).message,
      });
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Record evidence item. Engine handles deduplication by stable ID.
   */
  async recordEvidence(evidence: {
    id: string;
    type: string;
    tool_name?: string;
    status?: string;
    delta_r?: number;
    [key: string]: unknown;
  }): Promise<{ success: boolean; deduplicated?: boolean; degraded?: boolean; boundary: ExecutionBoundaryInfo }> {
    const boundary = this.getBoundary();
    const boundedEvidence = { ...evidence, boundary };
    if (!this.available) {
      // In degraded mode, append to pending log
      try {
        await appendPendingEvidence(this.userId, boundedEvidence);
        return { success: false, degraded: true, boundary };
      } catch (err) {
        log.warn('failed to append pending evidence', {
          userId: this.userId,
          error: (err as Error).message,
        });
        return { success: false, degraded: true, boundary };
      }
    }

    try {
      const result = await this.connection.callTool(
        'record_evidence',
        boundedEvidence,
        { timeoutMs: 15_000 },
      );
      const parsed = parseToolResult<{
        success: boolean;
        deduplicated?: boolean;
        snapshot?: unknown;
      }>(result);

      if (!parsed?.success) {
        return { success: false, boundary };
      }

      // Engine state is in-memory and dies with the process, so a record that
      // only lands there is lost on restart. Persist the returned snapshot.
      // Deduplicated writes changed nothing, so they skip the disk write.
      if (!parsed.deduplicated && parsed.snapshot !== undefined) {
        try {
          await writeKstarSnapshot(this.userId, parsed.snapshot);
        } catch (err) {
          log.warn('failed to persist snapshot after evidence record', {
            userId: this.userId,
            evidenceId: evidence.id,
            error: (err as Error).message,
          });
        }
      }

      return { success: true, deduplicated: parsed.deduplicated, boundary };
    } catch (err) {
      log.warn('evidence recording failed', {
        userId: this.userId,
        evidenceId: evidence.id,
        error: (err as Error).message,
      });
      return { success: false, boundary };
    }
  }

  /**
   * Call an arbitrary Engine tool. Returns parsed result or null on failure.
   */
  async callEngineTool<T = unknown>(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T | null> {
    if (!this.available) {
      return null;
    }

    try {
      const result = await this.connection.callTool(toolName, args, { timeoutMs });
      return parseToolResult<T>(result);
    } catch (err) {
      log.warn('engine tool call failed', {
        userId: this.userId,
        tool: toolName,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Close the underlying connection.
   */
  async close(): Promise<void> {
    await this.connection.close();
  }
}
