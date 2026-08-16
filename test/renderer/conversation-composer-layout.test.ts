import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('conversation composer layout contract', () => {
  it('scopes the taller composer and history clearance to active conversations', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/#panel-conversation \.chat-main-pane\s*{[\s\S]*?--chat-input-reserve:\s*180px;/);
    expect(css).toMatch(/#panel-conversation \.chat-input-area\s*{[\s\S]*?width:\s*min\(82%,\s*1600px\);[\s\S]*?padding:\s*10px 18px 12px;/);
    expect(css).toMatch(/#panel-conversation \.chat-input-area textarea#chat-input:not\(\.chat-rich-source\),[\s\S]*?#panel-conversation \.chat-input-area \.chat-rich-editor\s*{[\s\S]*?min-height:\s*64px;/);
  });

  it('keeps the homepage composer on its existing compact canvas', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/\.new-chat-input-area textarea\s*{[\s\S]*?min-height:\s*80px;/);
    expect(css).toMatch(/\.new-chat-input-area \.chat-rich-editor\s*{[\s\S]*?min-height:\s*80px;/);
  });
});
