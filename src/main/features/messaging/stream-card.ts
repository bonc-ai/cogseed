/**
 * Feishu streaming-card building blocks: the interactive card JSON shape and
 * the key/guard helpers around it. The per-runtime card state machine (debounce
 * timers, in-flight flush tracking) lives on the messaging runtime; this module
 * stays pure so the card shape is unit-testable without a runtime.
 */

import type {
  JsonCompatibleValue,
  MessagingAdapter,
  MessagingCardAdapter,
} from './types';

/** Debounce window between accumulated card updates (ms). */
export const CARD_FLUSH_DELAY_MS = 400;
/** Cap for the accumulated reply text inside a streaming card. */
export const CARD_MAX_TEXT_LENGTH = 12_000;

export function isCardAdapter(adapter: MessagingAdapter): adapter is MessagingCardAdapter {
  return typeof (adapter as MessagingCardAdapter).sendCard === 'function'
    && typeof (adapter as MessagingCardAdapter).updateCard === 'function';
}

export function cardStateKey(bindingKey: string, turnId: string): string {
  return `${bindingKey}\u0000${turnId}`;
}

export function cardEventTurnId(event: { turn_id?: string }): string {
  return typeof event.turn_id === 'string' && event.turn_id ? event.turn_id : '';
}

/** Build the incremental streaming-card JSON. Tool chrome renders as
 * inline-code chips above an `hr` separator, mirroring Hermes' progress
 * bubbles on Feishu; the reply text stays inside a markdown element. */
export function buildStreamCard(title: string, toolLines: string[], text: string): Record<string, JsonCompatibleValue> {
  const elements: Array<Record<string, JsonCompatibleValue>> = [];
  if (toolLines.length) {
    elements.push({ tag: 'markdown', content: toolLines.map((line) => `\`${line}\``).join('\n') });
    elements.push({ tag: 'hr' });
  }
  elements.push({ tag: 'markdown', content: text || '…' });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title.slice(0, 120) },
    },
    elements,
  };
}
