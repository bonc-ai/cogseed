/** Resolve only an owned, explicitly referenced message and its text attachments.
 * A locator is not a permission grant; check parent and source controls on every read. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { getConversation, getMessagesPage } from '../chats';
import { resolveAttachmentAbsPath, warmConversationSpace } from '../chat_attachments';
import { isCognitionSourceEnabled } from './source-control';
import { normalizeCognitionSourceRef, type CognitionSourceLocator, type CognitionSourceRef } from './source-service';
import { cognitionAttachmentSourceId, cognitionMessageSourceId } from './source-identity';

const textVersion = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
/** Bind a new message reference to its complete original text, not its timestamp. */
export function cognitionMessageSourceRef(conversationId: string, message: { id: string; text: string }): CognitionSourceRef {
  return { kind: 'conversation', subtype: 'message', taxonomyVersion: 2, scope: 'conversation',
    id: cognitionMessageSourceId(conversationId, message.id), locator: { conversationId, messageId: message.id },
    sourceVersion: textVersion(message.text) };
}

export type LocatedSourceState = 'available' | 'unavailable' | 'missing' | 'read_failed' | 'changed';
export interface LocatedSource {
  state: LocatedSourceState;
  title?: string;
  text?: string;
  excerpt?: string;
  sourceVersion?: string;
  location?: { startLine: number; endLine: number };
}
async function resolveLocatedMessage(userId: string, locator: CognitionSourceLocator) {
  const conversation = await getConversation(userId, locator.conversationId);
  if (!conversation || conversation.deleted_at || !await isCognitionSourceEnabled(userId,
    { kind: 'conversation', id: locator.conversationId })
    || !await isCognitionSourceEnabled(userId, { kind: 'conversation',
      id: cognitionMessageSourceId(locator.conversationId, locator.messageId) })) return { state: 'unavailable' as const };
  let cursor: number | null | undefined;
  do {
    // A failed or malformed message file must not masquerade as a missing message.
    let page: Awaited<ReturnType<typeof getMessagesPage>>;
    try {
      page = await getMessagesPage(userId, locator.conversationId, 100, cursor, undefined, { strict: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' as const };
      throw error;
    }
    const message = page.history.find(row => row.id === locator.messageId && !row.deleted_at);
    if (message) return { state: 'available' as const, conversation, message };
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { state: 'missing' as const };
}
export async function readLocatedMessage(userId: string, locator: CognitionSourceLocator) {
  const result = await resolveLocatedMessage(userId, locator);
  return result.state === 'available' ? { conversation: result.conversation, message: result.message } : undefined;
}
export async function readLocatedSource(userId: string, input: CognitionSourceRef): Promise<LocatedSource> {
  const ref = normalizeCognitionSourceRef(input), locator = ref?.locator;
  if (!ref || !locator || ref.degraded) return { state: 'unavailable' };
  const expectedId = locator.attachmentName
    ? cognitionAttachmentSourceId(locator.conversationId, locator.messageId, locator.attachmentName)
    : cognitionMessageSourceId(locator.conversationId, locator.messageId);
  if (expectedId !== ref.id) return { state: 'unavailable' };
  try {
    if (!await isCognitionSourceEnabled(userId, ref)) return { state: 'unavailable' };
    const owned = await resolveLocatedMessage(userId, locator);
    if (owned.state !== 'available') return { state: owned.state };
    let text = owned.message.text || '';
    const title = locator.attachmentName || owned.conversation.title || '';
    if (locator.attachmentName) {
      if (!(owned.message.attachments || []).includes(locator.attachmentName)
        || !/\.(txt|md|markdown|csv|tsv|json|yaml|yml|log)$/i.test(locator.attachmentName)) return { state: 'unavailable' };
      await warmConversationSpace(userId, locator.conversationId);
      const file = resolveAttachmentAbsPath(userId, locator.conversationId, locator.attachmentName);
      if (!file.ok) return { state: 'unavailable' };
      if ((await fs.stat(file.absPath)).size > 2 * 1024 * 1024) return { state: 'unavailable' };
      text = await fs.readFile(file.absPath, 'utf8');
    }
    const sourceVersion = textVersion(text);
    if (ref.sourceVersion && ref.sourceVersion !== sourceVersion
      && (locator.attachmentName || ref.sourceVersion !== owned.message.ts)) return { state: 'changed', title };
    const range = locator.range || { start: 0, end: text.length };
    if (range.end > text.length) return { state: 'changed', title };
    // Legacy labels contain clipped quotes. Keep their exact anchor, but read
    // the surrounding source lines so a clipped condition is not lost.
    const start = text.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1;
    const nextLine = text.indexOf('\n', range.end);
    const end = nextLine < 0 ? text.length : nextLine;
    return { state: 'available', title, text, sourceVersion, excerpt: text.slice(start, end),
      location: { startLine: text.slice(0, start).split('\n').length,
        endLine: text.slice(0, end).split('\n').length } };
  } catch { return { state: 'read_failed' }; }
}

export interface LegacySourceResolution {
  recorded: boolean;
  refs: CognitionSourceRef[];
  issue?: 'unavailable' | 'ambiguous' | 'unmatched' | 'read_failed';
}
/** Known legacy envelope only; its quote must occur once in the actual source.
 * No fuzzy/model match and no search outside that message's attachments. */
export async function resolveLegacyOntologySource(userId: string, label: string): Promise<LegacySourceResolution> {
  const match = /^会话\s+([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\s*·\s*[^·]*(?:·\s*([\s\S]*))?)?$/.exec(label.trim());
  if (!match) return { recorded: false, refs: [] };
  const [, conversationId, messageId, rawQuote] = match;
  const quote = rawQuote?.trim();
  if (!quote) return { recorded: true, refs: [], issue: 'unmatched' };
  const locator = { conversationId, messageId };
  try {
    const owned = await readLocatedMessage(userId, locator);
    if (!owned) return { recorded: true, refs: [], issue: 'unavailable' };
    const names = (owned.message.attachments || []).filter(name => /\.(txt|md|markdown|csv|tsv|json|yaml|yml|log)$/i.test(name));
    const inputs: CognitionSourceRef[] = [
      { kind: 'conversation', subtype: 'message', taxonomyVersion: 2,
        id: cognitionMessageSourceId(conversationId, messageId), locator },
      ...names.map(attachmentName => ({ kind: 'artifact_file' as const, subtype: 'artifact' as const, taxonomyVersion: 2 as const,
        id: cognitionAttachmentSourceId(conversationId, messageId, attachmentName), locator: { ...locator, attachmentName } })),
    ];
    const matches: CognitionSourceRef[] = [];
    let unreadable: LegacySourceResolution['issue'];
    for (const input of inputs) {
      const read = await readLocatedSource(userId, input);
      if (read.state !== 'available') { unreadable = read.state === 'read_failed' ? 'read_failed' : 'unavailable'; continue; }
      const start = read.text!.indexOf(quote);
      if (start < 0) continue;
      if (read.text!.indexOf(quote, start + 1) >= 0) return { recorded: true, refs: [], issue: 'ambiguous' };
      matches.push({ ...input, sourceVersion: read.sourceVersion, title: read.title,
        locator: { ...input.locator!, range: { start, end: start + quote.length } } });
    }
    if (matches.length > 1) return { recorded: true, refs: [], issue: 'ambiguous' };
    // An unreadable sibling may contain the same quotation; don't invent uniqueness.
    if (unreadable) return { recorded: true, refs: [], issue: unreadable };
    return matches.length ? { recorded: true, refs: matches } : { recorded: true, refs: [], issue: 'unmatched' };
  } catch { return { recorded: true, refs: [], issue: 'read_failed' }; }
}
