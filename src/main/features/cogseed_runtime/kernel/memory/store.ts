import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { cogseedRuntimeMemoryDir } from '../../../../paths';
import { nowIso, safeId } from '../../../../storage';
import { redactTranscriptPathHints } from '../prompt-assembler';

const RUNTIME_MEMORY_HEADER = '# Runtime Memory\n\n## Stable user preferences\n\n## Runtime task learnings\n';
const CREDENTIAL_ASSIGNMENT_PATTERN = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|bearer)\s*[:=]\s*[^\s,;]+/ig;
const WELL_KNOWN_SECRET_PATTERN = /\b(?:sk|ghp|gho|ghu|ghs|github_pat|xox[baprs])-[-A-Za-z0-9_]{4,}\b/g;

function assertAgentId(agentId: string): string {
  if (!safeId(agentId)) throw new Error('invalid runtime memory agent id');
  return agentId;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 34)).trimEnd()}\n[truncated runtime memory entry]`;
}

export function sanitizeRuntimeMemoryText(text: string, maxChars = 4000): string {
  return truncate(
    redactTranscriptPathHints(String(text || ''))
      .replace(CREDENTIAL_ASSIGNMENT_PATTERN, '[redacted-credential]')
      .replace(WELL_KNOWN_SECRET_PATTERN, '[redacted-credential]')
      .replace(/\r\n/g, '\n')
      .trim(),
    maxChars,
  );
}

export function runtimeMemoryFile(uid: string): string {
  return path.join(cogseedRuntimeMemoryDir(uid), 'runtime.md');
}

export function runtimeAgentMemoryFile(uid: string, agentId: string): string {
  return path.join(cogseedRuntimeMemoryDir(uid), 'agents', `${assertAgentId(agentId)}.md`);
}

function fileForScope(uid: string, agentId?: string): string {
  return agentId ? runtimeAgentMemoryFile(uid, agentId) : runtimeMemoryFile(uid);
}

async function readUtf8IfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function readRuntimeMemory(uid: string, opts: { agentId?: string } = {}): Promise<string> {
  return readUtf8IfExists(fileForScope(uid, opts.agentId));
}

export async function writeRuntimeMemory(uid: string, text: string, opts: { agentId?: string } = {}): Promise<void> {
  const file = fileForScope(uid, opts.agentId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, sanitizeRuntimeMemoryText(text), 'utf8');
}

export async function appendRuntimeMemoryEntry(uid: string, entry: string, opts: { agentId?: string; createdAt?: string } = {}): Promise<void> {
  const clean = sanitizeRuntimeMemoryText(entry);
  if (!clean) return;
  const file = fileForScope(uid, opts.agentId);
  const existing = await readUtf8IfExists(file);
  const prefix = existing.trim() ? `${existing.trimEnd()}\n\n` : `${RUNTIME_MEMORY_HEADER}\n`;
  const timestamp = opts.createdAt || nowIso();
  const block = [`### ${timestamp}`, clean].join('\n\n');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${prefix}${block}\n`, 'utf8');
}
