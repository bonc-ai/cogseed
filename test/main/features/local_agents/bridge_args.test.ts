import { describe, expect, it } from 'vitest';

import { buildClaudeArgs } from '../../../../src/main/features/local_agents/backends/claude';
import { buildCodexBridgeOverrides, codexDeveloperInstructions } from '../../../../src/main/features/local_agents/backends/codex';

const BASE = {
  binPath: '/codex', prompt: 'hi', cwd: '/proj',
  signal: new AbortController().signal, onEvent: () => {}, timeoutMs: 1000,
} as const;

// Bridge injection args per backend (plan §D3). Companion to
// claude_parser.test.ts (base arg shape) and bridge.test.ts (host).

describe('claude bridge args', () => {
  it('adds --mcp-config and --append-system-prompt before customArgs', () => {
    const args = buildClaudeArgs({
      bridge: {
        mcpConfigPath: '/runs/r1/cogseed-mcp-config.json',
        server: { command: '/node', args: ['/bridge.cjs'], env: {} },
        appendSystemPrompt: 'You are running inside CogSeed.',
      },
      customArgs: ['--some-user-flag'],
    });
    const mcpIdx = args.indexOf('--mcp-config');
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(args[mcpIdx + 1]).toBe('/runs/r1/cogseed-mcp-config.json');
    const sysIdx = args.indexOf('--append-system-prompt');
    expect(args[sysIdx + 1]).toContain('CogSeed');
    // User flags still trail so they can override.
    expect(args.indexOf('--some-user-flag')).toBeGreaterThan(sysIdx);
    // No strict mode — the user's own MCP servers must keep working.
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('omits bridge flags entirely when no bridge is live', () => {
    const args = buildClaudeArgs({});
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--append-system-prompt');
  });
});

describe('codex bridge overrides', () => {
  it('emits TOML-quoted -c overrides for command/args and non-secret env', () => {
    const overrides = buildCodexBridgeOverrides({
      command: '/usr/local/bin/node',
      args: ['/pc/bin/cogseed-bridge.cjs'],
      // Real serverEnv shape: env-file pointer + run-as-node + paths, with the
      // secret token/socket present to prove they are filtered out of argv.
      env: {
        ORKAS_BRIDGE_ENV_FILE: '/runs/r1/cogseed-bridge-env.json',
        ELECTRON_RUN_AS_NODE: '1',
        ORKAS_PC_DIR: '/pc',
        ORKAS_BRIDGE_TOKEN: 'tok',
        ORKAS_BRIDGE_SOCKET: '/tmp/b.sock',
      },
    });
    expect(overrides[0]).toBe('-c');
    expect(overrides[1]).toBe('mcp_servers.cogseed.command="/usr/local/bin/node"');
    expect(overrides[3]).toBe('mcp_servers.cogseed.args=["/pc/bin/cogseed-bridge.cjs"]');
    // Non-secret env IS injected — Codex does not inherit the parent env, so
    // without these the bridge MCP server exits "env required".
    expect(overrides).toContain('mcp_servers.cogseed.env.ORKAS_BRIDGE_ENV_FILE="/runs/r1/cogseed-bridge-env.json"');
    expect(overrides).toContain('mcp_servers.cogseed.env.ELECTRON_RUN_AS_NODE="1"');
    expect(overrides).toContain('mcp_servers.cogseed.env.ORKAS_PC_DIR="/pc"');
    // Token/socket must never reach argv.
    expect(overrides.join('\n')).not.toContain('ORKAS_BRIDGE_TOKEN');
    expect(overrides.join('\n')).not.toContain('ORKAS_BRIDGE_SOCKET');
    expect(overrides.join('\n')).not.toContain('tok');
    expect(overrides.join('\n')).not.toContain('/tmp/b.sock');
  });

  it('escapes quotes and backslashes in TOML strings (Windows paths + env)', () => {
    const overrides = buildCodexBridgeOverrides({
      command: 'C:\\Program Files\\node.exe',
      args: ['C:\\pc\\bin\\cogseed-bridge.cjs'],
      env: { ORKAS_PC_DIR: 'C:\\Program Files\\CogSeed' },
    });
    expect(overrides[1]).toBe('mcp_servers.cogseed.command="C:\\\\Program Files\\\\node.exe"');
    // Non-secret env values are TOML-escaped the same way.
    expect(overrides).toContain('mcp_servers.cogseed.env.ORKAS_PC_DIR="C:\\\\Program Files\\\\CogSeed"');
  });

  it('carries the bridge prompt as developerInstructions, null otherwise', () => {
    expect(codexDeveloperInstructions({ ...BASE })).toBeNull();
    expect(codexDeveloperInstructions({
      ...BASE,
      bridge: {
        mcpConfigPath: '/cfg.json',
        server: { command: '/node', args: ['/b.cjs'], env: {} },
        appendSystemPrompt: 'You are running inside CogSeed.',
      },
    })).toContain('CogSeed');
  });
});
