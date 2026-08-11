(function touchpointSettingsModelModule(root) {
  'use strict';

  function deriveTouchpointSettingsModel(dashboard, instances) {
    const data = dashboard || {};
    const messaging = data.messaging || {};
    const authorization = data.authorization || {};
    const resources = data.resources || {};
    const sync = data.sync || {};
    const botConnected = messaging.botConnected === true && messaging.ownerConfigured === true;
    const authorized = authorization.kind === 'connected';
    const hasResources = Number(resources.selected || 0) > 0;
    const ready = botConnected && authorized && hasResources && ['ready', 'awaiting_review'].includes(sync.state);
    const currentStep = !botConnected ? 'connection' : !authorized ? 'authorization' : !hasResources ? 'resources' : 'ready';
    const order = ['connection', 'authorization', 'resources', 'ready'];
    const currentIndex = order.indexOf(currentStep);
    const steps = order.map((id, index) => ({
      id,
      state: ready || index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'waiting',
    }));
    return {
      status: ready ? 'ready' : botConnected ? 'connected' : 'not_connected',
      currentStep,
      steps,
      primaryAction: !botConnected
        ? 'connection.connect'
        : !authorized
          ? 'authorization.begin'
          : !hasResources
            ? 'resources.discover'
            : sync.state !== 'ready' && sync.state !== 'awaiting_review'
              ? 'sync.start'
              : 'briefing.preview',
      botConnected,
      authorized,
      hasResources,
      ready,
      showMetrics: authorized && (Number(resources.discovered || 0) > 0 || hasResources),
      canConfigureDelivery: ready,
      identityLabel: authorization.identityLabel || messaging.ownerLabel || '',
      instanceCount: Array.isArray(instances)
        ? instances.filter((instance) => instance && instance.platform === 'feishu_lark').length
        : 0,
    };
  }

  const api = Object.freeze({ deriveTouchpointSettingsModel });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TouchpointSettingsModel = api;
}(typeof window !== 'undefined' ? window : null));
