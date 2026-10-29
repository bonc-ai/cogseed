/**
 * 模块 A 客户端侧：本地授权存储 + 平台基址解析。
 *
 * 这里测的是**真实文件系统**（<uid>/local/packages/.secrets/），不 mock fs：
 * 存储的整个意义就是"断电/重启后还在"，用 mock 测等于没测。
 * 只把 uid 指到临时目录（test/setup-env.ts 已把 workspace root 钉在临时目录）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  clearPluginOAuth,
  generatePkce,
  pluginOAuthFile,
  readPluginOAuth,
  writePluginOAuth,
  type PluginOAuthRecord,
} from '../../../src/main/features/plugin_oauth_store';
import {
  DEV_EDUSEED_BASE,
  EDU_BASE_PATH,
  RELEASE_EDUSEED_BASE,
  joinApiUrl,
  platformApiBase,
  resolveEduSeedBase,
  validatePlatformServerUrl,
} from '../../../src/main/features/plugin_platform_url';

const UID = 'test-uid-oauth-store';

function record(over: Partial<PluginOAuthRecord> = {}): PluginOAuthRecord {
  return {
    server_url: 'https://platform.example.test/edu',
    tokens: {
      access_token: 'pat_plaintext_access_token_value',
      refresh_token: 'prt_plaintext_refresh_token_value',
      access_expires_at: '2026-09-20T13:00:00.000Z',
      refresh_expires_at: '2026-10-20T12:00:00.000Z',
      binding: { person_id: '2025xxxx', role: 'student' },
    },
    ...over,
  };
}

beforeEach(() => {
  clearPluginOAuth(UID, 'demo-pkg');
  clearPluginOAuth(UID, 'other-pkg');
});

afterEach(() => {
  clearPluginOAuth(UID, 'demo-pkg');
  clearPluginOAuth(UID, 'other-pkg');
});

describe('plugin oauth store', () => {
  it('未授权时返回空记录且 corrupt=false（"从没授权"与"坏了"必须可区分）', () => {
    const r = readPluginOAuth(UID, 'demo-pkg');
    expect(r.record).toEqual({});
    expect(r.corrupt).toBe(false);
  });

  it('🔴 磁盘上不得出现明文令牌（加密落盘）', () => {
    expect(writePluginOAuth(UID, 'demo-pkg', record()).ok).toBe(true);
    const raw = fs.readFileSync(pluginOAuthFile(UID, 'demo-pkg'), 'utf8');
    expect(raw).not.toContain('pat_plaintext_access_token_value');
    expect(raw).not.toContain('prt_plaintext_refresh_token_value');
    expect(raw).toContain('oauth_enc');
  });

  it('往返一致（写入什么读回什么）', () => {
    writePluginOAuth(UID, 'demo-pkg', record());
    const r = readPluginOAuth(UID, 'demo-pkg');
    expect(r.corrupt).toBe(false);
    expect(r.record.tokens?.access_token).toBe('pat_plaintext_access_token_value');
    expect(r.record.tokens?.binding?.person_id).toBe('2025xxxx');
    expect(r.record.server_url).toBe('https://platform.example.test/edu');
  });

  it('🔴 令牌文件不进 cloud/（会同步 → 两设备共用 refresh 必然触发重放检测）', () => {
    writePluginOAuth(UID, 'demo-pkg', record());
    const file = pluginOAuthFile(UID, 'demo-pkg');
    expect(file).toContain(`${path.sep}local${path.sep}`);
    expect(file).not.toContain(`${path.sep}cloud${path.sep}`);
    expect(path.basename(file)).toBe('demo-pkg.oauth.json');
  });

  it('🔴 与 PluginRuntimeConfig 不同文件（保存配置会整文件覆写 → 并存会丢令牌）', () => {
    const oauthFile = pluginOAuthFile(UID, 'demo-pkg');
    const configFile = path.join(path.dirname(oauthFile), 'demo-pkg.json');
    expect(oauthFile).not.toBe(configFile);
  });

  it('文件权限 0600', () => {
    writePluginOAuth(UID, 'demo-pkg', record());
    if (process.platform === 'win32') return;
    const mode = fs.statSync(pluginOAuthFile(UID, 'demo-pkg')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('🔴 缺任一必填字段 → 当作没有令牌（半条记录去刷新 = 触发重放）', () => {
    for (const missing of ['access_token', 'refresh_token', 'access_expires_at', 'refresh_expires_at'] as const) {
      const full = record();
      const tokens = { ...full.tokens! } as Record<string, unknown>;
      delete tokens[missing];
      writePluginOAuth(UID, 'demo-pkg', { ...full, tokens: tokens as never });
      expect(readPluginOAuth(UID, 'demo-pkg').record.tokens, missing).toBeUndefined();
      clearPluginOAuth(UID, 'demo-pkg');
    }
  });

  it('写入空记录 = 删除文件（"未授权"在磁盘上只有一个表示）', () => {
    writePluginOAuth(UID, 'demo-pkg', record());
    expect(fs.existsSync(pluginOAuthFile(UID, 'demo-pkg'))).toBe(true);
    clearPluginOAuth(UID, 'demo-pkg');
    expect(fs.existsSync(pluginOAuthFile(UID, 'demo-pkg'))).toBe(false);
  });

  it('🔴 密文损坏 → corrupt=true 且不抛错（界面提示重新连接，而不是崩在这）', () => {
    const file = pluginOAuthFile(UID, 'demo-pkg');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, oauth_enc: 'not-a-real-ciphertext' }));
    const r = readPluginOAuth(UID, 'demo-pkg');
    expect(r.corrupt).toBe(true);
    expect(r.record).toEqual({});
  });

  it('文件不是合法 JSON → corrupt=true', () => {
    const file = pluginOAuthFile(UID, 'demo-pkg');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{oops');
    expect(readPluginOAuth(UID, 'demo-pkg').corrupt).toBe(true);
  });

  it('非法包名（路径穿越）一律拒绝，且不触碰文件系统', () => {
    for (const bad of ['../evil', 'a/b', '.hidden', '']) {
      expect(writePluginOAuth(UID, bad, record()).ok).toBe(false);
      expect(readPluginOAuth(UID, bad).record).toEqual({});
    }
  });

  it('两个包各自独立（互不覆盖）', () => {
    writePluginOAuth(UID, 'demo-pkg', record());
    writePluginOAuth(UID, 'other-pkg', record({ server_url: 'https://other.test/edu' }));
    expect(readPluginOAuth(UID, 'demo-pkg').record.server_url).toBe('https://platform.example.test/edu');
    expect(readPluginOAuth(UID, 'other-pkg').record.server_url).toBe('https://other.test/edu');
  });

  it('pending 流程可往返（含 code_verifier），同样加密', () => {
    writePluginOAuth(UID, 'demo-pkg', {
      server_url: 'https://platform.example.test/edu',
      pending: {
        state: 'state-xyz',
        code_verifier: 'verifier-abc',
        server_url: 'https://platform.example.test/edu',
        created_at: '2026-09-20T12:00:00.000Z',
      },
    });
    const raw = fs.readFileSync(pluginOAuthFile(UID, 'demo-pkg'), 'utf8');
    expect(raw).not.toContain('verifier-abc');
    expect(readPluginOAuth(UID, 'demo-pkg').record.pending?.code_verifier).toBe('verifier-abc');
  });

  it('last_error 只存错误码（不存服务端原文）', () => {
    writePluginOAuth(UID, 'demo-pkg', { last_error: { code: 'INELIGIBLE', at: '2026-09-20T12:00:00.000Z' } });
    expect(readPluginOAuth(UID, 'demo-pkg').record.last_error?.code).toBe('INELIGIBLE');
  });
});

describe('generatePkce', () => {
  it('🔴 state 与 verifier 每次都不同（不可猜测性是防 CSRF / 防拦截的唯一依据）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generatePkce();
      expect(seen.has(p.state)).toBe(false);
      expect(seen.has(p.codeVerifier)).toBe(false);
      seen.add(p.state);
      seen.add(p.codeVerifier);
    }
  });

  it('🔴 code_challenge == BASE64URL(SHA256(verifier))（RFC 7636 S256）', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const { codeVerifier, codeChallenge } = generatePkce();
    const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('长度与字符集符合 base64url（无 + / =，URL 查询参数安全）', () => {
    const { state, codeVerifier, codeChallenge } = generatePkce();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('platform url resolution', () => {
  it('🔴 platformApiBase 保留子路径（丢掉 /edu 会静默 404）', () => {
    expect(platformApiBase('https://cogseed-open.bonc.com.cn/edu')).toBe('https://cogseed-open.bonc.com.cn/edu');
    expect(platformApiBase('https://cogseed-open.bonc.com.cn/edu/')).toBe('https://cogseed-open.bonc.com.cn/edu');
    expect(platformApiBase('http://localhost:3000/edu')).toBe('http://localhost:3000/edu');
  });

  it('validatePlatformServerUrl 只给 origin（校验语义，不能拿它拼接口）', () => {
    expect(validatePlatformServerUrl('https://a.test/edu')).toBe('https://a.test');
    expect(platformApiBase('https://a.test/edu')).toBe('https://a.test/edu');
  });

  it('拒绝带账号密码 / 查询 / 片段的地址（防密钥随 URL 外泄）', () => {
    for (const bad of ['https://u:p@a.test/edu', 'https://a.test/edu?x=1', 'https://a.test/edu#f', 'ftp://a.test', 'not a url', '']) {
      expect(platformApiBase(bad)).toBeNull();
      expect(validatePlatformServerUrl(bad)).toBeNull();
    }
  });

  it('joinApiUrl 正确处理带/不带子路径的基址', () => {
    expect(joinApiUrl('https://a.test/edu', '/api/oauth/token')).toBe('https://a.test/edu/api/oauth/token');
    expect(joinApiUrl('https://a.test/edu/', 'api/oauth/token')).toBe('https://a.test/edu/api/oauth/token');
  });

  it('EDU_BASE_PATH 与平台 BASE_PATH 一致', () => {
    expect(EDU_BASE_PATH).toBe('/edu');
    expect(RELEASE_EDUSEED_BASE.endsWith('/edu')).toBe(true);
    expect(DEV_EDUSEED_BASE.endsWith('/edu')).toBe(true);
  });

  it('显式地址优先于环境变量与通道默认值', () => {
    expect(resolveEduSeedBase('https://self.test/edu', { EDUSEED_PLATFORM_BASE_URL: 'https://env.test/edu' }))
      .toBe('https://self.test/edu');
  });

  it('无显式地址时用环境变量覆盖（本地联调/部署覆盖）', () => {
    expect(resolveEduSeedBase(undefined, { EDUSEED_PLATFORM_BASE_URL: 'https://env.test/edu' }))
      .toBe('https://env.test/edu');
  });

  it('都没有时按构建通道取默认值（release → 生产；dev → 本地）', () => {
    expect(resolveEduSeedBase(undefined, { COGSEED_BUILD_CHANNEL: 'release' })).toBe(RELEASE_EDUSEED_BASE);
    expect(resolveEduSeedBase(undefined, { COGSEED_BUILD_CHANNEL: 'dev' })).toBe(DEV_EDUSEED_BASE);
  });

  it('显式地址非法时回落到环境变量（不因为一个坏地址就完全没平台）', () => {
    expect(resolveEduSeedBase('not a url', { EDUSEED_PLATFORM_BASE_URL: 'https://env.test/edu' }))
      .toBe('https://env.test/edu');
  });
});

// ---------------------------------------------------------------------------
// 物化凭据的残留清理（安全审计 2026-09-21）
//
// 背景：`<uid>/local/packages/.secrets/<包名>.runtime.json` 里是**明文令牌**
// （run-skill.cjs 读不了加密文件，只能读它）。原实现只在"主动断开授权"时删除，
// 于是**令牌自然过期**与**续期失败**两条路径都会把凭据形状的字符串留在盘上；
// 原子写（writeFileSync → rename）的 `.tmp` 崩溃残留也从没人清。
// ---------------------------------------------------------------------------
describe('sweepStaleRuntimeCredentials', () => {
  const secretsDir = () => path.join(process.env.COGSEED_WORKSPACE_ROOT!, UID, 'local', 'packages', '.secrets');

  beforeEach(() => {
    fs.rmSync(path.join(process.env.COGSEED_WORKSPACE_ROOT!, UID), { recursive: true, force: true });
    fs.mkdirSync(secretsDir(), { recursive: true });
  });

  const write = (name: string, body: string) => fs.writeFileSync(path.join(secretsDir(), name), body, { mode: 0o600 });

  it('删掉已过期的物化凭据，保留仍然有效的那个', async () => {
    const { sweepStaleRuntimeCredentials } = await import('../../../src/main/features/plugin_oauth_store');
    const now = Date.parse('2026-09-21T10:00:00.000Z');
    write('expired-pkg.runtime.json', JSON.stringify({ api_key: 'pat_dead', expires_at: '2026-09-21T09:00:00.000Z' }));
    write('live-pkg.runtime.json', JSON.stringify({ api_key: 'pat_live', expires_at: '2026-09-21T11:00:00.000Z' }));

    const r = sweepStaleRuntimeCredentials(UID, now);
    expect(r.removedExpired).toBe(1);
    expect(fs.existsSync(path.join(secretsDir(), 'expired-pkg.runtime.json'))).toBe(false);
    expect(fs.existsSync(path.join(secretsDir(), 'live-pkg.runtime.json'))).toBe(true);
  });

  it('🔴 清掉原子写留下的 *.tmp（runtime 的 tmp 里同样是明文令牌）', async () => {
    const { sweepStaleRuntimeCredentials } = await import('../../../src/main/features/plugin_oauth_store');
    write('pkg.runtime.json.tmp', JSON.stringify({ api_key: 'pat_plaintext_in_tmp' }));
    write('pkg.oauth.json.tmp', '{}');
    const r = sweepStaleRuntimeCredentials(UID, Date.now());
    expect(r.removedTmp).toBe(2);
    expect(fs.readdirSync(secretsDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('expires_at 读不出来时**不删**（宁可留一个不可用的，也不误删刚写好的）', async () => {
    const { sweepStaleRuntimeCredentials } = await import('../../../src/main/features/plugin_oauth_store');
    write('weird.runtime.json', JSON.stringify({ api_key: 'pat_x' }));
    const r = sweepStaleRuntimeCredentials(UID, Date.now());
    expect(r.removedExpired).toBe(0);
    expect(fs.existsSync(path.join(secretsDir(), 'weird.runtime.json'))).toBe(true);
  });

  it('目录不存在时不抛错（未接入插件的用户）', async () => {
    const { sweepStaleRuntimeCredentials } = await import('../../../src/main/features/plugin_oauth_store');
    fs.rmSync(path.join(process.env.COGSEED_WORKSPACE_ROOT!, UID), { recursive: true, force: true });
    expect(() => sweepStaleRuntimeCredentials(UID, Date.now())).not.toThrow();
  });
});
