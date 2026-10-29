/** Main-owned bridge to the existing glossary engine and confirmation cards.
 * Bind private data and card routing to the persisted task, never tool input.
 * The Worker receives definitions and evidence only, not business storage. */
import { createTranscriptGlossaryTools } from '../transcript-agent-tools';
import type { TranscriptToolName, TranscriptToolResult } from '../transcript-tool-contract';
import { readCogSeedTaskByRequestId } from './task-store';

export async function runTranscriptHostTool(
  userId: string,
  name: TranscriptToolName,
  input: Record<string, unknown>,
  scope: { requestId: string; runtimeSessionId: string;
    readOnlyRoots?: readonly string[]; writableRoots?: readonly string[]; workingDir?: string },
): Promise<TranscriptToolResult> {
  const task = await readCogSeedTaskByRequestId(userId, scope.requestId);
  if (!task || task.runtimeSessionId !== scope.runtimeSessionId) {
    return { content: '[E_RUNTIME_HOST_TOOL_SCOPE] transcript task scope mismatch', isError: true };
  }
  // The model cannot grant itself permission to apply high-risk replacements.
  // Confirmation is consumed by the existing Main-side one-shot card token.
  if (name === 'transcript_glossary_apply' && Array.isArray(input.acceptRiskLevels)
    && input.acceptRiskLevels.includes('high')) {
    return { content: '[E_TRANSCRIPT_CONFIRMATION_REQUIRED] Use the user confirmation token; high risk cannot be self-approved.', isError: true };
  }
  const tool = createTranscriptGlossaryTools({
    userId,
    agentId: task.agentId, taskId: task.taskId,
    ...(task.conversationId ? { cid: task.conversationId } : {}),
    turnId: task.executionId,
    // Same roots the Worker's file tools get, so a transcript path the Agent
    // can read is one the host can read, and nothing outside it.
    files: {
      readRoots: scope.readOnlyRoots ?? [],
      writeRoots: scope.writableRoots ?? [],
      ...(scope.workingDir ? { workingDir: scope.workingDir } : {}),
    },
  }).find((candidate) => candidate.name === name)!;
  return tool.execute(input, { state: {} }) as Promise<TranscriptToolResult>;
}
