import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('conversation composer layout contract', () => {
  it('aligns the active-conversation composer with the shared thread width', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/#panel-conversation \.chat-main-pane\s*\{[\s\S]*?--chat-input-reserve:\s*180px;/);
    expect(css).toMatch(/#panel-conversation \.chat-input-area\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*var\(--layout-thread-width\);[\s\S]*?padding:\s*10px 16px 12px;/);
    expect(css).toMatch(/#panel-conversation \.chat-input-area textarea#chat-input:not\(\.chat-rich-source\),[\s\S]*?#panel-conversation \.chat-input-area \.chat-rich-editor\s*\{[\s\S]*?min-height:\s*64px;/);
  });

  it('keeps the homepage composer on its existing compact canvas', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/\.new-chat-input-area textarea\s*\{[\s\S]*?min-height:\s*80px;/);
    expect(css).toMatch(/\.new-chat-input-area \.chat-rich-editor\s*\{[\s\S]*?min-height:\s*80px;/);
    expect(css).toMatch(/\.new-chat-input-area\s*\{[\s\S]*?container:\s*composer \/ inline-size;/);
    // 压缩阶梯：≤720px 收起次要 chrome（工作空间文字），核心执行信息只收紧宽度。
    expect(css).toMatch(/@container composer \(max-width:\s*720px\)\s*\{[\s\S]*?\.workspace-chip-prefix,[\s\S]*?\.workspace-chip-label\s*\{[\s\S]*?display:\s*none;/);
    expect(css).not.toMatch(/\.chat-recipient-name[^{}]*\{[^{}]*display:\s*none/);
    expect(css).not.toMatch(/\.model-chip-label[^{}]*\{[^{}]*display:\s*none/);
  });
});
