import { describe, it, expect, beforeEach } from 'vitest';

import {
  selectServices,
  hubProbeUrl,
  platformProbeUrl,
  hubReachable,
  platformReachable,
  channelAllowsLocalFallback,
  resolveServicesOnce,
  selectedHubBase,
  selectedPlatformBase,
  PRODUCTION_HUB_BASE,
  PRODUCTION_PLATFORM_BASE,
  LOCAL_HUB_CANDIDATES,
  LOCAL_PLATFORM_CANDIDATES,
  PROBE_STATE,
  __resetServiceSelectionForTests,
} from '../../../src/main/features/service_origins';

/**
 * 这组用例守的是「生产优先 / 本地兜底」的选择语义（features/service_origins.ts）。
 *
 * 为什么值得测：这套选择决定了**授权流程连哪台服务器**。选错的两种后果都很贵 ——
 * 选到"活着但没部署授权路由"的生产（当前真实状态）会让第二步 404；
 * 在正式包里偷偷回退到本机端口则是安全问题。
 */

describe('可用性判定（哪些状态算"走不通"）', () => {
  it('Hub：401 算可用（服务在、路由在，只差令牌）', () => {
    expect(hubReachable(200)).toBe(true);
    expect(hubReachable(401)).toBe(true);
  });

  it('Hub：连不上 / 5xx / 404 都算不可用', () => {
    expect(hubReachable(null)).toBe(false);
    expect(hubReachable(500)).toBe(false);
    expect(hubReachable(404)).toBe(false);
  });

  it('🔴 平台：404 必须判为不可用（这就是当前生产的状态）', () => {
    // 生产 /api/health 是 200，但 /api/oauth/authorize 是 404。
    // 只看"服务活着"会选中一个功能缺失的生产环境。
    expect(platformReachable(404)).toBe(false);
    expect(platformReachable(null)).toBe(false);
  });

  it('平台：400/200/401 都算可用（路由存在），5xx 不算', () => {
    expect(platformReachable(400)).toBe(true); // 参数不合法 = 路由在
    expect(platformReachable(200)).toBe(true);
    expect(platformReachable(401)).toBe(true);
    expect(platformReachable(503)).toBe(false);
  });

  it('只有 dev / unknown 允许本地兜底（正式包不允许）', () => {
    expect(channelAllowsLocalFallback('dev')).toBe(true);
    expect(channelAllowsLocalFallback('unknown')).toBe(true);
    expect(channelAllowsLocalFallback('release')).toBe(false);
    expect(channelAllowsLocalFallback('packaged-dev')).toBe(false);
  });
});

describe('探测地址', () => {
  it('平台探测用不存在的 client_id（校验在写库之前 → 无副作用）', () => {
    const url = platformProbeUrl('https://example.test/edu');
    expect(url).toBe(
      `https://example.test/edu/api/oauth/authorize?client_id=__connectivity_probe__&redirect_uri=cogseed%3A%2F%2Fplugin%2Fauthorize%2Fcallback&response_type=code&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256&state=${PROBE_STATE}`,
    );
    // 关键：不能带合法 client_id —— 否则每次启动都会往 state 表插一行垃圾
    expect(url).not.toContain('client_id=cogseed-desktop');
  });

  it('Hub 探测打 /api/v1/account/me，且去掉尾斜杠', () => {
    expect(hubProbeUrl('https://hub.test/')).toBe('https://hub.test/api/v1/account/me');
  });
});

describe('选择顺序：env → 生产 → 本地 → 标记不可用', () => {
  beforeEach(() => {
    __resetServiceSelectionForTests();
  });

  it('显式 env 最优先，且**不探测**', async () => {
    const probed: string[] = [];
    const sel = await selectServices({
      channel: 'dev',
      envHub: 'http://env-hub.test',
      envPlatform: 'http://env-plat.test/edu',
      probe: async (url) => {
        probed.push(url);
        return null;
      },
    });
    expect(sel.hub).toMatchObject({ base: 'http://env-hub.test', source: 'env' });
    expect(sel.platform).toMatchObject({ base: 'http://env-plat.test/edu', source: 'env' });
    expect(probed).toEqual([]);
  });

  it('生产可用 → 用生产（哪怕本地也在）', async () => {
    const sel = await selectServices({
      channel: 'dev',
      probe: async (url) => (url.includes('bonc.com.cn') ? 401 : 200),
    });
    expect(sel.hub).toMatchObject({ base: PRODUCTION_HUB_BASE, source: 'production' });
    expect(sel.platform).toMatchObject({ base: PRODUCTION_PLATFORM_BASE, source: 'production' });
  });

  it('🔴 生产平台 404 → 回退本地平台（Hub 仍走生产）', async () => {
    // 复刻真实状态：Hub 生产活着；平台生产活着但授权路由没部署。
    const sel = await selectServices({
      channel: 'dev',
      probe: async (url) => {
        if (url.includes('bonc.com.cn') && url.includes('/api/oauth/authorize')) return 404;
        if (url.includes('bonc.com.cn') && url.includes('/api/v1/account/me')) return 401;
        if (url.startsWith('http://127.0.0.1:3001/edu/api/oauth/authorize')) return 400;
        return null;
      },
    });
    expect(sel.hub).toMatchObject({ base: PRODUCTION_HUB_BASE, source: 'production' });
    expect(sel.platform).toMatchObject({ base: LOCAL_PLATFORM_CANDIDATES[0], source: 'local' });
  });

  it('生产连不上 → 回退本地（按候选顺序，第一个可用的胜出）', async () => {
    const sel = await selectServices({
      channel: 'dev',
      probe: async (url) => {
        if (url.includes('bonc.com.cn')) return null;
        if (url.startsWith(LOCAL_HUB_CANDIDATES[1])) return 401; // 只有 4202 活着
        if (url.startsWith(LOCAL_PLATFORM_CANDIDATES[1])) return 200; // 只有 3000/edu 活着
        return null;
      },
    });
    expect(sel.hub).toMatchObject({ base: LOCAL_HUB_CANDIDATES[1], source: 'local' });
    expect(sel.platform).toMatchObject({ base: LOCAL_PLATFORM_CANDIDATES[1], source: 'local' });
  });

  it('两边都不通 → 回生产地址 + 标记 unreachable（报错时能说清"都试过了"）', async () => {
    const sel = await selectServices({ channel: 'dev', probe: async () => null });
    expect(sel.hub).toMatchObject({ base: PRODUCTION_HUB_BASE, source: 'unreachable' });
    expect(sel.platform).toMatchObject({ base: PRODUCTION_PLATFORM_BASE, source: 'unreachable' });
    // 试过的地址要留痕（诊断用）
    expect(sel.platform.probed).toContain(PRODUCTION_PLATFORM_BASE);
    expect(sel.platform.probed).toContain(LOCAL_PLATFORM_CANDIDATES[0]);
  });

  it('🔴 release 通道绝不探本地（正式包不得偷偷连本机端口）', async () => {
    const probed: string[] = [];
    const sel = await selectServices({
      channel: 'release',
      probe: async (url) => {
        probed.push(url);
        return null;
      },
    });
    expect(probed.every((u) => !u.includes('127.0.0.1'))).toBe(true);
    expect(sel.hub.source).toBe('unreachable');
    expect(sel.hub.base).toBe(PRODUCTION_HUB_BASE);
  });
});

describe('启动解析只做一次（缓存）', () => {
  beforeEach(() => {
    __resetServiceSelectionForTests();
  });

  it('重复调用复用同一结果，不重复探测', async () => {
    let calls = 0;
    const probe = async (url: string) => {
      calls += 1;
      return url.includes('bonc.com.cn') ? 401 : null;
    };
    const first = await resolveServicesOnce({ COGSEED_BUILD_CHANNEL: 'dev' }, probe);
    const afterFirst = calls;
    const second = await resolveServicesOnce({ COGSEED_BUILD_CHANNEL: 'dev' }, probe);
    expect(second).toBe(first);
    expect(calls).toBe(afterFirst); // 第二次没有新增探测
    expect(selectedHubBase()).toBe(PRODUCTION_HUB_BASE);
  });

  it('release 通道返回 null（调用方继续用既有通道默认值）', async () => {
    const sel = await resolveServicesOnce({ COGSEED_BUILD_CHANNEL: 'release' }, async () => 401);
    expect(sel).toBeNull();
    expect(selectedHubBase()).toBeNull();
    expect(selectedPlatformBase()).toBeNull();
  });

  it('探测抛异常不影响启动（返回 null）', async () => {
    const sel = await resolveServicesOnce({ COGSEED_BUILD_CHANNEL: 'dev' }, async () => {
      throw new Error('boom');
    });
    expect(sel).toBeNull();
  });
});
