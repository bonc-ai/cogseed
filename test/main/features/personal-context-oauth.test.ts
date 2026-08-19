import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OAuthCredential, TokenEndpoint } from '../../../src/main/features/personal_context/oauth-manager';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-pc-oauth-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UID = 'test-user-1';
const PROVIDER = 'feishu';

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    accessToken: 'at_secret_value_123',
    refreshToken: 'rt_secret_value_456',
    tokenType: 'Bearer',
    scopes: ['calendar:calendar'],
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 可编程 mock TokenEndpoint */
function mockEndpoint(overrides: Partial<TokenEndpoint> = {}): TokenEndpoint & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { exchange: [], refresh: [], revoke: [], health: [] };
  return {
    calls,
    async exchangeCode(code: string, redirectUri: string) {
      calls.exchange.push([code, redirectUri]);
      return credential();
    },
    async refreshToken(refreshToken: string) {
      calls.refresh.push([refreshToken]);
      return credential({ accessToken: 'at_refreshed_999' });
    },
    async revokeToken(refreshToken: string) {
      calls.revoke.push([refreshToken]);
    },
    async healthCheck(accessToken: string) {
      calls.health.push([accessToken]);
      return { ok: true };
    },
    ...overrides,
  };
}

async function load() {
  const { OAuthManager } = await import('../../../src/main/features/personal_context/oauth-manager');
  return { OAuthManager };
}

async function loadSecrets() {
  return import('../../../src/main/util/local-secret-store');
}

const authUrl = (state: string) => `https://open.feishu.cn/authorize?state=${state}`;

describe('OAuth 授权状态机', () => {
  it('完整授权流：disconnected → connecting → connected，凭据可解密读取', async () => {
    const { OAuthManager } = await load();
    const endpoint = mockEndpoint();
    const manager = new OAuthManager(endpoint);

    expect((await manager.getStatus(UID, PROVIDER)).kind).toBe('disconnected');
    expect(await manager.getCredential(UID, PROVIDER)).toBeNull();

    const req = await manager.beginAuthorize(UID, PROVIDER, ['calendar:calendar'], authUrl);
    expect(req.state).toBeTruthy();
    expect(req.authUrl).toContain(`state=${req.state}`);
    expect((await manager.getStatus(UID, PROVIDER)).kind).toBe('connecting');

    const status = await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');
    expect(status.kind).toBe('connected');
    expect(status.needsReauth).toBe(false);

    const credential = await manager.getCredential(UID, PROVIDER);
    expect(credential?.accessToken).toBe('at_secret_value_123');
    expect(endpoint.calls.exchange).toHaveLength(1);
    expect(endpoint.calls.exchange[0]).toEqual(['code_abc', 'https://app/callback']);
  });

  it('state 不匹配 → error，不落凭据', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint());
    await manager.beginAuthorize(UID, PROVIDER, [], authUrl);

    const status = await manager.completeAuthorize(UID, PROVIDER, 'code_abc', 'wrong-state', 'https://app/callback');
    expect(status.kind).toBe('error');
    expect(status.needsReauth).toBe(false);
    expect(await manager.getCredential(UID, PROVIDER)).toBeNull();
  });

  it('兑换失败 → error 且保留错误码', async () => {
    const { OAuthManager } = await load();
    const { TokenEndpointError } = await import('../../../src/main/features/personal_context/oauth-manager');
    const manager = new OAuthManager(mockEndpoint({
      async exchangeCode() {
        throw new TokenEndpointError('provider_error', 'scope 校验失败');
      },
    }));
    const req = await manager.beginAuthorize(UID, PROVIDER, ['calendar:calendar'], authUrl);
    const status = await manager.completeAuthorize(UID, PROVIDER, 'code_bad', req.state, 'https://app/callback');
    expect(status.kind).toBe('error');
    expect(await manager.getCredential(UID, PROVIDER)).toBeNull();
  });
});

describe('OAuth 刷新/健康检查', () => {
  it('刷新成功 → connected 且凭据换新', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint());
    const req = await manager.beginAuthorize(UID, PROVIDER, ['calendar:calendar'], authUrl);
    await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');

    const status = await manager.refresh(UID, PROVIDER);
    expect(status.kind).toBe('connected');
    expect((await manager.getCredential(UID, PROVIDER))?.accessToken).toBe('at_refreshed_999');
  });

  it('刷新 invalid_grant → error + needsReauth', async () => {
    const { OAuthManager } = await load();
    const { TokenEndpointError } = await import('../../../src/main/features/personal_context/oauth-manager');
    const manager = new OAuthManager(mockEndpoint({
      async refreshToken() {
        throw new TokenEndpointError('invalid_grant', 'refresh token 已失效');
      },
    }));
    const req = await manager.beginAuthorize(UID, PROVIDER, [], authUrl);
    await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');

    const status = await manager.refresh(UID, PROVIDER);
    expect(status.kind).toBe('error');
    expect(status.needsReauth).toBe(true);
  });

  it('未授权时刷新 → error + needsReauth', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint());
    const status = await manager.refresh(UID, PROVIDER);
    expect(status.kind).toBe('error');
    expect(status.needsReauth).toBe(true);
  });

  it('健康检查有效 → connected；invalid_grant → error + needsReauth', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint({
      async healthCheck() {
        return { ok: false, error: '令牌已失效', code: 'invalid_grant' };
      },
    }));
    const req = await manager.beginAuthorize(UID, PROVIDER, [], authUrl);
    await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');

    const bad = await manager.healthCheck(UID, PROVIDER);
    expect(bad.kind).toBe('error');
    expect(bad.needsReauth).toBe(true);

    // 换一个健康端点，恢复 connected
    const okManager = new OAuthManager(mockEndpoint());
    const good = await okManager.healthCheck(UID, PROVIDER);
    expect(good.kind).toBe('connected');
    expect(good.needsReauth).toBe(false);
  });

  it('健康检查网络错误 → 保留原连接状态（不误判失效）', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint({
      async healthCheck() {
        return { ok: false, error: 'network timeout', code: 'network_error' };
      },
    }));
    const req = await manager.beginAuthorize(UID, PROVIDER, [], authUrl);
    await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');

    const status = await manager.healthCheck(UID, PROVIDER);
    expect(status.kind).toBe('connected');
  });

  it('未授权时健康检查 → disconnected', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint());
    const status = await manager.healthCheck(UID, PROVIDER);
    expect(status.kind).toBe('disconnected');
  });
});

describe('OAuth 撤销与存储', () => {
  it('撤销 → disconnected，远端 revoke 被调用，本地凭据清除', async () => {
    const { OAuthManager } = await load();
    const endpoint = mockEndpoint();
    const manager = new OAuthManager(endpoint);
    const req = await manager.beginAuthorize(UID, PROVIDER, [], authUrl);
    await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');

    const status = await manager.revoke(UID, PROVIDER);
    expect(status.kind).toBe('disconnected');
    expect(endpoint.calls.revoke).toEqual([['rt_secret_value_456']]);
    expect(await manager.getCredential(UID, PROVIDER)).toBeNull();

    // 再次授权必须重新走全流程（状态不再直接 connected）
    const status2 = await manager.getStatus(UID, PROVIDER);
    expect(status2.kind).toBe('disconnected');
  });

  it('setIdentityLabel 写入后 getStatus 返回授权账号展示名', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint());
    expect((await manager.getStatus(UID, PROVIDER)).identityLabel).toBeUndefined();

    await manager.setIdentityLabel(UID, PROVIDER, ' 张三 ');
    expect((await manager.getStatus(UID, PROVIDER)).identityLabel).toBe('张三');

    // 重启（新实例）后仍能读回：identityLabel 已持久化
    const reloaded = new OAuthManager(mockEndpoint());
    expect((await reloaded.getStatus(UID, PROVIDER)).identityLabel).toBe('张三');
  });

  it('远端 revoke 失败也清除本地凭据（用户意图优先）', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint({
      async revokeToken() {
        throw new Error('remote down');
      },
    }));
    const req = await manager.beginAuthorize(UID, PROVIDER, [], authUrl);
    await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');

    const status = await manager.revoke(UID, PROVIDER);
    expect(status.kind).toBe('disconnected');
    expect(await manager.getCredential(UID, PROVIDER)).toBeNull();
  });

  it('凭据加密落盘：文件不含明文令牌，位于机器私有 local 目录', async () => {
    const { OAuthManager } = await load();
    const secrets = await loadSecrets();
    const manager = new OAuthManager(mockEndpoint());
    const req = await manager.beginAuthorize(UID, PROVIDER, ['calendar:calendar'], authUrl);
    await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');

    const storePath = path.join(tmpDir, UID, 'local', 'config', 'personal-context', `${PROVIDER}.json`);
    expect(fs.existsSync(storePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(raw.providerId).toBe('feishu');
    expect(raw.status.kind).toBe('connected');
    // 加密载荷：可识别为密文且不含明文令牌
    expect(typeof raw.secretsEnc).toBe('string');
    expect(secrets.isEncryptedSecret(raw.secretsEnc)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('at_secret_value_123');
    expect(JSON.stringify(raw)).not.toContain('rt_secret_value_456');
    // 云同步目录下无任何 OAuth 痕迹
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud'))).toBe(false);
  });

  it('凭据文件可被跨进程读取（加密密钥与 uid/provider 绑定）', async () => {
    const { OAuthManager } = await load();
    const manager = new OAuthManager(mockEndpoint());
    const req = await manager.beginAuthorize(UID, PROVIDER, [], authUrl);
    await manager.completeAuthorize(UID, PROVIDER, 'code_abc', req.state, 'https://app/callback');

    // 新实例（模拟重启后）读同一文件
    const { OAuthManager: OAuthManager2 } = await load();
    const manager2 = new OAuthManager2(mockEndpoint());
    const credential = await manager2.getCredential(UID, PROVIDER);
    expect(credential?.accessToken).toBe('at_secret_value_123');
    expect((await manager2.getStatus(UID, PROVIDER)).kind).toBe('connected');
  });
});
