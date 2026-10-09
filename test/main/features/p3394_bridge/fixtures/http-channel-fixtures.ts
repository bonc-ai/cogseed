/**
 * HTTP channel 级 accepted/rejected fixture 目录（Conformance Matrix V-02）。
 *
 * 与 envelope 层 fixture（umf-envelopes.ts）同一约定：每条 fixture 带稳定
 * id 与矩阵 ID。每条 fixture 声明自己的 channel 配置（body 上限 / 速率等），
 * 由 http-fixtures.test.ts 在真实 listener 上逐个执行并断言状态码 + 机器
 * 可读错误码。
 */

export interface P3394HttpChannelFixtureRequest {
  method: 'GET' | 'POST';
  path: string;
  /** Bearer token（缺省不带 Authorization 头）。 */
  token?: string;
  /** POST body 信封（会被序列化为 { envelope: body }）。 */
  envelope?: unknown;
  /** 原始 body（覆盖 envelope 序列化，用于非法 JSON 等形态）。 */
  rawBody?: string;
}

export interface P3394HttpChannelFixture {
  id: string;
  matrix: string[];
  name: string;
  /** 专用 channel 配置（如 tiny body 上限 / 速率 1）。 */
  channelOptions?: { maxBodyBytes?: number; maxInboundRequestsPerMinute?: number };
  /** 断言前先执行 N 次相同请求（用于消耗速率预算）。 */
  warmups?: number;
  request: P3394HttpChannelFixtureRequest;
  expected: { status: number; error: string };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-http-fixture',
    session_id: 'ses-http-fixture',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'remote-agent' },
    recipients: [{ agent_id: 'cogseed-agent' }],
    payload: { parts: [{ type: 'text', text: 'hello over http' }] },
    idempotency_key: 'idem-http-fixture',
    ...overrides,
  };
}

/** 每类拒绝错误码至少一条 fixture（http-fixtures.test.ts 断言穷尽）。 */
export const HTTP_CHANNEL_ERROR_CODES = [
  'unauthorized',
  'missing_spec_version',
  'unsupported_kind',
  'invalid_json',
  'missing_envelope',
  'payload_too_large',
  'rate_limited',
] as const;

export const HTTP_CHANNEL_FIXTURES: P3394HttpChannelFixture[] = [
  // ── accepted ──
  {
    id: 'A-C04-01',
    matrix: ['C-04'],
    name: 'health 探活免认证 200',
    request: { method: 'GET', path: '/p3394/health' },
    expected: { status: 200, error: '' },
  },
  {
    id: 'A-M01-06',
    matrix: ['M-01', 'C-04'],
    name: 'Bearer 认证后 envelope 投递 200',
    request: { method: 'POST', path: '/p3394/envelope', token: 'tok', envelope: envelope() },
    expected: { status: 200, error: '' },
  },
  // ── rejected ──
  {
    id: 'R-C04-01',
    matrix: ['C-04', 'S-03'],
    name: '错误 token 访问 manifest → 401 unauthorized',
    request: { method: 'GET', path: '/p3394/manifest', token: 'wrong' },
    expected: { status: 401, error: 'unauthorized' },
  },
  {
    id: 'R-M01-13',
    matrix: ['M-01'],
    name: '缺失 spec_version → 422 missing_spec_version',
    request: {
      method: 'POST',
      path: '/p3394/envelope',
      token: 'tok',
      envelope: (() => {
        const raw = envelope();
        delete raw.spec_version;
        return raw;
      })(),
    },
    expected: { status: 422, error: 'missing_spec_version' },
  },
  {
    id: 'R-M02-04',
    matrix: ['M-02'],
    name: '不支持的 kind → 422 unsupported_kind',
    request: { method: 'POST', path: '/p3394/envelope', token: 'tok', envelope: envelope({ kind: 'unknown' }) },
    expected: { status: 422, error: 'unsupported_kind' },
  },
  {
    id: 'R-M01-14',
    matrix: ['M-01'],
    name: '非法 JSON body → 400 invalid_json',
    request: { method: 'POST', path: '/p3394/envelope', token: 'tok', rawBody: '{not-json' },
    expected: { status: 400, error: 'invalid_json' },
  },
  {
    id: 'R-M01-15',
    matrix: ['M-01'],
    name: 'body 不含 envelope → 400 missing_envelope',
    request: { method: 'POST', path: '/p3394/envelope', token: 'tok', rawBody: '{}' },
    expected: { status: 400, error: 'missing_envelope' },
  },
  {
    id: 'R-M05-07',
    matrix: ['M-05', 'S-06'],
    name: 'body 超上限 → 413 payload_too_large',
    channelOptions: { maxBodyBytes: 64 },
    request: { method: 'POST', path: '/p3394/envelope', token: 'tok', envelope: envelope({ message_id: 'msg-http-fixture-big', idempotency_key: 'idem-http-fixture-big' }) },
    expected: { status: 413, error: 'payload_too_large' },
  },
  {
    id: 'R-S06-01',
    matrix: ['S-06'],
    name: '入站速率超限 → 429 rate_limited',
    channelOptions: { maxInboundRequestsPerMinute: 1 },
    warmups: 1,
    request: { method: 'GET', path: '/p3394/manifest', token: 'tok' },
    expected: { status: 429, error: 'rate_limited' },
  },
];
