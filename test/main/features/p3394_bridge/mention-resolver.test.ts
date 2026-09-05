import { describe, expect, it } from 'vitest';
import { normalizePeerParam, resolveLeadingMention } from '../../../../src/main/features/p3394_bridge/mention-resolver';

const registry = new Map<string, { agent_id: string; expected_identity?: string }>([
  ['hermes', { agent_id: 'hermes', expected_identity: 'hermes-expected' }],
  ['reviewer', { agent_id: 'agent-reviewer-1', expected_identity: 'agent-reviewer-1' }],
]);
const lookup = (aliasOrId: string) => registry.get(aliasOrId) ?? null;

describe('P3394 leading @alias mention resolver (§7.2/§7.3, A4/E4)', () => {
  it('resolves a leading @alias to the registered peer and carries expected_identity (A4)', () => {
    const hit = resolveLeadingMention('@hermes 请审查这份合同', lookup);
    expect(hit).toMatchObject({ agentId: 'hermes', alias: 'hermes', expectedIdentity: 'hermes-expected' });
    expect(hit?.rest).toBe('请审查这份合同');
    // alias 可指向与 agent_id 不同的注册节点。
    const alias = resolveLeadingMention('@reviewer check the draft', lookup);
    expect(alias?.agentId).toBe('agent-reviewer-1');
  });

  it('never resolves mentions inside quoted/reference text (E4, §17.4)', () => {
    expect(resolveLeadingMention('他说 @hermes 不行', lookup)).toBeNull();
    expect(resolveLeadingMention('> @hermes 引用的原话', lookup)).toBeNull();
    expect(resolveLeadingMention('「@hermes」是别人的名字', lookup)).toBeNull();
  });

  it('never resolves unregistered or malformed mentions (E4)', () => {
    expect(resolveLeadingMention('@张三 帮我干活', lookup)).toBeNull();
    expect(resolveLeadingMention('@ 前面是空格', lookup)).toBeNull();
    expect(resolveLeadingMention('@hermes没有空格分隔不是调用', lookup)).toBeNull();
    expect(resolveLeadingMention('', lookup)).toBeNull();
    // token 后必须紧跟空白或结尾（防 @hermes-x 这类复合词误拆）。
    expect(resolveLeadingMention('@hermes-x hi', lookup)).toBeNull();
  });

  it('strips one leading @ from the peer tool param (convenience spelling)', () => {
    expect(normalizePeerParam('@hermes')).toBe('hermes');
    expect(normalizePeerParam('hermes')).toBe('hermes');
    expect(normalizePeerParam('  @agent-reviewer-1 ')).toBe('agent-reviewer-1');
  });
});
