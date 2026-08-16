import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('composer control visual contract', () => {
  it('uses a neutral stop treatment while keeping send on the primary color', () => {
    const css = read('src/renderer/style.css');
    const streamingRule = css.match(/\.chat-send-btn\.streaming\s*{([\s\S]*?)}/)?.[1] || '';
    const conversationStopRule = css.match(/#panel-conversation \.chat-send-btn\.streaming,[\s\S]*?#panel-conversation \.chat-send-btn\.streaming:disabled\s*{([\s\S]*?)}/)?.[1] || '';

    expect(css).toMatch(/--control-stop:\s*#5B6470;/);
    expect(css).toMatch(/--control-stop-hover:\s*#46505B;/);
    expect(css).toMatch(/\.chat-send-btn\s*{[\s\S]*?background:\s*var\(--primary\);/);
    expect(streamingRule).toContain('background: var(--control-stop);');
    expect(streamingRule).not.toMatch(/#dc2626|var\(--danger\)/i);
    expect(conversationStopRule).toContain('background: color-mix(in srgb, var(--control-stop) 8%, var(--surface));');
    expect(conversationStopRule).toContain('color: var(--control-stop);');
    expect(conversationStopRule).toContain('box-shadow: none;');
  });

  it('keeps the conversation send button light without weakening the homepage CTA', () => {
    const css = read('src/renderer/style.css');
    const conversationSendRule = css.match(/#panel-conversation \.chat-send-btn:not\(\.streaming\):not\(:disabled\)\s*{([\s\S]*?)}/)?.[1] || '';

    expect(conversationSendRule).toContain('background: color-mix(in srgb, var(--surface-2) 78%, var(--surface));');
    expect(conversationSendRule).toContain('color: var(--primary-text);');
    expect(conversationSendRule).toContain('box-shadow: none;');
    expect(css).toMatch(/\.chat-send-btn\s*{[\s\S]*?background:\s*var\(--primary\);/);
  });

  it('renders recipient chips as compact mentions in every locale', () => {
    const html = read('src/renderer/index.html');
    const css = read('src/renderer/style.css');
    const locales = ['en', 'zh', 'ja', 'pt'].map((language) => (
      JSON.parse(read(`src/renderer/locales/${language}.json`)) as Record<string, string>
    ));

    expect(html.match(/data-i18n="chat\.recipient_label">@<\/span>/g)).toHaveLength(3);
    expect(locales.every((locale) => locale['chat.recipient_label'] === '@')).toBe(true);
    expect(css).toMatch(/\.chat-recipient-chip\s*{[\s\S]*?gap:\s*0;/);
  });
});
