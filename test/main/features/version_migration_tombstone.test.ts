import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * N-01 regression. The version migration used to `fs.rmSync` every `cli` /
 * `p3394-gateway` agent directory: the agents vanished from the UI, surfaced as
 * "local agent does not reply", and the data was gone for good. Repo rules say
 * never delete user data to make progress — sideline or write a tombstone. It now
 * writes a disable marker into agent.json and keeps everything.
 */
const UID = '91000099';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-version-migration-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAgent(id: string, name: string, runtime: Record<string, unknown>): string {
  const dir = path.join(tmpDir, UID, 'cloud', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent.json');
  fs.writeFileSync(file, JSON.stringify({ agent_id: id, name, runtime, custom_note: 'keep me' }), 'utf8');
  return file;
}

async function runMigration() {
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  fs.writeFileSync(path.join(tmpDir, 'users.json'), JSON.stringify({
    current_user_id: UID, dev_current_user_id: UID, users: [{ user_id: UID }],
  }), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'app-version.json'), JSON.stringify({ version: '1.2.0' }), 'utf8');
  const mod = await import('../../../src/main/features/version_migration');
  return mod.runVersionMigration();
}

describe('version migration · retired CLI agents are tombstoned, never deleted', () => {
  it('keeps every agent directory and marks the retired runtimes disabled', async () => {
    const cliFile = seedAgent('a1', 'Codex', { kind: 'cli', cli: 'codex' });
    const gatewayFile = seedAgent('a2', 'WorkBudd', { kind: 'p3394-gateway', cli: 'workbuddy' });
    const localFile = seedAgent('a3', '我的探索Agent', { kind: 'local' });

    const result = await runMigration();

    // Directories and files survive — nothing was deleted.
    for (const file of [cliFile, gatewayFile, localFile]) {
      expect(fs.existsSync(file), `${file} must survive the migration`).toBe(true);
    }

    const cli = JSON.parse(fs.readFileSync(cliFile, 'utf8'));
    expect(cli.disabled_at).toEqual(expect.any(String));
    expect(cli.disabled_reason).toBe('cli-runtime-retired');
    expect(cli.disabled_runtime_kind).toBe('cli');
    expect(cli.disabled_runtime_cli).toBe('codex');
    // Untouched fields survive, so the agent can be rebuilt or restored.
    expect(cli.custom_note).toBe('keep me');
    expect(cli.runtime).toEqual({ kind: 'cli', cli: 'codex' });

    const gateway = JSON.parse(fs.readFileSync(gatewayFile, 'utf8'));
    expect(gateway.disabled_reason).toBe('cli-runtime-retired');

    // A non-CLI agent is not touched at all.
    const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    expect(local.disabled_at).toBeUndefined();

    expect(result.clearedAgents).toBe(2);

    // Read side: the agent lists derive `enabled` from the component sets, so a
    // tombstoned agent must be reported disabled (rebuildable) rather than usable.
    const components = await import('../../../src/main/features/component_enabled');
    const { agents: disabledAgentIds } = components.readDisabledSets(UID);
    expect(disabledAgentIds.has('a1')).toBe(true);
    expect(disabledAgentIds.has('a2')).toBe(true);
    expect(disabledAgentIds.has('a3')).toBe(false);

    const agentFeature = await import('../../../src/main/features/agents');
    const summaries = await agentFeature.listAgentSummariesForUser(UID);
    const byId = new Map(summaries.map((row) => [row.agent_id, row]));
    expect(byId.get('a1')?.enabled).toBe(false);
    expect(byId.get('a3')?.enabled).toBe(true);
  });

  it('is idempotent: a second run leaves the tombstone intact', async () => {
    const cliFile = seedAgent('a1', 'Codex', { kind: 'cli', cli: 'codex' });
    await runMigration();
    const first = JSON.parse(fs.readFileSync(cliFile, 'utf8'));

    const mod = await import('../../../src/main/features/version_migration');
    await mod.runVersionMigration();

    const second = JSON.parse(fs.readFileSync(cliFile, 'utf8'));
    expect(second.disabled_at).toBe(first.disabled_at);
    expect(fs.existsSync(cliFile)).toBe(true);
  });
});
