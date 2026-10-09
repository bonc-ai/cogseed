/**
 * Messaging inbound slash commands — 命令识别与分发注册表。
 *
 * 覆盖（纯函数，无 IO）：
 *   - /权限：无参数识别
 *   - /遗忘：preview（带 scope）/ confirm / cancel 三态
 *   - 未知命令不劫持（返回 null，走正常对话流）
 *   - 分发注册表：未注册 → 不消费；已注册 → 消费并回带回复文本
 *   - handler 抛错 → 消费 + 错误提示（不把异常泄漏给入站链路）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  matchInboundCommand,
  registerInboundCommand,
  unregisterInboundCommand,
  dispatchInboundCommand,
  registeredCommandNames,
  type InboundCommand,
} from '../../../src/main/features/messaging/commands';

function fakeCtx(command: InboundCommand) {
  return {
    uid: 'u1',
    instance: { id: 'inst_1' } as never,
    envelope: {} as never,
    command,
  };
}

describe('messaging/commands — matchInboundCommand', () => {
  it('识别 /权限（无参数与带尾随空格）', () => {
    expect(matchInboundCommand('/权限')).toEqual({ name: 'permission', args: '' });
    expect(matchInboundCommand('/权限  ')).toEqual({ name: 'permission', args: '' });
    expect(matchInboundCommand('  /权限')).toEqual({ name: 'permission', args: '' });
  });

  it('识别 /遗忘 的三种子动作', () => {
    expect(matchInboundCommand('/遗忘')).toMatchObject({ name: 'forget', action: 'preview', args: '' });
    expect(matchInboundCommand('/遗忘 feishu:calendar')).toMatchObject({
      name: 'forget', action: 'preview', args: 'feishu:calendar',
    });
    expect(matchInboundCommand('/遗忘 确认')).toEqual({ name: 'forget', args: '确认', action: 'confirm' });
    expect(matchInboundCommand('/遗忘 取消')).toEqual({ name: 'forget', args: '取消', action: 'cancel' });
  });

  it('不劫持未知命令与普通文本', () => {
    expect(matchInboundCommand('/new')).toBeNull();
    expect(matchInboundCommand('/reset')).toBeNull();
    expect(matchInboundCommand('/help')).toBeNull();
    expect(matchInboundCommand('帮我看看今天有什么安排')).toBeNull();
    expect(matchInboundCommand('')).toBeNull();
    expect(matchInboundCommand('/权限x')).toBeNull(); // 命令名必须整词匹配
    expect(matchInboundCommand('/遗忘术')).toBeNull();
  });
});

describe('messaging/commands — 分发注册表', () => {
  beforeEach(() => {
    for (const name of registeredCommandNames()) unregisterInboundCommand(name);
  });
  afterEach(() => {
    for (const name of registeredCommandNames()) unregisterInboundCommand(name);
  });

  it('未注册命令 → 不消费（消息走正常对话流）', async () => {
    const outcome = await dispatchInboundCommand(fakeCtx({ name: 'permission', args: '' }));
    expect(outcome).toEqual({ consumed: false });
  });

  it('已注册命令 → 消费并回带回复文本', async () => {
    registerInboundCommand('permission', async () => ({ consumed: true, replyText: '授权全景…' }));
    const outcome = await dispatchInboundCommand(fakeCtx({ name: 'permission', args: '' }));
    expect(outcome).toEqual({ consumed: true, replyText: '授权全景…' });
  });

  it('handler 抛错 → 消费 + 错误提示（不外泄异常）', async () => {
    registerInboundCommand('forget', async () => {
      throw new Error('boom');
    });
    const outcome = await dispatchInboundCommand(fakeCtx({ name: 'forget', args: 'feishu:calendar', action: 'preview' }));
    expect(outcome.consumed).toBe(true);
    expect(outcome.replyText).toContain('boom');
  });
});
