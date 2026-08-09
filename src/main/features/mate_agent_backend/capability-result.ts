import { buildBoundedPreview } from '../../util/tool-result-cap';

export const DEFAULT_MATE_CAPABILITY_RESULT_CHARS = 24_000;

export function capCapabilityText(value: string, maxChars = DEFAULT_MATE_CAPABILITY_RESULT_CHARS): string {
  const text = String(value);
  const limit = Math.max(32, Math.floor(maxChars));
  if (text.length <= limit) return text;
  const marker = '\n[truncated]';
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

export function capCapabilityValue(value: unknown, toolName: string, maxChars = DEFAULT_MATE_CAPABILITY_RESULT_CHARS): unknown {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (serialized === undefined || serialized.length <= maxChars) return value;
  const preview = buildBoundedPreview(serialized, Math.max(64, Math.floor(maxChars / 4)));
  return {
    content: capCapabilityText(`${preview}\n[truncated]`, maxChars),
    truncated: true,
    tool: toolName,
    originalChars: serialized.length,
  };
}
