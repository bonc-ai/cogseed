import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { p3394StateFile } from './runtime-paths';
import { P3394HttpChannel } from './http-channel';

/**
 * 第二期 Dashboard：远端 P3394 节点的配置存储与连通性校验。
 * 配置存 per-variant 状态目录（与 p3394-peers.json 相邻）；token 只落
 * 机器私有文件（0600），返回渲染层时打码。
 */

/** per-node TLS 信任材料（PEM 字符串或文件路径；§15：endpoint 为 https 时
 *  出站 dial 使用——ca 校验对端，cert/key 携带 mTLS 客户端证书）。 */
export interface P3394RemoteNodeTls {
  ca?: string;
  cert?: string;
  key?: string;
}

export interface P3394RemoteNode {
  id: string;
  label: string;
  endpoint: string;
  token: string;
  expected_identity?: string;
  enabled: boolean;
  created_at: string;
  /** 可选 per-node TLS 材料（endpoint https 时出站用）。 */
  tls?: P3394RemoteNodeTls;
}

/** 渲染层视图：token 打码，永远不回明文。 */
export interface P3394RemoteNodeView {
  id: string;
  label: string;
  endpoint: string;
  tokenPreview: string;
  expected_identity?: string;
  enabled: boolean;
  created_at: string;
}

interface RemoteNodesFile {
  schema_version: 1;
  nodes: Record<string, P3394RemoteNode>;
}

function stateFilePath(): string {
  return p3394StateFile('p3394-remote-nodes.json');
}

function readFile(): RemoteNodesFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) as Partial<RemoteNodesFile>;
    if (parsed && parsed.schema_version === 1 && parsed.nodes && typeof parsed.nodes === 'object') {
      return parsed as RemoteNodesFile;
    }
  } catch { /* missing / malformed → fresh */ }
  return { schema_version: 1, nodes: {} };
}

function writeFile(data: RemoteNodesFile): void {
  const file = stateFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  // 0600 + tmp/rename 原子写：文件含明文 dial token（以及可选 TLS 私钥
  // 路径），必须仅本用户可读，且读者永远不会看到半截 JSON。
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort（umask 兜底之上的显式收紧） */ }
  fs.renameSync(tmp, file);
  notifyRemoteNodesChanged();
}

/** remote-nodes 变更通知（app-wiring 注册：触发注册表 re-sync）。 */
type RemoteNodesListener = () => void;
let changeListener: RemoteNodesListener | null = null;

export function setRemoteNodesChangedListener(listener: RemoteNodesListener | null): void {
  changeListener = listener;
}

function notifyRemoteNodesChanged(): void {
  try { changeListener?.(); } catch { /* 监听方故障不影响存储写入 */ }
}

/** main 进程内部读取（明文，含 token/tls）：供注册表注入与出站 TLS 材料
 *  匹配使用；渲染层永远走 listRemoteNodes 的打码视图。 */
export function listRemoteNodesInternal(): P3394RemoteNode[] {
  return Object.values(readFile().nodes);
}

function normalizeEndpoint(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function toView(node: P3394RemoteNode): P3394RemoteNodeView {
  return {
    id: node.id,
    label: node.label,
    endpoint: node.endpoint,
    tokenPreview: node.token ? `${node.token.slice(0, 4)}…${node.token.slice(-2)}` : '',
    ...(node.expected_identity ? { expected_identity: node.expected_identity } : {}),
    enabled: node.enabled,
    created_at: node.created_at,
  };
}

/** tls 输入校验：只接受非空字符串字段（PEM 或文件路径），其余丢弃。 */
function normalizeTls(input: unknown): P3394RemoteNodeTls | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const pick = (key: 'ca' | 'cert' | 'key'): string | undefined =>
    typeof raw[key] === 'string' && (raw[key] as string).trim() ? (raw[key] as string).trim() : undefined;
  const ca = pick('ca');
  const cert = pick('cert');
  const key = pick('key');
  if (!ca && !cert && !key) return undefined;
  return { ...(ca ? { ca } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}) };
}

export function listRemoteNodes(): { ok: true; nodes: P3394RemoteNodeView[] } {
  const data = readFile();
  return { ok: true, nodes: Object.values(data.nodes).map(toView) };
}

export function addRemoteNode(input: {
  label?: unknown;
  endpoint?: unknown;
  token?: unknown;
  expected_identity?: unknown;
  tls?: unknown;
}): { ok: true; node: P3394RemoteNodeView } | { ok: false; error: { reason: string; message: string } } {
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!endpoint) {
    return { ok: false, error: { reason: 'invalid_endpoint', message: '远端节点地址无效（需要 http(s)://host:port）' } };
  }
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!token) {
    return { ok: false, error: { reason: 'invalid_token', message: '访问令牌不能为空' } };
  }
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 80) : endpoint;
  const expectedIdentity = typeof input.expected_identity === 'string' && input.expected_identity.trim()
    ? input.expected_identity.trim()
    : undefined;
  const tls = normalizeTls(input.tls);
  const data = readFile();
  const duplicate = Object.values(data.nodes).find((node) => node.endpoint === endpoint);
  if (duplicate) {
    return { ok: false, error: { reason: 'duplicate_endpoint', message: `该端点已配置为「${duplicate.label}」` } };
  }
  const id = `remote_${crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 12)}`;
  const node: P3394RemoteNode = {
    id,
    label,
    endpoint,
    token,
    ...(expectedIdentity ? { expected_identity: expectedIdentity } : {}),
    enabled: true,
    created_at: new Date().toISOString(),
    ...(tls ? { tls } : {}),
  };
  data.nodes[id] = node;
  writeFile(data);
  return { ok: true, node: toView(node) };
}

export function removeRemoteNode(id: unknown): { ok: boolean; expected_identity?: string; error?: { reason: string; message: string } } {
  if (typeof id !== 'string' || !id) return { ok: false, error: { reason: 'invalid_id', message: '节点 id 无效' } };
  const data = readFile();
  const node = data.nodes[id];
  if (!node) return { ok: false, error: { reason: 'not_found', message: '节点不存在' } };
  delete data.nodes[id];
  writeFile(data);
  // 把被删节点的期望身份带回给调用方（IPC 层据此撤销花名册注册）。
  return { ok: true, expected_identity: node.expected_identity };
}

/** 编辑远端节点：label/期望身份/endpoint/token/tls 任意子集；
 * 未传 token 保留原值；endpoint 变更做去重校验。 */
export function updateRemoteNode(id: unknown, input: {
  label?: unknown;
  endpoint?: unknown;
  token?: unknown;
  expected_identity?: unknown;
  tls?: unknown;
}): { ok: true; node: P3394RemoteNodeView } | { ok: false; error: { reason: string; message: string } } {
  if (typeof id !== 'string' || !id) return { ok: false, error: { reason: 'invalid_id', message: '节点 id 无效' } };
  const data = readFile();
  const node = data.nodes[id];
  if (!node) return { ok: false, error: { reason: 'not_found', message: '节点不存在' } };
  const nextEndpoint = input.endpoint === undefined ? node.endpoint : normalizeEndpoint(input.endpoint);
  if (input.endpoint !== undefined && !nextEndpoint) {
    return { ok: false, error: { reason: 'invalid_endpoint', message: '远端节点地址无效（需要 http(s)://host:port）' } };
  }
  if (nextEndpoint && nextEndpoint !== node.endpoint) {
    const duplicate = Object.values(data.nodes).find((n) => n.id !== id && n.endpoint === nextEndpoint);
    if (duplicate) {
      return { ok: false, error: { reason: 'duplicate_endpoint', message: `该端点已配置为「${duplicate.label}」` } };
    }
  }
  const nextToken = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : node.token;
  const nextLabel = input.label === undefined
    ? node.label
    : (typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 80) : node.label);
  const nextIdentity = input.expected_identity === undefined
    ? node.expected_identity
    : (typeof input.expected_identity === 'string' && input.expected_identity.trim() ? input.expected_identity.trim() : undefined);
  const nextTls = input.tls === undefined ? node.tls : normalizeTls(input.tls);
  const updated: P3394RemoteNode = {
    ...node,
    label: nextLabel,
    endpoint: nextEndpoint || node.endpoint,
    token: nextToken,
    ...(nextIdentity ? { expected_identity: nextIdentity } : {}),
  };
  // tls 三态：未传保留；传入有效覆盖；传入空/无效清除（...node 会带上旧
  // 值，必须显式删掉）。
  if (input.tls !== undefined) {
    if (nextTls) updated.tls = nextTls;
    else delete updated.tls;
  }
  data.nodes[id] = updated;
  writeFile(data);
  return { ok: true, node: toView(updated) };
}

export type RemoteNodeTestResult =
  | { ok: true; peer_agent_id: string }
  | { ok: false; error: { reason: string; message: string } };

/** 按存储 id 测试（渲染层只有打码 token，明文从磁盘取）。 */
export async function testRemoteNodeById(id: unknown): Promise<RemoteNodeTestResult> {
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: { reason: 'invalid_id', message: '节点 id 无效' } };
  }
  const node = readFile().nodes[id];
  if (!node) return { ok: false, error: { reason: 'not_found', message: '节点不存在' } };
  return testRemoteNode({
    endpoint: node.endpoint,
    token: node.token,
    expected_identity: node.expected_identity,
    ...(node.tls ? { tls: node.tls } : {}),
  });
}

/** 连通性校验：地址不通 / 令牌不对 / 身份不符 各有独立错误码。 */
export async function testRemoteNode(input: {
  endpoint?: unknown;
  token?: unknown;
  expected_identity?: unknown;
  tls?: unknown;
}): Promise<RemoteNodeTestResult> {
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!endpoint) return { ok: false, error: { reason: 'invalid_endpoint', message: '远端节点地址无效' } };
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  const expectedIdentity = typeof input.expected_identity === 'string' && input.expected_identity.trim()
    ? input.expected_identity.trim()
    : undefined;
  const tls = normalizeTls(input.tls);
  const channel = new P3394HttpChannel('remote-probe', {
    dial: {
      endpoints: [endpoint],
      bearerToken: token,
      ...(expectedIdentity ? { expected_identity: expectedIdentity } : {}),
      ...(tls ? { tls } : {}),
    },
    timeoutMs: 8_000,
  });
  try {
    const result = await channel.negotiate();
    if (result.ok === true) return { ok: true, peer_agent_id: result.peer_agent_id };
    const failure = result as Extract<typeof result, { ok: false }>;
    // negotiate 统一返回 negotiation_failed，差异在 message 前缀：
    // p3394_identity_mismatch（身份不符）/ p3394_manifest_http_401（令牌）/ 其他（连接）。
    const message = failure.error.message;
    if (message.includes('identity_mismatch') || message.includes('identity_changed')) {
      return { ok: false, error: { reason: 'identity_mismatch', message: `对端身份与期望不符（期望 ${expectedIdentity || '—'}）` } };
    }
    if (message.includes('_http_401') || message.includes('_http_403')) {
      return { ok: false, error: { reason: 'auth', message: '令牌无效或对端拒绝访问' } };
    }
    return { ok: false, error: { reason: 'unreachable', message: `无法连接对端节点：${message}` } };
  } finally {
    await channel.close().catch(() => {});
  }
}
