import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const style = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('conversation user-message editing', () => {
  it('adds an accessible centralized pencil action only for persisted user records', () => {
    const attach = extractFunction('_attachUserMessageEditAction');
    expect(attach).toContain("_uiIconHtml('edit-pencil', 'ui-icon')");
    expect(attach).toContain("setAttribute('aria-label', t('chat.message_edit_title'))");
    expect(source).toContain("if (message._msg_id) _attachUserMessageEditAction(msgDiv);");
    expect(source).not.toContain('<svg');
  });

  it('preserves optimistic metadata, confirms side effects, and dispatches edit_message_id', () => {
    const submit = extractFunction('_submitUserMessageEdit');
    expect(extractFunction('_confirmUserMessageEdit')).toContain("t('chat.message_edit_confirm')");
    expect(submit).toContain('edit_message_id: state.messageId');
    expect(submit).toContain("_messageEditDatasetArray(state.msgDiv, 'attachments')");
    expect(submit).toContain("_messageEditDatasetArray(state.msgDiv, 'references')");
    expect(submit).toContain('_removeRenderedHistoryFrom(state.msgDiv);');
    expect(submit).toContain('loadConversationHistory(state.cid, { preserveScroll: true })');
  });

  it('guards Cmd/Ctrl+Enter and IME composition in the inline editor', () => {
    const begin = extractFunction('_beginUserMessageEdit');
    expect(begin).toContain('event.isComposing || event.keyCode === 229');
    expect(begin).toContain("event.key === 'Enter' && (event.metaKey || event.ctrlKey)");
    expect(begin).toContain('composer.requestSubmit()');
    expect(begin).toContain("event.key === 'Escape'");
  });

  it('keeps the edit affordance quiet until hover/focus and gives the editor stable bounds', () => {
    expect(style).toContain('.chat-message-edit-btn');
    expect(style).toContain('.chat-message.user:hover .chat-message-edit-btn');
    expect(style).toContain('.chat-message-edit-input');
    expect(style).toContain('max-height: 260px;');
  });
});
