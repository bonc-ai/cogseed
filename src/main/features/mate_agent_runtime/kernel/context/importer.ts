import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DEFAULT_RUNTIME_KERNEL_CONFIG } from '../config';
import type { AssembledRuntimeContext, RuntimePromptFileRef, RuntimePromptTextSection } from '../prompt-assembler';
import type { RuntimeKernelRequest } from '../types';
import { normalizeRuntimePath } from '../tools/permissions';

export interface RuntimeContextImportOptions {
  maxPromptContextChars?: number;
}

function basenameLabel(candidate: string): string {
  return path.basename(candidate) || 'file';
}

function consumeBudget(text: string, remaining: number): { text: string; truncated: boolean; remaining: number } {
  if (remaining <= 0) return { text: '', truncated: text.length > 0, remaining: 0 };
  if (text.length <= remaining) return { text, truncated: false, remaining: remaining - text.length };
  const suffix = '\n[truncated runtime context]';
  const sliceLength = Math.max(0, remaining - suffix.length);
  return { text: `${text.slice(0, sliceLength).trimEnd()}${suffix}`, truncated: true, remaining: 0 };
}

async function readTextPreview(absPath: string, remaining: number): Promise<{ preview?: string; truncated: boolean; remaining: number }> {
  if (remaining <= 0) return { truncated: true, remaining: 0 };
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) return { truncated: false, remaining };
  const maxBytes = Math.min(stat.size, Math.max(remaining * 4, 4096));
  const handle = await fs.open(absPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { truncated: false, remaining };
    const decoded = bytes.toString('utf8');
    const consumed = consumeBudget(decoded, remaining);
    return { preview: consumed.text, truncated: consumed.truncated || stat.size > bytesRead, remaining: consumed.remaining };
  } finally {
    await handle.close();
  }
}

export async function assembleRuntimeContextForPrompt(
  request: RuntimeKernelRequest,
  opts: RuntimeContextImportOptions = {},
): Promise<AssembledRuntimeContext> {
  const maxChars = opts.maxPromptContextChars ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxPromptContextChars;
  let remaining = maxChars;
  let truncated = false;
  const textSections: RuntimePromptTextSection[] = [];
  const fileRefs: RuntimePromptFileRef[] = [];

  for (const item of request.context) {
    if (item.type === 'text') {
      const consumed = consumeBudget(item.content, remaining);
      remaining = consumed.remaining;
      truncated ||= consumed.truncated;
      textSections.push({ id: `context-${textSections.length + 1}`, ...(item.label ? { label: item.label } : {}), text: consumed.text });
      continue;
    }

    const absPath = normalizeRuntimePath(item.path, request.readOnlyRoots);
    const preview = await readTextPreview(absPath, remaining);
    remaining = preview.remaining;
    truncated ||= preview.truncated;
    fileRefs.push({
      id: `context-file-${fileRefs.length + 1}`,
      label: item.label || basenameLabel(absPath),
      kind: 'context_file',
      ...(preview.preview ? { preview: preview.preview } : {}),
    });
  }

  for (const item of request.attachments) {
    const absPath = normalizeRuntimePath(item.path, request.readOnlyRoots);
    const preview = await readTextPreview(absPath, remaining);
    remaining = preview.remaining;
    truncated ||= preview.truncated;
    fileRefs.push({
      id: `attachment-${fileRefs.length + 1}`,
      label: item.name || basenameLabel(absPath),
      kind: 'attachment',
      ...(preview.preview ? { preview: preview.preview } : {}),
    });
  }

  return {
    textSections,
    fileRefs,
    diagnostics: {
      inputContextCount: request.context.length,
      inputAttachmentCount: request.attachments.length,
      truncated,
    },
  };
}
