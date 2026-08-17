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
});
