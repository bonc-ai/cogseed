// ─── Execution Log (unified execution record model) ───────────────────────
//
// Provides a unified model for command/tool execution records that maintains
// the same structure whether the execution is in progress or completed. This
// ensures consistency when resuming conversations - users see the same intent,
// resources, and risk information regardless of session state.
//
// Records are persisted to ~/.cogseed/data/execution-log.jsonl (one JSON object
// per line, append-only). Logs older than 7 days are automatically cleaned up.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { WS_ROOT } from '../paths';

export const EXECUTION_LOG_FILE = path.join(WS_ROOT, 'execution-log.jsonl');

export type RiskLevel = 'low' | 'medium' | 'high';
export type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed';

export interface ExecutionRecord {
  id: string;               // Unique ID (timestamp + random)
  intent: string;           // Human-readable: "正在安装依赖包"
  why: string;              // Reason: "项目需要 3 个 npm 包才能运行"
  resources: string[];      // Affected paths: ["/path/to/package.json"]
  risk: RiskLevel;          // 'low' | 'medium' | 'high'
  status: ExecutionStatus;  // 'pending' | 'running' | 'success' | 'failed'
  startTime: number;        // Unix timestamp (ms)
  endTime?: number;         // Unix timestamp (ms), set when completed
  output?: string;          // Command output (realtime or final)
  rawCommand?: string;      // Original command (for debug mode)
  errorMessage?: string;    // Error details if status is 'failed'
}

/**
 * Append a new execution record to the log file.
 */
export function appendRecord(record: ExecutionRecord): void {
  try {
    const dir = path.dirname(EXECUTION_LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(EXECUTION_LOG_FILE, line, 'utf-8');
  } catch (err) {
    // Best-effort logging; don't crash if we can't write
    console.error('[execution_log] Failed to append record:', err);
  }
}

/**
 * Update an existing record (find by ID, rewrite file).
 * Note: This is less efficient than append-only, but necessary for status updates.
 */
export function updateRecord(id: string, updates: Partial<ExecutionRecord>): void {
  try {
    const records = readAllRecords();
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) return; // Record not found, no-op

    records[index] = { ...records[index], ...updates };
    writeAllRecords(records);
  } catch (err) {
    console.error('[execution_log] Failed to update record:', err);
  }
}

/**
 * Read all records from the log file.
 */
export function readAllRecords(): ExecutionRecord[] {
  if (!fs.existsSync(EXECUTION_LOG_FILE)) return [];

  try {
    const content = fs.readFileSync(EXECUTION_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter((line) => line.length > 0);

    return lines.map((line) => {
      try {
        return JSON.parse(line) as ExecutionRecord;
      } catch {
        return null;
      }
    }).filter((r): r is ExecutionRecord => r !== null);
  } catch (err) {
    console.error('[execution_log] Failed to read records:', err);
    return [];
  }
}

/**
 * Read records for a specific time range (for session recovery).
 */
export function readRecordsSince(sinceMs: number): ExecutionRecord[] {
  return readAllRecords().filter((r) => r.startTime >= sinceMs);
}

/**
 * Clean up records older than 7 days.
 */
export function cleanupOldRecords(): void {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const records = readAllRecords().filter((r) => r.startTime >= sevenDaysAgo);
    writeAllRecords(records);
  } catch (err) {
    console.error('[execution_log] Failed to cleanup old records:', err);
  }
}

/**
 * Write all records back to file (used by update/cleanup).
 */
function writeAllRecords(records: ExecutionRecord[]): void {
  const dir = path.dirname(EXECUTION_LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(EXECUTION_LOG_FILE, content, 'utf-8');
}

/**
 * Generate a unique execution ID.
 */
export function generateExecutionId(): string {
  return `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
