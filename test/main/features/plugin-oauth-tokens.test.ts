import { describe, it, expect, vi } from 'vitest';

import {
  REFRESH_SKEW_MS,
  applyRefreshResponse,
  buildInjectedEnv,
  createSingleFlightRunner,
  describeAuthForDisplay,
  isAccessTokenFresh,
  isRefreshTokenValid,
  resolveAccessToken,
  type OAuthTokenState,
  type RefreshResult,
} from '../../../src/main/features/plugin_oauth_tokens';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

function state(over: Partial<OAuthTokenState> = {}): OAuthTokenState {
  return {
    access_token: 'pat_abcdefghijklmnop',
    refresh_token: 'prt_abcdefghijkl',
    access_expires_at: new Date(NOW + 3600_000).toISOString(),
    refresh_expires_at: new Date(NOW + 30 * 24 * 3600_000).toISOString(),
    server_url: 'https://example.test/edu',
    ...over,
  };
}

const okRefresh = (over: Partial<Extract<RefreshResult, { ok: true }>> = {}): RefreshResult => ({
  ok: true,
  access_token: 'pat_NEWTOKEN',
  refresh_token: 'prt_NEWREFRESH',
  expires_in: 3600,
  refresh_expires_in: 2592000,
  ...over,
});

const failRefresh = (over: Partial<Extract<RefreshResult, { ok: false }>> = {}): RefreshResult => ({
  ok: false,
  code: 'INVALID_REFRESH_TOKEN',
  message: '刷新令牌无效',
  ...over,
});

// ---------------------------------------------------------------------------
// 有效期判定
// ---------------------------------------------------------------------------

describe('isAccessTokenFresh', () => {
  it('剩余远超 5 分钟 → 新鲜', () => {
    expect(isAccessTokenFresh(state(), NOW)).toBe(true);
  });

  it('恰好在 5 分钟窗口内 → 不新鲜（提前刷新，避免请求瞬间过期）', () => {
    for (const ms of [0, 1, REFRESH_SKEW_MS - 1, REFRESH_SKEW_MS]) {
      const s = state({ access_expires_at: new Date(NOW + ms).toISOString() });
      expect(isAccessTokenFresh(s, NOW)).toBe(false);
    }
  });

  it('刚过窗口 → 新鲜', () => {
    const s = state({ access_expires_at: new Date(NOW + REFRESH_SKEW_MS + 1).toISOString() });
    expect(isAccessTokenFresh(s, NOW)).toBe(true);
  });

  it('时间不可解析 → 视为不新鲜（不假装可用）', () => {
    expect(isAccessTokenFresh(state({ access_expires_at: 'not-a-date' }), NOW)).toBe(false);
  });
});

describe('isRefreshTokenValid', () => {
  it('未过期 → true；已过期 → false', () => {
    expect(isRefreshTokenValid(state(), NOW)).toBe(true);
    expect(isRefreshTokenValid(state({ refresh_expires_at: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
  });

  it('时间不可解析 → false', () => {
    expect(isRefreshTokenValid(state({ refresh_expires_at: 'x' }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 🔴 主流程：注入时序
// ---------------------------------------------------------------------------

describe('resolveAccessToken', () => {
  it('未授权（无本地令牌）→ NOT_AUTHORIZED，且提示需要重新授权', async () => {
    const r = await resolveAccessToken({ now: () => NOW, load: () => null });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('NOT_AUTHORIZED');
    expect(r.ok === false && r.needsReauth).toBe(true);
  });

  it('🔴 令牌新鲜 → 直接返回，**不发起刷新请求**', async () => {
    const refresh = vi.fn();
    const r = await resolveAccessToken({ now: () => NOW, load: () => state(), refresh });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.apiKey).toBe('pat_abcdefghijklmnop');
    expect(r.ok === true && r.refreshed).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('🔴 令牌将过期 → 刷新后再注入（插件只看到有效令牌）', async () => {
    const save = vi.fn();
    const r = await resolveAccessToken({
      now: () => NOW,
      load: () => state({ access_expires_at: new Date(NOW + 1000).toISOString() }),
      refresh: async () => okRefresh(),
      save,
    });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.apiKey).toBe('pat_NEWTOKEN');
    expect(r.ok === true && r.refreshed).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('🔴 刷新成功后必须写回新 refresh（旧的可能已被轮换/单次使用）', async () => {
    const save = vi.fn();
    await resolveAccessToken({
      now: () => NOW,
      load: () => state({ access_expires_at: new Date(NOW + 1000).toISOString() }),
      refresh: async () => okRefresh(),
      save,
    });
    const saved = save.mock.calls[0][0] as OAuthTokenState;
    expect(saved.refresh_token).toBe('prt_NEWREFRESH');
    expect(saved.access_token).toBe('pat_NEWTOKEN');
  });

  it('refresh 已过期 → REFRESH_TOKEN_EXPIRED（刷新也没用，必须重新授权）', async () => {
    const refresh = vi.fn();
    const r = await resolveAccessToken({
      now: () => NOW,
      // 真实世界里 refresh（30 天）过期时 access（1 小时）必然更早过期，
      // 这里必须构造成一致的状态，否则会先命中"access 仍新鲜"的快路径。
      load: () =>
        state({
          access_expires_at: new Date(NOW - 1).toISOString(),
          refresh_expires_at: new Date(NOW - 1).toISOString(),
        }),
      refresh,
    });
    expect(r.ok === false && r.reason).toBe('REFRESH_TOKEN_EXPIRED');
    expect(r.ok === false && r.needsReauth).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('🔴 边界：access 仍新鲜但 refresh 已过期 → 照常用 access，不逼用户重新授权', async () => {
    // 两者寿命不同（1 小时 vs 30 天），存在最长 1 小时的重叠窗口：
    // refresh 刚过期、access 还没过期的这一刻，令牌本身仍然有效。
    // 此时强制重新授权是伪失败 —— 用户会看到"明明能用却要重连"。
    const refresh = vi.fn();
    const r = await resolveAccessToken({
      now: () => NOW,
      load: () =>
        state({
          access_expires_at: new Date(NOW + 600_000).toISOString(),
          refresh_expires_at: new Date(NOW - 1).toISOString(),
        }),
      refresh,
    });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.apiKey).toBe('pat_abcdefghijklmnop');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('🔴 刷新失败 → 命令不执行，返回明确原因（不静默失败）', async () => {
    const r = await resolveAccessToken({
      now: () => NOW,
      load: () => state({ access_expires_at: new Date(NOW).toISOString() }),
      refresh: async () => failRefresh(),
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('REFRESH_FAILED');
    expect(r.ok === false && r.message).toContain('刷新令牌无效');
  });

  it('刷新失败且标记 needsReauth → 归为 REFRESH_TOKEN_EXPIRED 并提示重连', async () => {
    const r = await resolveAccessToken({
      now: () => NOW,
      load: () => state({ access_expires_at: new Date(NOW).toISOString() }),
      refresh: async () => failRefresh({ code: 'TOKEN_REPLAY_DETECTED', needsReauth: true, message: '检测到重放' }),
    });
    expect(r.ok === false && r.reason).toBe('REFRESH_TOKEN_EXPIRED');
    expect(r.ok === false && r.needsReauth).toBe(true);
  });

  it('🔴 写回失败必须中止（否则会用旧 refresh 再次刷新 → 触发重放检测、全设备被踢）', async () => {
    const r = await resolveAccessToken({
      now: () => NOW,
      load: () => state({ access_expires_at: new Date(NOW).toISOString() }),
      refresh: async () => okRefresh(),
      save: () => {
        throw new Error('disk full');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('STORE_UNAVAILABLE');
    expect(r.ok === false && r.message).toContain('已中止');
  });

  it('读取本地令牌抛错 → STORE_UNAVAILABLE（不抛给调用方）', async () => {
    const r = await resolveAccessToken({
      now: () => NOW,
      load: () => {
        throw new Error('permission denied');
      },
    });
    expect(r.ok === false && r.reason).toBe('STORE_UNAVAILABLE');
  });

  it('令牌字段为空 → 视为未授权', async () => {
    for (const over of [{ access_token: '' }, { refresh_token: '' }]) {
      const r = await resolveAccessToken({ now: () => NOW, load: () => state(over) });
      expect(r.ok === false && r.reason).toBe('NOT_AUTHORIZED');
    }
  });

  it('缺少刷新实现 → REFRESH_FAILED（客户端缺陷，不伪装成用户问题）', async () => {
    const r = await resolveAccessToken({
      now: () => NOW,
      load: () => state({ access_expires_at: new Date(NOW).toISOString() }),
    });
    expect(r.ok === false && r.reason).toBe('REFRESH_FAILED');
    expect(r.ok === false && r.needsReauth).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 响应 → 本地状态
// ---------------------------------------------------------------------------

describe('applyRefreshResponse', () => {
  it('按响应里的秒数计算到期时间（不硬编码）', () => {
    const next = applyRefreshResponse(
      state(),
      { access_token: 'a', refresh_token: 'r', expires_in: 1800, refresh_expires_in: 86400 },
      NOW,
    );
    expect(next.access_expires_at).toBe(new Date(NOW + 1800_000).toISOString());
    expect(next.refresh_expires_at).toBe(new Date(NOW + 86400_000).toISOString());
  });

  it('响应缺 refresh 时保留旧值（不写入空串把用户踢出去）', () => {
    const next = applyRefreshResponse(
      state(),
      { access_token: 'a', refresh_token: '', expires_in: 3600, refresh_expires_in: 86400 },
      NOW,
    );
    expect(next.refresh_token).toBe('prt_abcdefghijkl');
  });

  it('非法秒数不会产出过去时间', () => {
    const next = applyRefreshResponse(
      state(),
      { access_token: 'a', refresh_token: 'r', expires_in: 0, refresh_expires_in: 0 },
      NOW,
    );
    expect(Date.parse(next.access_expires_at)).toBeGreaterThan(NOW);
  });
});

// ---------------------------------------------------------------------------
// 🔴 单飞：刷新不重复
// ---------------------------------------------------------------------------

describe('createSingleFlightRunner', () => {
  it('🔴 并发调用只真正执行一次（防重放误判：两次刷新会用同一个已轮换的 refresh）', async () => {
    const run = createSingleFlightRunner();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    });
    const results = await Promise.all([run(fn), run(fn), run(fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['done', 'done', 'done']);
  });

  it('前一次结束后可以再次执行（不是永久锁）', async () => {
    const run = createSingleFlightRunner();
    const fn = vi.fn(async () => 'x');
    await run(fn);
    await run(fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('失败后不卡死，下次仍可执行', async () => {
    const run = createSingleFlightRunner();
    await expect(run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(run(async () => 'ok')).resolves.toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 🔴 环境变量注入：插件零改动的关键
// ---------------------------------------------------------------------------

describe('buildInjectedEnv', () => {
  it('🔴 环境变量名保持 EDUSEED_API_KEY（插件零改动）', () => {
    const env = buildInjectedEnv({ PATH: '/usr/bin' }, { serverUrl: 'https://s/edu', accessToken: 'pat_x' });
    expect(env.EDUSEED_API_KEY).toBe('pat_x');
    expect(env.EDUSEED_SERVER_URL).toBe('https://s/edu');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('可选字段只在有值时注入（不写空串覆盖）', () => {
    const env = buildInjectedEnv({}, { serverUrl: 's', accessToken: 't' });
    expect('EDUSEED_STUDENT_ID' in env).toBe(false);
    const env2 = buildInjectedEnv({}, { serverUrl: 's', accessToken: 't', studentId: 'S1', role: 'student' });
    expect(env2.EDUSEED_STUDENT_ID).toBe('S1');
    expect(env2.EDUSEED_ROLE).toBe('student');
  });

  it('不修改传入的 base 对象（纯函数）', () => {
    const base = { A: '1' };
    buildInjectedEnv(base, { serverUrl: 's', accessToken: 't' });
    expect(base).toEqual({ A: '1' });
  });
});

// ---------------------------------------------------------------------------
// 展示：只出掩码
// ---------------------------------------------------------------------------

describe('describeAuthForDisplay', () => {
  it('🔴 只出掩码，永不含明文令牌', () => {
    const d = describeAuthForDisplay(state(), NOW);
    expect(d.authorized).toBe(true);
    expect(d.maskedAccess).toContain('*');
    expect(d.maskedAccess).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(d)).not.toContain('pat_abcdefghijklmnop');
  });

  it('未授权 → authorized=false', () => {
    expect(describeAuthForDisplay(null, NOW).authorized).toBe(false);
    expect(describeAuthForDisplay(state({ access_token: '' }), NOW).authorized).toBe(false);
  });

  it('带出剩余秒数与是否需要刷新', () => {
    const d = describeAuthForDisplay(state({ access_expires_at: new Date(NOW + 600_000).toISOString() }), NOW);
    expect(d.expiresInSeconds).toBe(600);
    expect(d.needsRefresh).toBe(false);
    const d2 = describeAuthForDisplay(state({ access_expires_at: new Date(NOW + 1000).toISOString() }), NOW);
    expect(d2.needsRefresh).toBe(true);
  });

  it('带出课程身份供界面显示', () => {
    const d = describeAuthForDisplay(state({ binding: { person_id: '2025xxx', role: 'student' } }), NOW);
    expect(d.personId).toBe('2025xxx');
    expect(d.role).toBe('student');
  });
});
