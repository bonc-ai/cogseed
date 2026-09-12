// ─── 会话标题生成（conversation-title）测试 ───────────────────────────────
//
// 覆盖：模型输出的清洗（引号/尾标点/截断）、短消息跳过、失败降级为 null。
// 模型调用通过 options.runModel 注入，不触网。

import { describe, expect, it, vi } from 'vitest';

import {
  generateConversationTitle,
  sanitizeGeneratedTitle,
  shouldGenerateTitle,
} from '../../../src/main/features/conversation-title';

describe('sanitizeGeneratedTitle', () => {
  it('去掉包裹引号与句末标点', () => {
    expect(sanitizeGeneratedTitle('「认知资产模块梳理」')).toBe('认知资产模块梳理');
    expect(sanitizeGeneratedTitle('“P3394 账本整理”')).toBe('P3394 账本整理');
    expect(sanitizeGeneratedTitle('梳理使用记录页面。')).toBe('梳理使用记录页面');
    expect(sanitizeGeneratedTitle('Title: hello!')).toBe('Title: hello');
  });

  it('折叠空白并截断超长输出', () => {
    expect(sanitizeGeneratedTitle('  多  余\n空白  ')).toBe('多 余 空白');
    const long = '一'.repeat(60);
    expect(sanitizeGeneratedTitle(long)).toHaveLength(24);
  });

  it('空输出返回空串', () => {
    expect(sanitizeGeneratedTitle('')).toBe('');
    expect(sanitizeGeneratedTitle('   ')).toBe('');
    expect(sanitizeGeneratedTitle('""')).toBe('');
  });
});

describe('shouldGenerateTitle', () => {
  it('过短的消息（如 hi）不生成', () => {
    expect(shouldGenerateTitle('hi')).toBe(false);
    expect(shouldGenerateTitle('1')).toBe(false);
    expect(shouldGenerateTitle('   ')).toBe(false);
  });

  it('有信息量的消息生成', () => {
    expect(shouldGenerateTitle('帮我梳理认知资产')).toBe(true);
  });
});

describe('generateConversationTitle（注入 runModel）', () => {
  it('成功路径返回清洗后的标题', async () => {
    const runModel = vi.fn(async () => '「认知资产的三个核心概念」');
    const title = await generateConversationTitle('u-1', 'c-1', '帮我梳理一下认知资产模块的三个核心概念', { runModel });
    expect(title).toBe('认知资产的三个核心概念');
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it('短消息不调用模型', async () => {
    const runModel = vi.fn(async () => '打招呼');
    const title = await generateConversationTitle('u-1', 'c-1', 'hi', { runModel });
    expect(title).toBeNull();
    expect(runModel).not.toHaveBeenCalled();
  });

  it('模型输出为空时返回 null（调用方保持机械标题）', async () => {
    const runModel = vi.fn(async () => '   ');
    expect(await generateConversationTitle('u-1', 'c-1', '帮我梳理认知资产模块', { runModel })).toBeNull();
  });

  it('模型抛错时降级为 null，不向上抛', async () => {
    const runModel = vi.fn(async () => { throw new Error('429 rate limit'); });
    expect(await generateConversationTitle('u-1', 'c-1', '帮我梳理认知资产模块', { runModel })).toBeNull();
  });
});
