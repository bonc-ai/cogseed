/**
 * Pluggable vision-fallback seam (2026-08-27, 子安定调).
 *
 * When a turn carries image attachments but the receiving model is KNOWN to
 * be vision-incapable (vision === false from the model-abilities chain), the
 * group-chat turn builder hands the images to the registered handler. The
 * handler does NOT silently transform the conversation: it returns
 * *instructions for the model* — what the images are, where they live on
 * disk, and which tools it may use (a vision-model reroute, a user-configured
 * vision MCP, local OCR…). The model then acts on its own agency and calls
 * those tools itself. Vision-capable or unknown models never pass through
 * here; their images go inline as today.
 *
 * No handler registered (the default today): images pass through unchanged —
 * exactly the pre-seam behavior. The concrete processor shape stays open on
 * purpose (子安: 视觉工具不固化形式).
 */

import { createLogger } from '../logger';

const log = createLogger('vision-fallback');

export interface VisionFallbackImage {
  /** Attachment display name, e.g. `chart.png`, when known. */
  name?: string;
  /** On-disk path — every plausible processor (vision-model reroute, vision
   *  MCP tool, OCR) reads the original bytes from here rather than from the
   *  compressed inline payload. */
  absPath?: string;
  /** Base64 payload without the `data:` prefix (the compressed inline form
   *  the model would have received). */
  data: string;
  mediaType: string;
}

export interface VisionFallbackInput {
  userId: string;
  conversationId: string;
  /** Model about to receive the turn (known vision === false). */
  providerId: string;
  modelId: string;
  images: VisionFallbackImage[];
}

export interface VisionFallbackResult {
  /** Instructions appended to the message body FOR THE MODEL: what the
   *  images are, where they live, which vision tools it may call. The model
   *  decides and acts — this seam never pretends the model saw the pixels. */
  instructions?: string;
  /** Images to still send inline (subset), if any. Omit → send none. */
  passthrough?: VisionFallbackImage[];
  /** User-facing note surfaced in the process stream. */
  note?: string;
}

export type VisionFallbackHandler = (input: VisionFallbackInput) => Promise<VisionFallbackResult>;

let handler: VisionFallbackHandler | null = null;

export function setVisionFallbackHandler(next: VisionFallbackHandler | null): void {
  handler = next;
  log.info('vision fallback handler ' + (next ? 'registered' : 'cleared'));
}

export function getVisionFallbackHandler(): VisionFallbackHandler | null {
  return handler;
}

/** Abilities of the model about to receive a turn, as resolved by the
 *  caller (the group-chat bus reads the current default entry via auth). */
export interface TurnModelAbilities {
  providerId: string;
  modelId: string;
  vision?: boolean;
}

/**
 * Turn-level orchestration used by the group-chat bus: when the turn carries
 * images and the resolved model is KNOWN vision-incapable (vision === false),
 * ask the registered handler for model-facing instructions and splice them
 * into the message; inline images are reduced to the handler's passthrough.
 *
 * Conservative exits (no change, returns null):
 *   - no images on the turn
 *   - abilities unknown or vision !== false (unknown never blocks passthrough)
 *   - no handler registered (today's default)
 *   - handler throws (logged; images pass through rather than failing the turn)
 */
export async function applyVisionFallbackIfBlind(params: {
  userId: string;
  conversationId: string;
  messageText: string;
  images: VisionFallbackImage[];
  resolveAbilities: () => Promise<TurnModelAbilities | null>;
}): Promise<{ messageText: string; images: VisionFallbackImage[]; note?: string } | null> {
  const { userId, conversationId, messageText, images, resolveAbilities } = params;
  if (!images.length || !handler) return null;
  let abilities: TurnModelAbilities | null = null;
  try {
    abilities = await resolveAbilities();
  } catch (error) {
    log.warn('ability resolve failed; passing images through', { error: (error as Error).message });
    return null;
  }
  if (!abilities || abilities.vision !== false) return null;
  try {
    const result = await handler({
      userId,
      conversationId,
      providerId: abilities.providerId,
      modelId: abilities.modelId,
      images,
    });
    const nextText = result.instructions ? `${messageText}\n\n${result.instructions}` : messageText;
    const nextImages = Array.isArray(result.passthrough)
      ? images.filter((img) => result.passthrough!.some((p) => p.data === img.data && p.mediaType === img.mediaType))
      : [];
    return { messageText: nextText, images: nextImages, ...(result.note ? { note: result.note } : {}) };
  } catch (error) {
    log.warn('vision fallback handler threw; passing images through', { error: (error as Error).message });
    return null;
  }
}
