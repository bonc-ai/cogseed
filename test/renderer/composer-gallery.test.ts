import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('composer gallery and real-page integration', () => {
  it('documents the wide, conversation, and narrow production specimens', () => {
    const gallery = read('src/renderer/component-gallery.html');
    const script = read('src/renderer/component-gallery.js');

    expect(gallery).toContain('id="composer"');
    expect(gallery).toContain('18 / 18 已定义');
    expect(script).toContain("['首页 / 900px'");
    expect(script).toContain("['已有对话 / 760px'");
    expect(script).toContain("['窄宽 / 480px'");
    expect(script).toContain('chat-permission-select ai-select');
    expect(script).toContain("specimen('弹层 / 统一外壳'");
    expect(script).toContain('gallery-composer-popover-grid');
    expect(script).toContain('renderComposerSpecimens();');
  });

  it('uses component-owned width rules on both real composer surfaces', () => {
    const html = read('src/renderer/index.html');
    const css = read('src/renderer/style.css');
    const tokens = read('src/renderer/tokens.css');

    expect(html).toContain('id="new-chat-send-btn" class="chat-send-btn"');
    expect(html).toContain('id="chat-send-btn" class="chat-send-btn"');
    expect(tokens).toContain('--layout-composer-width-min: 480px;');
    expect(tokens).toContain('--layout-composer-width-max: 900px;');
    expect(css).toMatch(/\.new-chat-input-area\s*\{[\s\S]*?container:\s*composer \/ inline-size;/);
    expect(css).toMatch(/#panel-conversation \.chat-input-area\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*var\(--layout-thread-width\);/);
    expect(css).toMatch(/@container composer \(max-width:\s*720px\)\s*\{[\s\S]*?\.workspace-chip-label,[\s\S]*?\.model-chip-label,[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/@container composer \(max-width:\s*720px\)\s*\{[\s\S]*?\.chat-permission-chip\s*\{[\s\S]*?width:\s*var\(--chat-permission-control-height\);[\s\S]*?\.chat-permission-select :is\(\.ai-select-label, \.ai-select-caret\)\s*\{[\s\S]*?display:\s*none;/);
  });

  it('keeps focus neutral and only emphasizes enabled send actions with content', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/\.new-chat-input-area:focus-within\s*\{[\s\S]*?border-color:\s*var\(--line-strong\);[\s\S]*?box-shadow:\s*var\(--shadow-composer\);/);
    expect(css).toMatch(/:has\(\.chat-rich-editor:not\(:empty\)\) \.chat-send-btn:not\(\.streaming\):not\(:disabled\)\s*\{[\s\S]*?background:\s*var\(--control-primary-bg\);/);
  });
});
