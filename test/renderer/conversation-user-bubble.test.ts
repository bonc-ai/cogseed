import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const style = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

describe('conversation user message bubble', () => {
  it('uses a neutral low-contrast surface only in the main conversation', () => {
    expect(style).toMatch(
      /#panel-conversation \.chat-message\.user > \.chat-bubble\s*\{[^}]*background:\s*rgba\(245, 247, 246, 0\.82\);[^}]*border:\s*1px solid rgba\(30, 41, 59, 0\.045\);[^}]*border-radius:\s*20px;[^}]*box-shadow:\s*none;/s,
    );
  });

  it('reserves green feedback for selected user messages', () => {
    expect(style).toMatch(
      /#panel-conversation \.chat-message\.user\.is-message-selected > \.chat-bubble\s*\{[^}]*background:\s*rgba\(14, 159, 110, 0\.035\);[^}]*border-color:\s*rgba\(14, 159, 110, 0\.42\);[^}]*box-shadow:\s*0 0 0 2px rgba\(14, 159, 110, 0\.09\);/s,
    );
  });
});
