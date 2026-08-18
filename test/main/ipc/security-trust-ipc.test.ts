/**
 * IPC contract tests for the skill security surface.
 *
 * Locks three regressions introduced by a recall-governance refactor
 * (`9ae11042`) that silently dropped security wiring from the invoke layer:
 *
 *  1. `acceptSecurityRisk` was removed from the `marketplace.installSkill` /
 *     `marketplace.installAgent` handlers, so the renderer's confirmed
 *     override never reached `resolveInstallDecision` — the "仍要安装" flow
 *     was cut end-to-end while every layer around it stayed green.
 *  2. `skills.trust.reverify` (the "重新检查" button) became an unknown channel.
 *  3. `skills.trust.list` (receipt listing for the trust surface) became an
 *     unknown channel.
 *
 * These are contract tests on the handler shapes, not re-tests of the feature
 * logic: the feature modules already have their own coverage, which is exactly
 * why the breakage was invisible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uTrustIpc';

const marketplaceMock = vi.hoisted(() => ({
  installMarketplaceSkill: vi.fn(async () => ({ ok: true, id: 'skill-contract' })),
  installMarketplaceAgent: vi.fn(async () => ({ ok: true, id: 'agent-contract' })),
}));

const skillReverifyMock = vi.hoisted(() => ({
  reverifySkillDeep: vi.fn(async (_uid: string, skillId: string) => ({
    skillId, decision: 'pass', rescanned: true, staleReason: 'no_receipt',
    receipt: { skillId },
  })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'orkas.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../src/main/features/marketplace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/features/marketplace')>()),
  installMarketplaceSkill: marketplaceMock.installMarketplaceSkill,
  installMarketplaceAgent: marketplaceMock.installMarketplaceAgent,
}));
vi.mock('../../../src/main/features/skill_reverify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/features/skill_reverify')>()),
  reverifySkillDeep: skillReverifyMock.reverifySkillDeep,
}));

beforeEach(async () => {
  process.env.ORKAS_WORKSPACE_ROOT = os.tmpdir();
  invokeHandler = null;
  vi.resetModules(); vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users'); users.activateUser(UID);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => vi.resetModules());

function call(channel: string, payload: unknown = {}): Promise<Record<string, unknown>> {
  if (!invokeHandler) throw new Error('missing handler');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

const INSTALL_PAYLOAD = {
  id: 'skill-contract', name: 'Contract Skill', version: '1.0.0', published_at: 1700000000000,
};

describe('ipc › skill security surface contract', () => {
  it('forwards the confirmed security override from installSkill to the install gate', async () => {
    const r = await call('marketplace.installSkill', { ...INSTALL_PAYLOAD, acceptSecurityRisk: true });
    expect(r.ok).toBe(true);
    expect(marketplaceMock.installMarketplaceSkill).toHaveBeenCalledTimes(1);
    const [, , opts] = marketplaceMock.installMarketplaceSkill.mock.calls[0] as unknown[];
    expect(opts).toMatchObject({ acceptSecurityRisk: true });
  });

  it('forwards the confirmed security override from installAgent to the install gate', async () => {
    const r = await call('marketplace.installAgent', { ...INSTALL_PAYLOAD, acceptSecurityRisk: true });
    expect(r.ok).toBe(true);
    expect(marketplaceMock.installMarketplaceAgent).toHaveBeenCalledTimes(1);
    const [, , opts] = marketplaceMock.installMarketplaceAgent.mock.calls[0] as unknown[];
    expect(opts).toMatchObject({ acceptSecurityRisk: true });
  });

  it('passes an explicit false when the renderer did not consent', async () => {
    await call('marketplace.installSkill', { ...INSTALL_PAYLOAD });
    const [, , opts] = marketplaceMock.installMarketplaceSkill.mock.calls[0] as unknown[];
    expect(opts).toMatchObject({ acceptSecurityRisk: false });
  });

  it('keeps forwarding force and name alongside the consent flag', async () => {
    await call('marketplace.installSkill', { ...INSTALL_PAYLOAD, force: true, acceptSecurityRisk: true });
    const [, , opts] = marketplaceMock.installMarketplaceSkill.mock.calls[0] as unknown[];
    expect(opts).toMatchObject({ force: true, name: 'Contract Skill', acceptSecurityRisk: true });
  });

  it('registers skills.trust.reverify and routes it to the deep reverify', async () => {
    const r = await call('skills.trust.reverify', { skillId: 'skill-contract' });
    expect(r).toMatchObject({ ok: true, result: { skillId: 'skill-contract', decision: 'pass' } });
    expect(skillReverifyMock.reverifySkillDeep).toHaveBeenCalledWith(UID, 'skill-contract');
  });

  it('rejects an invalid skill id on skills.trust.reverify', async () => {
    const r = await call('skills.trust.reverify', { skillId: '../escape' });
    expect(r.ok).toBe(false);
    expect(skillReverifyMock.reverifySkillDeep).not.toHaveBeenCalled();
  });

  it('registers skills.trust.list and returns the receipt array', async () => {
    const r = await call('skills.trust.list');
    expect(r.ok).toBe(true);
    expect(Array.isArray((r as { receipts?: unknown[] }).receipts)).toBe(true);
  });

  it('propagates the security-blocked verdict fields to the renderer', async () => {
    marketplaceMock.installMarketplaceSkill.mockRejectedValueOnce(
      Object.assign(new Error('Security scan rejected skill Contract Skill (no_credential_path_read)'), {
        securityBlocked: true,
        securityUnavailable: false,
        securityOverridable: true,
        securityRuleIds: ['no_credential_path_read'],
        securityScan: { outcome: 'blocked', score: 20 },
      }),
    );
    const r = await call('marketplace.installSkill', { ...INSTALL_PAYLOAD });
    expect(r).toMatchObject({
      ok: false,
      securityBlocked: true,
      securityOverridable: true,
      securityRuleIds: ['no_credential_path_read'],
    });
    expect((r as { securityScan?: unknown }).securityScan).toBeDefined();
  });

  it('registers skills.security.status and returns the guardrail snapshot', async () => {
    const r = await call('skills.security.status');
    expect(r.ok).toBe(true);
    const status = (r as { status?: Record<string, unknown> }).status;
    expect(status && typeof status === 'object').toBe(true);
    expect(typeof status?.scanner).toBe('string');
    expect(['present', 'absent_by_build', 'broken']).toContain(status?.scanner);
  });

  it('propagates the security-unavailable verdict fields to the renderer', async () => {
    marketplaceMock.installMarketplaceSkill.mockRejectedValueOnce(
      Object.assign(new Error('Security check unavailable for skill Contract Skill (spawn_failed)'), {
        securityBlocked: false,
        securityUnavailable: true,
        securityOverridable: true,
      }),
    );
    const r = await call('marketplace.installSkill', { ...INSTALL_PAYLOAD });
    expect(r).toMatchObject({ ok: false, securityUnavailable: true, securityOverridable: true });
  });
});
