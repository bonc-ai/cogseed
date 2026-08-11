(function touchpointSettingsModelModule(root) {
  'use strict';

  function deriveTouchpointSettingsModel(dashboard, instances) {
    const data = dashboard || {};
    const messaging = data.messaging || {};
    const authorization = data.authorization || {};
    const resources = data.resources || {};
    const sync = data.sync || {};
    const briefing = data.briefing || {};
    const botConnected = messaging.botConnected === true && messaging.ownerConfigured === true;
    const authorizing = authorization.kind === 'authorizing';
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
    const destination = briefing.destination || null;
    return {
      status: ready ? 'ready' : botConnected ? 'connected' : 'not_connected',
      currentStep,
      steps,
      primaryAction: !botConnected
        ? 'connection.connect'
        : authorizing
          ? 'authorize.cancel'
          : !authorized
            ? 'authorization.begin'
            : !hasResources
              ? 'resources.discover'
              : sync.state !== 'ready' && sync.state !== 'awaiting_review'
                ? 'sync.start'
                : 'briefing.preview',
      botConnected,
      authorizing,
      authorized,
      hasResources,
      ready,
      showMetrics: authorized && (Number(resources.discovered || 0) > 0 || hasResources),
      canConfigureDelivery: ready,
      identityLabel: authorization.identityLabel || messaging.ownerLabel || messaging.ownerMaskedId || '',
      // 与 botConnected（要求 enabled）语义对齐：禁用实例不计入"已连接实例数"。
      instanceCount: Array.isArray(instances)
        ? instances.filter((instance) => instance && instance.platform === 'feishu_lark' && instance.enabled === true).length
        : 0,
      syncMessage: typeof sync.message === 'string' && sync.message ? sync.message : '',
      briefingConfigured: Boolean(destination && destination.configured),
      briefingSchedule: destination && destination.configured && destination.schedule
        ? { hour: destination.schedule.hour, minute: destination.schedule.minute }
        : null,
    };
  }

  const api = Object.freeze({ deriveTouchpointSettingsModel });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TouchpointSettingsModel = api;
}(typeof window !== 'undefined' ? window : null));
