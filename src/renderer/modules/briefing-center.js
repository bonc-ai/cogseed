// Structured briefing preview and delivery view models.
(function () {
  'use strict';

  function briefingViewModel(briefing) {
    const source = briefing && typeof briefing === 'object' ? briefing : {};
    const sections = Array.isArray(source.sections) ? source.sections : [];
    const lastDelivery = source.lastDelivery && typeof source.lastDelivery === 'object' ? source.lastDelivery : null;
    return Object.freeze({
      state: String(source.state || 'not_configured'),
      previewVisible: source.state === 'preview_ready' || source.state === 'sending' || source.state === 'delivered' || source.state === 'delivery_failed',
      deliveryEnabled: Boolean(source.canDeliver),
      retryVisible: source.state === 'delivery_failed' && Boolean(lastDelivery && lastDelivery.retryable),
      sectionCount: sections.length,
      sections: sections.map((section) => Object.freeze({ id: String(section.id || ''), title: String(section.title || ''), itemCount: Array.isArray(section.items) ? section.items.length : 0 })),
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { briefingViewModel };
  if (typeof window !== 'undefined') window.BriefingCenter = Object.freeze({ briefingViewModel });
})();
