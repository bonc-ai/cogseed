import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTool } from '#core-agent';
import type { BuildRunnerParams } from '../../../../src/main/model/core-agent/runner';

vi.mock('electron', () => ({
  app: { isPackaged: false }, BrowserWindow: vi.fn(), dialog: {}, shell: {},
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const uid = 'runner-tool-policy';
let root: string;
let previousWorkspace: string | undefined;
let buildRunner: typeof import('../../../../src/main/model/core-agent/runner').buildRunner;
let agentId: string;
let baseline: Awaited<ReturnType<typeof buildRunner>>;
let sessionIndex = 0;
const network = vi.fn(() => { throw new Error('Tool assembly must not make network requests'); });

// Inspect the real SDK constructor's map, including tools it adds after the
// host's snapshot. Never run inference or execute shell/file tools here.
function toolNames(built: Awaited<ReturnType<typeof buildRunner>>): string[] {
  return [...(built.runner as unknown as { tools: ReadonlyMap<string, AgentTool> }).tools.keys()].sort();
}
function extraTool(name: string): AgentTool {
  return { name, description: 'Caller tool policy fixture', inputSchema: { type: 'object', properties: {} }, execute: async () => ({ content: 'unused' }) };
}
function build(options: Partial<BuildRunnerParams> = {}) {
  return buildRunner({
    userId: uid, agentId, sessionId: `gworker-tool-policy-${++sessionIndex}`,
    skillList: [], ephemeralSession: true, ...options,
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runner-policy-'));
  previousWorkspace = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.stubGlobal('fetch', network);
  const auth = await import('../../../../src/main/features/auth');
  vi.spyOn(auth, 'pickChatEntryGroupForUser').mockResolvedValue([
    { entryId: 'policy-entry', profileId: 'policy-profile', provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-key' },
  ]);
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
  const agents = await import('../../../../src/main/features/agents');
  const agent = await agents.createCustomAgentForUser(uid, {
    name: 'Tool_policy_fixture', description_en: 'Inspect tool policy assembly.',
    description_zh: '检查工具策略装配。', workflow: 'Inspect the supplied workspace and report the findings.', skill_list: [],
  });
  if (!agent) throw new Error('Agent fixture was not created');
  agentId = agent.agent_id;
  ({ buildRunner } = await import('../../../../src/main/model/core-agent/runner'));
  baseline = await build();
});

afterAll(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousWorkspace === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspace;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('buildRunner final constructor tool policy', () => {
  it('keeps changing runtime task context out of system while forwarding the latest context', async () => {
    const first = await build({ systemPrompt: 'Stable rules.\n\n## Runtime injection\nRuntime task A' });
    const next = await build({ systemPrompt: 'Stable rules.\n\n## Runtime injection\nRuntime task B with changed requirements' });
    expect(first.resolvedSystemPrompt).toBe(next.resolvedSystemPrompt);
    expect(first.resolvedSystemPrompt).not.toContain('Runtime task');
    expect(first.turnEphemeral).toContain('Runtime task A');
    expect(next.turnEphemeral).toContain('Runtime task B with changed requirements');
    expect(next.turnEphemeral).not.toContain('Runtime task A');
    expect(next.toolDefs).toEqual(first.toolDefs);
  });

  it('denies execution planning while retaining normal reads, shell and evolution tools', async () => {
    const names = toolNames(baseline);
    expect(names).toEqual(expect.arrayContaining(['manage_execution_plan', 'read_file', 'bash', 'skill_manage']));
    const denied = await build({ toolDenylist: ['manage_execution_plan'], extraTools: [extraTool('manage_execution_plan')] });
    expect(toolNames(denied)).toEqual(names.filter(name => name !== 'manage_execution_plan'));
    expect(denied.toolDefs.map(tool => tool.name)).not.toContain('manage_execution_plan');
  });

  it.each(['web_fetch', 'write_file'])('does not re-add denied builtin %s, including its host override', async name => {
    expect(toolNames(baseline)).toContain(name);
    const denied = await build({ toolDenylist: [name], extraTools: [extraTool(name)] });
    expect(toolNames(denied)).toEqual(toolNames(baseline).filter(tool => tool !== name));
    expect(denied.toolDefs.map(tool => tool.name)).not.toContain(name);
  });

  it('denies late-added skill_manage without losing execution planning or ordinary tools', async () => {
    const denied = await build({ toolDenylist: ['skill_manage'] });
    expect(toolNames(denied)).toEqual(toolNames(baseline).filter(name => name !== 'skill_manage'));
  });

  it.each([{ toolDenylist: [] }, { toolDenylist: ['nonexistent_tool'] }])('preserves the assembled map for an empty or irrelevant denial $toolDenylist', async ({ toolDenylist }) => {
    const unchanged = await build({ toolDenylist });
    expect(toolNames(unchanged)).toEqual(toolNames(baseline));
    expect(unchanged.toolDefs.map(tool => tool.name)).toEqual(baseline.toolDefs.map(tool => tool.name));
  });

  it('intersects the caller allowlist even when it names denied constructor tools', async () => {
    const built = await build({
      toolAllowlist: ['read_file', 'write_file', 'manage_execution_plan', 'skill_manage'],
      toolDenylist: ['manage_execution_plan', 'skill_manage'],
    });
    expect(toolNames(built)).toEqual(['read_file', 'write_file']);
  });

  it('cannot widen an empty caller allowlist', async () => {
    expect(toolNames(await build({ toolAllowlist: [], toolDenylist: ['manage_execution_plan'] }))).toEqual([]);
  });

  it('keeps the read-only ceiling at the constructor even with a broader caller allowlist', async () => {
    const built = await build({
      toolAccess: 'read-only',
      toolAllowlist: ['read_file', 'web_fetch', 'bash', 'write_file', 'manage_execution_plan', 'skill_manage'],
      toolDenylist: ['web_fetch'],
    });
    expect(toolNames(built)).toEqual(['read_file']);
  });

  it('keeps read-only tools closed without a caller allowlist', async () => {
    const { READ_ONLY_TOOL_ALLOWLIST } = await import('../../../../src/main/model/core-agent/runner');
    const built = await build({ toolAccess: 'read-only', toolDenylist: ['web_fetch'] });
    expect(toolNames(built)).toContain('read_file');
    expect(toolNames(built).every(name => READ_ONLY_TOOL_ALLOWLIST.has(name) && name !== 'web_fetch')).toBe(true);
  });

  it('intersects the reception ceiling and never exposes private or network extras', async () => {
    const granted = path.join(root, 'reception');
    fs.mkdirSync(granted);
    const built = await build({
      receptionScope: { sourceActorId: 'a2a_policy_peer', conversationId: 'policy-reception', root: granted },
      toolAllowlist: ['read_file', 'bash', 'web_fetch', 'skill_manage', 'manage_execution_plan', 'private_extra'],
      toolDenylist: ['manage_execution_plan'],
      extraTools: [extraTool('private_extra'), extraTool('web_fetch')],
    });
    expect(toolNames(built)).toEqual(['bash', 'read_file']);
  });

  it('cannot restore any tools when disableTools is set', async () => {
    const built = await build({
      disableTools: true, toolAllowlist: ['read_file', 'bash', 'manage_execution_plan', 'skill_manage'],
      toolDenylist: ['manage_execution_plan'], extraTools: [extraTool('read_file')],
    });
    expect(toolNames(built)).toEqual([]);
    expect(built.toolDefs).toEqual([]);
  });

  it('supports denying the entire assembled tool set', async () => {
    const built = await build({ toolDenylist: toolNames(baseline) });
    expect(toolNames(built)).toEqual([]);
    expect(built.toolDefs).toEqual([]);
  });
});
