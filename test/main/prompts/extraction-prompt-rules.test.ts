/** 提取提示词保留相对时间双锚、否定语义、新旧状态和通读全文规则。
 * 规则来源参考 Mem0 abb81c8 的公开提取策略；这里只检查规则文本在位，
 * 实际形成行为由对应提取场景验收。 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('提取 prompt 的相对时间、否定与状态变化规则', () => {
  it('自动提取 system prompt 含四项规则', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/main/features/recall/capture-service.ts'),
      'utf8',
    );
    expect(source, '通读整段防首题主导').toMatch(/Read the entire bounded run before deciding candidates/);
    expect(source, '相对时间锚定消息时间戳').toMatch(/anchor it against the message timestamp/);
    expect(source, '保留明确否定与变化').toMatch(/Preserve explicit negation and reversal/);
    expect(source, '历史陈述不足以推断当前状态').toMatch(/A historical statement alone does not establish the current state/);
    expect(source, '转变记新旧两态').toMatch(/record B as the current state and note the superseded prior state/);
  });

  it('手动草稿模块和专属提示词已删除，现役夜间提示词保留', () => {
    expect(fs.existsSync(path.join(__dirname, '../../../src/main/features/cognition/capture-draft.ts'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../../../src/main/prompts/cognition_capture.md'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../../../src/main/prompts/cognition_capture_value.md'))).toBe(true);
  });

  it('stock prompt routes uncertain facts to insufficient instead of a text correction', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/main/prompts/recall_stock_organization.md'),
      'utf8',
    );
    expect(source, '所有 update/correct 先检查目标').toMatch(/Before any update or correct action/);
    expect(source, 'correct 只用于 confirmed fact').toMatch(/stored certainty is `confirmed`/);
    expect(source, 'inferred/unknown 不许 correct').toMatch(/certainty is `inferred` or `unknown`/);
    expect(source, '未解析 subject 不许 correct').toMatch(/identityStatus:"unresolved"/);
    expect(source, '改用 insufficient').toMatch(/"outcome":"insufficient"/);
    expect(source, '禁止文本 correct 对冲身份').toMatch(/Do not use a text `correct`/);
  });
});
