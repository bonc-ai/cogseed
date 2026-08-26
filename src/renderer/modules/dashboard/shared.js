// ─── 智能体总览 2.0 · shared 工具层 ──────────────────────────────────────
// classic script（对齐渲染层惯例，无 ES module）。挂在 window.DashboardShared
// （简称 DS），供 overview / cost / collab / index 四个模块取用。这里只放
// 纯函数与推送订阅包装——视图状态一律归各视图模块自己持有。
(function () {
  'use strict';

  function t(key, vars) {
    try {
      if (typeof window.t === 'function') return window.t(key, vars);
    } catch (_) { /* i18n 未就绪时回退键名 */ }
    return key;
  }

  // 1_234 → "1.2k"、5_600_000 → "5.6M" —— 用在卡片的关键数字位
  function fmtTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(Math.round(v));
  }

  function fmtDuration(ms) {
    const v = Math.max(0, Number(ms) || 0);
    if (v < 60_000) return `${Math.round(v / 1000)}s`;
    if (v < 3_600_000) return `${Math.round(v / 60_000)}m`;
    return `${(v / 3_600_000).toFixed(1)}h`;
  }

  function fmtTimeAgo(epochMs) {
    const delta = Date.now() - Number(epochMs);
    if (!Number.isFinite(delta) || delta < 0) return '—';
    if (delta < 60_000) return t('dashboard.time.just_now');
    if (delta < 3_600_000) return t('dashboard.time.minutes_ago', { n: Math.round(delta / 60_000) });
    if (delta < 86_400_000) return t('dashboard.time.hours_ago', { n: Math.round(delta / 3_600_000) });
    return t('dashboard.time.days_ago', { n: Math.round(delta / 86_400_000) });
  }

  // 推送订阅包装：handler 异常吞掉（推送链路上一个坏 handler 不能杀掉
  // 其他订阅），返回退订函数。订阅纪律由各视图在 unmount 时调用退订。
  function subscribe(channel, handler) {
    if (!window.cogseed || typeof window.cogseed.onPushEvent !== 'function') {
      return () => undefined;
    }
    return window.cogseed.onPushEvent(channel, (payload) => {
      try { handler(payload); } catch (_) { /* swallow */ }
    });
  }

  function invoke(channel, payload) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      return Promise.reject(new Error('cogseed ipc unavailable'));
    }
    return window.cogseed.invoke(channel, payload);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.DashboardShared = { t, fmtTokens, fmtDuration, fmtTimeAgo, subscribe, invoke, esc };
}());
