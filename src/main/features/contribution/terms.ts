/**
 * 社区贡献条款读取（契约 C-01）。
 *
 * ## 为什么走 marketplace 的 api base 而不是 hub_account 的
 *
 * `hub_account/client.ts` 的 `HubClient` 是**账号服务**的客户端，方法全是账号操作
 * （`me` / `bind` / `listDevices` / `consents` / …），base 指向账号服务。
 * 贡献端点按跨端契约「位于现有 api base 的 `/marketplace/contributions/` 路径族，
 * **与迭代一 A-01 / A-02 同一 base，不新增网关**」——那是 `marketplace.apiBase()`。
 * 把贡献端点挂进账号客户端会把两个服务混成一个。
 *
 * ## 为什么不复用 `marketplace.postJson`
 *
 * 条款接口是 **GET** 且**匿名可访问**（C-01 §1），而 `postJson` 固定 POST 且
 * 会走迭代一的信封校验。这里另写一个 GET 是因为方法与鉴权语义都不同，不是重复造轮子；
 * 请求头仍复用 `withCommonHeaders`，不另起一套。
 *
 * ## `open=false` 与「读取失败」必须分开
 *
 * C-01 §2：后台未配置生效版本时服务端返回 `{ open: false, terms: null }`——那是
 * **一个明确的答复**。网络不可达、服务端未实现、响应不可解析是**没有答复**。
 * 两者在 UI 上都表现为"现在不能贡献"，但前者该说"暂未开放"，后者该说"无法获取"，
 * 且后者可重试。合并会让一次服务端故障看起来像产品状态。
 */
import { createLogger } from '../../logger';
import { readTerms } from './hub-client';

const log = createLogger('contribution/terms');

let cached: { etag: string | null; state: TermsState } | null = null;

export interface ContributionTerms {
  version: string;
  effective_at: string;
  body_markdown: string;
}

export type TermsState =
  /** 服务端明确答复：有生效条款。 */
  | { status: 'open'; terms: ContributionTerms }
  /** 服务端明确答复：当前无生效版本。**不是错误**。 */
  | { status: 'closed' }
  /** 没有拿到答复。可重试，UI 措辞须与 `closed` 区分。 */
  | { status: 'unavailable'; reason: string };

/**
 * 读取当前生效条款。
 *
 * 永不抛错：任何失败落 `unavailable` 并带机器原因，由调用方决定提示还是重试。
 */
export async function fetchTerms(): Promise<TermsState> {
  try {
    const response = await readTerms(cached?.etag || undefined);
    if (response.notModified && cached) return cached.state;
    const data = response.body;
    if (!data) return { status: 'unavailable', reason: 'empty_response' };

    if (data.open !== true) {
      // 明确答复"无生效版本"。`terms` 为 null 时也走这里。
      const state: TermsState = { status: 'closed' };
      cached = { etag: response.etag, state };
      return state;
    }

    const t = data.terms as Record<string, unknown> | null | undefined;
    const version = typeof t?.version === 'string' ? t.version : '';
    const body = typeof t?.body_markdown === 'string' ? t.body_markdown : '';
    if (!version || !body) {
      // `open: true` 却没有可展示的条款：契约不成立，按未拿到答复处理——
      // 让贡献者在看不到条款正文的情况下"接受条款"是不可接受的。
      return { status: 'unavailable', reason: 'terms_incomplete' };
    }
    const state: TermsState = {
      status: 'open',
      terms: {
        version,
        effective_at: typeof t?.effective_at === 'string' ? t.effective_at : '',
        body_markdown: body,
      },
    };
    cached = { etag: response.etag, state };
    return state;
  } catch (err) {
    const reason = (err as Error).name === 'AbortError' ? 'timeout' : 'network';
    log.warn('terms fetch failed', { reason });
    return { status: 'unavailable', reason };
  }
}

export function _resetTermsCacheForTest(): void { cached = null; }
