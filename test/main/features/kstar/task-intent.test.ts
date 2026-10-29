import { describe, expect, it } from 'vitest';
import { detectTaskIntent, isClosingIntent, taskIntentHint } from '../../../../src/main/features/kstar/task-intent';

describe('KStar host task-intent detection (layer 1)', () => {
  it('detects ordinary task-shaped requests without formal phrasing', () => {
    expect(detectTaskIntent('审查一下 OAuth 登录回调的代码，看看状态校验有没有问题').isTask).toBe(true);
    expect(detectTaskIntent('帮我修复一下登录页面的 bug').isTask).toBe(true);
    expect(detectTaskIntent('写一个单元测试覆盖这个函数').isTask).toBe(true);
    expect(detectTaskIntent('分析一下这个项目的整体架构和模块划分').isTask).toBe(true);
  });

  it('never flags greetings, thanks, status queries or trivial messages', () => {
    expect(detectTaskIntent('你好').isTask).toBe(false);
    expect(detectTaskIntent('谢谢，辛苦了').isTask).toBe(false);
    expect(detectTaskIntent('好的收到').isTask).toBe(false);
    expect(detectTaskIntent('到哪一步了？').isTask).toBe(false);
    expect(detectTaskIntent('完成了吗').isTask).toBe(false);
    expect(detectTaskIntent('嗯').isTask).toBe(false);
    expect(detectTaskIntent('👍').isTask).toBe(false);
    expect(detectTaskIntent(undefined).isTask).toBe(false);
    expect(detectTaskIntent('').isTask).toBe(false);
  });

  it('renders an advisory hint only for task-shaped messages', () => {
    expect(taskIntentHint('你好')).toBe('');
    expect(taskIntentHint('审查一下 bus.ts 的守卫实现')).toContain('Host routing note');
    // The hint never instructs a kstar_control call (world model owns the
    // lifecycle; the tool is no longer in the Commander's surface).
    expect(taskIntentHint('审查一下 bus.ts 的守卫实现')).not.toContain('kstar_control');
  });

  it('never claims tracked state the host did not actually open', () => {
    // Default (no fact): the note must NOT say "already tracked".
    const defaultHint = taskIntentHint('审查一下 bus.ts 的守卫实现');
    expect(defaultHint).not.toContain('already tracked');
    expect(defaultHint).toContain('did not open');
    // Only when the host really opened the task may the note say so.
    const openedHint = taskIntentHint('审查一下 bus.ts 的守卫实现', { hostOpenedTask: true });
    expect(openedHint).toContain('already tracked');
    expect(openedHint).toContain('Governance is handled automatically');
    expect(openedHint).not.toContain('did not open');
  });

  it('isObviouslyTrivial filters greetings/status/emoji deterministically', () => {
    const { isObviouslyTrivial } = require('../../../../src/main/features/kstar/task-intent');
    expect(isObviouslyTrivial('你好')).toBe(true);
    expect(isObviouslyTrivial('谢谢，辛苦了')).toBe(true);
    expect(isObviouslyTrivial('到哪一步了？')).toBe(true);
    expect(isObviouslyTrivial('👍')).toBe(true);
    expect(isObviouslyTrivial('')).toBe(true);
    expect(isObviouslyTrivial(undefined)).toBe(true);
    // Boundary task-shaped messages are NOT filtered by the fast path.
    expect(isObviouslyTrivial('帮我看看这个文件哪里不对')).toBe(false);
    expect(isObviouslyTrivial('审查一下 bus.ts 的守卫实现')).toBe(false);
  });

  it('does not let the unanchored status pattern swallow a task-shaped request', () => {
    const { isObviouslyTrivial } = require('../../../../src/main/features/kstar/task-intent');
    // "进度" / "还差" / "多久" match ANYWHERE in the message, so a request that
    // merely mentions one of them used to be filtered as obvious trivia: no
    // model call, no governed task, no requirement, no learning-loop entry.
    expect(isObviouslyTrivial('整理一下这个季度的进度报告')).toBe(false);
    expect(isObviouslyTrivial('分析一下竞品的进度报告怎么写')).toBe(false);
    expect(isObviouslyTrivial('写一份周报，说明当前进度')).toBe(false);
    // Bare status queries stay on the fast path.
    expect(isObviouslyTrivial('现在到哪了')).toBe(true);
    expect(isObviouslyTrivial('还差什么')).toBe(true);
    // The hint detector shares the predicate, so the two agree on the same
    // input instead of one calling it a task while the gate calls it a
    // greeting.
    expect(detectTaskIntent('整理一下这个季度的进度报告').isTask).toBe(true);
  });

  it('isClosingIntent flags explicit task-completion messages', () => {
    expect(isClosingIntent('完成')).toBe(true);
    expect(isClosingIntent('完成了')).toBe(true);
    expect(isClosingIntent('搞定')).toBe(true);
    expect(isClosingIntent('结束了')).toBe(true);
    expect(isClosingIntent('就这样')).toBe(true);
    expect(isClosingIntent('done')).toBe(true);
    expect(isClosingIntent('Done!')).toBe(true);
    // Non-closing messages are not flagged.
    expect(isClosingIntent('帮我完成这个报告')).toBe(false);
    expect(isClosingIntent('完成了多少')).toBe(false);
    expect(isClosingIntent('你好')).toBe(false);
    expect(isClosingIntent('谢谢')).toBe(false);
    expect(isClosingIntent(undefined)).toBe(false);
    expect(isClosingIntent('')).toBe(false);
  });

  // Real shapes taken from 242 logged user messages (Hermes sessions, 2026-05..09).
  it('isAnswerLikeConfirmation matches selections and acknowledgements', () => {
    const { isAnswerLikeConfirmation } = require('../../../../src/main/features/kstar/task-intent');
    // Observed in real traffic (the pre-existing trivial filter only caught "可以").
    for (const text of ['是的', '第三个', '1', '可以', '需要', '1234都需要', '第一个和第三个']) {
      expect(isAnswerLikeConfirmation(text), text).toBe(true);
    }
    // Common variants of the same shape.
    for (const text of ['不用了', '都要', '全都要', '前两个', '第一个就行', '第一和第三', '同意', '方案一', '选项2', 'ok', 'OK', '没问题']) {
      expect(isAnswerLikeConfirmation(text), text).toBe(true);
    }
  });

  it('isAnswerLikeConfirmation never swallows a real request', () => {
    const { isAnswerLikeConfirmation } = require('../../../../src/main/features/kstar/task-intent');
    const mustNotMatch = [
      '把这个整成PDF',            // continuation, but carries a verb — must reach the model
      '这个',                      // bare pronoun, not a selection
      '第一个方案有问题',          // selection word + real content
      '方案一有问题',              // label + real content
      '帮我看看这个文件哪里不对',  // task without a strong verb
      '审查一下 bus.ts 的守卫实现',
      '写个函数',
      '把第一周的详细展开，输出文档',
      '', undefined,
    ];
    for (const text of mustNotMatch) {
      expect(isAnswerLikeConfirmation(text as string | undefined), String(text)).toBe(false);
    }
  });
});
