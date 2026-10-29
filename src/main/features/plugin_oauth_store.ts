/**
 * plugin-oauth-store.ts —— 插件授权的本地持久化（模块 A · 客户端侧）
 *
 * 契约：`specs/001-plugin-oauth-auth/contracts/authorization-endpoints.md`
 *       `specs/001-plugin-oauth-auth/contracts/callback-protocol.md` §5（本地存储）
 *
 * 🔴 为什么不并进 `PluginRuntimeConfig` 的那个文件（契约初版是那么写的）：
 *   `plugin_ui.ts::readPluginRuntimeConfig()` 只挑白名单字段（server_url /
 *   api_key / student_id / role / cohort / course_id）返回，而
 *   `savePluginRuntimeConfig()` 是"读旧 → 合并 → **整文件覆写**"。
 *   于是任何一次"保存配置"都会把不在白名单里的 `oauth` 字段**写没**——
 *   用户改一次 API Key 就被登出，而且没有任何报错。
 *   实测确认该覆写路径（`JSON.stringify(out)` 整文件写），因此令牌独立成文件：
 *   同目录（`<uid>/local/packages/.secrets/`，机器私有、不进 cloud/ 同步），
 *   不同文件（`<包名>.oauth.json`），互不覆盖。
 *
 * 🔴 令牌**不得**进 `cloud/`：那是会同步的目录。两个设备共享同一个 refresh
 *   令牌必然触发平台的**重放检测**，后果是该账号**全部会话被撤销**
 *   （见 authorization-endpoints §3）。所以这里连目录都必须是 local。
 *
 * 存储形态沿用 `features/hub_account/tokens.ts` 的既有做法：
 *   · 密文（`util/local-secret-store.ts`，OSS 构建回落到 crypto-vault）
 *   · 绑定上下文 `{ namespace, ownerId: uid, recordId: 包名 }`
 *   · 文件里只有不透明密文 + 极小元数据，**没有任何明文凭据**
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { userPackageSecretsDir } from '../paths';
import { createLogger } from '../logger';
import * as localSecrets from '../util/local-secret-store';

const log = createLogger('plugin-oauth-store');

const NAMESPACE = 'plugin-oauth';

/** 待处理的授权流程（用户在浏览器里还没点完的那一步）。 */
export interface PendingAuthorize {
  /** 客户端生成的一次性随机串（防 CSRF，回调用它比对）。 */
  state: string;
  /** PKCE verifier（S256）。**是凭据**，绝不进日志/界面。 */
  code_verifier: string;
  /** 发起授权时使用的平台基址（含子路径，如 …/edu）。 */
  server_url: string;
  /** ISO 8601；用于 10 分钟超时判定。 */
  created_at: string;
}

/** 一次授权的全部本地状态（整体加密）。 */
export interface PluginOAuthRecord {
  /** 平台基址；令牌与它配套，换平台必须重新授权。 */
  server_url?: string;
  tokens?: {
    access_token: string;
    refresh_token: string;
    access_expires_at: string;
    refresh_expires_at: string;
    binding?: { person_id?: string; role?: string };
  };
  pending?: PendingAuthorize;
  /**
   * 最近一次失败的**错误码**（只存码，不存服务端原文）。
   *
   * 用处：界面要能区分「已失效」（F）与「无课程资格」（D）——
   * 后者不是故障，是"这门课需要合作账号"，必须给出路而不是让人反复重试。
   */
  last_error?: { code: string; at: string };
}

/** 读取结果。`corrupt` 与"从没授权过"必须可区分（否则用户看到的是假象）。 */
export interface PluginOAuthReadResult {
  record: PluginOAuthRecord;
  /** true = 文件在但解不开（密钥变了/文件损坏）→ 界面应让用户重新连接。 */
  corrupt: boolean;
}

function isSafeName(name: unknown): name is string {
  // 与 plugin_ui.ts::isSafePackageName 同规则：包名是单一路径段。
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

function secretContext(uid: string, name: string): localSecrets.LocalSecretContext {
  return { namespace: NAMESPACE, ownerId: uid, recordId: name };
}

/** `<uid>/local/packages/.secrets/<包名>.oauth.json` */
export function pluginOAuthFile(uid: string, name: string): string {
  return path.join(userPackageSecretsDir(uid), `${name}.oauth.json`);
}

/** 读取（解密失败 → `corrupt: true` + 空记录，**不抛错**）。 */
export function readPluginOAuth(uid: string, name: string): PluginOAuthReadResult {
  if (!isSafeName(name)) return { record: {}, corrupt: false };
  let raw: string;
  try {
    raw = fs.readFileSync(pluginOAuthFile(uid, name), 'utf8');
  } catch {
    return { record: {}, corrupt: false }; // 不存在 = 从未授权（正常路径）
  }
  let envelope: { v?: unknown; oauth_enc?: unknown };
  try {
    envelope = JSON.parse(raw) as { v?: unknown; oauth_enc?: unknown };
  } catch {
    log.warn('plugin oauth file unreadable', { package_name: name });
    return { record: {}, corrupt: true };
  }
  const cipher = typeof envelope.oauth_enc === 'string' ? envelope.oauth_enc : '';
  if (!cipher) return { record: {}, corrupt: false };
  let plaintext: string;
  try {
    plaintext = localSecrets.decryptLocalSecret(secretContext(uid, name), cipher);
  } catch (err) {
    // 🔴 绝不把密文/明文写进日志，只记"解不开"这个事实。
    log.warn('plugin oauth decrypt failed', { package_name: name, error: (err as Error).message });
    return { record: {}, corrupt: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { record: {}, corrupt: true };
  }
  return { record: normalizeRecord(parsed), corrupt: false };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 逐字段校验：磁盘内容不可信（可能被手改、可能是旧版本写的）。 */
function normalizeRecord(value: unknown): PluginOAuthRecord {
  if (!value || typeof value !== 'object') return {};
  const src = value as Record<string, unknown>;
  const out: PluginOAuthRecord = {};
  if (str(src.server_url)) out.server_url = str(src.server_url);

  const t = src.tokens as Record<string, unknown> | undefined;
  if (t && typeof t === 'object') {
    const access = str(t.access_token);
    const refresh = str(t.refresh_token);
    const accessExp = str(t.access_expires_at);
    const refreshExp = str(t.refresh_expires_at);
    // 🔴 四个字段缺一不可：缺任何一项就当作没有令牌（宁可让用户重新授权，
    //    也不要拿半条记录去刷新 → 触发重放检测）。
    if (access && refresh && accessExp && refreshExp) {
      const bindingRaw = t.binding as Record<string, unknown> | undefined;
      const binding = bindingRaw && typeof bindingRaw === 'object'
        ? {
            person_id: str(bindingRaw.person_id) || undefined,
            role: str(bindingRaw.role) || undefined,
          }
        : undefined;
      out.tokens = {
        access_token: access,
        refresh_token: refresh,
        access_expires_at: accessExp,
        refresh_expires_at: refreshExp,
        binding: binding && (binding.person_id || binding.role) ? binding : undefined,
      };
    }
  }

  const p = src.pending as Record<string, unknown> | undefined;
  if (p && typeof p === 'object') {
    const state = str(p.state);
    const verifier = str(p.code_verifier);
    const serverUrl = str(p.server_url);
    const createdAt = str(p.created_at);
    if (state && verifier && createdAt) {
      out.pending = { state, code_verifier: verifier, server_url: serverUrl, created_at: createdAt };
    }
  }

  const e = src.last_error as Record<string, unknown> | undefined;
  if (e && typeof e === 'object' && str(e.code) && str(e.at)) {
    out.last_error = { code: str(e.code), at: str(e.at) };
  }
  return out;
}

/**
 * 写入（整体加密 + 原子替换 + 0600）。
 *
 * 传**真正空**的记录（无 tokens、无 pending、无 last_error）时删除文件，
 * 让"未授权"这一状态在磁盘上有唯一表示。
 *
 * 🔴 `last_error` 也算内容：它是"上次为什么没连上"的唯一记录。
 *    若把它当空记录删掉，用户看到的就是"从没连过"，而实际是"无课程资格"
 *    —— 那会让人反复重试一件永远不会成功的事。
 */
export function writePluginOAuth(uid: string, name: string, record: PluginOAuthRecord): { ok: true } | { ok: false; error: string } {
  if (!isSafeName(name)) return { ok: false, error: 'invalid package name' };
  const file = pluginOAuthFile(uid, name);
  const empty = !record.tokens && !record.pending && !record.last_error;
  try {
    if (empty) {
      try { fs.rmSync(file, { force: true }); } catch { /* 已不存在 */ }
      return { ok: true };
    }
    const dir = userPackageSecretsDir(uid);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const oauthEnc = localSecrets.encryptLocalSecret(secretContext(uid, name), JSON.stringify(record));
    const tmp = `${file}.tmp`;
    // 0600 + 原子 rename：半个文件写坏会让用户"莫名需要重新授权"。
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, oauth_enc: oauthEnc }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on win32 */ }
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    log.warn('plugin oauth write failed', { package_name: name, error: message });
    return { ok: false, error: message };
  }
}

/** 清空（撤销/解绑后调用）。 */
export function clearPluginOAuth(uid: string, name: string): void {
  writePluginOAuth(uid, name, {});
}

/**
 * 生成 PKCE 参数（S256）。
 *
 * `state` 与 `code_verifier` 都用 `crypto.randomBytes(32)` —— 不可猜测性是
 * 防 CSRF（state）与防授权码拦截（PKCE）的**唯一**依据，不能用时间戳/自增。
 */
export function generatePkce(): { state: string; codeVerifier: string; codeChallenge: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const state = crypto.randomBytes(32).toString('base64url');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { state, codeVerifier, codeChallenge };
}

// ── 运行时凭据（给 bin/run-skill.cjs 读的"物化"文件） ──────────────────────
//
// 🔴 为什么需要它（2026-09-21 真机实测的第七个缺口）：
//   对话里让智能体调插件时，走的是 `bin/run-skill.cjs`
//   （`injectPackageRuntimeSecrets`），它读的是**旧的手工配置文件**
//   `<pkg>.json` 里的明文 `api_key`。而授权令牌存在**加密**的
//   `<pkg>.oauth.json` 里 —— 那条路径**完全不认识它**。
//   结果：授权成功、插件页显示"已连接"，但用户一说「我的挑战有哪些」，
//   智能体拿到的是"缺少 EDUSEED_* 三件套"，功能等于没接上。
//
// 为什么不直接在 run-skill.cjs 里解密 oauth 文件：
//   · 解密依赖 `util/crypto-vault`（TS，且密钥派生规则属于主进程内部约定），
//     在 bin/ 下的独立 CJS 脚本里复制一份必然漂移；
//   · 令牌**刷新**需要 Hub 会话与网络调用，那是主进程的职责，
//     不该下沉到每次技能运行都要跑一遍的脚本里。
//
// 所以由主进程**在每次解析出可用凭据后**把当前有效的令牌物化到这个文件，
// run-skill.cjs 只做一件简单的事：读它、判过期、注入。字段与旧配置**完全同形**
// （`applyPackageSecrets` 原样可用），另加 `expires_at` 供过期判断。
//
// 安全：与既有的 `<pkg>.json`（同样存明文 api_key）同级，0600、机器私有、
// 不进 cloud/ 同步；文件里**只有当前有效令牌**，刷新即覆盖，撤销即删除。

/** 运行时凭据文件的字段：与 `<pkg>.json` 同形 + `expires_at`。 */
export interface RuntimeCredentialFile {
  server_url: string;
  api_key: string;
  student_id?: string;
  role?: string;
  cohort?: string;
  /** ISO 8601；run-skill.cjs 据此判断是否过期。 */
  expires_at?: string;
  /** 令牌来源，便于诊断（`oauth` = 授权令牌；`legacy` = 手工 key）。 */
  source?: "oauth" | "legacy";
}

/** `<uid>/local/packages/.secrets/<包名>.runtime.json` */
export function pluginRuntimeCredentialFile(uid: string, name: string): string {
  return path.join(userPackageSecretsDir(uid), `${name}.runtime.json`);
}

/**
 * 物化当前可用凭据（供 run-skill.cjs 读取）。
 *
 * 令牌是**短期的**（约 1 小时），所以这个文件不是"配置"，而是"当前有效凭据的快照"：
 * 每次解析成功都会覆盖它，断开授权时删除它。
 */
export function writeRuntimeCredential(
  uid: string,
  name: string,
  cred: RuntimeCredentialFile,
): { ok: true } | { ok: false; error: string } {
  if (!isSafeName(name)) return { ok: false, error: "invalid package name" };
  const file = pluginRuntimeCredentialFile(uid, name);
  try {
    const dir = userPackageSecretsDir(uid);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on win32 */ }
    return { ok: true };
  } catch (err) {
    // 物化失败**不能**让命令失败：插件页那条路径是直接注入 env 的，不依赖本文件。
    log.warn("plugin runtime credential write failed", { package_name: name, error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

/** 删除物化文件（断开授权时调用）。 */
export function clearRuntimeCredential(uid: string, name: string): void {
  try { fs.rmSync(pluginRuntimeCredentialFile(uid, name), { force: true }); } catch { /* 已不存在 */ }
}

/**
 * 清理 `userPackageSecretsDir` 里的**残留物**（安全审计 2026-09-21）。
 *
 * 清两类东西：
 *   ① **已过期**的 `<包名>.runtime.json` —— 那是**明文令牌**。它虽然已经不能用
 *      （run-skill 侧也会按 `expires_at` 判掉），但没有理由让一枚凭据形状的字符串
 *      长期躺在盘上；而原实现只在"主动断开授权"时才删它，
 *      令牌自然过期 / 续期失败这两条路径都**不会**清理。
 *   ② **`*.tmp`** —— 原子写（writeFileSync → rename）之间的崩溃残留；
 *      注意 runtime 的 `.tmp` 里是**明文令牌**，所以就更容易被忽略。
 *
 * 只在"确实有东西要清"时写日志；失败一律静默（这是维护动作，不影响功能）。
 */
export function sweepStaleRuntimeCredentials(
  uid: string,
  now: number = Date.now(),
): { removedExpired: number; removedTmp: number } {
  const dir = userPackageSecretsDir(uid);
  let removedExpired = 0;
  let removedTmp = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { removedExpired, removedTmp }; // 目录不存在
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      if (entry.endsWith(".tmp")) {
        fs.rmSync(full, { force: true });
        removedTmp += 1;
        continue;
      }
      if (!entry.endsWith(".runtime.json")) continue;
      const raw = JSON.parse(fs.readFileSync(full, "utf8")) as { expires_at?: unknown };
      const exp = typeof raw?.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
      // 时间戳读不出来 → **不删**（宁可留一个不可用的文件，也不误删刚写好但字段异常的那个）
      if (!Number.isFinite(exp) || exp > now) continue;
      fs.rmSync(full, { force: true });
      removedExpired += 1;
    } catch {
      /* 单个文件失败不影响其余 */
    }
  }
  if (removedExpired > 0 || removedTmp > 0) {
    log.info("plugin runtime credential sweep", { removed_expired: removedExpired, removed_tmp: removedTmp });
  }
  return { removedExpired, removedTmp };
}
