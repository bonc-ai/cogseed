import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TEST_UID = 'u-projection';
let prevWorkspaceRoot: string | undefined;
let testVariant = '';

describe('P3394 node -> AI team projection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-proj-'));
    prevWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
    process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
    // 每次运行唯一变体：投影状态文件按变体目录隔离，杜绝跨测试/跨运行污染。
    testVariant = 'p3394-proj-test-' + Math.random().toString(36).slice(2, 10);
    process.env.ORKAS_RUNTIME_VARIANT = testVariant;
  });

  afterEach(() => {
    if (prevWorkspaceRoot !== undefined) process.env.ORKAS_WORKSPACE_ROOT = prevWorkspaceRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      const variantDir = path.join(os.homedir(), '.cogseed', 'runtime-variants', testVariant);
      fs.rmSync(variantDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('projects a local hermes node into the AI team with the external badge runtime', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const result = await mod.projectP3394NodeToTeam({
      nodeId: 'hermes',
      alias: 'Hermes',
      endpoints: ['http://127.0.0.1:9000'],
    });
    expect(result.projected).toBe(true);
    expect(result.agent_id).toBeTruthy();

    const agents = await import('../../../../src/main/features/agents');
    const list = await agents.listAgents();
    const created = list.find((a) => a.agent_id === result.agent_id);
    expect(created).toBeTruthy();
    expect(created?.runtime).toEqual({ kind: 'p3394-gateway', cli: 'hermes' });
    expect(created?.name).toContain('Hermes');
    expect(created?.description_zh).toContain('P3394');
    expect(agents.isP3394GatewayAgent(created)).toBe(true);

    const again = await mod.projectP3394NodeToTeam({
      nodeId: 'hermes',
      alias: 'Hermes',
      endpoints: ['http://127.0.0.1:9000'],
    });
    expect(again.projected).toBe(false);
    expect(again.agent_id).toBe(result.agent_id);
    const p3394Agents = (await agents.listAgents()).filter((a) => {
      const rt = a.runtime as { kind?: string; cli?: string } | undefined;
      return rt && rt.kind === 'p3394-gateway' && rt.cli === 'hermes';
    });
    expect(p3394Agents).toHaveLength(1);
  });

  it('skips non-local nodes and endpoint-less cloud clients', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const lan = await mod.projectP3394NodeToTeam({ nodeId: 'lan-agent', endpoints: ['http://192.168.1.5:9000'] });
    expect(lan.projected).toBe(false);
    expect(lan.reason).toBe('skip_non_local');

    const cloud = await mod.projectP3394NodeToTeam({ nodeId: 'cloud-agent', endpoints: [] });
    expect(cloud.projected).toBe(false);
    expect(cloud.reason).toBe('skip_non_local');

    const self = await mod.projectP3394NodeToTeam({ nodeId: 'cogseed', endpoints: ['http://127.0.0.1:8444'] });
    expect(self.projected).toBe(false);
    expect(self.reason).toBe('skip_local');
  });

  it('projects an unknown self-built gateway node with a generic description', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const result = await mod.projectP3394NodeToTeam({ nodeId: 'my-custom-agent', alias: '我的自研智能体', endpoints: ['http://127.0.0.1:9200'] });
    expect(result.projected).toBe(true);
    const agents = await import('../../../../src/main/features/agents');
    const created = (await agents.listAgents()).find((a) => a.agent_id === result.agent_id);
    expect(created?.name).toBe('我的自研智能体');
    expect(created?.runtime).toEqual({ kind: 'p3394-gateway', cli: 'my-custom-agent' });
  });
});
