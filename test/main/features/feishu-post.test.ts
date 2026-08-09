import { describe, expect, it } from 'vitest';
import {
  buildMarkdownPostPayload,
  buildMarkdownPostRows,
  chunkMarkdownMessage,
  isMarkdown,
  stripMarkdownToPlainText,
  MAX_MESSAGE_LENGTH,
} from '../../../src/main/features/messaging/feishu-post';

describe('feishu-post markdown detection', () => {
  it('accepts every markdown hint branch', () => {
    const hints = [
      '| a | b |\n|---|---|',           // pipe table
      '# 标题',                          // heading
      '- item',                          // unordered list
      '1. item',                         // ordered list
      '---',                             // horizontal rule
      '```js\ncode\n```',                // code fence
      '用 `code` 包裹',                   // inline code
      '**加粗**',                        // bold
      '~~删除~~',                        // strikethrough
      '<u>下划线</u>',                    // underline
      '*斜体*',                          // italic
      '[链接](https://example.com)',     // link
      '> 引用',                          // blockquote
    ];
    for (const hint of hints) expect(isMarkdown(hint), hint).toBe(true);
  });

  it('rejects plain prose', () => {
    expect(isMarkdown('你好，世界')).toBe(false);
    expect(isMarkdown('普通的一段话，没有格式。')).toBe(false);
    expect(isMarkdown('')).toBe(false);
  });
});

describe('feishu-post post payload building', () => {
  it('keeps fence-free markdown in a single md row', () => {
    const rows = buildMarkdownPostRows('# 标题\n普通段落');
    expect(rows).toEqual([[{ tag: 'md', text: '# 标题\n普通段落' }]]);
  });

  it('isolates each complete code block into its own row', () => {
    const rows = buildMarkdownPostRows('开头\n```js\nconst a = 1;\n```\n结尾');
    expect(rows).toEqual([
      [{ tag: 'md', text: '开头' }],
      [{ tag: 'md', text: '```js\nconst a = 1;\n```' }],
      [{ tag: 'md', text: '结尾' }],
    ]);
  });

  it('keeps an unterminated fence block in its own row', () => {
    const rows = buildMarkdownPostRows('```python\nprint(1)');
    expect(rows).toEqual([[{ tag: 'md', text: '```python\nprint(1)' }]]);
  });

  it('builds the zh_cn locale post payload JSON', () => {
    const payload = JSON.parse(buildMarkdownPostPayload('第一行\n第二行'));
    expect(payload).toEqual({
      zh_cn: { content: [[{ tag: 'md', text: '第一行\n第二行' }]] },
    });
  });
});

describe('feishu-post plain-text fallback', () => {
  it('strips formatting markers and restores links', () => {
    expect(stripMarkdownToPlainText('**粗体**和`code`以及[链接](https://a.b)'))
      .toBe('粗体和code以及链接 (https://a.b)');
  });

  it('strips blockquotes, strike, underline, headings and fences', () => {
    expect(stripMarkdownToPlainText('# 标题\n> 引用\n~~删~~\n<u>下</u>\n```js\nx\n```\n正文'))
      .toBe('标题\n引用\n删\n下\nx\n正文');
  });
});

describe('feishu-post chunking', () => {
  it('returns a single chunk for short messages', () => {
    expect(chunkMarkdownMessage('短消息', MAX_MESSAGE_LENGTH)).toEqual(['短消息']);
  });

  it('splits long prose at newline boundaries and appends (i/n) indicators', () => {
    const line = '这是一行测试内容，用于验证分块逻辑是否正常。';
    const text = Array.from({ length: 200 }, () => line).join('\n');
    const chunks = chunkMarkdownMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatch(/ \(1\/\d+\)$/);
    expect(chunks[chunks.length - 1]).toMatch(/ \(\d+\/\d+\)$/);
    expect(chunks[0].length).toBeLessThanOrEqual(2000 + 10);
  });

  it('closes a code block at a chunk boundary and reopens it with the same language tag', () => {
    const code = Array.from({ length: 400 }, (_, i) => `const line_${i} = 1;`).join('\n');
    const text = `开头\n\`\`\`ts\n${code}\n\`\`\`\n结尾`;
    const chunks = chunkMarkdownMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    // Chunk 0 ends inside the code block: it must be closed with a fence.
    expect(chunks[0].endsWith('\n``` (1/' + chunks.length + ')')).toBe(true);
    // The next chunk reopens the fence with the carried language tag.
    expect(chunks[1].startsWith('```ts\n')).toBe(true);
    // The last chunk contains the closing fence of the original block.
    const lastBody = chunks[chunks.length - 1].replace(/ \(\d+\/\d+\)$/, '');
    expect(lastBody).toContain('\n```');
  });

  it('does not split inside an inline code span', () => {
    const text = '说明文字 '.repeat(400) + '`code_inside` 结尾';
    const chunks = chunkMarkdownMessage(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk may carry an unpaired backtick.
    for (const chunk of chunks) {
      const body = chunk.replace(/ \(\d+\/\d+\)$/, '');
      const backticks = body.split('`').length - 1;
      expect(backticks % 2).toBe(0);
    }
  });

  it('keeps code-block language carried across chunk boundaries intact', () => {
    const text = '```python\n' + 'x = 1\n'.repeat(500) + '```';
    const chunks = chunkMarkdownMessage(text, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    // Intermediate chunks reopen with python, not a generic fence.
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].startsWith('```python\n')).toBe(true);
    }
  });
});
