/**
 * Tool-result image externalization — the DSH route (`@deepseek-ai/dsh-llm`
 * `lib/types/content.js`): an image lives in the session as a typed block and, once
 * it no longer fits the request, is *replaced by a text handle* that names the
 * attachment and its read-only path. The choice is recorded on the block
 * (`offloaded: true`), so a replayed request that is later re-serialized keeps the
 * same decision instead of re-deciding — and the replacement never costs a provider
 * retry because it happens during context construction, not inside a request.
 *
 * Why the host does not put images into `tool_result.content`: the host contract
 * (`shared/types.ts`) types that field as `string`. pi-ai's `ToolResultMessage`
 * accepts `(TextContent | ImageContent)[]`, but the OpenAI/Gemini converters
 * corroborate the existing fallback shape (images ride the next user turn). Extending
 * the host contract to block arrays is a wider change than C1/R-09 needs, so the
 * low-risk route keeps the shape and makes the fallback *addressable and bounded*.
 *
 * Everything here is pure: no IO, no model calls.
 */

import type { ImageContent, Message, MessageContent } from "./types.js";

/** Request budget for tool-produced images. `undefined` bounds are unbounded. */
export interface ToolImageBudget {
  /** Keep at most this many image occurrences; the oldest overflow is offloaded. */
  maxImages?: number;
  /** Keep at most this many base64 characters; the oldest overflow is offloaded. */
  maxBase64Chars?: number;
}

/**
 * Conservative default for one request. The concrete numbers are a host policy
 * choice, not a provider contract: they keep a long screenshot-heavy session from
 * spending its context on history the model can re-read from disk, while leaving a
 * normal multi-image turn untouched. Callers that know a route's real budget pass
 * their own.
 */
export const TOOL_RESULT_IMAGE_BUDGET: ToolImageBudget = { maxImages: 8, maxBase64Chars: 12 * 1024 * 1024 };

function imageLabel(image: ImageContent): string {
  const name = typeof image.name === 'string' && image.name.trim() ? image.name.trim() : '';
  const id = typeof image.toolUseId === 'string' && image.toolUseId.trim() ? image.toolUseId.trim() : '';
  if (name && id) return `${JSON.stringify(name)} (${id})`;
  if (name) return JSON.stringify(name);
  if (id) return `tool result ${id}`;
  return 'tool result image';
}

/**
 * Stable text shown in place of one externalized tool image. Mirrors DSH's
 * `offloadedImageText`: identity, the read-only path to read it with file tools, and
 * the "copy before editing" instruction. Without a path it names the limitation and
 * points at the recovery path instead of pretending the image is still readable.
 */
export function toolResultImageHandleText(image: ImageContent): string {
  const label = imageLabel(image);
  const mediaType = String(image.mediaType || 'image');
  const path = typeof image.readonlyPath === 'string' ? image.readonlyPath.trim() : '';
  if (!path) {
    return `[image omitted from this request's image budget; ${label}. No local read-only copy is available; ask the user to attach it again if the image is needed.]`;
  }
  return `[image omitted from this request's image budget; ${label}. Read-only copy saved at ${JSON.stringify(path)} (${mediaType}).`
    + ' Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it.]';
}

function isImageBlock(block: MessageContent): block is ImageContent {
  return block.type === 'image';
}

/**
 * Only images a tool produced take part. Attribution is the `toolUseId` stamped when
 * the image was appended; user-attached images never carry it and are governed by
 * their own (existing) vision path. Images from before the metadata existed are left
 * alone rather than guessed at by position — a wrong guess would externalize a user's
 * own attachment.
 */
function isToolResultImage(block: MessageContent): block is ImageContent {
  return isImageBlock(block) && typeof block.toolUseId === 'string' && block.toolUseId.trim() !== '';
}

/** Every tool-image occurrence in message order, with its owning message position. */
function imageOccurrences(messages: readonly Message[]): Array<{ message: number; block: number; bytes: number }> {
  const out: Array<{ message: number; block: number; bytes: number }> = [];
  messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (!isToolResultImage(block)) return;
      const data = typeof block.data === 'string' ? block.data : '';
      out.push({ message: messageIndex, block: blockIndex, bytes: data.length });
    });
  });
  return out;
}

/**
 * Record the externalization decision on the oldest overflow. Already-offloaded
 * blocks are not counted again, so re-running after more history arrives does not
 * move the boundary backwards (the decision is replay-stable). Returns the input
 * array unchanged when nothing needs offloading.
 */
export function markOffloadedToolImages(messages: readonly Message[], budget: ToolImageBudget): Message[] {
  const occurrences = imageOccurrences(messages)
    .filter(({ message, block }) => (messages[message].content[block] as ImageContent).offloaded !== true);
  const maxImages = budget?.maxImages;
  const maxBase64Chars = budget?.maxBase64Chars;
  const totalBytes = occurrences.reduce((sum, occurrence) => sum + occurrence.bytes, 0);
  const excessCount = maxImages === undefined ? 0 : Math.max(0, occurrences.length - Math.max(0, maxImages));
  const excessBytes = maxBase64Chars === undefined ? 0 : Math.max(0, totalBytes - Math.max(0, maxBase64Chars));
  if (excessCount === 0 && excessBytes === 0) return [...messages];

  // Oldest first, in whole occurrences: stop once both targets are met, so a byte
  // overflow never leaves a count overflow behind (DSH's prefix rule).
  const toOffload = new Set<number>();
  let removedBytes = 0;
  for (const occurrence of occurrences) {
    const countMet = toOffload.size >= excessCount;
    const bytesMet = removedBytes >= excessBytes;
    if (countMet && bytesMet) break;
    toOffload.add(occurrence.message * 100000 + occurrence.block);
    removedBytes += occurrence.bytes;
  }

  return messages.map((message, messageIndex) => {
    let next: MessageContent[] | null = null;
    message.content.forEach((block, blockIndex) => {
      if (!isImageBlock(block) || !toOffload.has(messageIndex * 100000 + blockIndex)) {
        next?.push(block);
        return;
      }
      next ??= message.content.slice(0, blockIndex);
      next.push({ ...block, offloaded: true });
    });
    return next ? { ...message, content: next } : message;
  });
}

/**
 * Replace every offloaded image with its text handle. Idempotent: an already
 * projected message has no image block left to replace, so a second pass returns the
 * same shape. Non-image and non-offloaded blocks keep their position.
 */
export function projectOffloadedToolImages(messages: readonly Message[]): Message[] {
  let changed = false;
  const projected = messages.map((message) => {
    let next: MessageContent[] | null = null;
    message.content.forEach((block, blockIndex) => {
      if (!isImageBlock(block) || block.offloaded !== true) {
        next?.push(block);
        return;
      }
      next ??= message.content.slice(0, blockIndex);
      next.push({ type: 'text', text: toolResultImageHandleText(block) });
    });
    if (!next) return message;
    changed = true;
    return { ...message, content: next };
  });
  return changed ? projected : [...messages];
}

/**
 * The one call the provider boundary makes: bound tool-produced images, then replace
 * the bounded ones with text. Deterministic in (messages, budget) so replay and route
 * switches reproduce the same request.
 */
export function externalizeToolResultImages(
  messages: readonly Message[],
  budget: ToolImageBudget = TOOL_RESULT_IMAGE_BUDGET,
): Message[] {
  return projectOffloadedToolImages(markOffloadedToolImages(messages, budget));
}
