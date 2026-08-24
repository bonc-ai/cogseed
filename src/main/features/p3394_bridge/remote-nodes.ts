import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { p3394StateFile } from './runtime-paths';
import { P3394HttpChannel } from './http-channel';

/**
 * 第二期 Dashboard：远端 P3394 节点的配置存储与连通性校验。
 * 配置存 per-variant 状态目录（与 p3394-peers.json 相邻）；token 只落
 * 机器私有文件，返回渲染层时打码。
 */

export interface P3394RemoteNode {
  id: string;
  label: string;
  endpoint: string;
  token: string;
  expected_identity?: string;
  enabled: boolean;
  created_at: string;
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
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
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

export function listRemoteNodes(): { ok: true; nodes: P3394RemoteNodeView[] } {
  const data = readFile();
  return { ok: true, nodes: Object.values(data.nodes).map(toView) };
}

export function addRemoteNode(input: {
  label?: unknown;
  endpoint?: unknown;
  token?: unknown;
  expected_identity?: unknown;
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
  };
  data.nodes[id] = node;
  writeFile(data);
  return { ok: true, node: toView(node) };
}

export function removeRemoteNode(id: unknown): { ok: boolean; error?: { reason: string; message: string } } {
  if (typeof id !== 'string' || !id) return { ok: false, error: { reason: 'invalid_id', message: '节点 id 无效' } };
  const data = readFile();
  if (!data.nodes[id]) return { ok: false, error: { reason: 'not_found', message: '节点不存在' } };
  delete data.nodes[id];
  writeFile(data);
  return { ok: true };
}

export type RemoteNodeTestResult =
  | { ok: true; peer_agent_id: string }
  | { ok: false; error: { reason: string; message: string } };

/** 连通性校验：地址不通 / 令牌不对 / 身份不符 各有独立错误码。 */
export async function testRemoteNode(input: {
  endpoint?: unknown;
  token?: unknown;
  expected_identity?: unknown;
}): Promise<RemoteNodeTestResult> {
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!endpoint) return { ok: false, error: { reason: 'invalid_endpoint', message: '远端节点地址无效' } };
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  const expectedIdentity = typeof input.expected_identity === 'string' && input.expected_identity.trim()
    ? input.expected_identity.trim()
    : undefined;
  const channel = new P3394HttpChannel('remote-probe', {
    dial: {
      endpoints: [endpoint],
      bearerToken: token,
      ...(expectedIdentity ? { expected_identity: expectedIdentity } : {}),
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
