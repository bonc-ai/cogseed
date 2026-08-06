import { DEFAULT_RUNTIME_KERNEL_CONFIG } from '../config';
import type { RuntimeKernelRequest } from '../types';
import { readRuntimeMemory, sanitizeRuntimeMemoryText } from './store';

function capSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 36)).trimEnd()}\n[truncated runtime memory summary]`;
}

export async function loadRuntimeMemorySummary(
  uid: string,
  opts: { agentId?: string; maxChars?: number } = {},
): Promise<string | undefined> {
  const maxChars = opts.maxChars ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxMemoryInjectionChars;
  const parts: string[] = [];
  const globalMemory = sanitizeRuntimeMemoryText(await readRuntimeMemory(uid), maxChars);
  if (globalMemory.trim()) parts.push(globalMemory.trim());
  if (opts.agentId) {
    const agentMemory = sanitizeRuntimeMemoryText(await readRuntimeMemory(uid, { agentId: opts.agentId }), maxChars);
    if (agentMemory.trim()) parts.push(`## Runtime agent memory\n\n${agentMemory.trim()}`);
  }
  if (!parts.length) return undefined;
  return capSummary(parts.join('\n\n'), maxChars);
}

export function createRuntimeMemoryProvider(opts: { maxChars?: number } = {}) {
  return async (request: RuntimeKernelRequest): Promise<string | undefined> => loadRuntimeMemorySummary(request.userId, {
    agentId: request.agentId,
    maxChars: opts.maxChars,
  });
}
