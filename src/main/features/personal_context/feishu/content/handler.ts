import type { ResourceType } from '../../contract';
import type { NormalizedContent } from './types';

export type ContentHandler = (input: NormalizedContent) => NormalizedContent;

const identityHandler: ContentHandler = (input) => input;

const HANDLERS: Readonly<Record<ResourceType, ContentHandler>> = Object.freeze({
  calendar: identityHandler,
  calendar_event: identityHandler,
  document: identityHandler,
  file: identityHandler,
  folder: identityHandler,
  chat: identityHandler,
  contact: identityHandler,
});

export function resolveContentHandler(type: ResourceType): ContentHandler {
  return HANDLERS[type];
}
