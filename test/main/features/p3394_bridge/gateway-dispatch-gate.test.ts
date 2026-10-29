import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Only the policy read is mocked; `isAgentChatDispatchable` and the error codes
 *  stay real, so this exercises the gate's decision against the actual predicate. */
const policyRead = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../../../src/main/features/agent-dispatch-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/agent-dispatch-policy')>();
  return { ...actual, getAgentDispatchPolicy: vi.fn(async () => { if (policyRead.value instanceof Error) throw policyRead.value; return policyRead.value; }) };
});

const { gatewayDispatchBlock } = await import('../../../../src/main/features/p3394_bridge/gateway-dispatch-gate');
const UID = 'gate-user-1';

/** Contract: a retired/disabled agent must not be dispatched through a gateway,
 *  while an id that simply is not in the local catalog (external node) must. */
describe('p3394_bridge › gateway dispatch gate', () => {
  beforeEach(() => { policyRead.value = null; });

  it('blocks a disabled agent with a config terminal', async () => {
    policyRead.value = { enabled: false };
    const blocked = await gatewayDispatchBlock(UID, 'retired-agent');
    expect(blocked).not.toBeNull();
    expect(blocked?.failureKind).toBe('config');
    expect(blocked?.failureCode).toBe('E_AGENT_CHAT_UNAVAILABLE');
    expect(blocked?.error).toContain('E_AGENT_CHAT_UNAVAILABLE');
  });

  it('blocks a management-only agent with its own code', async () => {
    policyRead.value = { enabled: true, interaction_mode: 'management_only' };
    const blocked = await gatewayDispatchBlock(UID, 'expense-workbench');
    expect(blocked?.failureCode).toBe('E_AGENT_MANAGEMENT_ONLY');
  });

  it('allows an external node that has no catalog policy, and an enabled agent', async () => {
    // Unknown id: external nodes live outside the local catalog.
    expect(await gatewayDispatchBlock(UID, 'some-external-node')).toBeNull();
    policyRead.value = { enabled: true };
    expect(await gatewayDispatchBlock(UID, 'known-agent')).toBeNull();
  });

  it('fails open when the policy read throws (dispatch must not become an exception)', async () => {
    policyRead.value = new Error('disk unavailable');
    expect(await gatewayDispatchBlock(UID, 'any-agent')).toBeNull();
  });

  it('never blocks without a usable identity', async () => {
    policyRead.value = { enabled: false };
    expect(await gatewayDispatchBlock('', 'retired-agent')).toBeNull();
    expect(await gatewayDispatchBlock(UID, '   ')).toBeNull();
  });
});
