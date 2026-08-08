/**
 * ACP Transcript recording.
 *
 * Records ACP protocol messages to `~/.cogseed/acp-transcripts/<agent-type>/<session-id>.jsonl`
 * for later import in onboarding. Each line is a JSON entry:
 *   - Line 0: TranscriptHeader (session metadata)
 *   - Line 1+: TranscriptEntry (prompt | update | turn_end)
 *
 * Recording is best-effort: failures are logged but never block the session.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../../logger';

const log = createLogger('acp-transcript');

export interface TranscriptHeader {
  version: 1;
  agentType: string;
  sessionId: string;
  cwd: string;
  startedAt: string; // ISO 8601
}

export interface PromptEntry {
  type: 'prompt';
  timestamp: string;
  content: Array<{ type: string; text?: string }>;
}

export interface UpdateEntry {
  type: 'update';
  timestamp: string;
  update: any; // Raw ACP update, kept verbatim
}

export interface TurnEndEntry {
  type: 'turn_end';
  timestamp: string;
  stopReason: string;
  durationMs: number;
  model?: string;
}

export type TranscriptEntry = PromptEntry | UpdateEntry | TurnEndEntry;

function getTranscriptRoot(): string {
  const home = process.env.COGSEED_HOME || path.join(os.homedir(), '.cogseed');
  return path.join(home, 'acp-transcripts');
}

function getTranscriptPath(agentType: string, sessionId: string): string {
  return path.join(getTranscriptRoot(), agentType, `${sessionId}.jsonl`);
}

/** Write transcript header (first line). Creates directory if needed. */
export async function writeHeader(agentType: string, sessionId: string, cwd: string): Promise<void> {
  const filePath = getTranscriptPath(agentType, sessionId);
  const header: TranscriptHeader = {
    version: 1,
    agentType,
    sessionId,
    cwd,
    startedAt: new Date().toISOString(),
  };

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(header) + '\n', 'utf8');
  } catch (err) {
    log.warn('failed to write transcript header', { agentType, sessionId, error: String(err) });
  }
}

/** Append a prompt entry. */
export async function writePrompt(
  agentType: string,
  sessionId: string,
  content: Array<{ type: string; text?: string }>
): Promise<void> {
  const filePath = getTranscriptPath(agentType, sessionId);
  const entry: PromptEntry = {
    type: 'prompt',
    timestamp: new Date().toISOString(),
    content,
  };

  try {
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    log.warn('failed to write prompt', { agentType, sessionId, error: String(err) });
  }
}

/** Append a raw ACP update. */
export async function writeUpdate(agentType: string, sessionId: string, update: any): Promise<void> {
  const filePath = getTranscriptPath(agentType, sessionId);
  const entry: UpdateEntry = {
    type: 'update',
    timestamp: new Date().toISOString(),
    update,
  };

  try {
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    log.warn('failed to write update', { agentType, sessionId, error: String(err) });
  }
}

/** Append a turn-end marker. */
export async function writeTurnEnd(
  agentType: string,
  sessionId: string,
  stopReason: string,
  durationMs: number,
  model?: string
): Promise<void> {
  const filePath = getTranscriptPath(agentType, sessionId);
  const entry: TurnEndEntry = {
    type: 'turn_end',
    timestamp: new Date().toISOString(),
    stopReason,
    durationMs,
    model,
  };

  try {
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    log.warn('failed to write turn end', { agentType, sessionId, error: String(err) });
  }
}

/** List all session IDs for a given agent type. */
export async function listTranscripts(agentType: string): Promise<string[]> {
  const dir = path.join(getTranscriptRoot(), agentType);
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, ''));
  } catch (err) {
    if ((err as any).code === 'ENOENT') return [];
    throw err;
  }
}

/** Read a full transcript (header + entries). */
export async function readTranscript(
  agentType: string,
  sessionId: string
): Promise<{ header: TranscriptHeader; entries: TranscriptEntry[] }> {
  const filePath = getTranscriptPath(agentType, sessionId);
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    throw new Error('Empty transcript file');
  }

  const header = JSON.parse(lines[0]) as TranscriptHeader;
  const entries = lines.slice(1).map(line => JSON.parse(line) as TranscriptEntry);

  return { header, entries };
}
