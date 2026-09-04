// Settings tab switching.
//
// PC's Settings tab binding lives in sync_settings.js, which is stripped from
// the open-source build. Keep this tiny standalone module so the remaining local Settings
// panes still bind after sync.

// 一级页面 header：统一由 uiPageHeader() 渲染（页面骨架规格 PH-01..PH-06）。
// 设置页是 tab 容器，页级没有单一主操作（操作落在各 tab 内），故只渲染语义 h1
// 标题，不设操作（PH-05：无操作页面保持同一标题骨架）。
function _renderSettingsPageHeader() {
  if (typeof document.getElementById !== 'function') return;
  const root = document.getElementById('settings-page-header');
  if (!root || typeof uiPageHeader !== 'function') return;
  root.innerHTML = uiPageHeader({ title: typeof t === 'function' ? t('settings.title') : '设置' });
}

function activateSettingsTab(name) {
  const tabs = Array.from(document.querySelectorAll('.settings-tab'));
  if (!tabs.length) return;

  // If the requested tab was removed by open-source stripping, fall back to the
  // first surviving tab so no pane stays hidden.
  const existing = tabs.find((btn) => btn.dataset.settingsTab === name);
  const target = existing ? name : tabs[0].dataset.settingsTab;
  const panes = document.querySelectorAll('.settings-tab-pane');

  tabs.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.settingsTab === target);
  });
  panes.forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== target;
  });
}

function initSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  if (!tabs.length) return;

  if (!window.__settingsTabsBound) {
    window.__settingsTabsBound = true;
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('i18n-change', _renderSettingsPageHeader);
    }
  }
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => activateSettingsTab(btn.dataset.settingsTab));
  });

  const defaultTab = document.querySelector('.settings-tab.is-active')?.dataset.settingsTab
    || tabs[0]?.dataset.settingsTab;
  _renderSettingsPageHeader();
  activateSettingsTab(defaultTab);
}

window.initSettingsTabs = initSettingsTabs;
window.activateSettingsTab = activateSettingsTab;
