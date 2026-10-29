/**
 * Tests for the connector umbrella architecture: `getConnectorPromptBlock` (system-prompt
 * enumeration) + the two meta-tools (`list_connector_tools` / `call_connector_tool`). Covers
 * the actor-visibility matrix (commander scope vs. optional agent-id filtering,
 * the `enabled_subtools` instance filter), the empty-state contract (zero tools + empty block
 * when nothing visible), the discover-before-invoke contract, and MCP error propagation.
 *
 * `manager` and `agents` are mocked at the module level. The live MCP transport is never
 * spawned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ConnectorInstance, ToolSchema } from '../../../../src/main/features/connectors/types';

// ── Mocks ────────────────────────────────────────────────────────────────

type AgentMock = { agent_id: string; enabled_connectors?: string[] } | null;

const fixtures: {
  instances: ConnectorInstance[];
  agents: Record<string, AgentMock>;
  analyticsEvents: { event: string; payload: Record<string, unknown> }[];
  callTool: (uid: string, id: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
} = {
  instances: [],
  agents: {},
  analyticsEvents: [],
  callTool: async () => 'OK',
};

vi.mock('../../../../src/main/features/connectors/manager', () => ({
  listInstances: (uid: string) => (uid ? fixtures.instances : []),
  restoreComposioConnectionsFromServer: async () => 0,
  refreshStaleToolCaches: async () => 0,
  callTool: (uid: string, id: string, name: string, args: Record<string, unknown>) =>
    fixtures.callTool(uid, id, name, args),
}));

vi.mock('../../../../src/main/features/analytics/connectors', () => ({
  trackConnectorAnalytics: (event: string, payload: Record<string, unknown>) => {
    fixtures.analyticsEvents.push({ event, payload });
  },
}));

vi.mock('../../../../src/main/features/agents', () => ({
  getAgentForChatDispatch: async (_uid: string, agentId: string | null | undefined) =>
    (agentId ? fixtures.agents[agentId] ?? null : null),
}));

// Catalog stub: descriptions land in the rendered block. Test fixture covers Notion + GitHub
// (both used in NOTION_TOOLS / GITHUB_TOOLS); other ids return undefined → block falls back to
// display_name only.
vi.mock('../../../../src/main/features/connectors/catalog', () => ({
  findCatalogEntry: (id: string) => {
    if (id === 'notion') return { id, description_zh: '读写 Notion 页面', description_en: 'Read and write Notion pages.' };
    if (id === 'github') return { id, description_zh: '仓库 / Issue / PR / 代码搜索', description_en: 'Repos, issues, PRs, code search.' };
    return undefined;
  },
}));

vi.mock('../../../../src/main/features/connectors/availability', () => ({
  isConnectorRuntimeEnabled: () => true,
}));

vi.mock('../../../../src/main/i18n', () => ({
  getCurrentLang: () => 'en',
  descriptionLang: (lang: 'zh' | 'en' | 'ja') => (lang === 'zh' ? 'zh' : 'en'),
  SUPPORTED_LANGS: ['zh', 'en', 'ja'] as const,
  t: (key: string) => key,
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<ConnectorInstance> & { id: string; tools?: ToolSchema[] }): ConnectorInstance {
  const tools: ToolSchema[] = overrides.tools ?? [];
  return {
    id: overrides.id,
    display_name: overrides.display_name ?? overrides.id,
    transport: { kind: 'streamable-http', url: 'https://example.invalid/mcp' },
    enabled_subtools: overrides.enabled_subtools ?? null,
    tools_cache: tools,
    tools_cached_at: 0,
    status: overrides.status ?? { kind: 'connected', since: 0 },
    created_at: '2026-05-14T00:00:00.000Z',
    updated_at: '2026-05-14T00:00:00.000Z',
    ...(overrides.icon ? { icon: overrides.icon } : {}),
    ...(overrides.oauth_grant ? { oauth_grant: overrides.oauth_grant } : {}),
    ...(overrides.dcr_client ? { dcr_client: overrides.dcr_client } : {}),
  };
}

const NOTION_TOOLS: ToolSchema[] = [
  {
    name: 'search',
    description: 'Search Notion pages by query.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'create_page',
    description: 'Create a new page.',
    input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
];

const GITHUB_TOOLS: ToolSchema[] = [
  {
    name: 'list_repos',
    description: 'List the authenticated user\'s repos.',
    input_schema: { type: 'object', properties: {} },
  },
];

const GOOGLE_WORKSPACE_TOOLS: ToolSchema[] = [
  { name: 'send_message', description: '[Gmail] Send Gmail.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_events', description: '[Calendar] List calendar events.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_document', description: '[Docs] Read Google Docs.', input_schema: { type: 'object', properties: {} } },
  { name: 'read_sheet', description: '[Sheets] Read Google Sheets.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_tasks', description: '[Tasks] List Google Tasks.', input_schema: { type: 'object', properties: {} } },
];

const UID = 'u-meta-001';

beforeEach(() => {
  fixtures.instances = [];
  fixtures.agents = {};
  fixtures.analyticsEvents = [];
  fixtures.callTool = async () => 'OK';
  vi.resetModules();
});

async function loadModule() {
  return import('../../../../src/main/model/core-agent/connector-meta-tools');
}

async function runTool(tool: { execute: (input: any, ctx: any) => Promise<any> }, input: Record<string, unknown> = {}) {
  return tool.execute(input, { workingDir: '.', signal: undefined } as any);
}

// ── connectorExposureFromSessionId (the runner.ts session-kind gate) ────
//
// session_id is now `<kind>-<tail>` (CLAUDE.md §5 — uid no longer in session_id, since the
// path root `<activeUid>/{cloud,local}/sessions/<sid>.jsonl` already scopes by user). The
// gate just looks at the kind keyword anchored at the start.

describe('connectorExposureFromSessionId', () => {
  it('matches gconv (commander) → tools+block', async () => {
    const { connectorExposureFromSessionId } = await import('../../../../src/main/model/core-agent/runner');
    expect(connectorExposureFromSessionId('gconv-ac5559863d42')).toBe('tools+block');
  });

  it('matches gmember (agent worker) including dashed aid in the tail → tools+block', async () => {
    const { connectorExposureFromSessionId } = await import('../../../../src/main/model/core-agent/runner');
    expect(connectorExposureFromSessionId('gmember-cv1-agt-42')).toBe('tools+block');
  });

  it('matches agent-edit → discover+block (block + list_connector_tools, NO call_connector_tool)', async () => {
    const { connectorExposureFromSessionId } = await import('../../../../src/main/model/core-agent/runner');
    expect(connectorExposureFromSessionId('agent-agt-7')).toBe('discover+block');
  });

  it('returns none for non-task session kinds (skill / extract-img / cli / reflect / memory-extract / anon)', async () => {
    const { connectorExposureFromSessionId } = await import('../../../../src/main/model/core-agent/runner');
    expect(connectorExposureFromSessionId('skill-sk1')).toBe('none');
    expect(connectorExposureFromSessionId('extract-img-deadbeef')).toBe('none');
    expect(connectorExposureFromSessionId('cli-claude-run-1')).toBe('none');
    expect(connectorExposureFromSessionId('reflect-x')).toBe('none');
    expect(connectorExposureFromSessionId('memory-extract-x')).toBe('none');
    expect(connectorExposureFromSessionId('anon')).toBe('none');
    expect(connectorExposureFromSessionId('anon-deadbeef')).toBe('none');
  });

  it('returns none when fed a legacy uid-prefixed session_id (regression: pre-migration leftovers must not silently match)', async () => {
    // Legacy `<uid>-<kind>-<tail>` files should be renamed by `migrateLegacySessionIds` before
    // the runner ever sees them. If one slips through, the gate returning 'none' is safer than
    // a partial substring match that would expose the wrong tools.
    const { connectorExposureFromSessionId } = await import('../../../../src/main/model/core-agent/runner');
    expect(connectorExposureFromSessionId('D69594E0-CF31-424C-9318-30231197E3A9-gconv-cv1')).toBe('none');
    expect(connectorExposureFromSessionId('99999999-agent-agt-1')).toBe('none');
  });
});

describe('systemSkillsExposureFromSessionId', () => {
  it('exposes system skills to authoring sessions only', async () => {
    const { systemSkillsExposureFromSessionId } = await import('../../../../src/main/model/core-agent/runner');
    expect(systemSkillsExposureFromSessionId('gconv-ac5559863d42')).toBe(true);
    expect(systemSkillsExposureFromSessionId('agent-agt-7')).toBe(true);
    expect(systemSkillsExposureFromSessionId('skill-sk1')).toBe(true);
    expect(systemSkillsExposureFromSessionId('gmember-cv1-agt-42')).toBe(false);
    expect(systemSkillsExposureFromSessionId('extract-img-deadbeef')).toBe(false);
    expect(systemSkillsExposureFromSessionId('cli-claude-run-1')).toBe(false);
    expect(systemSkillsExposureFromSessionId('reflect-x')).toBe(false);
    expect(systemSkillsExposureFromSessionId('memory-extract-x')).toBe(false);
    expect(systemSkillsExposureFromSessionId('anon')).toBe(false);
  });
});

describe('openSkillSourcesExposureFromSessionId', () => {
  it('exposes open-tier skills to group-chat task sessions and agent-edit only', async () => {
    const { openSkillSourcesExposureFromSessionId } = await import('../../../../src/main/model/core-agent/runner');
    expect(openSkillSourcesExposureFromSessionId('gconv-ac5559863d42')).toBe(true);
    expect(openSkillSourcesExposureFromSessionId('gmember-cv1-agt-42')).toBe(true);
    expect(openSkillSourcesExposureFromSessionId('agent-agt-7')).toBe(true);
    expect(openSkillSourcesExposureFromSessionId('skill-sk1')).toBe(false);
    expect(openSkillSourcesExposureFromSessionId('extract-img-deadbeef')).toBe(false);
    expect(openSkillSourcesExposureFromSessionId('cli-claude-run-1')).toBe(false);
    expect(openSkillSourcesExposureFromSessionId('reflect-x')).toBe(false);
    expect(openSkillSourcesExposureFromSessionId('memory-extract-x')).toBe(false);
    expect(openSkillSourcesExposureFromSessionId('anon')).toBe(false);
  });
});

// ── createConnectorMetaTools shape (mode-gated tri-state) ───────────────

describe('createConnectorMetaTools', () => {
  it('full mode: returns both meta-tools when at least one connector is visible', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { createConnectorMetaTools } = await loadModule();
    const tools = await createConnectorMetaTools({ userId: UID }, 'full');
    expect(tools.map((t) => t.name)).toEqual([
      'list_connector_tools',
      'call_connector_tool',
    ]);
  });

  it('discover mode: returns only list_connector_tools (no call) — agent-edit shape', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { createConnectorMetaTools } = await loadModule();
    const tools = await createConnectorMetaTools({ userId: UID }, 'discover');
    expect(tools.map((t) => t.name)).toEqual(['list_connector_tools']);
  });

  it('full is the default when mode is omitted', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { createConnectorMetaTools } = await loadModule();
    const tools = await createConnectorMetaTools({ userId: UID });
    expect(tools.length).toBe(2);
  });

  it('returns [] when no connector is visible (commander, no instances installed)', async () => {
    fixtures.instances = [];
    const { createConnectorMetaTools } = await loadModule();
    expect(await createConnectorMetaTools({ userId: UID })).toEqual([]);
  });

  it('returns [] when an explicit actor filter has empty enabled_connectors', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    fixtures.agents = { 'a1': { agent_id: 'a1', enabled_connectors: [] } };
    const { createConnectorMetaTools } = await loadModule();
    expect(await createConnectorMetaTools({ userId: UID, agentId: 'a1' })).toEqual([]);
  });

  it('returns [] when uid empty (no scope)', async () => {
    const { createConnectorMetaTools } = await loadModule();
    expect(await createConnectorMetaTools({ userId: '' })).toEqual([]);
  });
});

// ── getConnectorPromptBlock ─────────────────────────────────────────────

describe('getConnectorPromptBlock', () => {
  it('renders one line per connector with id + display_name + catalog description (en)', async () => {
    fixtures.instances = [
      makeInstance({ id: 'notion', display_name: 'Notion', tools: NOTION_TOOLS }),
      makeInstance({ id: 'github', display_name: 'GitHub', tools: GITHUB_TOOLS }),
    ];
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, undefined);
    expect(block).toContain('## Connectors');
    expect(block).toContain('**notion** — Notion: Read and write Notion pages.');
    expect(block).toContain('**github** — GitHub: Repos, issues, PRs, code search.');
  });

  it('does NOT include the protocol-teaching header paragraph (per-role chat prompts teach that)', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, undefined);
    expect(block).not.toContain('list_connector_tools');
    expect(block).not.toContain('call_connector_tool');
    expect(block).not.toMatch(/don't guess|list first/i);
  });

  it('does NOT include action counts (filler — model finds out via list_connector_tools)', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, undefined);
    expect(block).not.toMatch(/\d+ actions?/);
  });

  it('appends "(account: ...)" only when the OAuth grant carries an account_label', async () => {
    fixtures.instances = [
      makeInstance({
        id: 'notion',
        tools: NOTION_TOOLS,
        oauth_grant: {
          access_token: 't',
          refresh_token: null,
          expires_at: null,
          scopes: [],
          token_type: 'Bearer',
          account_label: 'foo@bar.com',
        },
      }),
      makeInstance({ id: 'github', tools: GITHUB_TOOLS }), // no oauth_grant
    ];
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, undefined);
    expect(block).toContain('(account: foo@bar.com)');
    // github line should not have a parenthetical account
    const githubLine = block.split('\n').find((l) => l.includes('**github**')) ?? '';
    expect(githubLine).not.toContain('account:');
  });

  it('never emits a status suffix — the block only contains connected instances by design', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, undefined);
    expect(block).not.toMatch(/—\s*(connected|disconnected|connecting|error)/i);
    expect(block).not.toMatch(/ask user to refresh/i);
  });

  it('non-connected instances are filtered out entirely (not just status-suffixed)', async () => {
    fixtures.instances = [
      makeInstance({ id: 'notion',  tools: NOTION_TOOLS,  status: { kind: 'disconnected' } }),
      makeInstance({ id: 'github',  tools: GITHUB_TOOLS,  status: { kind: 'error', message: 'boom', at: 0 } }),
      makeInstance({ id: 'gmail',   tools: [],            status: { kind: 'connecting' } }),
      makeInstance({ id: 'slack',   tools: [],            status: { kind: 'connected', since: 0 } }),
    ];
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, undefined);
    expect(block).toContain('**slack**');
    expect(block).not.toContain('**notion**');
    expect(block).not.toContain('**github**');
    expect(block).not.toContain('**gmail**');
  });

  it('falls back to display_name only when the catalog has no description (defensive)', async () => {
    // 'unknown_id' isn't in our findCatalogEntry mock → returns undefined
    fixtures.instances = [makeInstance({ id: 'unknown_id', display_name: 'Mystery Service', tools: [] })];
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, undefined);
    expect(block).toContain('**unknown_id** — Mystery Service');
    expect(block).not.toContain(': '); // no description colon when fallback
  });

  it('respects the optional actor enabled_connectors filter (only allowed connectors appear)', async () => {
    fixtures.instances = [
      makeInstance({ id: 'notion', tools: NOTION_TOOLS }),
      makeInstance({ id: 'github', tools: GITHUB_TOOLS }),
    ];
    fixtures.agents = { 'a1': { agent_id: 'a1', enabled_connectors: ['notion'] } };
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, 'a1');
    expect(block).toContain('**notion**');
    expect(block).not.toContain('**github**');
  });

  it('returns "" when no connector is visible (commander, none installed)', async () => {
    fixtures.instances = [];
    const { getConnectorPromptBlock } = await loadModule();
    expect(await getConnectorPromptBlock(UID, undefined)).toBe('');
  });

  it('returns "" when an explicit actor filter has undefined enabled_connectors', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    fixtures.agents = { 'a1': { agent_id: 'a1' } };
    const { getConnectorPromptBlock } = await loadModule();
    expect(await getConnectorPromptBlock(UID, 'a1')).toBe('');
  });

  it('returns "" when uid is empty', async () => {
    const { getConnectorPromptBlock } = await loadModule();
    expect(await getConnectorPromptBlock('', undefined)).toBe('');
  });
});

// ── list_connector_tools ────────────────────────────────────────────────

describe('list_connector_tools', () => {
  it('connected instance returns full tool schemas', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { createConnectorMetaTools } = await loadModule();
    const [listTools] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(listTools, { connector_id: 'notion' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('### search');
    expect(r.content).toContain('### create_page');
    expect(r.content).toContain('"query"');
    expect(r.content).toContain('"title"');
  });

  it('enabled_subtools whitelist filters the visible action list', async () => {
    fixtures.instances = [
      makeInstance({ id: 'notion', tools: NOTION_TOOLS, enabled_subtools: ['search'] }),
    ];
    const { createConnectorMetaTools } = await loadModule();
    const [listTools] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(listTools, { connector_id: 'notion' });
    expect(r.content).toContain('### search');
    expect(r.content).not.toContain('### create_page');
  });

  it('unknown connector_id → E_CONNECTOR_NOT_VISIBLE', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { createConnectorMetaTools } = await loadModule();
    const [listTools] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(listTools, { connector_id: 'slack' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_CONNECTOR_NOT_VISIBLE');
  });

  it('disconnected connector → invisible at the meta-tool, surfaces as E_CONNECTOR_NOT_VISIBLE', async () => {
    // Under the live-state filter (`resolveVisibleConnectors` keeps only connected instances),
    // a disconnected instance never reaches the per-call branch — the model sees the same
    // error code as for an unknown id, and `## Connectors` doesn't list it either.
    fixtures.instances = [
      makeInstance({ id: 'github', tools: GITHUB_TOOLS }),
      makeInstance({ id: 'notion', tools: NOTION_TOOLS, status: { kind: 'disconnected' } }),
    ];
    const { createConnectorMetaTools } = await loadModule();
    const [listTools] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(listTools, { connector_id: 'notion' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_CONNECTOR_NOT_VISIBLE');
  });

  it('missing connector_id → E_BAD_INPUT', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { createConnectorMetaTools } = await loadModule();
    const [listTools] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(listTools, {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_BAD_INPUT');
  });

  it('respects the optional actor filter at execution time (not just at build time)', async () => {
    fixtures.instances = [
      makeInstance({ id: 'notion', tools: NOTION_TOOLS }),
      makeInstance({ id: 'github', tools: GITHUB_TOOLS }),
    ];
    fixtures.agents = { 'a1': { agent_id: 'a1', enabled_connectors: ['notion'] } };
    const { createConnectorMetaTools } = await loadModule();
    const [listTools] = await createConnectorMetaTools({ userId: UID, agentId: 'a1' });
    const r = await runTool(listTools, { connector_id: 'github' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_CONNECTOR_NOT_VISIBLE');
  });

  it('dedupes Google Workspace tools when the matching single-service connector is also visible', async () => {
    fixtures.instances = [
      makeInstance({ id: 'google-workspace', display_name: 'Google Workspace', tools: GOOGLE_WORKSPACE_TOOLS }),
      makeInstance({
        id: 'gmail',
        display_name: 'Gmail',
        tools: [
          { name: 'send_message', description: 'Send Gmail.', input_schema: { type: 'object', properties: {} } },
        ],
      }),
    ];
    const { createConnectorMetaTools } = await loadModule();
    const [listTools] = await createConnectorMetaTools({ userId: UID });

    const workspace = await runTool(listTools, { connector_id: 'google-workspace' });
    expect(workspace.isError).toBeFalsy();
    expect(workspace.content).not.toContain('### send_message');
    expect(workspace.content).toContain('### list_events');

    const gmail = await runTool(listTools, { connector_id: 'gmail' });
    expect(gmail.isError).toBeFalsy();
    expect(gmail.content).toContain('### send_message');
  });

  it('keeps Google Workspace Gmail tools when Gmail is not visible separately', async () => {
    fixtures.instances = [
      makeInstance({ id: 'google-workspace', display_name: 'Google Workspace', tools: GOOGLE_WORKSPACE_TOOLS }),
    ];
    const { createConnectorMetaTools } = await loadModule();
    const [listTools] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(listTools, { connector_id: 'google-workspace' });

    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('### send_message');
    expect(r.content).toContain('### list_events');
  });

  it('hides Google Workspace entirely when all of its service tools are shadowed by single-service connectors', async () => {
    fixtures.instances = [
      makeInstance({ id: 'google-workspace', display_name: 'Google Workspace', tools: GOOGLE_WORKSPACE_TOOLS }),
      makeInstance({ id: 'gmail', tools: [{ name: 'send_message', description: '', input_schema: {} }] }),
      makeInstance({ id: 'gcal', tools: [{ name: 'list_events', description: '', input_schema: {} }] }),
      makeInstance({ id: 'gdocs', tools: [{ name: 'get_document', description: '', input_schema: {} }] }),
      makeInstance({ id: 'gsheets', tools: [{ name: 'read_sheet', description: '', input_schema: {} }] }),
      makeInstance({ id: 'gtasks', tools: [{ name: 'list_tasks', description: '', input_schema: {} }] }),
    ];
    const { getConnectorPromptBlock, createConnectorMetaTools } = await loadModule();

    const block = await getConnectorPromptBlock(UID, undefined);
    expect(block).not.toContain('**google-workspace**');
    expect(block).toContain('**gmail**');

    const [listTools] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(listTools, { connector_id: 'google-workspace' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_CONNECTOR_NOT_VISIBLE');
  });
});

// ── call_connector_tool ─────────────────────────────────────────────────

describe('call_connector_tool', () => {
  it('routes a valid call to manager.callTool with verbatim args + stringifies the result', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    let received: { uid?: string; id?: string; name?: string; args?: Record<string, unknown> } = {};
    fixtures.callTool = async (uid, id, name, args) => {
      received = { uid, id, name, args };
      return { content: [{ type: 'text', text: 'page hits: 3' }] };
    };
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, {
      connector_id: 'notion',
      tool_name: 'search',
      args: { query: 'plan' },
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe('page hits: 3');
    expect(received).toEqual({ uid: UID, id: 'notion', name: 'search', args: { query: 'plan' } });
  });

  it('spills a meeting transcript to the workspace and returns transcript_path', async () => {
    fixtures.instances = [makeInstance({ id: 'tencent-meeting', tools: [{ name: 'get_transcript', description: 'transcript', input_schema: { type: 'object', properties: {} } }] })];
    fixtures.callTool = async () => ({
      record_file_id: 'rec-1',
      text: 'hello transcript '.repeat(80),
      paragraphs: [{ pid: 0, text: 'hello transcript' }],
      more: false,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-spill-'));
    try {
      const { createConnectorMetaTools } = await loadModule();
      const [, call] = await createConnectorMetaTools({ userId: UID });
      const r = await call.execute({ connector_id: 'tencent-meeting', tool_name: 'get_transcript', args: {} }, { workingDir: dir, signal: undefined } as never);
      expect(r.isError).toBeFalsy();
      const payload = JSON.parse(String(r.content));
      expect(payload.transcript_path).toBe(path.join(dir, 'transcript_rec-1.txt'));
      expect(fs.readFileSync(payload.transcript_path, 'utf8')).toContain('hello transcript');
      expect(payload.paragraphs).toBeUndefined();
      expect(String(payload.preview).length).toBeLessThanOrEqual(1_201);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('connector not in actor scope → E_CONNECTOR_NOT_VISIBLE (does not invoke manager.callTool)', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    let calledManager = false;
    fixtures.callTool = async () => { calledManager = true; return ''; };
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { connector_id: 'slack', tool_name: 'whatever', args: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_CONNECTOR_NOT_VISIBLE');
    expect(calledManager).toBe(false);
  });

  it('tool_name not in tools_cache → E_TOOL_NOT_AVAILABLE (does not invoke manager.callTool)', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    let calledManager = false;
    fixtures.callTool = async () => { calledManager = true; return ''; };
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { connector_id: 'notion', tool_name: 'delete_universe', args: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_TOOL_NOT_AVAILABLE');
    expect(calledManager).toBe(false);
  });

  it('tool_name muted by enabled_subtools → E_TOOL_NOT_AVAILABLE', async () => {
    fixtures.instances = [
      makeInstance({ id: 'notion', tools: NOTION_TOOLS, enabled_subtools: ['search'] }),
    ];
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { connector_id: 'notion', tool_name: 'create_page', args: { title: 'x' } });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_TOOL_NOT_AVAILABLE');
  });

  it('MCP error from manager.callTool propagates with isError=true (not silently swallowed)', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    fixtures.callTool = async () => { throw new Error('upstream rate limited'); };
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { connector_id: 'notion', tool_name: 'search', args: { query: 'x' } });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('upstream rate limited');
  });

  it('missing args object → E_BAD_INPUT', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { connector_id: 'notion', tool_name: 'search' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_BAD_INPUT');
  });

  it('missing connector_id → E_BAD_INPUT', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { tool_name: 'search', args: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_BAD_INPUT');
  });
});

// ── stringifyMcpResult (transitively, via call_connector_tool) ──────────

describe('stringifyMcpResult (via call_connector_tool)', () => {
  it('flattens MCP `content: [{type:"text", text}]` arrays', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    fixtures.callTool = async () => ({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { connector_id: 'notion', tool_name: 'search', args: { query: 'x' } });
    expect(r.content).toBe('first\nsecond');
  });

  it('returns plain strings verbatim', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    fixtures.callTool = async () => 'just a string';
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { connector_id: 'notion', tool_name: 'search', args: { query: 'x' } });
    expect(r.content).toBe('just a string');
  });

  it('JSON-serialises non-text MCP shapes (image / structured data)', async () => {
    fixtures.instances = [makeInstance({ id: 'notion', tools: NOTION_TOOLS })];
    fixtures.callTool = async () => ({ content: [{ type: 'image', data: 'b64...' }] });
    const { createConnectorMetaTools } = await loadModule();
    const [, call] = await createConnectorMetaTools({ userId: UID });
    const r = await runTool(call, { connector_id: 'notion', tool_name: 'search', args: { query: 'x' } });
    expect(r.content).toContain('"type":"image"');
  });
});

// ── instanceIds：per-agent 连接器白名单（"配置两个 MCP 的访问权限"）────────
//
// 背景：`agentId` 存在时适配器把 `undefined` 和 `[]` 都当"零连接器"，于是任务会话
// 无法表达"继承 commander"。runner 解析 `agent.enabled_connectors` 后经 `instanceIds`
// 传入，这里锁住三态语义。

describe('instanceIds — per-agent connector allowlist', () => {
  const NOTION = () => makeInstance({ id: 'notion', tools: NOTION_TOOLS });
  const GITHUB = () => makeInstance({ id: 'github', tools: GITHUB_TOOLS });

  it('undefined = 不收窄（继承 commander，存量行为不变）', async () => {
    fixtures.instances = [NOTION(), GITHUB()];
    const { createConnectorMetaTools } = await loadModule();
    const tools = await createConnectorMetaTools({ userId: UID, instanceIds: undefined });
    const list = tools.find((t) => t.name === 'list_connector_tools')!;
    // 两个连接器都能被发现
    expect((await runTool(list, { connector_id: 'notion' })).isError).toBeFalsy();
    expect((await runTool(list, { connector_id: 'github' })).isError).toBeFalsy();
  });

  it('非空数组 = 收窄到白名单内的实例', async () => {
    fixtures.instances = [NOTION(), GITHUB()];
    const { createConnectorMetaTools } = await loadModule();
    const tools = await createConnectorMetaTools({ userId: UID, instanceIds: ['notion'] });
    const list = tools.find((t) => t.name === 'list_connector_tools')!;
    expect((await runTool(list, { connector_id: 'notion' })).isError).toBeFalsy();
    const denied = await runTool(list, { connector_id: 'github' });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('E_CONNECTOR_NOT_VISIBLE');
  });

  it('[] = 零连接器（显式禁止，不得退化成继承）', async () => {
    fixtures.instances = [NOTION(), GITHUB()];
    const { createConnectorMetaTools } = await loadModule();
    const tools = await createConnectorMetaTools({ userId: UID, instanceIds: [] });
    // 连 add_custom_connector 之外的 meta-tool 都不该产出
    expect(tools.find((t) => t.name === 'list_connector_tools')).toBeUndefined();
    expect(tools.find((t) => t.name === 'call_connector_tool')).toBeUndefined();
  });

  it('白名单里的 id 不存在时，等于零可见（不报错、不泄漏其它实例）', async () => {
    fixtures.instances = [NOTION(), GITHUB()];
    const { createConnectorMetaTools } = await loadModule();
    const tools = await createConnectorMetaTools({ userId: UID, instanceIds: ['meshseed'] });
    expect(tools.find((t) => t.name === 'list_connector_tools')).toBeUndefined();
  });

  it('call_connector_tool 同样受白名单约束（不能绕过 list 直接调用）', async () => {
    fixtures.instances = [NOTION(), GITHUB()];
    let called = false;
    fixtures.callTool = async () => { called = true; return 'OK'; };
    const { createConnectorMetaTools } = await loadModule();
    const tools = await createConnectorMetaTools({ userId: UID, instanceIds: ['notion'] });
    const call = tools.find((t) => t.name === 'call_connector_tool')!;
    const r = await runTool(call, { connector_id: 'github', tool_name: 'list_issues', args: {} });
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });

  it('system prompt 的 ## Connectors 块同样按白名单渲染', async () => {
    fixtures.instances = [NOTION(), GITHUB()];
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, undefined, ['github']);
    expect(block).toContain('**github**');
    expect(block).not.toContain('**notion**');
  });

  it('instanceIds 优先于 agentId（runner 已解析完白名单，适配器不再二次查表）', async () => {
    // agentId 指向一个白名单为空的 agent；若 instanceIds 生效，则应看到 notion
    fixtures.instances = [NOTION(), GITHUB()];
    fixtures.agents = { a1: { agent_id: 'a1', enabled_connectors: [] } };
    const { getConnectorPromptBlock } = await loadModule();
    const block = await getConnectorPromptBlock(UID, 'a1', ['notion']);
    expect(block).toContain('**notion**');
  });
});
