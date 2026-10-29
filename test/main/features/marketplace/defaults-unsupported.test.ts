import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
const info = vi.fn();
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info, warn, error: vi.fn() }),
}));

const UID = 'u_marketplace_defaults_unsupported';
const savedBase = process.env.COGSEED_API_BASE_URL;

/** 本机真 Hub 对 POST /marketplace/defaults 的实际回答（2026-10-15 实测）。 */
const HUB_NOT_SUPPORTED = {
  code: 404,
  msg: '本 Hub 不提供该路径（/marketplace/defaults）。旧 Marketplace 接口不在本 Hub 契约内：请按 404 做有依据的降级。',
  error: { code: 'NOT_SUPPORTED', message: '本 Hub 不提供该路径' },
};

beforeEach(async () => {
  warn.mockClear();
  info.mockClear();
  process.env.COGSEED_API_BASE_URL = 'https://marketplace.test/api';
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedBase === undefined) delete process.env.COGSEED_API_BASE_URL;
  else process.env.COGSEED_API_BASE_URL = savedBase;
});

describe('默认安装推荐：Hub 明确"不提供"时静默降级', () => {
  it('NOT_SUPPORTED：不算失败、不写警告、不要求重试，只记一条 info', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(HUB_NOT_SUPPORTED), { status: 404 })));
    const mp = await import('../../../../src/main/features/marketplace');
    const result = await mp.ensureDefaultInstalls(UID, { force: true, minIntervalMs: 0 });
    expect(result).toMatchObject({ seeded_agents: 0, seeded_skills: 0, unsupported: true });
    expect(result.failed).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls.some((c) => /not offered by this Hub/.test(String(c[0])))).toBe(true);
  });

  it('其它失败（例如服务端 500）仍按原样：失败、写警告、允许重试', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 500, msg: 'boom 500' }), { status: 200 })));
    const mp = await import('../../../../src/main/features/marketplace');
    const result = await mp.ensureDefaultInstalls(UID, { force: true, minIntervalMs: 0 });
    expect(result.failed).toBe(true);
    expect(result.unsupported).toBeUndefined();
    expect(warn.mock.calls.some((c) => /incremental seed failed/.test(String(c[0])))).toBe(true);
    expect(mp.isRetryableMarketplaceError(String(result.error))).toBe(true);
  });

  it('isMarketplaceEndpointUnsupported 只认 Hub 的 NOT_SUPPORTED 码，不凭文案猜', async () => {
    const mp = await import('../../../../src/main/features/marketplace');
    expect(mp.isMarketplaceEndpointUnsupported(Object.assign(new Error('x'), { hubErrorCode: 'NOT_SUPPORTED' }))).toBe(true);
    expect(mp.isMarketplaceEndpointUnsupported(new Error('本 Hub 不提供该路径 NOT_SUPPORTED'))).toBe(false);
    expect(mp.isMarketplaceEndpointUnsupported(Object.assign(new Error('x'), { hubErrorCode: 'FORBIDDEN' }))).toBe(false);
    expect(mp.isMarketplaceEndpointUnsupported(null)).toBe(false);
  });
});
