import { describe, it, expect } from 'vitest';
import {
  resolveCliSandboxPosture,
  postureIsApprovalFallback,
} from '../../../../src/main/features/local_agents/backends/base';
import {
  buildClaudeArgs,
  CLAUDE_READ_ONLY_TOOLS,
} from '../../../../src/main/features/local_agents/backends/claude';

/** Contract: a `read-only` session must never let a spawned CLI change the
 *  workspace, and the other modes must keep behaving as before (they cannot be
 *  narrowed until an approval bridge exists — see `resolveCliSandboxPosture`). */
describe('local_agents › CLI sandbox posture', () => {
  it('narrows only the read-only mode; every granted mode keeps full access', () => {
    expect(resolveCliSandboxPosture('read-only')).toBe('read-only');
    for (const mode of ['workspace_approval', 'all_files_approval', 'all_files_auto', 'ask', 'full', 'auto_approve', '', undefined, null]) {
      expect(resolveCliSandboxPosture(mode as string | undefined | null)).toBe('full-access');
    }
  });

  it('tolerates surrounding whitespace on the host-supplied mode', () => {
    expect(resolveCliSandboxPosture('  read-only  ')).toBe('read-only');
  });

  it('flags the modes whose full access comes from the missing approval bridge', () => {
    for (const mode of ['workspace_approval', 'all_files_approval', 'ask']) {
      expect(postureIsApprovalFallback(mode)).toBe(true);
    }
    for (const mode of ['read-only', 'all_files_auto', 'full', 'auto_approve', '', undefined]) {
      expect(postureIsApprovalFallback(mode as string | undefined)).toBe(false);
    }
  });

  it('gives claude a read/search-only tool surface in a read-only run, without any bypass flag', () => {
    const args = buildClaudeArgs({ executionContext: { permissionMode: 'read-only' } } as never);
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe(CLAUDE_READ_ONLY_TOOLS);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('bypassPermissions');
  });

  it('keeps claude bypass flags for the modes that still grant the scope', () => {
    for (const mode of ['all_files_approval', 'all_files_auto', 'workspace_approval']) {
      const args = buildClaudeArgs({ executionContext: { permissionMode: mode } } as never);
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('bypassPermissions');
      expect(args).not.toContain('--tools');
    }
  });

  it('keeps the legacy no-context call shape unchanged', () => {
    const args = buildClaudeArgs({});
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--tools');
  });

  it('gives a no-tools run an empty tool surface with no MCP, bridge, resume, or custom flags', () => {
    const args = buildClaudeArgs({
      toolPolicy: 'none',
      bridge: {
        mcpConfigPath: '/runs/r1/cogseed-mcp-config.json',
        server: { command: '/node', args: ['/bridge.cjs'], env: {} },
        appendSystemPrompt: 'bridge prompt',
      },
      customArgs: ['--user-flag'],
      resumeSessionId: 'resume-1',
    } as never);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--user-flag');
    expect(args).not.toContain('--append-system-prompt');
    expect(args).not.toContain('/runs/r1/cogseed-mcp-config.json');
  });
});
