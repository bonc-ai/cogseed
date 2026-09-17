// Skill-only DOM bindings. Loaded immediately after skills.js when either the
// Skills tab or the chat Agent/Skill picker first needs that surface.
// 认知资产相关的绑定与错误文案已随 skills.js 瘦身迁出：错误翻译在
// cognition-assets/core.js（NS.recallErrorText），事件在 cognition-assets/app.js。

function _initSkillsStaticBindings() {
  const panel = document.getElementById('panel-skills');
  if (panel && panel.dataset.skillBindings === '1') return;
  if (panel) panel.dataset.skillBindings = '1';

  document.getElementById('create-skill-btn')?.addEventListener('click', () => {
    openSkillModal();
  });
  document.getElementById('skills-more-btn')?.addEventListener('click', () => {
    const load = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof load !== 'function') return;
    load('marketplace').then(() => openMarketplace('skill')).catch(() => {});
  });
  document.getElementById('skill-use-btn')?.addEventListener('click', () => {
    if (_selectedSkill && !_skillsCache?.some((s) => s.id === _selectedSkill.id && s.enabled === false)) {
      useSkill(_selectedSkill.id, _selectedSkill.name);
    }
  });
  document.getElementById('skill-edit-btn')?.addEventListener('click', toggleSkillEditMode);
  document.getElementById('skill-delete-btn')?.addEventListener('click', deleteSelectedSkill);
  document.getElementById('skill-upload-marketplace-btn')?.addEventListener('click', () => {
    if (_selectedSkill && typeof openMarketplaceUpload === 'function') {
      openMarketplaceUpload('skill', _selectedSkill.id, _selectedSkill.source);
    }
  });
  document.getElementById('skill-chat-clear-btn')?.addEventListener('click', clearSkillChat);
  document.getElementById('skills-back-btn')?.addEventListener('click', () => _onSkillsBack());
  document.getElementById('skills-source-toggle')?.addEventListener('click', () => _toggleSkillsSource());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 技能库现在挂在连接页「技能」tab：仅当该 pane 可见时处理 Esc 返回。
    const skillsPane = document.getElementById('connections-pane-skills');
    if (!skillsPane || skillsPane.hidden) return;
    const detail = document.getElementById('skills-detail-view');
    if (detail && detail.style.display !== 'none') {
      _onSkillsBack();
      e.preventDefault();
    }
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('skill-row-menu');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(e.target)) return;
    if (e.target.closest('[data-skill-more]')) return;
    _closeSkillRowMenu();
  });
  window.addEventListener('scroll', _closeSkillRowMenu, true);
  window.addEventListener('resize', _closeSkillRowMenu);
  window.addEventListener('i18n-change', () => {
    _closeSkillRowMenu();
    if (_skillsCache) renderSkillsGrid(_skillsCache);
  });
  const skillChatInput = document.getElementById('skills-chat-input');
  skillChatInput?.addEventListener('input', () => autoGrow(skillChatInput, 120));
  // Composer chat-use bindings are owned by the eager chat-use core. The
  // binder is idempotent, but Skills navigation must not initialize chat.
}

_initSkillsStaticBindings();
