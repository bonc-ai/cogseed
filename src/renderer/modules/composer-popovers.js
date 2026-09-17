// Composer popovers share one ownership rule: opening one closes every other
// chooser attached to the same toolbar. Feature modules register their own
// close behavior so this coordinator never owns business state or selection.
(function initComposerPopoverCoordinator(root) {
  'use strict';

  function createComposerPopoverCoordinator() {
    const closers = new Map();
    return {
      register(kind, close) {
        if (!kind || typeof close !== 'function') return () => {};
        closers.set(String(kind), close);
        return () => closers.delete(String(kind));
      },
      closeAll(exceptKind = '') {
        const except = String(exceptKind || '');
        for (const [kind, close] of closers) {
          if (kind === except) continue;
          close();
        }
      },
    };
  }

  const coordinator = createComposerPopoverCoordinator();
  root.registerComposerPopover = coordinator.register;
  root.closeComposerPopovers = coordinator.closeAll;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createComposerPopoverCoordinator };
  }
})(typeof window !== 'undefined' ? window : globalThis);
