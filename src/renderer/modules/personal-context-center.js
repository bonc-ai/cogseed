// Personal Context Center controller and state-to-view projection.
// Classic script: all main-process work remains behind window.orkas.invoke.
(function () {
  'use strict';

  function authorizationKind(dashboard) {
    return dashboard && dashboard.authorization && typeof dashboard.authorization.kind === 'string'
      ? dashboard.authorization.kind
      : 'disconnected';
  }

  function primaryActionFor(dashboard) {
    if (dashboard && dashboard.mode === 'demo') return 'sync.start';
    const kind = authorizationKind(dashboard);
    if (kind === 'authorizing') return 'authorize.cancel';
    if (kind === 'connected') return 'resources.discover';
    return 'authorize.begin';
  }

  function viewModel(dashboard) {
    const source = dashboard && typeof dashboard === 'object' ? dashboard : {};
    const mode = source.mode === 'demo' ? 'demo' : 'real';
    const resources = source.resources && typeof source.resources === 'object' ? source.resources : {};
    const review = source.review && typeof source.review === 'object' ? source.review : {};
    const briefing = source.briefing && typeof source.briefing === 'object' ? source.briefing : {};
    return Object.freeze({
      mode,
      badge: mode === 'demo' ? '演示模式' : '真实连接',
      primaryAction: primaryActionFor(source),
      authorizationKind: authorizationKind(source),
      resourceCount: Number(resources.discovered || 0),
      selectedCount: Number(resources.selected || 0),
      pendingCount: Number(review.pending || 0),
      briefingReady: briefing.state === 'preview_ready' || briefing.state === 'delivered' || briefing.state === 'delivery_failed',
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { viewModel, primaryActionFor };
  if (typeof window !== 'undefined') window.PersonalContextCenter = Object.freeze({ viewModel, primaryActionFor });
})();
