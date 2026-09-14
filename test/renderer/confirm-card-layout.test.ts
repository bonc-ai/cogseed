import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('confirm / artifact card layout contract (2026-09-14 Bug3)', () => {
  it('inline cards fill bubble width — no 40cqw / fixed px narrowing', () => {
    const css = read('src/renderer/style.css');
    expect(css).not.toMatch(/\.chat-artifact-card\s*{[^}]*40cqw/);
    // 评审定稿 v3：气泡拉伸铺满消息块 + 卡片 100% 与正文左右对齐（margin 0，不居中）
    expect(css).toMatch(/\.chat-message\.assistant \.chat-bubble:has\(\.chat-artifact-host\)\s*{[^}]*align-self:\s*stretch/);
    expect(css).toMatch(/\.chat-artifact-card\s*{[^}]*width:\s*100%/);
    expect(css).toMatch(/\.chat-artifact-card\s*{[^}]*margin:\s*0;/);
    expect(css).not.toMatch(/\.chat-input-form\s*{[^}]*40cqw/);
    expect(css).not.toMatch(/\.chat-marketplace-request\s*{[^}]*min\(360px/);
  });

  it('confirmed/cancelled readonly state styles exist for history replay', () => {
    const css = read('src/renderer/style.css');
    expect(css).toMatch(/\.chat-artifact-card\.is-confirmed[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.chat-artifact-card\.is-cancelled[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.chat-artifact-confirm-badge\s*{/);
    expect(css).toMatch(/\.chat-artifact-card\.is-confirmed \.chat-artifact-confirm-badge\s*{[\s\S]*?color:\s*#16a34a/);
  });
});
