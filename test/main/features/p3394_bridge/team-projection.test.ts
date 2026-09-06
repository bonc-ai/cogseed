import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let testUid = '';
let prevWorkspaceRoot: string | undefined;
let testVariant = '';

describe('P3394 node -> AI team projection', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-proj-'));
    prevWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
    process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
    // Agent 目录缓存按用户隔离；每例使用唯一 uid，避免上一个用例的缓存
    // 继续参与下一例的 existing-agent 查重。
    testUid = 'u-projection-' + Math.random().toString(36).slice(2, 10);
    // 每次运行唯一变体：投影状态文件按变体目录隔离，杜绝跨测试/跨运行污染。
    testVariant = 'p3394-proj-test-' + Math.random().toString(36).slice(2, 10);
    process.env.COGSEED_RUNTIME_VARIANT = testVariant;

    // 设置引导为已完成状态，允许 CLI Agent 投影
    const onboardingState = await import('../../../../src/main/features/onboarding_state');
    onboardingState.setOnboardingCompleted(true);
  });

  afterEach(() => {
    if (prevWorkspaceRoot !== undefined) process.env.COGSEED_WORKSPACE_ROOT = prevWorkspaceRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      const variantDir = path.join(os.homedir(), '.cogseed', 'runtime-variants', testVariant);
      fs.rmSync(variantDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('projects a local hermes node into the AI team with the external badge runtime', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
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

  it('repairs a stale projection after its Agent record is deleted', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const agents = await import('../../../../src/main/features/agents');
    const first = await mod.projectP3394NodeToTeam({
      nodeId: 'claude', alias: 'ClaudeCode', endpoints: ['http://127.0.0.1:8444'],
    });
    expect(first.projected).toBe(true);
    await agents.deleteCustomAgent(first.agent_id!);

    const repaired = await mod.projectP3394NodeToTeam({
      nodeId: 'claude', alias: 'ClaudeCode', endpoints: ['http://127.0.0.1:8444'],
    });
    expect(repaired.projected).toBe(true);
    expect(repaired.agent_id).not.toBe(first.agent_id);
    expect((await agents.listAgents()).filter((agent) => agent.runtime?.kind === 'p3394-gateway')).toHaveLength(1);
  });

  it('removeProjectionsForAgent clears every node mapping that points at the agent', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    // 同一个 agent 可能被多个 nodeId 投影（自报网关 id ≠ cli 类型，如
    // "workbuddy-final"）；删除 agent 时必须全部清掉，否则下次 hello 会
    // 复用陈旧映射重建同名 agent。
    const a = await mod.projectP3394NodeToTeam({
      nodeId: 'cli-a', alias: 'Alpha', endpoints: ['http://127.0.0.1:9101'],
    });
    expect(a.projected).toBe(true);
    const b = await mod.projectP3394NodeToTeam({
      nodeId: 'cli-a-final', alias: 'Alpha', endpoints: ['http://127.0.0.1:9102'],
    });
    // 第二个 nodeId 命中同 cli 的 existing agent → 复用同一 agent_id。
    expect(b.projected).toBe(false);
    expect(b.agent_id).toBe(a.agent_id);
    expect(mod.projectedTeamAgentId('cli-a')).toBe(a.agent_id);
    expect(mod.projectedTeamAgentId('cli-a-final')).toBe(a.agent_id);

    const removed = mod.removeProjectionsForAgent(a.agent_id!);
    expect(removed).toBe(2);
    expect(mod.projectedTeamAgentId('cli-a')).toBeUndefined();
    expect(mod.projectedTeamAgentId('cli-a-final')).toBeUndefined();
    // 幂等：再次清理返回 0。
    expect(mod.removeProjectionsForAgent(a.agent_id!)).toBe(0);
  });

  it('skips non-local nodes and endpoint-less cloud clients', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const lan = await mod.projectP3394NodeToTeam({ nodeId: 'lan-agent', endpoints: ['http://192.0.2.5:9000'] });
    expect(lan.projected).toBe(false);
    expect(lan.reason).toBe('skip_non_local');

    const cloud = await mod.projectP3394NodeToTeam({ nodeId: 'cloud-agent', endpoints: [] });
    expect(cloud.projected).toBe(false);
    expect(cloud.reason).toBe('skip_non_local');

    const self = await mod.projectP3394NodeToTeam({ nodeId: 'cogseed', endpoints: ['http://127.0.0.1:8444'] });
    expect(self.projected).toBe(false);
    expect(self.reason).toBe('skip_local');
  });

  it('projects an explicitly trusted remote node (remote-nodes injection markers) into the team', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    // X-4：remote-nodes 注入的跨机节点携带 expected_identity/dial_token
    //（用户显式添加的信任特征）→ 允许建 AI 团队卡片（群聊 @ 可达）。
    const result = await mod.projectP3394NodeToTeam({
      nodeId: 'b-node-agent',
      alias: 'B机智能体',
      endpoints: ['http://192.168.1.20:8444'],
      expected_identity: 'b-node-agent',
      dial_token: 'p3394-b-token',
    });
    expect(result.projected).toBe(true);
    expect(result.agent_id).toBeTruthy();

    const agents = await import('../../../../src/main/features/agents');
    const created = (await agents.listAgents()).find((a) => a.agent_id === result.agent_id);
    expect(created).toBeTruthy();
    // 卡片 runtime 指向远端节点 id → 派发经 p3394-gateway-turn 远端路由。
    expect(created?.runtime).toEqual({ kind: 'p3394-gateway', cli: 'b-node-agent' });
    // 远端节点描述区分于本地自动接入（用户能看出这是另一台设备的智能体）。
    expect(created?.description_zh).toContain('远端');
    expect(created?.description_en).toContain('Remote agent');

    // 幂等：再次投影同节点返回 already_projected。
    const again = await mod.projectP3394NodeToTeam({
      nodeId: 'b-node-agent',
      alias: 'B机智能体',
      endpoints: ['http://192.168.1.20:8444'],
      expected_identity: 'b-node-agent',
      dial_token: 'p3394-b-token',
    });
    expect(again.projected).toBe(false);
    expect(again.agent_id).toBe(result.agent_id);
    expect(again.reason).toBe('already_projected');
  });

  it('still skips a hello-self-reported non-loopback node without explicit trust markers', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    // 纯 hello 自报的非回环端点（无 dial_token/expected_identity/trusted）：
    // skip_non_local 语义保留给非信任来源（S-02 对称闸）。
    const untrusted = await mod.projectP3394NodeToTeam({
      nodeId: 'stranger-remote',
      endpoints: ['http://203.0.113.9:9000'],
    });
    expect(untrusted.projected).toBe(false);
    expect(untrusted.reason).toBe('skip_non_local');

    // 单独 dial_token（无 expected_identity）同样算显式信任特征。
    const tokenOnly = await mod.projectP3394NodeToTeam({
      nodeId: 'token-only-remote',
      endpoints: ['http://192.168.1.21:8444'],
      dial_token: 'p3394-token',
    });
    expect(tokenOnly.projected).toBe(true);

    // trusted 显式标记（调用方声明）。既有去重语义：同测试内已存在无 cli
    // 匹配的 p3394-gateway 卡片时，后续未知 nodeId 走 existing_agent 复用
    //（不重复建卡）——这里验证信任标记使其跳过 skip_non_local 闸门。
    const flagged = await mod.projectP3394NodeToTeam({
      nodeId: 'flagged-remote',
      endpoints: ['http://192.168.1.22:8444'],
      trusted: true,
    });
    expect(flagged.reason).not.toBe('skip_non_local');
    expect(flagged.agent_id).toBe(tokenOnly.agent_id);
  });

  it('does not auto-recreate a deleted agent whose node is suppressed (gateway still alive)', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const agents = await import('../../../../src/main/features/agents');
    // 首次投影创建 agent，然后用户删除 → 节点被抑制（模拟 agents.delete 联动）。
    const first = await mod.projectP3394NodeToTeam({
      nodeId: 'codex', alias: 'Codex', endpoints: ['http://127.0.0.1:9301'],
    });
    expect(first.projected).toBe(true);
    expect(await agents.deleteCustomAgent(first.agent_id!)).toBe(true);
    mod.suppressNodeProjection('codex');

    // 孤儿网关仍在线 hello → 不得自动重建同名 agent。
    const again = await mod.projectP3394NodeToTeam({
      nodeId: 'codex', alias: 'Codex', endpoints: ['http://127.0.0.1:9301'],
    });
    expect(again.projected).toBe(false);
    expect(again.reason).toBe('suppressed');
    expect((await agents.listAgents()).filter((agent) => agent.runtime?.kind === 'p3394-gateway')).toHaveLength(0);

    // 用户显式重新外接 → 解除抑制 → 允许再次投影（复用新建记录）。
    mod.unsuppressNodeProjection('codex');
    const reopened = await mod.projectP3394NodeToTeam({
      nodeId: 'codex', alias: 'Codex', endpoints: ['http://127.0.0.1:9301'],
    });
    expect(reopened.projected).toBe(true);
    expect(reopened.agent_id).not.toBe(first.agent_id);
  });

  it('projects an unknown self-built gateway node with a generic description', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(testUid);
    const mod = await import('../../../../src/main/features/p3394_bridge/team-projection');
    const result = await mod.projectP3394NodeToTeam({ nodeId: 'my-custom-agent', alias: '我的自研智能体', endpoints: ['http://127.0.0.1:9200'] });
    expect(result.projected).toBe(true);
    const agents = await import('../../../../src/main/features/agents');
    const created = (await agents.listAgents()).find((a) => a.agent_id === result.agent_id);
    expect(created?.name).toBe('我的自研智能体');
    expect(created?.runtime).toEqual({ kind: 'p3394-gateway', cli: 'my-custom-agent' });
  });
});
