import { appendRuntimeMemoryEntry, sanitizeRuntimeMemoryText } from './store';

export interface RuntimeMemoryExtractionInput {
  requestId: string;
  runtimeSessionId: string;
  task: string;
  finalText: string;
  createdAt: string;
}

function trimForEntry(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n[truncated runtime memory field]`;
}

export function buildRuntimeMemoryEntryFromResult(input: RuntimeMemoryExtractionInput): string {
  const task = trimForEntry(sanitizeRuntimeMemoryText(input.task, 800), 800);
  const result = trimForEntry(sanitizeRuntimeMemoryText(input.finalText, 2400), 2400);
  return [
    `- request: ${input.requestId}`,
    `- session: ${input.runtimeSessionId}`,
    `- task: ${task}`,
    `- result: ${result}`,
  ].join('\n');
}

export async function appendRuntimeMemoryFromResult(
  uid: string,
  input: RuntimeMemoryExtractionInput,
  opts: { agentId?: string } = {},
): Promise<void> {
  await appendRuntimeMemoryEntry(uid, buildRuntimeMemoryEntryFromResult(input), {
    agentId: opts.agentId,
    createdAt: input.createdAt,
  });
}
