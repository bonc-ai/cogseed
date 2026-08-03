import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAgent = vi.fn();

const CANONICAL_AGENT_ID = 'c045605cb916';

function trustedAgent() {
  return {
    agent_id: CANONICAL_AGENT_ID,
    source: 'marketplace',
    seed_source: 'builtin',
    enabled: true,
    management_surface: 'expense_workbench',
    interaction_mode: 'management_only',
    reimbursement_entry_role: 'canonical',
  };
}

beforeEach(() => {
  vi.resetModules();
  getAgent.mockReset();
  vi.doMock('../../../src/main/features/agents', () => ({ getAgent }));
});

afterEach(() => {
  vi.doUnmock('../../../src/main/features/agents');
});

describe('canonical expense workbench Agent trust boundary', () => {
  it('rejects an arbitrary id even when every declarative field is forged', async () => {
    getAgent.mockResolvedValue({ ...trustedAgent(), agent_id: 'forged-expense-agent' });
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent('forged-expense-agent'))
      .rejects.toThrow('does not expose the canonical expense workbench');
    expect(getAgent).not.toHaveBeenCalled();
  });

  it('rejects the fixed id when its install provenance is not builtin', async () => {
    getAgent.mockResolvedValue({ ...trustedAgent(), seed_source: 'platform' });
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('rejects the fixed id when the user has disabled it', async () => {
    getAgent.mockResolvedValue({ ...trustedAgent(), enabled: false });
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it.each([
    ['returned agent id', { agent_id: 'different-agent' }],
    ['source', { source: 'custom' }],
    ['management surface', { management_surface: undefined }],
    ['interaction mode', { interaction_mode: undefined }],
    ['entry role', { reimbursement_entry_role: 'invalid' }],
  ])('rejects a mismatch in %s', async (_label, mismatch) => {
    getAgent.mockResolvedValue({ ...trustedAgent(), ...mismatch });
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('returns the Agent only when every host trust condition matches', async () => {
    const agent = trustedAgent();
    getAgent.mockResolvedValue(agent);
    const {
      assertCanonicalExpenseWorkbenchAgent,
      CANONICAL_EXPENSE_WORKBENCH_AGENT_ID,
    } = await import('../../../src/main/features/expense_workbench/canonical-agent');

    await expect(assertCanonicalExpenseWorkbenchAgent(CANONICAL_EXPENSE_WORKBENCH_AGENT_ID))
      .resolves.toBe(agent);
    expect(getAgent).toHaveBeenCalledWith(CANONICAL_AGENT_ID);
  });
});
