import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function functionSource(name: string, nextName: string): string {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${nextName}(`));
}

describe('conversation shared UI integration', () => {
  it('uses shared buttons for space drafts and welcome carry actions', () => {
    const draft = functionSource('_renderSpaceDraftButtonHtml', '_parseWelcomeCarry');
    const carry = functionSource('_renderWelcomeCarryHtml', '_renderWelcomePendingHtml');

    expect(draft).toMatch(/uiButton\(\{\r?\n      label: t\('new_chat\.space_draft_create'/);
    expect(carry).toContain("role: 'ghost'");
    expect(carry).toContain("className: 'welcome-carry-continue'");
    expect(`${draft}${carry}`).not.toMatch(/<button\b/);
  });

  it('uses shared form and button primitives in conversation dialogs', () => {
    const operation = functionSource('_conversationOperationDialog', '_rememberConversationResultCard');
    const mergePicker = functionSource('_openConversationMergePicker', '_mergeSelectedConversationsWithConfirm');
    const spacePicker = functionSource('_openConversationSpacePicker', '_openConversationActionMenu');

    expect(operation).toMatch(/uiInput\(\{\r?\n            id: 'conversation-operation-title-input'/);
    expect(operation).toContain("uiButton({ label: confirmLabel, role: 'primary'");
    expect(mergePicker).toContain("uiIconButton({ label: t('common.close'), icon: 'x'");
    expect(mergePicker).toContain("id: 'conversation-merge-picker-search'");
    expect(spacePicker).toContain("className: 'conversation-space-unbind'");
    expect(`${operation}${mergePicker}`).not.toMatch(/<(?:input|button)\b/);
  });
});
