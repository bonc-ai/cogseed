// ─── S5：模板「一步创建」的共享确认框（空间模板 / 定时任务模板共用）──────────
//
// 点「创建」时，缺的 Hub 智能体 / 技能在一个确认框里列出，一键安装，全部装好后由调用方
// 创建实例（spec FR-020/021，评审会 M3）。安装走 S4 的 `catalogInstall`（登录提示、安全扫描、
// 质量确认、失败原因都沿用），这里不另写安装逻辑。
//
// - 任一项失败：不创建，框里显示原因与「重试」，重试只补装没装上的。
// - 中途关闭：已装好的保留，不创建；下次打开只列仍缺的（由调用方重新解析得出）。
// - 引用的 Hub 内容已停用 / 不可用：列出并让用户选「不带这几项创建」或取消（FR-062）。
//
// 依赖：ui-modal.js（uiModal）、ui-button.js、catalog.js（catalogInstall / catalogInstallFailure，
// 未加载时按需加载 marketplace 功能包）。

(function initTemplateInstall(root) {
  'use strict';

  const _t = (key, fallback, vars) => {
    const fn = typeof root.t === 'function' ? root.t : null;
    const out = fn ? fn(key, vars) : '';
    if (out && out !== key) return out;
    return String(fallback || key).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
  };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function _ensureCatalog() {
    if (typeof root.catalogInstall === 'function') return true;
    if (typeof root.loadRendererFeature === 'function') {
      try { await root.loadRendererFeature('marketplace'); } catch (_) { /* 下面按不可用处理 */ }
    }
    return typeof root.catalogInstall === 'function';
  }

  /** 找 Hub 列表行（安装要带版本与发布时间）：先看 S4 已加载的目录，再分页查。 */
  async function hubRowFor(kind, id) {
    const state = typeof root._mpState !== 'undefined' ? root._mpState : (typeof _mpState !== 'undefined' ? _mpState : null); // eslint-disable-line no-undef
    const loaded = state ? (kind === 'agent' ? state.agents : state.skills) : null;
    const hit = Array.isArray(loaded) ? loaded.find((row) => row && row.id === id) : null;
    if (hit) return hit;
    const channel = kind === 'agent' ? 'marketplace.listAgents' : 'marketplace.listSkills';
    for (let page = 1; page <= 10; page += 1) {
      const res = await root.cogseed.invoke(channel, { page, size: 100 });
      const rows = (res && res.list) || [];
      const row = rows.find((r) => r && r.id === id);
      if (row) return row;
      if (rows.length < 100) break;
    }
    return null;
  }

  /** 需要安装的项（`needs_fetch`）与不可用的项（停用 / 不兼容 / 缺失 / 未知 / 用户关闭）。 */
  function splitResolution(items) {
    const toInstall = [];
    const unavailable = [];
    for (const item of items || []) {
      if (!item || item.state === 'ready') continue;
      const kind = item.ref && item.ref.kind;
      if (item.state === 'needs_fetch' && (kind === 'agent' || kind === 'skill')) toInstall.push(item);
      else unavailable.push(item);
    }
    return { toInstall, unavailable };
  }

  function _label(item, names) {
    const id = item.ref && item.ref.id;
    return (names && names[id]) || id || '';
  }

  function _reasonText(state) {
    switch (state) {
      case 'disabled': return _t('templates.ref_disabled', '已在平台停用');
      case 'incompatible': return _t('templates.ref_incompatible', '版本不兼容');
      case 'missing': return _t('templates.ref_missing', '这台设备上没有');
      case 'user_disabled': return _t('templates.ref_user_disabled', '你已停用，请先在智能体 / 技能页启用');
      case 'unknown': return _t('templates.ref_unknown', '当前客户端不支持，请更新客户端');
      default: return _t('templates.ref_unavailable', '暂不可用');
    }
  }

  /**
   * 不可用的项：让用户选「不带这几项创建」或取消。
   * 停用 / 缺失可以去掉后继续；用户自己关掉的、客户端不认识的只能取消（去掉会掩盖问题）。
   * @returns {Promise<'drop' | 'cancel'>}
   */
  async function confirmDropUnavailable(unavailable, { names, what } = {}) {
    const droppable = unavailable.every((i) => i.state === 'disabled' || i.state === 'missing' || i.state === 'incompatible');
    const rows = unavailable.map((i) => `<li><strong>${esc(_label(i, names))}</strong><span>${esc(_reasonText(i.state))}</span></li>`).join('');
    const modal = root.uiModal({
      title: _t('templates.unavailable_title', '有些能力现在用不了'),
      description: droppable
        ? _t('templates.unavailable_desc', '可以不带这几项创建{what}，之后再补上。', { what: what || '' })
        : _t('templates.unavailable_blocked', '请先处理下面的问题再创建。'),
      closeLabel: _t('common.close', '关闭'),
      bodyHtml: `<ul class="tpl-install-list">${rows}</ul>`,
      actions: [
        { id: 'cancel', label: _t('common.cancel', '取消'), role: 'secondary' },
        ...(droppable ? [{ id: 'drop', label: _t('templates.create_without', '不带这几项创建'), role: 'primary' }] : []),
      ],
    });
    const res = await modal;
    return res && res.value === 'drop' ? 'drop' : 'cancel';
  }

  /**
   * 一键安装确认框。全部装好后调用 `onCreate()`（返回 truthy 视为创建成功）后关闭。
   * @param {{ toInstall: object[], names?: Record<string,string>, what?: string, onCreate: () => Promise<boolean> }} opts
   * @returns {Promise<boolean>} 是否创建成功
   */
  function installAndCreate({ toInstall, names, what, onCreate }) {
    const status = new Map(); // id → 'pending' | 'installing' | 'done' | 'failed'
    const reasons = new Map();
    for (const item of toInstall) status.set(item.ref.id, 'pending');
    let busy = false;
    let finished = false;

    const bodyHtml = () => {
      const rows = toInstall.map((item) => {
        const id = item.ref.id;
        const st = status.get(id);
        const kindLabel = item.ref.kind === 'agent' ? _t('templates.kind_agent', '智能体') : _t('templates.kind_skill', '技能');
        const stateText = st === 'installing' ? _t('templates.installing', '安装中…')
          : st === 'done' ? _t('templates.installed', '已安装')
            : st === 'failed' ? (reasons.get(id) || _t('templates.install_failed', '安装失败'))
              : _t('templates.not_installed', '未安装');
        return `<li data-state="${esc(st)}"><strong>${esc(_label(item, names))}</strong><small>${esc(kindLabel)}</small><span>${esc(stateText)}</span></li>`;
      }).join('');
      const anyFailed = [...status.values()].includes('failed');
      const primaryLabel = anyFailed ? _t('templates.retry', '重试') : _t('templates.install_and_create', '安装并创建{what}', { what: what || '' });
      return `<ul class="tpl-install-list">${rows}</ul>
        <div class="tpl-install-actions">
          ${root.uiButton({ label: _t('common.cancel', '取消'), role: 'secondary', attrs: { 'data-tpl-install': 'cancel', ...(busy ? { disabled: '' } : {}) } })}
          ${root.uiButton({ label: busy ? _t('templates.installing', '安装中…') : primaryLabel, role: 'primary', attrs: { 'data-tpl-install': 'go', ...(busy ? { disabled: '', 'aria-busy': 'true' } : {}) } })}
        </div>`;
    };

    const modal = root.uiModal({
      title: _t('templates.install_title', '还需要安装 {count} 项', { count: toInstall.length }),
      description: _t('templates.install_desc', '装好后会自动创建{what}。', { what: what || '' }),
      closeLabel: _t('common.close', '关闭'),
      bodyHtml: bodyHtml(),
      actions: [],
    });
    const body = modal.dialog.querySelector('.ui-modal__body');
    const repaint = () => { if (body) body.innerHTML = bodyHtml(); };

    async function run() {
      if (busy) return;
      busy = true;
      repaint();
      if (!await _ensureCatalog()) {
        for (const item of toInstall) if (status.get(item.ref.id) !== 'done') { status.set(item.ref.id, 'failed'); reasons.set(item.ref.id, _t('templates.install_unavailable', '暂时无法安装')); }
        busy = false;
        repaint();
        return;
      }
      for (const item of toInstall) {
        const id = item.ref.id;
        if (status.get(id) === 'done') continue;
        status.set(id, 'installing');
        repaint();
        let ok = false;
        try {
          const row = await hubRowFor(item.ref.kind, id);
          if (!row) reasons.set(id, _t('templates.install_not_found', '平台上找不到这一项'));
          else ok = (await root.catalogInstall(item.ref.kind, row)) === true;
          if (!ok && row && typeof root.catalogInstallFailure === 'function') {
            const text = root.catalogInstallFailure(item.ref.kind, id);
            if (text) reasons.set(id, String(text));
          }
        } catch (err) {
          reasons.set(id, (err && err.message) || String(err));
        }
        status.set(id, ok ? 'done' : 'failed');
        repaint();
      }
      busy = false;
      if ([...status.values()].every((s) => s === 'done')) {
        repaint();
        const created = await onCreate();
        if (created) { finished = true; modal.close(true, 'created'); return; }
      }
      repaint();
    }

    modal.dialog.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-tpl-install]');
      if (!btn || btn.disabled) return;
      if (btn.dataset.tplInstall === 'cancel') modal.close(false, 'cancel');
      else void run();
    });
    return modal.then(() => finished);
  }

  root.TemplateInstall = Object.freeze({ splitResolution, confirmDropUnavailable, installAndCreate, hubRowFor });
})(typeof window !== 'undefined' ? window : globalThis);
