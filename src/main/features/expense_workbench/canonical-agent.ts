import { getAgent, type Agent } from '../agents';
import { EXPENSE_WORKBENCH_SURFACE } from './contracts';

/** Host-owned trust anchor for the built-in reimbursement management entry. */
export const CANONICAL_EXPENSE_WORKBENCH_AGENT_ID = 'c045605cb916' as const;

export type CanonicalExpenseWorkbenchAgent = Agent & {
  agent_id: typeof CANONICAL_EXPENSE_WORKBENCH_AGENT_ID;
  source: 'marketplace';
  seed_source: 'builtin';
  enabled: true;
  management_surface: typeof EXPENSE_WORKBENCH_SURFACE;
  interaction_mode: 'management_only';
  reimbursement_entry_role: 'canonical';
};

function isCanonicalExpenseWorkbenchAgent(
  agent: Agent | null,
): agent is CanonicalExpenseWorkbenchAgent {
  return agent?.agent_id === CANONICAL_EXPENSE_WORKBENCH_AGENT_ID
    && agent.source === 'marketplace'
    && agent.seed_source === 'builtin'
    && agent.enabled === true
    && agent.management_surface === EXPENSE_WORKBENCH_SURFACE
    && agent.interaction_mode === 'management_only'
    && agent.reimbursement_entry_role === 'canonical';
}

export async function assertCanonicalExpenseWorkbenchAgent(
  agentId: string,
): Promise<CanonicalExpenseWorkbenchAgent> {
  if (agentId !== CANONICAL_EXPENSE_WORKBENCH_AGENT_ID) {
    throw new Error('agent does not expose the canonical expense workbench');
  }
  const agent = await getAgent(agentId);
  if (!isCanonicalExpenseWorkbenchAgent(agent)) {
    throw new Error('agent does not expose the canonical expense workbench');
  }
  return agent;
}
