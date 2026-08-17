import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const indexSource = readFileSync(
  resolve(__dirname, '../../src/renderer/index.html'),
  'utf8',
);
const styleSource = readFileSync(
  resolve(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

describe('9.1 unified framework · compact result blocks (middle)', () => {
  it('defines one compact result-block container helper', () => {
    expect(conversationSource).toContain('function _mountCompactResultBlock');
    expect(conversationSource).toContain('chat-result-block-head');
    expect(conversationSource).toContain('chat-result-block-body');
  });

  it('mounts artifacts via the shared artifact mount helper', () => {
    expect(conversationSource).toContain("if (role === 'assistant' && Array.isArray(message.artifacts)");
    expect(conversationSource).toContain('window.mountMessageArtifacts(bubble, message.artifacts');
  });

  it('wraps source references and teaching receipts in an evidence result block', () => {
    expect(conversationSource).toContain("t('chat.result_block.evidence')");
    expect(conversationSource).toContain('_compactResultBlockHtml');
    expect(conversationSource).toContain('evidenceRefCount + evidenceReceiptCount');
    // 证据块默认展开（open: true），证据不能被折叠藏起来。
    expect(conversationSource).toContain('icon: \'link\',');
    const bubbleLine = conversationSource.split('\n').find((l) => l.includes('chat-bubble">') && l.includes('${evidenceHtml}'));
    expect(bubbleLine).toBeTruthy();
  });

  it('wraps the produced-file footer in a receipt result block', () => {
    expect(conversationSource).toContain("t('chat.result_block.receipt')");
    const start = conversationSource.indexOf('function _mountMessageProducedFooter');
    const end = conversationSource.indexOf('\n// Render a "view details" chip', start);
    const fnSource = conversationSource.slice(start, end);
    expect(fnSource).toContain('_mountCompactResultBlock(bubble');
    expect(fnSource).toContain('count: absPaths.length');
    expect(fnSource).toContain('open: true');
  });

  it('mounts kstar review, expense setup and marketplace requests (recall simplified)', () => {
    expect(conversationSource).toContain('chat-kstar-review chat-kstar-result-review');
    expect(conversationSource).toContain('window.mountExpenseSetupCard(bubble');
    expect(conversationSource).toContain('function _mountMarketplaceInstallRequests');
    // recall_projection 已按产品决策简化为普通文本呈现，不再渲染结果块卡片。
    expect(conversationSource).toContain('仅以普通文本呈现');
  });

  it('styles the compact result block in the shared stylesheet', () => {
    expect(styleSource).toContain('.chat-result-block-head');
    expect(styleSource).toContain('.chat-result-block-caret');
    expect(styleSource).toContain('.chat-result-block[open] .chat-result-block-caret');
  });
});

describe('9.1 unified framework · bottom zone', () => {
  it('uses the wake-pending host for the composer pending area', () => {
    expect(conversationSource).toContain('chat-wake-pending-host');
    expect(styleSource).toContain('.chat-wake-pending-host');
  });
});

describe('9.1 unified framework · left zone (tasks & sessions)', () => {
  it('keeps the sidebar row free of inline status badges (design decision)', () => {
    // 用户设计确认：侧栏行内无装饰状态（不显示进行中/排队徽标），
    // 仅保留全局运行计数与任务状态行（运行中/排队/计划进度）。
    expect(conversationSource).toContain('侧栏行不显示「进行中/排队」徽标');
    expect(conversationSource).not.toContain("badge.classList.add('is-running')");
  });

  it('aggregates a task status line (running / queued / plan progress) per conversation', () => {
    expect(conversationSource).toContain('function _convTaskStatusLine');
    expect(conversationSource).toContain('window.planRail.planFor(cid)');
    expect(conversationSource).toContain("t('chat.task_plan_label'");
    expect(conversationSource).toContain('_refreshConvTaskLine(cid)');
    expect(styleSource).toContain('.conv-task-line');
    expect(styleSource).toContain('.conv-task-chip.is-running');
  });

  it('exposes plan progress per conversation from the plan rail', () => {
    const planRailSource = readFileSync(
      resolve(__dirname, '../../src/renderer/modules/plan-rail.js'),
      'utf8',
    );
    expect(planRailSource).toContain('planFor(cid)');
    expect(planRailSource).toContain('done: counts.done');
  });
});

describe('9.1 unified framework · locale coverage', () => {
  it('defines the active keys in all four renderer languages', () => {
    const keys = [
      'chat.retry_btn',
      'chat.status.running',
      'chat.task_plan_label',
      'chat.result_block.evidence',
      'chat.result_block.receipt',
    ];
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const data = JSON.parse(readFileSync(
        resolve(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      ));
      for (const key of keys) {
        expect(data[key], `${locale}.json missing ${key}`).toBeTruthy();
      }
    }
  });
});
