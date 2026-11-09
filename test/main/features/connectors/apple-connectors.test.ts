import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let temporary: string;
const userId = 'apple-connector-test';

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-connectors-'));
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', temporary);
  vi.stubEnv('COGSEED_REMCTL_BIN', path.join(temporary, 'remctl'));
  vi.stubEnv('COGSEED_APPLE_NPX_BIN', path.join(temporary, 'npx'));
  vi.stubEnv('COGSEED_APPLE_NODE_BIN', path.join(temporary, 'node'));
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/connectors/mcp-client');
  vi.doUnmock('node:os');
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function installExecutables() {
  for (const binary of ['remctl', 'npx', 'node']) {
    fs.writeFileSync(path.join(temporary, binary), '', { mode: 0o755 });
  }
}

describe('optional Apple connectors', () => {
  it('finds GUI-launched npm and a compatible NVM Node in separate directories', async () => {
    vi.stubEnv('COGSEED_APPLE_NPX_BIN', '');
    vi.stubEnv('COGSEED_APPLE_NODE_BIN', '');
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.doMock('node:os', async importOriginal => ({ ...await importOriginal<typeof os>(), homedir: () => temporary }));
    const npxDirectory = path.join(temporary, '.npm-global', 'bin');
    fs.mkdirSync(npxDirectory, { recursive: true });
    fs.writeFileSync(path.join(npxDirectory, 'npx'), '', { mode: 0o755 });
    for (const version of ['v9.11.2', 'v22.2.0', 'v22.14.0']) {
      const directory = path.join(temporary, '.nvm', 'versions', 'node', version, 'bin');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'node'), '', { mode: 0o755 });
    }
    vi.doMock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>(),
      accessSync: (candidate: fs.PathLike, mode?: number) => {
        if (!String(candidate).startsWith(temporary + path.sep)) throw new Error('fixture excludes host executables');
        return fs.accessSync(candidate, mode);
      },
    }));
    const { resolveAppleMcpTransport } = await import('../../../../src/main/features/connectors/apple-mcp');
    const transport = resolveAppleMcpTransport('apple-notes');
    expect(transport.kind).toBe('stdio');
    if (transport.kind !== 'stdio') throw new Error('expected stdio');
    expect(transport.command).toBe(path.join(npxDirectory, 'npx'));
    expect(transport.env?.PATH.split(path.delimiter).slice(0, 2)).toEqual([
      path.join(temporary, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), npxDirectory,
    ]);
  });

  it.each(['win32', 'linux'] as const)('keeps both entries visible but blocks %s before spawning', async platform => {
    installExecutables();
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const { catalogWithAvailability, assertConnectorRuntimeEnabled } = await import('../../../../src/main/features/connectors/availability');
    const entries = catalogWithAvailability(userId, CONNECTOR_CATALOG).filter(entry => entry.id.startsWith('apple-'));
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({ availability: 'visible_disabled', disabled_reason: 'macos_only' });
      expect(() => assertConnectorRuntimeEnabled(userId, entry.id)).toThrow();
    }
  });

  it('distinguishes missing dependencies from unsupported platforms and resolves absolute launch paths', async () => {
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const { catalogWithAvailability } = await import('../../../../src/main/features/connectors/availability');
    const { resolveAppleMcpTransport } = await import('../../../../src/main/features/connectors/apple-mcp');
    const missing = catalogWithAvailability(userId, CONNECTOR_CATALOG).filter(entry => entry.id.startsWith('apple-'));
    expect(missing).toHaveLength(2);
    expect(missing.every(entry => entry.disabled_reason === 'cli_missing')).toBe(true);
    expect(() => resolveAppleMcpTransport('apple-notes')).toThrow('apple_mcp_dependency_missing');
    installExecutables();
    expect(resolveAppleMcpTransport('apple-reminders')).toMatchObject({ command: path.join(temporary, 'remctl'), args: ['mcp', 'serve'] });
    expect(resolveAppleMcpTransport('apple-notes')).toMatchObject({ command: path.join(temporary, 'npx'), args: ['-y', 'apple-notes-mcp@2.15.14'] });
    const available = catalogWithAvailability(userId, CONNECTOR_CATALOG).filter(entry => entry.id.startsWith('apple-'));
    expect(available.every(entry => !entry.availability)).toBe(true);
  });

  it('does not install at boot and provisions without CLI login or OAuth, retaining the tool subset after reconnect', async () => {
    installExecutables();
    const calls = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const constructor = vi.fn(function () {
      return { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), isConnected: true,
        listTools: vi.fn(async () => ['create_reminder', 'run', 'delete_reminder'].map(name => ({ name, description: '', input_schema: {} }))), callTool: calls };
    });
    vi.doMock('../../../../src/main/features/connectors/mcp-client', () => ({ McpConnection: constructor }));
    const users = await import('../../../../src/main/features/users');
    users.activateUser(userId);
    const manager = await import('../../../../src/main/features/connectors/manager');
    const registry = await import('../../../../src/main/features/connectors/registry');
    expect(registry.load(userId).connections['apple-reminders']).toBeUndefined();
    const instance = await manager.connectViaOAuth(userId, 'apple-reminders');
    expect(instance.status.kind).toBe('connected');
    expect(instance.oauth_grant).toBeUndefined();
    expect(instance.enabled_subtools).toContain('create_reminder');
    expect(instance.enabled_subtools).not.toContain('run');
    expect(instance.enabled_subtools).not.toContain('delete_reminder');
    expect(calls).not.toHaveBeenCalled();
    const { resolveVisibleConnectors } = await import('../../../../src/main/features/connectors/tools-adapter');
    const visible = await resolveVisibleConnectors(userId, undefined);
    expect(visible.find(row => row.instance.id === instance.id)?.tools.map(tool => tool.name)).toEqual(['create_reminder']);
    await manager.setEnabledSubtools(userId, instance.id, ['create_reminder']);
    const reconnected = await manager.connectViaOAuth(userId, instance.id);
    expect(reconnected.enabled_subtools).toEqual(['create_reminder']);
    expect(constructor).toHaveBeenCalledTimes(2);
    await manager.shutdownAll();
    await manager.refreshTools(userId, instance.id);
    expect(constructor).toHaveBeenCalledTimes(3);
    expect(registry.load(userId).connections[instance.id].enabled_subtools).toEqual(['create_reminder']);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await expect(manager.callTool(userId, instance.id, 'create_reminder', { title: 'test' })).rejects.toThrow('connector_unsupported');
    expect(calls).not.toHaveBeenCalled();
    await manager.shutdownAll();
  });

  it('retains a failed Notes connection for retry and passes hashes and permission errors through unchanged', async () => {
    installExecutables();
    let fail = true;
    const permissionError = { isError: true, content: [{ type: 'text', text: 'Notes automation permission denied' }] };
    const call = vi.fn(async () => permissionError);
    const connect = vi.fn(async () => { if (fail) throw new Error('upstream MCP failed to start'); });
    vi.doMock('../../../../src/main/features/connectors/mcp-client', () => ({
      McpConnection: vi.fn(function () { return { connect, close: vi.fn(async () => {}), isConnected: true,
        listTools: vi.fn(async () => [{ name: 'update-note', description: '', input_schema: {} }]), callTool: call }; }),
    }));
    const users = await import('../../../../src/main/features/users');
    users.activateUser(userId);
    const manager = await import('../../../../src/main/features/connectors/manager');
    const failed = await manager.connectViaOAuth(userId, 'apple-notes');
    expect(failed.status).toMatchObject({ kind: 'error', message: 'upstream MCP failed to start' });
    expect(call).not.toHaveBeenCalled();
    fail = false;
    const connected = await manager.connectViaOAuth(userId, 'apple-notes');
    expect(connected.status.kind).toBe('connected');
    expect(connected.oauth_grant).toBeUndefined();
    const args = { id: 'fixture-note', expectedContentHash: 'sha256:fixture', newContent: 'fixture text' };
    expect(await manager.callTool(userId, 'apple-notes', 'update-note', args)).toEqual(permissionError);
    expect(call).toHaveBeenCalledExactlyOnceWith('update-note', args);
    await manager.shutdownAll();
  });
});
