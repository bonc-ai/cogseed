import {
  getCanonicalManagementAgentPolicy,
  type CanonicalManagementAgentPolicy,
} from '../agent-dispatch-policy';
import { EXPENSE_WORKBENCH_SURFACE } from './contracts';
import { CANONICAL_EXPENSE_WORKBENCH_AGENT_ID } from './identity';

export { CANONICAL_EXPENSE_WORKBENCH_AGENT_ID } from './identity';

export type CanonicalExpenseWorkbenchAgent = CanonicalManagementAgentPolicy<
  typeof CANONICAL_EXPENSE_WORKBENCH_AGENT_ID,
  typeof EXPENSE_WORKBENCH_SURFACE,
  'canonical'
>;

export async function assertCanonicalExpenseWorkbenchAgent(
  userId: string,
  agentId: string,
): Promise<CanonicalExpenseWorkbenchAgent> {
  if (agentId !== CANONICAL_EXPENSE_WORKBENCH_AGENT_ID) {
    throw new Error('agent does not expose the canonical expense workbench');
  }
  const agent = await getCanonicalManagementAgentPolicy(userId, {
    agentId,
    managementSurface: EXPENSE_WORKBENCH_SURFACE,
    reimbursementEntryRole: 'canonical',
  });
  if (!agent) {
    throw new Error('agent does not expose the canonical expense workbench');
  }
  return agent;
}
