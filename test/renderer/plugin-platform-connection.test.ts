/**
 * 插件详情页「课程平台连接」的真实页面接线（模块 A）。
 *
 * 这一层测的是 **renderer 页面到底怎么接**（cogseed-component-change 的第 3 类：
 * page-specific composition），不是组件内部实现：
 *   · 主路径是「连接课程平台」，手工表单被收进折叠区（存量用户例外）
 *   · 走共享原语（uiButton / uiField / uiModal），不手写控件、不硬编码图标
 *   · 授权 URL 绝不回到 renderer（里面带 hub_token）
 *   · 断开必须先确认（破坏性操作）
 *   · 失败/无资格态呈现中文说明，不暴露技术错误码
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const rawSource = read('src/renderer/modules/plugins.js');
const css = read('src/renderer/plugins.css');

/** 去掉注释：断言的是**代码**行为，注释里说明这些约束不算违规。 */
const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 课程平台连接那两段渲染函数（auth 卡 + 配置区块）。 */
const configSection = source.match(/function _authBlockHtml[\s\S]*?\n  function _bindConfigEvents/)?.[0] || '';

describe('plugin platform connection card', () => {
  it('🔴 授权是主路径，手工表单收进折叠区（存量用户仍直接可见）', () => {
    expect(source).toContain("data-plugins-config-action': 'authorize'");
    expect(source).toContain('<details class="plugins-config-manual">');
    expect(source).toContain("plugins.auth_other_way', '其他方式：手动填写密钥'");
    // 存量用户（method==='legacy'）分支必须保留**直接可见**的表单，
    // 不能把他们的入口一并藏进折叠区。
    expect(source).toMatch(/auth\.method === 'legacy'\s*\n?\s*\?/);
    expect(source).toContain("plugins.auth_legacy_switch', '改用授权连接（推荐）'");
  });

  it('🔴 五种状态各自成形（A/B/C/D/F），且不呈现技术错误码', () => {
    expect(source).toContain("state === 'B'");
    expect(source).toContain("state === 'D'");
    expect(source).toContain("state === 'F'");
    expect(source).toContain("state === 'C'");
    // D（无资格）要给出路，而不是让人重试。
    expect(source).toContain("data-plugins-config-action': 'contact'");
    // 文案全部走取词函数（可见字符串不得硬编码在分支里）。
    for (const key of [
      'plugins.auth_connect', 'plugins.auth_reconnect', 'plugins.auth_resume',
      'plugins.auth_disconnect', 'plugins.auth_state_pending', 'plugins.auth_state_expired',
      'plugins.auth_state_ineligible', 'plugins.auth_state_corrupt',
      // 原型里的异常态：身份冲突 / 账号停用 / 已取消 / 换账号，以及它们用的徽章与出路
      'plugins.auth_state_conflict', 'plugins.auth_state_account_disabled',
      'plugins.auth_state_cancelled', 'plugins.auth_state_switch_account',
      'plugins.auth_state_needs_recovery', 'plugins.auth_state_unconnected',
      'plugins.auth_state_recovery_action',
    ]) {
      expect(source, key).toContain(key);
    }
  });

  it('🔴 身份冲突（identity_conflict）单独成形：给出路、不给「重新连接」', () => {
    // 场景：这个教育身份已经连到**另一个** CogSeed 账号（平台返回 identity_conflict）。
    // 与「无资格」必须分开：那个找课程负责人开通席位，这个找管理员核对账号关系。
    expect(source).toContain("auth.last_error_code === 'identity_conflict'");
    expect(source).toContain("plugins.auth_state_conflict'");
    // 「查看处理方式」是**恢复类状态共用**的出路按钮（冲突 / 账号停用都用它）
    expect(source).toContain("plugins.auth_state_recovery_action'");
    // 必须排在 corrupt 之前：否则先命中通用提示就吞掉了这条。
    const conflictAt = source.indexOf("auth.last_error_code === 'identity_conflict'");
    const corruptAt = source.indexOf('else if (auth.corrupt)');
    expect(conflictAt).toBeGreaterThan(-1);
    expect(corruptAt).toBeGreaterThan(conflictAt);
    // 冲突态不得走「重新连接」（重试不会变好，与服务端 needsReauth=false 一致）：
    // 只允许 contact 这一个出路。
    const conflictBranch = source.slice(source.indexOf('} else if (identityConflict || accountDisabled)'), source.indexOf('} else if (auth.hub_signed_in === false)'));
    expect(conflictBranch).toContain("'contact'");
    expect(conflictBranch).not.toContain("'authorize'");
  });

  it('🔴 三步进度条照原型（1 登录 → 2 确认身份 → 3 授权完成），且用真实状态', () => {
    // 原型 line 673：未连接的连接卡片里有 .authprogress，三步文案固定，
    // 第 1 步按 Hub 登录态标 done/now，后两步是常量。
    expect(source).toContain('plugins-auth-progress');
    for (const key of ['plugins.auth_step_login', 'plugins.auth_step_identity', 'plugins.auth_step_done']) {
      expect(source, key).toContain(key);
    }
    // 沿用同一组件，但第 2 步按**真实**身份标（主进程知道 person_id，没必要让用户猜）
    expect(source).toContain("const stepLogin = auth.hub_signed_in === false ? 'now' : 'done';");
    expect(source).toContain('const stepIdentity = auth.person_id ?');
    // 已连接（C）不显示进度：那条路径没有待办（原型在"已连接"卡片里也没有这条）
    expect(source).toContain("const progress = state === 'C' ? '' :");
    // 颜色走 token，不照抄原型写死的近似绿（#377a54 / #233f2e / #84978a）
    expect(css).toContain('.plugins-auth-progress .done');
    expect(css).toContain('var(--color-brand)');
    // 与 `source` 同一原则：注释里说明"不要用某个色"不算违规，所以去注释后再查字面量
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const literal of ['#377a54', '#233f2e', '#84978a']) {
      expect(cssCode, literal).not.toContain(literal);
    }
  });

  it('🔴 失败原因只在「未连接」时常驻，不会把「已连接」的说明盖掉', () => {
    // conflict / cancelled 都来自 last_error_code（上一次尝试的失败原因）。
    // 原型把 cancelled 做成了独立演示场景；我们让它常驻 —— 但**必须限定未连接**，
    // 否则用户后来连上了，一条过期的失败原因会盖掉"已连接"，界面又开始说假话。
    expect(source).toContain("const notConnected = state !== 'C';");
    expect(source).toContain("const identityConflict = notConnected && auth.last_error_code === 'identity_conflict';");
    expect(source).toContain("const lastCancelled = notConnected && auth.last_error_code === 'access_denied';");
    expect(source).toContain("plugins.auth_state_cancelled'");
    // 原型 cancelled 场景的两个要点：没有建立连接、可随时重来
    expect(source).toContain('尚未建立教育连接');
    expect(source).toContain('可随时重新发起');
  });

  it('🔴 徽章用到的每个 is-* 变体都必须有 CSS 规则（防「写了标记忘了样式」）', () => {
    // 真实教训：`.plugins-badge.is-checking` 一直在用，但 CSS 里**没有这条规则**
    //（只有 `.plugins-license.is-checking`），于是态 B 的徽章跟普通徽章一模一样 ——
    // 静态断言只查了「JS 里有没有这个字符串」，所以长期显示通过。
    // 平台侧也踩过同一类（`.brand` / `h1` / `.sub` 出现在标记里却没有样式）。
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const variants = [...new Set([...source.matchAll(/plugins-badge\s+(is-[a-z-]+)/g)].map((m) => m[1]))];
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      expect(cssCode, `缺少 .plugins-badge.${v} 规则`).toContain(`.plugins-badge.${v}`);
    }
  });

  it('🔴 「需恢复」只给该恢复的状态：失效/冲突/停用是它，换账号与取消不是', () => {
    // 原型对"东西还在、但需要先做点什么"的状态用 amber tag「需恢复」；
    // 而"取消过""刚解绑"只是**没连上**，标成"需恢复"会让用户以为哪里坏了。
    expect(source).toContain("const needsRecovery = notConnected && (state === 'F' || identityConflict || accountDisabled);");
    expect(source).toContain('plugins.auth_state_needs_recovery');
    expect(source).toContain('plugins.auth_state_unconnected');
    // 判定必须在徽章之前算出（徽章与说明共用同一份判定，避免两处各判一次而漂移）
    const declared = source.indexOf('const needsRecovery =');
    const badge = source.indexOf('const badge =');
    expect(declared).toBeGreaterThan(-1);
    expect(badge).toBeGreaterThan(declared);
  });

  it('🔴 只显示掩码与到期时间，绝不显示令牌明文', () => {
    expect(source).toContain('auth.masked_access');
    expect(source).not.toContain('access_token');
    expect(source).not.toContain('refresh_token');
    // 到期信息用"剩余约 N 分钟/小时"，不吐 ISO 时间戳。
    // 🔴 不显示"令牌剩余 XX 分钟"：真人验收反馈会让人以为要手动做什么。
    //    只在真的需要用户动手时才提示 —— 这条断言防止它被重新加回来。
    expect(source).not.toContain('auth_expires_minutes');
    expect(source).not.toContain('expiryLine');
    expect(source).toContain('plugins.auth_ready');
  });

  it('🔴 授权 URL 不回 renderer（里面有 hub_token）', () => {
    const authorizeCall = source.match(/_invoke\('packages\.auth\.start'[\s\S]{0,400}/)?.[0] || '';
    expect(authorizeCall).toContain('packages.auth.start');
    expect(authorizeCall).not.toContain('authorizeUrl');
    expect(source).not.toContain('authorizeUrl');
    expect(source).not.toContain('hub_token');
  });

  it('断开是破坏性操作：先确认再执行，且用共享弹窗', () => {
    const disconnect = source.match(/function _confirmDisconnect[\s\S]*?\n  }/)?.[0] || '';
    expect(disconnect).toContain('uiModal(');
    expect(disconnect).toContain("tone: 'danger'");
    expect(disconnect).toContain("outcome.value === 'confirm'");
    expect(disconnect).toContain("packages.auth.disconnect");
    // 没有 uiModal（测试/裁剪构建）时也不能静默什么都不做。
    expect(disconnect).toContain('if (typeof uiModal !== \'function\')');
  });

  it('走共享原语与共享图标，不手写控件、不硬编码 SVG', () => {
    expect(configSection).toContain('_btn({');
    expect(configSection).toContain('uiField({');
    expect(configSection).not.toContain('<button');
    expect(configSection).not.toContain('<svg');
    expect(configSection).not.toContain('z-index');
    // `<details>/<summary>` 是原生披露控件，不是按钮/表单控件，不违反共享原语约束。
    expect(configSection).toContain('<details');
  });

  it('🔴 Hub 未登录时，按钮必须是「登录账号」而不是「重新连接」', () => {
    // 真人验收发现：Hub 登出后点「重新连接」→ 先弹"正在打开浏览器…"再弹"连接失败" ——
    // 让用户点一个必然失败的按钮是设计错误。正确动作是先登录，且复用左下角那条通道。
    expect(source).toContain("auth.hub_signed_in === false");
    expect(source).toContain("data-plugins-config-action': 'hub-login'");
    expect(source).toContain("_invoke('hub-account.start_login')");
    expect(source).toContain("plugins.auth_login_hub");
    // 登录完成后要能刷新本页
    expect(source).toContain("onPushEvent('hub-account:login-result'");
    // 未登录分支必须排在「重新连接」之前，否则永远不会命中
    const block = source.match(/function _authBlockHtml[\s\S]*?\n  function /)?.[0] || '';
    const idxHub = block.indexOf("'hub-login'");
    const idxReconnect = block.indexOf("plugins.auth_reconnect");
    expect(idxHub).toBeGreaterThan(0);
    expect(idxReconnect).toBeGreaterThan(0);
    expect(idxHub).toBeLessThan(idxReconnect);
  });

  it('🔴 授权在浏览器里完成 → 推送 + **窗口焦点兜底**都要有', () => {
    expect(source).toContain("onPushEvent('packages:auth-changed'");
    expect(source).toContain('_licenseCache.clear()');
    // 真机实测：推送没到达时界面会停在"还差一步"，用户以为没连上。
    // 窗口重新获得焦点（从浏览器切回来）必须有兜底刷新，且要节流。
    expect(source).toContain("window.addEventListener('focus'");
    expect(source).toMatch(/_lastFocusRefresh < 3000/);
    // 必须**查两次**：切回窗口往往比令牌写盘早几十毫秒，只查一次会读到旧状态
    // （实测用户因此以为没连上，又点了一次）
    expect(source).toContain('setTimeout(refreshNow, 1500)');
  });

  it('CSS 用 token，不留字面 z-index（层级由 tokens.css 统一）', () => {
    const authCss = css.match(/\/\* ── 课程平台连接[\s\S]*?(?=\/\* ──)/)?.[0] || '';
    expect(authCss).toContain('.plugins-auth');
    expect(authCss).toContain('.plugins-config-manual');
    expect(authCss).toContain('var(--color-focus-halo');
    expect(authCss).not.toMatch(/z-index\s*:/);
  });
});
