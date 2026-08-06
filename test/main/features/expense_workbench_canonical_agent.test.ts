import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const CANONICAL_AGENT_ID = 'c045605cb916';
const TEST_UID = 'u-expense-policy';
let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;
let previousBuiltinRoot: string | undefined;
let previousResourcesPath: string | undefined;

const SOURCE_BUILTIN_ROOT = path.resolve(__dirname, '../../../resources/builtin');
const require = createRequire(import.meta.url);
const builtinGate = require('../../../bin/builtin-resource-gate.cjs') as {
  createBuiltinManifest(root: string, options?: { allowIgnoredJunk?: boolean }): Record<string, unknown>;
};

function removeIgnoredJunk(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.name === '.DS_Store' || entry.name.endsWith('.pyc') || entry.name === '__pycache__') {
      fs.rmSync(target, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      removeIgnoredJunk(target);
    }
  }
}

function copyPackagedBuiltin(destination: string): void {
  fs.cpSync(SOURCE_BUILTIN_ROOT, destination, { recursive: true });
  removeIgnoredJunk(destination);
}

function writeBuiltinManifest(root: string): void {
  fs.writeFileSync(
    path.join(root, '_manifest.json'),
    `${JSON.stringify(builtinGate.createBuiltinManifest(root, { allowIgnoredJunk: true }), null, 2)}\n`,
    'utf8',
  );
}

function writeTrustedAgent(overrides: Record<string, unknown> = {}, installOverrides: Record<string, unknown> = {}) {
  const dir = path.join(workspaceRoot, TEST_UID, 'local', 'marketplace', 'agents', CANONICAL_AGENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: CANONICAL_AGENT_ID,
    management_surface: 'expense_workbench',
    interaction_mode: 'management_only',
    reimbursement_entry_role: 'canonical',
    ...overrides,
  }));
  fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
    seed_source: 'builtin',
    ...installOverrides,
  }));
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-expense-policy-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  previousBuiltinRoot = process.env.ORKAS_BUILTIN_ROOT;
  previousResourcesPath = process.resourcesPath;
  process.env.ORKAS_WORKSPACE_ROOT = workspaceRoot;
  process.env.ORKAS_BUILTIN_ROOT = SOURCE_BUILTIN_ROOT;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  if (previousBuiltinRoot === undefined) delete process.env.ORKAS_BUILTIN_ROOT;
  else process.env.ORKAS_BUILTIN_ROOT = previousBuiltinRoot;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: previousResourcesPath,
  });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('canonical expense workbench Agent trust boundary', () => {
  it('rejects an arbitrary id even when every declarative field is forged', async () => {
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, 'forged-expense-agent'))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('takes provenance from the host resource rather than user install metadata', async () => {
    writeTrustedAgent({}, { seed_source: 'platform' });
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .resolves.toMatchObject({ agent_id: CANONICAL_AGENT_ID, seed_source: 'builtin' });
  });

  it('rejects the fixed id when the user has disabled it', async () => {
    writeTrustedAgent();
    const enabledFile = path.join(workspaceRoot, TEST_UID, 'cloud', 'config', 'component-enabled.json');
    fs.mkdirSync(path.dirname(enabledFile), { recursive: true });
    fs.writeFileSync(enabledFile, JSON.stringify({ version: 1, agents: { [CANONICAL_AGENT_ID]: false } }));
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('requires the installed Agent to retain the fixed host identity', async () => {
    writeTrustedAgent({ agent_id: 'different-agent' });
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it.runIf(process.platform !== 'win32')('rejects a user Agent policy supplied through a symbolic link', async () => {
    writeTrustedAgent();
    const agentFile = path.join(
      workspaceRoot,
      TEST_UID,
      'local',
      'marketplace',
      'agents',
      CANONICAL_AGENT_ID,
      'agent.json',
    );
    const external = path.join(workspaceRoot, 'external-agent.json');
    fs.copyFileSync(agentFile, external);
    fs.unlinkSync(agentFile);
    fs.symlinkSync(external, agentFile);
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('rejects an oversized user Agent policy before parsing it', async () => {
    writeTrustedAgent();
    const agentFile = path.join(
      workspaceRoot,
      TEST_UID,
      'local',
      'marketplace',
      'agents',
      CANONICAL_AGENT_ID,
      'agent.json',
    );
    fs.writeFileSync(agentFile, `{"agent_id":"${CANONICAL_AGENT_ID}","padding":"${'x'.repeat(1024 * 1024)}"}`);
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('does not let a forged user install self-attest when the host builtin identity is missing', async () => {
    writeTrustedAgent();
    process.env.ORKAS_BUILTIN_ROOT = path.join(workspaceRoot, 'missing-builtin');
    vi.resetModules();
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('does not let a forged user install self-attest when the host builtin manifest is tampered', async () => {
    writeTrustedAgent();
    const forgedBuiltin = path.join(workspaceRoot, 'forged-builtin');
    fs.cpSync(SOURCE_BUILTIN_ROOT, forgedBuiltin, { recursive: true });
    const hostSpecFile = path.join(
      forgedBuiltin,
      'marketplace',
      'agents',
      CANONICAL_AGENT_ID,
      'agent.json',
    );
    const hostSpec = JSON.parse(fs.readFileSync(hostSpecFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(hostSpecFile, JSON.stringify({ ...hostSpec, management_surface: 'forged' }));
    process.env.ORKAS_BUILTIN_ROOT = forgedBuiltin;
    vi.resetModules();
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('does not let a semantically altered host identity pass with a regenerated manifest', async () => {
    writeTrustedAgent();
    const forgedBuiltin = path.join(workspaceRoot, 'semantically-forged-builtin');
    fs.cpSync(SOURCE_BUILTIN_ROOT, forgedBuiltin, { recursive: true });
    const hostSpecFile = path.join(
      forgedBuiltin,
      'marketplace',
      'agents',
      CANONICAL_AGENT_ID,
      'agent.json',
    );
    const hostSpec = JSON.parse(fs.readFileSync(hostSpecFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(hostSpecFile, JSON.stringify({ ...hostSpec, management_surface: 'forged' }));
    writeBuiltinManifest(forgedBuiltin);
    process.env.ORKAS_BUILTIN_ROOT = forgedBuiltin;
    vi.resetModules();
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('uses packaged resources instead of a source-run builtin override', async () => {
    writeTrustedAgent();
    const packagedResources = path.join(workspaceRoot, 'packaged-resources');
    fs.mkdirSync(packagedResources, { recursive: true });
    copyPackagedBuiltin(path.join(packagedResources, 'builtin'));
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: packagedResources,
    });
    process.env.ORKAS_BUILTIN_ROOT = path.join(workspaceRoot, 'missing-source-override');
    vi.resetModules();
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .resolves.toMatchObject({ agent_id: CANONICAL_AGENT_ID, seed_source: 'builtin' });
  });

  it('rejects ignored source-cache artifacts when they appear in packaged resources', async () => {
    writeTrustedAgent();
    const packagedResources = path.join(workspaceRoot, 'tampered-packaged-resources');
    const packagedBuiltin = path.join(packagedResources, 'builtin');
    fs.mkdirSync(packagedResources, { recursive: true });
    copyPackagedBuiltin(packagedBuiltin);
    const shadowBytecode = path.join(
      packagedBuiltin,
      'marketplace',
      'agents',
      CANONICAL_AGENT_ID,
      '__pycache__',
      'shadow.pyc',
    );
    fs.mkdirSync(path.dirname(shadowBytecode), { recursive: true });
    fs.writeFileSync(shadowBytecode, 'unapproved packaged bytecode');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: packagedResources,
    });
    vi.resetModules();
    const { assertCanonicalExpenseWorkbenchAgent } = await import(
      '../../../src/main/features/expense_workbench/canonical-agent'
    );

    await expect(assertCanonicalExpenseWorkbenchAgent(TEST_UID, CANONICAL_AGENT_ID))
      .rejects.toThrow('does not expose the canonical expense workbench');
  });

  it('returns a minimal policy only when every host trust condition matches', async () => {
    writeTrustedAgent({ source: 'custom', seed_source: 'platform' });
    const {
      assertCanonicalExpenseWorkbenchAgent,
      CANONICAL_EXPENSE_WORKBENCH_AGENT_ID,
    } = await import('../../../src/main/features/expense_workbench/canonical-agent');

    await expect(assertCanonicalExpenseWorkbenchAgent(
      TEST_UID,
      CANONICAL_EXPENSE_WORKBENCH_AGENT_ID,
    )).resolves.toEqual({
      agent_id: CANONICAL_AGENT_ID,
      source: 'marketplace',
      seed_source: 'builtin',
      enabled: true,
      management_surface: 'expense_workbench',
      interaction_mode: 'management_only',
      reimbursement_entry_role: 'canonical',
    });
  });
});
