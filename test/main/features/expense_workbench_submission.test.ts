import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAgent = vi.fn();
const adapter = { callExpenseWorkbench: vi.fn() };
const confirmation = { issueExpenseWorkbenchConfirmation: vi.fn() };
const CANONICAL_AGENT_ID = 'c045605cb916';

function trustedAgent() {
  return {
    agent_id: CANONICAL_AGENT_ID,
    source: 'marketplace',
    seed_source: 'builtin',
    enabled: true,
    management_surface: 'expense_workbench',
    reimbursement_entry_role: 'canonical',
    interaction_mode: 'management_only',
  };
}

beforeEach(() => {
  vi.resetModules();
  getAgent.mockReset();
  adapter.callExpenseWorkbench.mockReset();
  confirmation.issueExpenseWorkbenchConfirmation.mockReset();
  vi.doMock('../../../src/main/features/agents', () => ({ getAgent }));
  vi.doMock('../../../src/main/features/expense_workbench/adapter', () => adapter);
  vi.doMock('../../../src/main/features/expense_workbench/confirmation', () => confirmation);
});

afterEach(() => {
  vi.doUnmock('../../../src/main/features/agents');
  vi.doUnmock('../../../src/main/features/expense_workbench/adapter');
  vi.doUnmock('../../../src/main/features/expense_workbench/confirmation');
});

describe('expense workbench submission', () => {
  it('issues a host capability only after the current draft and Feishu target validate', async () => {
    getAgent.mockResolvedValue(trustedAgent());
    confirmation.issueExpenseWorkbenchConfirmation.mockResolvedValue({ issued: true, capabilityId: 'hcap-test-1' });
    adapter.callExpenseWorkbench
      .mockResolvedValueOnce({
        application: {
          application_id: 'APP-1',
          current_version: 2,
          current_payload_hash: 'a'.repeat(64),
          precheck_status: 'ready_for_confirmation',
          target: {
            system: 'oa', environment: 'feishu', adapter: 'feishu-approval',
            form_type: 'approval.v4', mapping_version: 'feishu-expense-v1',
          },
        },
        unified_precheck: { status: 'ready' },
      })
      .mockResolvedValueOnce({ application: { confirmation_status: 'confirmed' } })
      .mockResolvedValueOnce({ application: { oa_status: 'submitted' } });
    const { confirmAndSubmitExpenseWorkbench } = await import('../../../src/main/features/expense_workbench/submission');

    await expect(confirmAndSubmitExpenseWorkbench('u-1', {
      agentId: CANONICAL_AGENT_ID, applicationId: 'APP-1', version: 2, payloadHash: 'a'.repeat(64),
    })).resolves.toEqual({
      confirmed: { application: { confirmation_status: 'confirmed' } },
      submitted: { application: { oa_status: 'submitted' } },
    });
    expect(confirmation.issueExpenseWorkbenchConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-1', applicationId: 'APP-1', draftVersion: 2, draftHash: 'a'.repeat(64),
    }));
    expect(adapter.callExpenseWorkbench).toHaveBeenNthCalledWith(
      2,
      'u-1',
      CANONICAL_AGENT_ID,
      'applications.confirm',
      { application_id: 'APP-1', payload_hash: 'a'.repeat(64) },
      { host_capability_id: 'hcap-test-1' },
    );
  });

  it('rejects a stale draft without issuing a host capability', async () => {
    getAgent.mockResolvedValue(trustedAgent());
    adapter.callExpenseWorkbench.mockResolvedValue({
      application: {
        application_id: 'APP-1', current_version: 3, current_payload_hash: 'a'.repeat(64),
        precheck_status: 'ready_for_confirmation', target: {},
      },
    });
    const { confirmAndSubmitExpenseWorkbench } = await import('../../../src/main/features/expense_workbench/submission');

    await expect(confirmAndSubmitExpenseWorkbench('u-1', {
      agentId: CANONICAL_AGENT_ID, applicationId: 'APP-1', version: 2, payloadHash: 'a'.repeat(64),
    })).rejects.toThrow('version has changed');
    expect(confirmation.issueExpenseWorkbenchConfirmation).not.toHaveBeenCalled();
  });
});
