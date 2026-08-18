import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

describe('conversation Recall citations', () => {
  it('keeps recall_citations in the persisted message record and renders the feedback footer', () => {
    // 本地产品决定（保留版）：recall_citations 在消息透传 + 渲染「提供给本次回答的记忆」
    // footer（有帮助/需改进反馈走 recall.usage.feedback）。远端曾按「后端可见即可」移除
    // footer，合并时保留本地版（用户实际在使用该反馈 UI）。
    expect(source).toContain('recall_citations');
    expect(source).toContain('_renderRecallCitationsHtml');
    expect(source).toContain('_hydrateRecallCitations');
    expect(source).toContain('chat-recall-citations');
    expect(source).toContain('data-recall-feedback');
    expect(source).toContain('recall.usage.feedback');
  });
});
