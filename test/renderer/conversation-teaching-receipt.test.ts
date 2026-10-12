// 教学回执并入保存回执（2026-09-28 四病整改 7.0 修7 / 深探 F39）。
// 旧世界里用户教一条记忆，回复气泡挂独立「教学回执卡」（scope+状态+撤销），
// 历史重载还要补拉 recall.teaching.list 对账撤销态。并入后：
//   - runner 把教学信号以 candidate+taught-pending-review 走 onCognitionSaveReceipt；
//   - 渲染层只留保存回执卡（chat-cognition-save-receipts），教学卡整卡删除；
//   - 撤销入口不迁入（首跑验收证实教学卡上本就没有撤销按钮、teachingRevoke
//     是渲染层零调用死函数——撤销入口无保留价值，一并删除）；
//   - 旧消息上的 teaching_receipts 只作数据留存，不再渲染、不再补拉。
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function renderSaveReceipts(receipts: unknown[]): string {
  const escape = (value: unknown) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const translations: Record<string, string> = {
    'chat.cognition_save.state_taught': '已记住 · 待审核',
    'chat.cognition_save.open_candidate': '去审核',
  };
  const context: any = {
    t: (key: string) => translations[key] || key,
    escapeHtml: escape,
    uiButton: ({ label, attrs }: { label: string; attrs?: Record<string, string> }) => {
      const renderedAttrs = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
      return `<button type="button" class="ui-button"${renderedAttrs}>${escape(label)}</button>`;
    },
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('_renderCognitionSaveReceiptsHtml')}\nthis.render = _renderCognitionSaveReceiptsHtml;`, context);
  return context.render(receipts);
}

describe('conversation teaching receipts（已并入保存回执）', () => {
  it('教学卡整卡删除：渲染函数/样式钩子/历史补拉/撤销通道引用全数清零', () => {
    for (const gone of [
      '_renderTeachingReceiptsHtml',
      '_hydrateTeachingReceipts',
      '_mergeTeachingReceiptStatuses',
      '_teachingReceiptScopeLabel',
      'chat-teaching-receipts',
      'data-chat-teaching-revoke',
      'recall.teaching.list',
      'recall.teaching.revoke',
      'teaching_receipts: gm.teaching_receipts',
    ]) {
      expect(source).not.toContain(gone);
    }
  });

  it('taught 回执在保存回执卡里渲染：已记住·待审核 + 打开候选', () => {
    const html = renderSaveReceipts([
      { target: 'candidate', id: 'cand-a', summary: '以后所有结论都附来源。', outcome: 'taught-pending-review' },
    ]);

    expect(html).toContain('以后所有结论都附来源。');
    expect(html).toContain('已记住 · 待审核');
    expect(html).toContain('data-candidate-citation="cand-a"');
  });

  it('保存回执卡与证据块照常渲染（并入不破既有链路）', () => {
    expect(source).toContain('_renderCognitionSaveReceiptsHtml(message.cognition_save_receipts)');
    expect(source).toContain('chat.cognition_save.state_taught');
  });
});
