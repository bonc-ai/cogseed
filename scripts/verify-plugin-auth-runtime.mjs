#!/usr/bin/env node
/**
 * verify-plugin-auth-runtime.mjs —— 在**真实运行数据**上核对模块 A 客户端侧
 *
 * 与其余 verify:* 脚本的分工：
 *   · `npm test` 里的注入式用例证明**逻辑**对；
 *   · 本脚本证明这些逻辑接的是**这台机器上真实的那份数据**（uid、包注册表、密钥目录），
 *     而不是只在测试夹具里成立。
 *
 * 🔴 它跑在应用的真实数据根上，因此：
 *   · 只读：对真实 uid 不做任何写入（唯一例外见下）；
 *   · 唯一写入用**临时 uid**（`__verify_plugin_auth`），跑完即删，且断言"未授权时不留待处理流程"；
 *   · 不打印任何令牌内容（只打印掩码与状态）。
 *
 * 用法（必须指到运行中的数据根，否则核对的是另一个目录）：
 *   COGSEED_WORKSPACE_ROOT="$HOME/.cogseed/runtime-variants/cogseed/data" \
 *     npm run verify:plugin-auth
 *
 * 若本机跑着平台服务（`nseap-platform` 的 `bash scripts/start-standalone.sh`），
 * 本脚本还会做**真实的服务端 → 客户端**契约核对（可跳过：PLATFORM_BASE_URL=off）：
 *   · 端点路径 `/edu/api/oauth/*`（契约 v1.0.0 写的 `/edu/oauth/*` 是 404）
 *   · 失败封套是**扁平**的 `{ok:false,error:"文本",code:"CODE"}`
 *   · 无 hub_token 时 `/refresh` 返回 HUB_TOKEN_REQUIRED（DECISION-2）
 *   · 平台 302 回来的 `error=` 深链，喂给客户端回调解析后必须得到中文说明
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const WS = process.env.COGSEED_WORKSPACE_ROOT ?? "";

if (!WS) {
  console.error(
    "❌ 必须显式设置 COGSEED_WORKSPACE_ROOT（指向运行中的数据根），否则核对的是另一个目录：\n"
    + '   COGSEED_WORKSPACE_ROOT="$HOME/.cogseed/runtime-variants/cogseed/data" npm run verify:plugin-auth',
  );
  process.exit(1);
}

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "✅" : "🔴"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const { resolve } = path;
const src = (rel) => pathToFileURL(resolve(ROOT, rel)).href;

// ── 真实 uid（与运行中的应用同一个 users.json） ──────────────────────────────
const usersFile = path.join(WS, "users.json");
if (!fs.existsSync(usersFile)) {
  console.error(`❌ 找不到 ${usersFile} —— 这个数据根里没有用户注册表`);
  process.exit(1);
}
const users = JSON.parse(fs.readFileSync(usersFile, "utf8"));
const uid = users.current_user_id || users.dev_current_user_id || "";
if (!uid) {
  console.error("❌ users.json 里没有 current_user_id —— 应用还没登录过本地用户？");
  process.exit(1);
}
console.log(`数据根：${WS}`);
console.log(`当前 uid：${uid}\n`);

const { readPackagesRegistry } = await import(src("src/main/features/packages.ts"));
const { writePluginOAuth } = await import(src("src/main/features/plugin_oauth_store.ts"));
const { pluginUiInfo, readPluginRuntimeConfig } = await import(src("src/main/features/plugin_ui.ts"));
const {
  getPluginAuthStatus,
  resolvePluginCredential,
  startPluginAuthorization,
  handlePluginAuthorizeCallbackUrl,
  parsePluginCallback,
  pluginAuthorizeCallbackUrl,
  disconnectPluginAuthorization,
  _resetRefreshGatesForTest,
} = await import(src("src/main/features/plugin_oauth_flow.ts"));
const { pluginOAuthFile, readPluginOAuth, clearPluginOAuth } = await import(src("src/main/features/plugin_oauth_store.ts"));

const packages = readPackagesRegistry(uid).packages;
console.log(`已安装插件：${packages.length} 个 —— ${packages.map((p) => p.name).join(", ") || "（无）"}\n`);

// ── 1) 深链识别：本流程认、别的流程不认 ─────────────────────────────────────
console.log("① 深链路由");
check(
  "识别插件授权回调",
  pluginAuthorizeCallbackUrl("cogseed://plugin/authorize/callback?code=a&state=b") !== null,
);
check(
  "不吞账号/连接器回调",
  pluginAuthorizeCallbackUrl("cogseed://account/callback?code=a&state=b") === null
  && pluginAuthorizeCallbackUrl("cogseed://connectors/oauth/callback?code=a") === null,
);
check(
  "解析出 code/state",
  (() => {
    const r = parsePluginCallback("cogseed://plugin/authorize/callback?code=abc&state=xyz");
    return r.ok === true && r.code === "abc" && r.state === "xyz";
  })(),
);
check(
  "重复 code 被拒（攻击形状不是「取第一个」）",
  (() => {
    const r = parsePluginCallback("cogseed://plugin/authorize/callback?code=a&code=b&state=s");
    return r.ok === false && r.error === "duplicate_code";
  })(),
);

// ── 2) 真实插件包的状态查询（只读） ─────────────────────────────────────────
console.log("\n② 真实插件包的状态（只读）");
if (packages.length === 0) {
  console.log("  ⏭  没有已安装插件，跳过");
} else {
  for (const pkg of packages) {
    const config = readPluginRuntimeConfig(uid, pkg.name);
    const status = getPluginAuthStatus(uid, pkg.name, { apiKey: config.api_key, serverUrl: config.server_url });
    console.log(`  · ${pkg.name}: state=${status.state} method=${status.method} authorized=${status.authorized} `
      + `server=${status.serverUrl || "（未定）"} masked=${status.maskedAccess || "（无）"}`);

    // 不变量：state C ⟺ authorized；B 必须有 pending；掩码里不得出现明文前缀
    check(`${pkg.name} state/authorized 一致`, (status.state === "C") === status.authorized);
    check(`${pkg.name} 掩码不含令牌明文`, !/pat_|prt_/.test(status.maskedAccess));
    check(
      `${pkg.name} 序列化结果不含令牌明文`,
      !/"?(?:access|refresh)_token"?\s*:/.test(JSON.stringify(status)),
    );

    if (typeof pluginUiInfo === "function") {
      const info = await pluginUiInfo(uid, pkg.name);
      if (info.ok && info.info) {
        const auth = info.info.auth;
        check(`${pkg.name} pluginUiInfo 带 auth 字段`, !!auth && typeof auth.state === "string");
        check(
          `${pkg.name} pluginUiInfo 里没有令牌字段`,
          !JSON.stringify(info.info).match(/pat_[A-Za-z0-9_-]{6,}|prt_[A-Za-z0-9_-]{6,}/),
        );
      } else {
        check(`${pkg.name} pluginUiInfo 可用`, false, info.error ?? "");
      }
    }

    // 未授权时解析凭据必须**明确失败**（不静默给空 key）
    const cred = await resolvePluginCredential(uid, pkg.name, { apiKey: config.api_key, serverUrl: config.server_url });
    if (cred.ok) {
      check(
        `${pkg.name} 凭据解析（已授权）`,
        cred.apiKey.length > 0,
        `method=${cred.method} refreshed=${cred.refreshed}`,
      );
      check(`${pkg.name} 注入的 serverUrl 非空`, !!cred.serverUrl);
    } else {
      check(
        `${pkg.name} 未授权时明确失败并给出可行动说明`,
        (cred.reason === "NOT_AUTHORIZED" || cred.reason === "STORE_UNAVAILABLE") && cred.message.length > 0,
        `reason=${cred.reason}`,
      );
    }
  }
}

// ── 3) 临时 uid：授权入口在"未登录 Hub"时必须干净失败 ───────────────────────
console.log("\n③ 授权入口（临时 uid，跑完即删）");
const TMP_UID = "__verify_plugin_auth";
const TMP_PKG = "verify-tmp-pkg";
_resetRefreshGatesForTest();
try {
  clearPluginOAuth(TMP_UID, TMP_PKG);
  const started = await startPluginAuthorization(TMP_UID, TMP_PKG, { serverUrl: "https://example.test/edu" });
  if (started.ok) {
    // 本机 Hub 已登录时走到这里：URL 必须带齐契约参数，且不含 verifier。
    const url = new URL(started.authorizeUrl);
    check("授权 URL 指向 /api/oauth/authorize", url.pathname.endsWith("/api/oauth/authorize"), url.pathname);
    check("授权 URL 带 client_id/redirect_uri/PKCE/state", ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"]
      .every((k) => !!url.searchParams.get(k)));
    check("hub_token 随 URL 下发（平台据此判定身份）", !!url.searchParams.get("hub_token"));
    const record = readPluginOAuth(TMP_UID, TMP_PKG).record;
    check("code_verifier 只落本地、不进 URL", !!record.pending && !started.authorizeUrl.includes(record.pending.code_verifier));
    check(
      "待处理流程在磁盘上加密（无明文 verifier）",
      !fs.readFileSync(pluginOAuthFile(TMP_UID, TMP_PKG), "utf8").includes(record.pending.code_verifier),
    );
  } else {
    check(
      "未登录 Hub 时干净失败并提示先登录",
      started.message.length > 0,
      `error=${started.error}`,
    );
    check("未登录时不留下待处理流程", !readPluginOAuth(TMP_UID, TMP_PKG).record.pending);
  }

  // 断开必须幂等，且"从未授权"时也是一个成功结果
  const d = await disconnectPluginAuthorization(TMP_UID, TMP_PKG);
  check("断开幂等（从未授权也算成功）", d.ok === true);
} catch (err) {
  check("临时 uid 的授权入口检查未抛错", false, err instanceof Error ? err.message : String(err));
}

// ── 4) 真实平台服务的契约核对（服务没起就明确跳过，不假装通过） ──────────────
const PLATFORM = (process.env.PLATFORM_BASE_URL ?? "http://127.0.0.1:3000/edu").replace(/\/+$/, "");
console.log(`\n④ 平台服务契约（${PLATFORM}）`);
if (process.env.PLATFORM_BASE_URL === "off") {
  console.log("  ⏭  PLATFORM_BASE_URL=off，跳过");
} else {
  let reachable = true;
  try {
    const res = await fetch(`${PLATFORM}/api/health`, { signal: AbortSignal.timeout(3000) });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.log(`  ⏭  服务未启动（先跑 nseap-platform 的 bash scripts/start-standalone.sh），跳过`);
  } else {
    // ① 路径：契约 v1.0.1 的 /api/oauth/* 必须存在（旧写法必须 404）
    for (const [p, expectNot] of [["/api/oauth/token", 404], ["/api/oauth/refresh", 404], ["/api/oauth/binding", 404]]) {
      const r = await fetch(`${PLATFORM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      check(`${p} 存在（不是 404）`, r.status !== expectNot, `http=${r.status}`);
    }
    const legacy = await fetch(`${PLATFORM}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("契约 v1.0.0 的旧路径 /oauth/token 确实 404（修正的必要性）", legacy.status === 404, `http=${legacy.status}`);

    // ② 失败封套：客户端 parsePlatformFailure 依赖扁平形状
    const badCode = await fetch(`${PLATFORM}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: "bogus",
        code_verifier: "v",
        client_id: "cogseed-desktop",
        redirect_uri: "cogseed://plugin/authorize/callback",
      }),
    });
    const badBody = await badCode.json().catch(() => null);
    check(
      "失败封套是扁平形状（error 为字符串、code 在顶层）",
      badBody && typeof badBody.error === "string" && typeof badBody.code === "string",
      `error=${JSON.stringify(badBody?.error)} code=${badBody?.code}`,
    );
    check("无效授权码 → INVALID_GRANT 401", badBody?.code === "INVALID_GRANT" && badCode.status === 401, `http=${badCode.status}`);

    // ③ DECISION-2：缺 hub_token 必须被拒
    const noHub = await fetch(`${PLATFORM}/api/oauth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "prt_bogus", client_id: "cogseed-desktop" }),
    });
    const noHubBody = await noHub.json().catch(() => null);
    check("缺 hub_token → HUB_TOKEN_REQUIRED", noHubBody?.code === "HUB_TOKEN_REQUIRED", `http=${noHub.status}`);

    // ④ 平台 302 回来的 error 深链 → 客户端回调解析必须给出中文说明
    const { generatePkce: genPkce } = await import(src("src/main/features/plugin_oauth_store.ts"));
    const pk = genPkce();
    const authUrl = new URL(`${PLATFORM}/api/oauth/authorize`);
    authUrl.searchParams.set("client_id", "cogseed-desktop");
    authUrl.searchParams.set("redirect_uri", "cogseed://plugin/authorize/callback");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", pk.codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", pk.state);
    const authRes = await fetch(authUrl, { redirect: "manual" });
    const location = authRes.headers.get("location") ?? "";
    check(
      "无 hub_token 时 302 回深链（不是 500/HTML 错误页）",
      authRes.status === 302 && location.startsWith("cogseed://plugin/authorize/callback"),
      `http=${authRes.status} location=${location.slice(0, 80)}`,
    );

    if (location) {
      // 真实服务端产出的深链，喂给真实客户端回调处理：
      // 必须先按同一个 state 铺好待处理流程，否则命中的是"state 不匹配"分支。
      writePluginOAuth(TMP_UID, TMP_PKG, {
        server_url: PLATFORM,
        pending: { state: pk.state, code_verifier: pk.codeVerifier, server_url: PLATFORM, created_at: new Date().toISOString() },
      });
      const handled = await handlePluginAuthorizeCallbackUrl(location, { uid: TMP_UID });
      check(
        "客户端解析平台的 error 深链 → 失败但给出中文说明（不暴露技术码）",
        handled.ok === false && handled.message.length > 0 && !handled.message.includes("invalid_request"),
        `error=${handled.ok === false ? handled.error : "?"} message=${handled.ok === false ? handled.message : "?"}`,
      );
      check("处理失败回调后清掉待处理流程（用户能重试）", !readPluginOAuth(TMP_UID, TMP_PKG).record.pending);
      check("失败原因落盘供界面区分状态", readPluginOAuth(TMP_UID, TMP_PKG).record.last_error?.code === "invalid_request");
      clearPluginOAuth(TMP_UID, TMP_PKG);
    }

    // ⑤ 参数不合法 → 400 且**不跳转**（防开放重定向）
    const badAuth = await fetch(`${PLATFORM}/api/oauth/authorize?client_id=nope`, { redirect: "manual" });
    check("参数不合法 → 400 且不跳转", badAuth.status === 400, `http=${badAuth.status}`);
  }
}

// ── 临时数据清理 ────────────────────────────────────────────────────────────
clearPluginOAuth(TMP_UID, TMP_PKG);
{
  const tmpDir = path.join(WS, TMP_UID);
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  check("临时验证数据已清理（不给真实数据根留垃圾）", !fs.existsSync(tmpDir));
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "✅ 全部通过" : `🔴 ${failed.length} 项未通过`}（共 ${results.length} 项）`);
if (failed.length) {
  for (const f of failed) console.error(`   · ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(1);
}
console.log("\n注：本脚本核对的是「模块 A 客户端侧在真实数据根上可用」；");
console.log("    浏览器里那一跳（登录 → 确认课程身份 → 同意）仍需真人执行，见 验收记录 §二 U9。");
