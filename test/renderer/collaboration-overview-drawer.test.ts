import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadLocale(name: string) {
  return JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${name}.json`), 'utf8'));
}

describe('collaboration overview locales', () => {
  it('defines collaboration drawer labels in all renderer locales', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const data = loadLocale(locale);
      expect(data['conversation_info.tab_collaboration']).toBeTruthy();
      expect(data['conversation_info.collaboration.title']).toBeTruthy();
      expect(data['conversation_info.collaboration.section_task_overview']).toBeTruthy();
      expect(data['conversation_info.collaboration.section_agent_activity']).toBeTruthy();
      expect(data['conversation_info.collaboration.section_attention']).toBeTruthy();
      expect(data['conversation_info.collaboration.status.idle']).toBeTruthy();
      expect(data['conversation_info.collaboration.step_count']).toBeTruthy();
      expect(data['conversation_info.collaboration.attention.wake']).toBeTruthy();
    }
  });
});


describe('Collaboration attention navigation', () => {
  it('focuses the matching main-chat review card and falls back to the source message', () => {
    const conversationSource = readFileSync(
      resolve(__dirname, '../../src/renderer/modules/conversation.js'),
      'utf8',
    );

    expect(conversationSource).toContain("function focusConversationAttention(kind, ref, messageId = '')");
    expect(conversationSource).toContain('.chat-wake-request[data-wake-request-id=');
    expect(conversationSource).toContain('_flashConversationHistorySearchTarget(target)');
    expect(conversationSource).toContain("_revealConversationHistorySearchTarget(currentCid, { msgId: fallbackMessageId })");
  });
});
