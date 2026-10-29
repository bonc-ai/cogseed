/**
 * S4 平台不可用（specs/009-agent-skill-pages FR-023 / SC-004）：IPC 把主进程失败回成
 * `{ok:false}` 而不是抛出，目录加载必须把它当失败，首页才会给出提示与「重试」。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const catalogSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/catalog.js'), 'utf8');

function loadCatalog(invoke: (channel: string, args?: unknown) => unknown): any {
  const window: any = { cogseed: { invoke: async (channel: string, args?: unknown) => invoke(channel, args) } };
  const context: any = {
    window,
    console,
    setTimeout,
    clearTimeout,
    t: (key: string) => key,
    escapeHtml: (v: string) => String(v),
    uiButton: ({ label, attrs = {} }: { label: string; attrs?: Record<string, unknown> }) =>
      `<button ${Object.keys(attrs).join(' ')}>${label}</button>`,
    createLogger: () => ({ warn() {}, error() {}, info() {} }),
  };
  vm.createContext(context);
  vm.runInContext(catalogSource, context, { filename: 'catalog.js' });
  return context;
}

const signedIn = { ok: true, status: { release_enabled: true, signed_in: true } };

describe('目录加载：平台不可用', () => {
  it('IPC 回 {ok:false} 时记为失败，首页显示「暂时无法获取」与「重试」', async () => {
    const ctx = loadCatalog((channel) => (channel === 'hub-account.status'
      ? signedIn
      : { ok: false, error: 'net::ERR_CONNECTION_REFUSED', code: 'E_UNKNOWN' }));
    await ctx.catalogLoad('agent', { force: true });

    expect(ctx.catalogStatus('agent').error).toBe('net::ERR_CONNECTION_REFUSED');
    expect(ctx.catalogRows('agent')).toEqual([]);
    const banner = ctx.catalogHomeBannerHtml('agent');
    expect(banner).toContain('data-catalog-banner="offline"');
    expect(banner).toContain('catalog.offline_banner');
    expect(banner).toContain('data-catalog-banner-action');
  });

  it('网络恢复后重试：错误清空、拿到完整目录、不再显示提示', async () => {
    let online = false;
    const ctx = loadCatalog((channel) => {
      if (channel === 'hub-account.status') return signedIn;
      return online
        ? { list: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }], total: 2 }
        : { ok: false, error: 'net::ERR_CONNECTION_REFUSED' };
    });
    await ctx.catalogLoad('agent', { force: true });
    expect(ctx.catalogStatus('agent').error).not.toBe('');

    online = true;
    await ctx.catalogLoad('agent', { force: true });
    expect(ctx.catalogStatus('agent').error).toBe('');
    expect(ctx.catalogRows('agent').map((r: { id: string }) => r.id)).toEqual(['a1', 'a2']);
    expect(ctx.catalogHomeBannerHtml('agent')).toBe('');
  });

  it('先成功、后断网：丢掉上次的目录，平台组只剩已安装的', async () => {
    let online = true;
    const ctx = loadCatalog((channel) => {
      if (channel === 'hub-account.status') return signedIn;
      return online ? { list: [{ id: 'a1' }], total: 1 } : { ok: false, error: 'net::ERR_CONNECTION_REFUSED' };
    });
    await ctx.catalogLoad('agent', { force: true });
    expect(ctx.catalogRows('agent')).toHaveLength(1);
    online = false;
    await ctx.catalogLoad('agent', { force: true });
    expect(ctx.catalogRows('agent')).toEqual([]);
    expect(ctx.catalogHomeBannerHtml('agent')).toContain('data-catalog-banner="offline"');
  });

  it('正常返回（不带 ok 字段）照旧当成功', async () => {
    const ctx = loadCatalog((channel) => (channel === 'hub-account.status'
      ? signedIn
      : { list: [{ id: 's1' }], total: 1 }));
    await ctx.catalogLoad('skill', { force: true });
    expect(ctx.catalogStatus('skill').error).toBe('');
    expect(ctx.catalogRows('skill')).toHaveLength(1);
  });
});
