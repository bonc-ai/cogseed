/**
 * ACP Transcript session reader for onboarding.
 *
 * Reads recorded ACP transcripts from ~/.cogseed/acp-transcripts/
 * and converts them into the same session format used by Claude Code CLI.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../../logger';
import * as transcript from './acp_transcript';

const log = createLogger('acp-sessions');

export interface AcpSessionSummary {
  sessionId: string;
  agentType: string;
  firstMessage: string;
  timestamp: number;
  projectPath?: string;
  filePath: string;
}

function getTranscriptRoot(): string {
  const home = process.env.COGSEED_HOME || path.join(os.homedir(), '.cogseed');
  return path.join(home, 'acp-transcripts');
}

/** List all agent types that have recorded transcripts. */
export async function listAgentTypes(): Promise<string[]> {
  const root = getTranscriptRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch (err) {
    if ((err as any).code === 'ENOENT') return [];
    throw err;
  }
}

/** List all sessions for a given agent type. */
export async function listSessions(agentType: string): Promise<AcpSessionSummary[]> {
  const sessionIds = await transcript.listTranscripts(agentType);
  const summaries: AcpSessionSummary[] = [];

  for (const sessionId of sessionIds) {
    try {
      const { header, entries } = await transcript.readTranscript(agentType, sessionId);

      // Find first prompt
      const firstPrompt = entries.find(e => e.type === 'prompt') as transcript.PromptEntry | undefined;
      if (!firstPrompt) continue; // Skip empty sessions

      const firstText = firstPrompt.content
        .map(c => c.text)
        .filter(Boolean)
        .join(' ')
        .slice(0, 80);

      summaries.push({
        sessionId,
        agentType,
        firstMessage: firstText || '(无文本内容)',
        timestamp: new Date(header.startedAt).getTime(),
        projectPath: header.cwd,
        filePath: path.join(getTranscriptRoot(), agentType, `${sessionId}.jsonl`),
      });
    } catch (err) {
      log.warn('failed to read session summary', { agentType, sessionId, error: String(err) });
    }
  }

  // Sort by timestamp descending (newest first)
  summaries.sort((a, b) => b.timestamp - a.timestamp);
  return summaries;
}
