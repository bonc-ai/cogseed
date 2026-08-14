import { describe, expect, it } from 'vitest';
import { detectTaskIntent, taskIntentHint } from '../../../../src/main/features/kstar/task-intent';

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
    expect(taskIntentHint('审查一下 bus.ts 的守卫实现')).toContain('kstar_control');
  });
});
