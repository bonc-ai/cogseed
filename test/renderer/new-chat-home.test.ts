import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function newChatScenarioOrder(html: string) {
  const row = html.match(/<div class="new-chat-scenarios" id="new-chat-scenarios">([\s\S]*?)<\/div>/);
  expect(row?.[1]).toBeTruthy();
  return [...row![1].matchAll(/data-scenario="([^"]+)"/g)].map((m) => m[1]);
}

describe('new chat home surface', () => {
  it('keeps the external agent entry while filtering voice input', () => {
    const html = read('src/renderer/index.html');

    expect(html).toContain('id="new-chat-external-agent-btn"');
    expect(html).toContain('data-i18n="new_chat.external_agent_entry"');
    expect(html).toContain('id="model-guard-slot"');
    // 首页不再有语音入口（外部 Agent 入口保留）。
    expect(html).not.toContain('id="new-chat-mic-btn"');
    // 注意：聊天输入框的语音转写（STT）mic 图标属于另一个表面，不在此断言范围。
  });

  it('uses the synced homepage shortcut set and order', () => {
    const html = read('src/renderer/index.html');

    expect(newChatScenarioOrder(html)).toEqual([
      'space_builder',
      'data',
      'ui_design',
      'seo_geo',
      'office',
      'rnd',
    ]);
    expect(html).toContain('id="new-chat-secondary-actions"');
    expect(html).not.toContain('data-scenario="goal"');
    expect(html).not.toContain('data-scenario="ecommerce"');
    expect(html).not.toContain('data-scenario="creation"');
  });

  it('keeps goal mode available as a shared secondary action', () => {
    const conversation = read('src/renderer/modules/conversation.js');

    expect(conversation).toContain("label: t('new_chat.quick.goal')");
    expect(conversation).toContain("className: 'new-chat-goal-mode-btn'");
    expect(conversation).toContain("void _applyEmptyStateScenario('goal')");
    expect(conversation).toContain("window.addEventListener('i18n-change', _renderEmptyStateSecondaryActions)");
  });

  it('exposes Library-aware picker copy and accessible skill chip removal', () => {
    const html = read('src/renderer/index.html');

    expect(html).toContain('placeholder="Type @ to choose agents, skills, connectors, Library files."');
    expect(html).toContain('data-i18n-title="chat.recipient_picker_title_with_library"');
    expect(html).toContain('data-i18n-aria-label="chat.chip_remove_title"');
    expect(html).toContain('data-ui-icon="x"');
    expect(html).toMatch(/id="chat-skill-chip"[\s\S]*?<button type="button" class="chip-close"[\s\S]*?data-i18n-aria-label="chat\.chip_remove_title"/);
    expect(html).not.toMatch(/id="chat-skill-chip"[\s\S]*?<span class="chip-close"/);
  });

  it('keeps only the visible rich composer in the keyboard and accessibility trees', () => {
    const conversation = read('src/renderer/modules/conversation.js');

    expect(conversation).toContain("textarea.setAttribute('aria-hidden', 'true')");
    expect(conversation).toContain('textarea.tabIndex = -1');
    expect(conversation).toContain("editor.setAttribute('aria-label', textarea.getAttribute('aria-label') || placeholder)");
  });

  it('keeps the home layout constraints aligned with the synced PC surface', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/#panel-new-chat\s*{[\s\S]*?position:\s*relative;/);
    expect(css).toMatch(/body\s*{[^}]*background:\s*var\(--bg\);/);
    expect(css).toMatch(/#panel-new-chat\s*{[^}]*background:\s*var\(--color-home-background\);/);
    expect(read('src/renderer/tokens.css')).toContain('--color-home-background:');
    // oss 能力条已随首页重构移除，不再断言 .oss-entry；
    // 保留 center 容器约束。
    expect(css).toContain('.new-chat-external-agent-btn');
    expect(css).toContain('.main-top-actions');
    expect(css).toMatch(/\.new-chat-greeting\s*{[\s\S]*?font-size:\s*34px;[\s\S]*?letter-spacing:\s*-0\.015em;/);
    expect(css).toMatch(/\.new-chat-scenarios\s*{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?justify-content:\s*space-between;/);
    expect(css).toMatch(/\.new-chat-input-area\s*{[\s\S]*?padding:\s*var\(--space-4\) var\(--space-4\) var\(--space-2\);[\s\S]*?border:\s*1px solid var\(--line-field\);/);
    expect(css).toMatch(/#panel-new-chat \.workspace-chip-prefix,[\s\S]*?#panel-new-chat \.chat-recipient-name\s*{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/\.model-guard-banner\s*{[\s\S]*?height:\s*56px;/);
    expect(css).toMatch(/\.model-guard-dismiss\s*{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/);
    expect(css).toMatch(/@media \(max-width: 1100px\)\s*{[\s\S]*?\.main-content:has\(#panel-new-chat\.active\):has\(#model-guard-banner\) \.main-top-actions\s*{[\s\S]*?flex-wrap:\s*wrap;/);
    expect(css).toMatch(/\.main-content:has\(#panel-new-chat\.active\):has\(#model-guard-banner\) \.model-guard-slot\s*{[\s\S]*?flex:\s*1 0 100%;[\s\S]*?padding-left:\s*0;/);
    expect(css).toMatch(/@media \(max-width: 720px\)\s*{[\s\S]*?\.model-guard-banner \.model-guard-text\s*{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/\.main-content:not\(:has\(#panel-new-chat\.active\)\) \.model-guard-slot\s*{\s*display:\s*none;/);
    expect(css).toMatch(/\.new-chat-input-area \.chat-rich-editor\s*{[\s\S]*?min-height:\s*80px;[\s\S]*?font-size:\s*16px;/);
    expect(css).toMatch(/\.new-chat-input-area \.chat-input-rich-wrap textarea\.chat-rich-source\s*{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*1px;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/);
    expect(css).toMatch(/\.chat-rich-editor\s*{[\s\S]*?outline:\s*none;/);
    expect(css).toMatch(/\.chat-rich-editor:empty::before\s*{[\s\S]*?content:\s*attr\(data-placeholder\);/);
  });
});
