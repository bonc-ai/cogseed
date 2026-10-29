import { createHash } from 'node:crypto';

export function cognitionStableSourceId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
export const cognitionMessageSourceId = (conversationId: string, messageId: string) =>
  cognitionStableSourceId('msg', conversationId, messageId);
export const cognitionAttachmentSourceId = (conversationId: string, messageId: string, name: string) =>
  cognitionStableSourceId('att', conversationId, messageId, name);
