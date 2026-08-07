'use strict';

// Phase 8 keeps the classic script tag so the existing plan rail DOM shell
// remains stable. The Mate IPC renderer work does not need a new bundle or a
// second UI surface yet, so this file is intentionally a tiny no-op bridge.
(function attachPlanRailBridge() {
  if (typeof window === 'undefined') return;
  if (!window.planRail) {
    window.planRail = {
      refresh() {},
      bind() {},
      unbind() {},
    };
  }
})();
