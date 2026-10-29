import { describe, expect, it } from 'vitest';

/**
 * 任务复盘详情明确区分 loading、failed 和成功但空的结果。
 * 初始请求置 loading，失败显式置 failed；失败块显示说明和收起动作，重新
 * 展开可重试。core 与 views 共用同一状态；IPC 由内存桩提供。
 */

const globalScope = globalThis as unknown as Record<string, unknown>;
type Invoke = (channel: string, payload: Record<string, unknown>) => Promise<unknown>;
let invokeImpl: Invoke = async () => ({ ok: true });

const NS = (() => {
  const stub: Record<string, unknown> = {};
  globalScope.window = {
    CogAssets: stub,
    cogseed: { invoke: (channel: string, payload: Record<string, unknown>) => invokeImpl(channel, payload) },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/core.js');
  return stub as unknown as {
    store: Record<string, unknown>;
    notify: () => void;
    loadKstarEpisode: (episodeId: string) => Promise<void>;
  };
})();

describe('KSTAR 复盘详情的加载/失败态（core）', () => {
  it('发起读取先写 loading，请求期间视图能区分「正在读」', async () => {
    let sawInFlight: Record<string, unknown> | null = null;
    invokeImpl = async () => {
      sawInFlight = { ...(NS.store.kstarEpisode as Record<string, unknown>) };
      return { ok: true, episode: { goal: 'g' }, review: { lesson: 'l' } };
    };
    await NS.loadKstarEpisode('kse-loading');
    expect(sawInFlight).toMatchObject({ episodeId: 'kse-loading', loading: true, failed: false });
  });

  it('读取失败显式记 failed，不冒充只有标题的空详情', async () => {
    invokeImpl = async () => ({ ok: false, error: 'kstar episode unreadable', code: 'E_IO' });
    await NS.loadKstarEpisode('kse-broken');
    expect(NS.store.kstarEpisode).toMatchObject({
      episodeId: 'kse-broken',
      loading: false,
      failed: true,
    });
    // data=null 时 episode/review 落 null（data && data.episode 的求值结果）。
    expect((NS.store.kstarEpisode as { episode?: unknown }).episode).toBeFalsy();
    expect((NS.store.kstarEpisode as { review?: unknown }).review).toBeFalsy();
  });

  it('成功落盘 episode/review 且 failed=false；成功但空载荷不算失败', async () => {
    invokeImpl = async () => ({ ok: true, episode: { goal: '整理周报' }, review: { lesson: '先定框架' } });
    await NS.loadKstarEpisode('kse-ok');
    expect(NS.store.kstarEpisode).toMatchObject({
      episodeId: 'kse-ok',
      episode: { goal: '整理周报' },
      review: { lesson: '先定框架' },
      loading: false,
      failed: false,
    });

    invokeImpl = async () => ({ ok: true });
    await NS.loadKstarEpisode('kse-empty');
    expect(NS.store.kstarEpisode).toMatchObject({ episodeId: 'kse-empty', loading: false, failed: false });
  });

  it('切到另一条后返回的迟到响应不回写旧状态', async () => {
    invokeImpl = async () => ({ ok: true, episode: { goal: '迟到的旧响应' } });
    const late = NS.loadKstarEpisode('kse-late');
    // 请求未回来就切去了另一条：kstarEpisode 已被改写。
    NS.store.kstarEpisode = { episodeId: 'kse-other', loading: true, failed: false };
    await late;
    expect((NS.store.kstarEpisode as { episodeId?: string }).episodeId).toBe('kse-other');
  });
});

/* ───────────── views：同一份状态在展开块上的三态呈现 ───────────── */

type Section = (route: { kstarEpisodeId?: string }) => string;

const section = (() => {
  // views.js 与 core.js 共享同一 CogAssets 命名空间：换上带 store 的真 NS
  // 再 require，views 顶层的 const S = NS.store 即取到 core 的状态仓库。
  // cogseed 必须保留——api.call 运行时读 window.cogseed.invoke，丢了它
  // 后续所有 core 调用都会被 catch 成 failed。
  globalScope.window = {
    CogAssets: NS,
    cogseed: { invoke: (channel: string, payload: Record<string, unknown>) => invokeImpl(channel, payload) },
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    uiButton: require('../../src/renderer/modules/ui-button.js').uiButton,
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/views.js');
  return (NS as unknown as { ui: { kstarEpisodeSection: Section } }).ui.kstarEpisodeSection;
})();

describe('KSTAR 复盘详情的加载/失败态（views）', () => {
  it('状态缺席或 loading 时显示读取中文案', () => {
    NS.store.kstarEpisode = undefined;
    expect(section({ kstarEpisodeId: 'kse-a' })).toContain('正在读取这次任务的经过');

    NS.store.kstarEpisode = { episodeId: 'kse-a', loading: true, failed: false };
    expect(section({ kstarEpisodeId: 'kse-a' })).toContain('正在读取这次任务的经过');
  });

  it('failed 时如实说读不出，并给「收起」出口（收起再点开即重试）', () => {
    NS.store.kstarEpisode = { episodeId: 'kse-a', loading: false, failed: true };
    const html = section({ kstarEpisodeId: 'kse-a' });
    expect(html).toContain('这次没读出这块内容');
    expect(html).toContain('data-act="open-kstar-episode"');
    // 不再冒充详情：失败块不得渲染出空的数据行容器。
    expect(html).not.toContain('meta-row');
  });

  it('正常数据照旧渲染任务经过详情（回归）', () => {
    NS.store.kstarEpisode = {
      episodeId: 'kse-a', loading: false, failed: false,
      episode: { goal: '整理季度 OKR' },
      review: { expectedResult: '对齐三个目标', actualResult: '对齐了两个', outcome: 'worse_than_expected', lesson: '先约关键人' },
    };
    const html = section({ kstarEpisodeId: 'kse-a' });
    expect(html).toContain('整理季度 OKR');
    expect(html).toContain('比预期差');
    expect(html).toContain('先约关键人');
    expect(html).not.toContain('正在读取这次任务的经过');
  });
});
