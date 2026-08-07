import { afterEach, describe, expect, it, vi } from 'vitest';

const getAgent = vi.fn();

vi.mock('../../../src/main/features/agents', () => ({ getAgent }));

afterEach(() => vi.resetModules());

describe('canonical reimbursement agent trust boundary', () => {
  it('accepts only an enabled built-in canonical reimbursement agent', async () => {
    getAgent.mockResolvedValue({
      agent_id: 'c045605cb916',
      source: 'marketplace',
      seed_source: 'builtin',
      enabled: true,
      management_surface: 'expense_workbench',
      reimbursement_entry_role: 'canonical',
      interactive: true,
    });
    const { assertCanonicalExpenseWorkbenchAgent } = await import('../../../src/main/features/expense_workbench/canonical-agent');
    await expect(assertCanonicalExpenseWorkbenchAgent('c045605cb916')).resolves.toMatchObject({ agent_id: 'c045605cb916' });
  });

  it.each([
    { source: 'custom' },
    { seed_source: 'manual' },
    { enabled: false },
    { management_surface: 'other_surface' },
    { reimbursement_entry_role: 'other' },
  ])('rejects a forged or unavailable agent: %o', async (override) => {
    getAgent.mockResolvedValue({
      agent_id: 'c045605cb916', source: 'marketplace', seed_source: 'builtin', enabled: true,
      management_surface: 'expense_workbench', reimbursement_entry_role: 'canonical',
      ...override,
    });
    const { assertCanonicalExpenseWorkbenchAgent } = await import('../../../src/main/features/expense_workbench/canonical-agent');
    await expect(assertCanonicalExpenseWorkbenchAgent('c045605cb916')).rejects.toThrow('canonical expense workbench');
  });
});
