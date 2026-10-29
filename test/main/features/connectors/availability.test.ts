import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_UID = 'u-google-connector-switches';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-google-connectors-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  vi.doUnmock('../../../../src/main/features/connectors/manager');
  vi.doUnmock('../../../../src/main/features/component_enabled');
  vi.doUnmock('../../../../src/main/features/agents');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeRemoteConfig(value: unknown): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  const paths = await import('../../../../src/main/paths');
  const storage = await import('../../../../src/main/storage');
  users.activateUser(TEST_UID);
  storage.writeJsonSync(paths.userRemoteConfigFile(TEST_UID), {
    version: 1,
    active: {
      immediate: { google_connectors: value },
      restart: {},
    },
  });
}

function ids(entries: Array<{ id: string }>): string[] {
  return entries.map((entry) => entry.id).sort();
}

function connectedInstance(id: string) {
  return {
    id,
    display_name: id,
    status: { kind: 'connected' as const, since: 1 },
    enabled_subtools: null,
    tools_cache: [{ name: `${id}_tool`, description: '', input_schema: {} }],
  };
}

describe('Google connector remote switches', () => {
  const releasedGoogleIds = ['google-workspace', 'gmail', 'gcal', 'gdocs', 'gsheets', 'gtasks', 'gsearch-console'];

  it('hides Google connectors by default', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG);
    const outIds = ids(out);

    expect(outIds).not.toEqual(expect.arrayContaining(releasedGoogleIds));
    expect(outIds).toContain('github');
    expect(availability.connectorAvailabilityForId('test-runtime-user', 'gmail')).toBe('hidden');
    expect(availability.connectorAvailabilityForId('test-runtime-user', 'gsearch-console')).toBe('hidden');
    expect(availability.connectorAvailabilityForId('test-runtime-user', 'github')).toBe('enabled');
  });

  it('lets the direct remote switch re-enable every Google connector', async () => {
    await writeRemoteConfig(true);
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG);
    const outIds = ids(out);

    expect(outIds).toEqual(expect.arrayContaining(releasedGoogleIds));
    expect(availability.connectorAvailabilityForId('test-runtime-user', 'gmail')).toBe('enabled');
    expect(() => availability.assertConnectorRuntimeEnabled('test-runtime-user', 'gmail')).not.toThrow();
  });

  it('hides every Google connector when the overall switch is disabled', async () => {
    await writeRemoteConfig({ google: 'disabled', gmail: 'enabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG);
    const outIds = ids(out);

    expect(outIds).not.toEqual(expect.arrayContaining(releasedGoogleIds));
    expect(outIds).toContain('github');
    expect(() => availability.assertConnectorRuntimeEnabled('test-runtime-user', 'gmail')).toThrow(/connector_unsupported/);
  });

  it('hides every Google connector when the overall switch is visible_disabled', async () => {
    await writeRemoteConfig({ google: 'visible_disabled', gmail: 'enabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG);

    expect(ids(out)).not.toEqual(expect.arrayContaining(releasedGoogleIds));
    expect(availability.connectorAvailabilityForId('test-runtime-user', 'gmail')).toBe('hidden');
  });

  it('lets the Gmail switch hide Gmail and Google Workspace while other Google services remain enabled', async () => {
    await writeRemoteConfig({ google: 'enabled', gmail: 'disabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG);
    const outIds = ids(out);

    expect(outIds).not.toContain('gmail');
    expect(outIds).not.toContain('google-workspace');
    expect(outIds).toEqual(expect.arrayContaining(['gcal', 'gdocs', 'gsheets', 'gtasks', 'gsearch-console']));
  });

  it('lets the Gmail switch show Gmail and Google Workspace as disabled cards', async () => {
    await writeRemoteConfig({ google: 'enabled', gmail: 'visible_disabled' });
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const availability = await import('../../../../src/main/features/connectors/availability');

    const out = availability.catalogWithAvailability('test-runtime-user', catalog.CONNECTOR_CATALOG);

    expect(out.find((entry) => entry.id === 'gmail')).toMatchObject({ availability: 'visible_disabled' });
    expect(out.find((entry) => entry.id === 'google-workspace')).toMatchObject({ availability: 'visible_disabled' });
    expect(out.find((entry) => entry.id === 'gcal')).not.toHaveProperty('availability');
  });

  it('filters disabled Google connectors from model-visible connector tools', async () => {
    await writeRemoteConfig({ google: 'enabled', gmail: 'disabled' });
    const restoreComposioConnectionsFromServer = vi.fn(async () => 0);
    const refreshStaleToolCaches = vi.fn(async () => 0);
    vi.doMock('../../../../src/main/features/connectors/manager', () => ({
      restoreComposioConnectionsFromServer,
      refreshStaleToolCaches,
      listInstances: vi.fn(() => [
        connectedInstance('google-workspace'),
        connectedInstance('gmail'),
        connectedInstance('gcal'),
        connectedInstance('notion'),
      ]),
    }));
    vi.doMock('../../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
    }));
    vi.doMock('../../../../src/main/features/agents', () => ({
      getAgentForChatDispatch: vi.fn(),
    }));

    const toolsAdapter = await import('../../../../src/main/features/connectors/tools-adapter');

    const visible = await toolsAdapter.resolveVisibleConnectors(TEST_UID, undefined);
    expect(visible.map((item) => item.instance.id).sort()).toEqual(['gcal', 'notion']);
    expect(restoreComposioConnectionsFromServer).not.toHaveBeenCalled();
    expect(refreshStaleToolCaches).not.toHaveBeenCalled();
  });

  it('never exposes auth-session tools to the model, even when the adapter caches them', async () => {
    const restoreComposioConnectionsFromServer = vi.fn(async () => 0);
    const refreshStaleToolCaches = vi.fn(async () => 0);
    // The adapter advertises all ten tools and `tools_cache` is faithful to that. Three of them
    // drive `tmeet auth login` for the connector page; handing them to the model would let it open
    // a browser and start an authorization flow nobody asked for.
    const withAuthTools = {
      ...connectedInstance('tencent-meeting'),
      tools_cache: [
        { name: 'list_recordings', description: '', input_schema: {} },
        { name: 'get_transcript', description: '', input_schema: {} },
        { name: 'start_login', description: '', input_schema: {} },
        { name: 'check_login', description: '', input_schema: {} },
        { name: 'stop_login', description: '', input_schema: {} },
        ...['prepare_meeting_change', 'commit_meeting_change', 'discard_meeting_change'].map((name) => ({ name, description: '', input_schema: {} })),
      ],
    };
    vi.doMock('../../../../src/main/features/connectors/manager', () => ({
      restoreComposioConnectionsFromServer,
      refreshStaleToolCaches,
      listInstances: vi.fn(() => [withAuthTools, connectedInstance('github')]),
    }));
    vi.doMock('../../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
    }));
    vi.doMock('../../../../src/main/features/agents', () => ({
      getAgentForChatDispatch: vi.fn(),
    }));

    // The availability gate probes the real filesystem/PATH; pin it so the instance stays visible
    // regardless of whether the runner has the CLI installed.
    const availability = await import('../../../../src/main/features/connectors/availability');
    availability._setLocalCliProbeForTest(() => true);
    try {
      const toolsAdapter = await import('../../../../src/main/features/connectors/tools-adapter');
      const visible = await toolsAdapter.resolveVisibleConnectors(TEST_UID, undefined);
      const tencent = visible.find((item) => item.instance.id === 'tencent-meeting');

      expect(tencent).toBeTruthy();
      expect(tencent!.tools.map((t) => t.name).sort()).toEqual(['get_transcript', 'list_recordings']);
      // The cache itself keeps them: the connector page and `local-cli-auth.ts` call them by name
      // over their own connection, so removing them from the cache would break authorization.
      expect(withAuthTools.tools_cache.map((t) => t.name)).toContain('start_login');
    } finally {
      availability._setLocalCliProbeForTest(null);
    }
  });
});

// ── 本地 CLI 类连接器：CLI 缺失时的报错路径 ──────────────────────────────
//
// 验收标准原文：「无权限或转写未就绪时明确报错，不编造内容」。腾讯会议连接器走的是
// `tmeet` CLI（`auth_mode: 'local_cli'`），本机没装且没有随包/托管二进制时，
// 卡片必须**仍然可见**并给出原因（而非静默消失），同时因为该组件可自动准备而带上
// `runtime_installable`，让用户能一键装；模型侧则看不到它，避免调用必然失败的工具。
describe('local-CLI connectors: missing-CLI reporting', () => {
  it('reports 腾讯会议 as a visible card with reason cli_missing, not hidden', async () => {
    const availability = await import('../../../../src/main/features/connectors/availability');
    availability._setLocalCliProbeForTest(() => false);
    try {
      expect(availability.connectorAvailabilityForId(TEST_UID, 'tencent-meeting')).toBe('visible_disabled');

      const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
      const shown = availability.catalogWithAvailability(TEST_UID, CONNECTOR_CATALOG);
      const tencent = shown.find((entry) => entry.id === 'tencent-meeting');
      expect(tencent).toBeTruthy();
      expect(tencent!.availability).toBe('visible_disabled');
      expect(tencent!.disabled_reason).toBe('cli_missing');

      // 非 CLI 类连接器不受影响（不能因为一个 CLI 缺失就误伤别的卡片）
      expect(shown.find((entry) => entry.id === 'notion')?.availability).toBeUndefined();
    } finally {
      availability._setLocalCliProbeForTest(null);
    }
  });

  it('keeps 腾讯会议 out of model-visible connector tools when the CLI is missing', async () => {
    vi.doMock('../../../../src/main/features/connectors/manager', () => ({
      restoreComposioConnectionsFromServer: vi.fn(async () => 0),
      refreshStaleToolCaches: vi.fn(async () => 0),
      listInstances: vi.fn(() => [connectedInstance('tencent-meeting'), connectedInstance('notion')]),
    }));
    vi.doMock('../../../../src/main/features/component_enabled', () => ({
      isConnectorEnabled: vi.fn(() => true),
    }));
    vi.doMock('../../../../src/main/features/agents', () => ({
      getAgentForChatDispatch: vi.fn(),
    }));

    const availability = await import('../../../../src/main/features/connectors/availability');
    availability._setLocalCliProbeForTest(() => false);
    try {
      const toolsAdapter = await import('../../../../src/main/features/connectors/tools-adapter');
      const visible = await toolsAdapter.resolveVisibleConnectors(TEST_UID, undefined);
      // CLI 缺失 → 模型看不到它（避免调用必然失败的连接器），但卡片对用户仍然可见并注明原因。
      expect(visible.map((item) => item.instance.id)).toEqual(['notion']);
    } finally {
      availability._setLocalCliProbeForTest(null);
    }
  });

  it('reports 腾讯会议 as enabled once the probe finds the CLI', async () => {
    const availability = await import('../../../../src/main/features/connectors/availability');
    availability._setLocalCliProbeForTest(() => true);
    try {
      expect(availability.connectorAvailabilityForId(TEST_UID, 'tencent-meeting')).toBe('enabled');
      expect(availability.isConnectorRuntimeEnabled(TEST_UID, 'tencent-meeting')).toBe(true);
      expect(() => availability.assertConnectorRuntimeEnabled(TEST_UID, 'tencent-meeting')).not.toThrow();
    } finally {
      availability._setLocalCliProbeForTest(null);
    }
  });
});
