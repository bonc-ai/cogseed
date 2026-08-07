import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const postJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/features/marketplace', () => ({
  postJson: postJsonMock,
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevBuiltin: string | undefined;

const EXPENSE_AGENT_ID = 'c045605cb916';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-expense-agent-seed-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevBuiltin = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Point the packaged builtin root at the real resources/builtin tree so the
  // seed exercise matches what ships in the repo.
  process.env.ORKAS_BUILTIN_ROOT = path.resolve(
    __dirname, '../../../resources/builtin',
  );
  postJsonMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevBuiltin === undefined) delete process.env.ORKAS_BUILTIN_ROOT;
  else process.env.ORKAS_BUILTIN_ROOT = prevBuiltin;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('builtin marketplace › expense-reimbursement seed', () => {
  it('seeds the reimbursement task agent without the retired CLI skill', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');
    users.activateUser('u-expense-seed');

    const result = await startup.seedBuiltinMarketplaceForActiveUser({
      reason: 'test',
    });
    expect(result?.seeded_agents).toBeGreaterThanOrEqual(1);
    expect(result?.manifest_agents).toBeGreaterThanOrEqual(1);

    const agentDir = paths.userMarketplaceAgentDir('u-expense-seed', EXPENSE_AGENT_ID);
    expect(fs.existsSync(path.join(agentDir, 'agent.json'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'skills/expense-reimbursement-cli'))).toBe(false);

    const spec = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'));
    expect(spec.agent_id).toBe(EXPENSE_AGENT_ID);
    expect(spec.runtime).toEqual({ kind: 'in_process' });
    expect(spec.output_format).toBe('markdown');
    expect(spec.interactive).toBe(true);
    expect(spec.management_surface).toBe('expense_workbench');
    expect(spec.skill_list).toEqual([]);

    // The seed must record the agent in the user's installs manifest as a
    // builtin-seeded resource, not merely copy files.
    const install = JSON.parse(fs.readFileSync(path.join(agentDir, '_install.json'), 'utf8'));
    expect(install.seed_source).toBe('builtin');
    expect(install.default_install).toBe(true);
    expect(install.version).toBe(spec.version);

    const {
      assertCanonicalExpenseWorkbenchAgent,
      CANONICAL_EXPENSE_WORKBENCH_AGENT_ID,
    } = await import('../../../src/main/features/expense_workbench/canonical-agent');
    await expect(assertCanonicalExpenseWorkbenchAgent(CANONICAL_EXPENSE_WORKBENCH_AGENT_ID))
      .resolves.toMatchObject({
        agent_id: EXPENSE_AGENT_ID,
        source: 'marketplace',
        seed_source: 'builtin',
        enabled: true,
        management_surface: 'expense_workbench',
        reimbursement_entry_role: 'canonical',
      });
  });
});
