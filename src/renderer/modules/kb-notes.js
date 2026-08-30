// ─── 知识库生态 · 笔记面板（S4）— classic script (window.renderKbNotes) ───
// 计划书 v1.3 §四.7：笔记列表（新建/删除）+ 富文本编辑器（工具栏/标题层级）
// + ✨AI帮写（复用 kbqa.askStream，基于当前知识库流式生成草稿插入编辑器）。
// 存储：contexts 下 notes/ 目录（contexts.mkdir/write/read/delete），纯文本 md。
(function () {
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const _state = { rendered: false, notes: [], current: '' };

  function _toast(msg, variant) {
    if (typeof uiToast === 'function') uiToast(msg, variant ? { variant } : undefined);
  }

  function renderKbNotes() {
    const host = document.getElementById('kb-notes');
    if (!host) return;
    if (!_state.rendered) {
      _state.rendered = true;
      host.innerHTML = `
        <div class="kb-notes">
          <aside class="kb-notes-list">
            <div class="kb-notes-list-head"><h2>笔记</h2><button type="button" class="kb-wb-icon-btn" id="kb-notes-new" title="新建笔记">＋</button></div>
            <div class="kb-notes-items" id="kb-notes-items"></div>
          </aside>
          <section class="kb-notes-editor">
            <div class="kb-notes-toolbar">
              <button type="button" class="ed-btn" data-cmd="undo" title="撤回">↩</button>
              <button type="button" class="ed-btn" data-cmd="redo" title="重做">↪</button>
              <span class="kb-sep"></span>
              <button type="button" class="ed-btn bold" data-cmd="bold" title="加粗">B</button>
              <button type="button" class="ed-btn italic" data-cmd="italic" title="斜体">I</button>
              <button type="button" class="ed-btn underline" data-cmd="underline" title="下划线">U</button>
              <span class="kb-sep"></span>
              <div class="kb-ed-dropdown">
                <button type="button" class="ed-btn" id="kb-notes-head" title="标题层级">标题 <span class="kb-caret">▾</span></button>
                <div class="kb-ed-menu" id="kb-notes-head-menu">
                  <div class="kb-ed-mi" data-fb="h1" style="font-size:16px;font-weight:700">标题 1</div>
                  <div class="kb-ed-mi" data-fb="h2" style="font-size:14px;font-weight:600">标题 2</div>
                  <div class="kb-ed-mi" data-fb="h3" style="font-size:13px;font-weight:600">标题 3</div>
                  <div class="kb-ed-mi" data-fb="p">正文</div>
                </div>
              </div>
              <span class="kb-sep"></span>
              <button type="button" class="ed-btn" data-cmd="insertUnorderedList" title="列表">☰</button>
              <div class="kb-notes-toolbar-right">
                <button type="button" class="kb-wb-a-btn" id="kb-notes-ai" title="基于知识库生成/续写">✨ AI帮写</button>
                <button type="button" class="kb-wb-a-btn" id="kb-notes-save" title="保存 (Cmd/Ctrl+S)">保存</button>
                <button type="button" class="kb-wb-a-btn kb-danger" id="kb-notes-del" title="删除当前笔记">删除</button>
              </div>
            </div>
            <div class="kb-notes-body"><div class="kb-notes-edit" id="kb-notes-edit" contenteditable="true"><p>选择左侧笔记，或点击 ＋ 新建。</p></div></div>
          </section>
        </div>`;
      host.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
        document.execCommand(b.dataset.cmd);
        document.getElementById('kb-notes-edit')?.focus();
      }));
      host.querySelectorAll('#kb-notes-head-menu .kb-ed-mi').forEach((mi) => mi.addEventListener('click', () => {
        document.execCommand('formatBlock', false, mi.dataset.fb);
        document.getElementById('kb-notes-head-menu').classList.remove('show');
      }));
      document.getElementById('kb-notes-head')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('kb-notes-head-menu')?.classList.toggle('show');
      });
      document.getElementById('kb-notes-new')?.addEventListener('click', _newNote);
      document.getElementById('kb-notes-save')?.addEventListener('click', _save);
      document.getElementById('kb-notes-ai')?.addEventListener('click', _aiWrite);
      document.getElementById('kb-notes-del')?.addEventListener('click', _deleteNote);
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.kb-ed-dropdown')) document.getElementById('kb-notes-head-menu')?.classList.remove('show');
      });
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          const ed = document.getElementById('kb-notes-edit');
          if (ed && ed.dataset.note) { e.preventDefault(); _save(); }
        }
      });
    }
    _loadNotes();
  }

  async function _loadNotes() {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    try {
      const res = await window.cogseed.invoke('contexts.tree');
      const tree = (res && Array.isArray(res.tree)) ? res.tree : [];
      const notesDir = tree.find((n) => n.type === 'dir' && n.name === 'notes');
      _state.notes = notesDir
        ? (notesDir.children || []).filter((n) => n.type === 'file').sort((a, b) => a.name.localeCompare(b.name))
        : [];
      _renderList();
    } catch (err) { /* ignore */ }
  }

  function _renderList() {
    const box = document.getElementById('kb-notes-items');
    if (!box) return;
    if (!_state.notes.length) {
      box.innerHTML = '<div class="kb-notes-empty">暂无笔记，点击 ＋ 新建</div>';
      return;
    }
    box.innerHTML = '';
    for (const n of _state.notes) {
      const d = document.createElement('div');
      d.className = 'kb-notes-item' + (n.name === _state.current ? ' active' : '');
      d.textContent = n.name.replace(/\.md$/, '');
      d.addEventListener('click', () => _openNote(n.name));
      box.appendChild(d);
    }
  }

  async function _openNote(name) {
    _state.current = name;
    _renderList();
    const ed = document.getElementById('kb-notes-edit');
    if (!ed) return;
    try {
      const res = await window.cogseed.invoke('contexts.read', { path: `notes/${name}` });
      const content = (res && res.ok !== false && typeof res.content === 'string') ? res.content : '';
      ed.innerHTML = content ? _esc(content).split('\n').map((l) => l.trim() ? `<p>${_esc(l)}</p>` : '<p><br></p>').join('') : '<p><br></p>';
      ed.dataset.note = name;
    } catch (err) {
      _toast('打开失败：' + ((err && err.message) || String(err)), 'error');
    }
  }

  async function _newNote() {
    let title = null;
    try {
      title = typeof uiPrompt === 'function' ? await uiPrompt('笔记标题：') : window.prompt('笔记标题：');
    } catch (_) { return; }
    if (!title || !title.trim()) return;
    const clean = title.trim().replace(/[\/\\]/g, '-');
    try {
      const tree = await window.cogseed.invoke('contexts.tree');
      const hasNotes = (tree && Array.isArray(tree.tree)) ? tree.tree.some((n) => n.type === 'dir' && n.name === 'notes') : false;
      if (!hasNotes) await window.cogseed.invoke('contexts.mkdir', { path: 'notes' });
      const name = `${clean}.md`;
      await window.cogseed.invoke('contexts.write', { path: `notes/${name}`, content: `# ${clean}\n` });
      await _loadNotes();
      await _openNote(name);
    } catch (err) {
      _toast('新建失败：' + ((err && err.message) || String(err)), 'error');
    }
  }

  async function _save() {
    if (!_state.current) return;
    const ed = document.getElementById('kb-notes-edit');
    if (!ed) return;
    try {
      await window.cogseed.invoke('contexts.write', {
        path: `notes/${_state.current}`,
        content: ed.innerText,
      });
      _toast('已保存', 'success');
    } catch (err) {
      _toast('保存失败：' + ((err && err.message) || String(err)), 'error');
    }
  }

  async function _deleteNote() {
    if (!_state.current) return;
    if (typeof uiConfirm === 'function') {
      const ok = await uiConfirm(`删除笔记「${_state.current}」？`);
      if (!ok) return;
    } else if (!window.confirm(`删除笔记「${_state.current}」？`)) {
      return;
    }
    try {
      await window.cogseed.invoke('contexts.delete', { path: `notes/${_state.current}` });
      _state.current = '';
      await _loadNotes();
      const ed = document.getElementById('kb-notes-edit');
      if (ed) { ed.innerHTML = '<p>选择左侧笔记，或点击 ＋ 新建。</p>'; delete ed.dataset.note; }
      _toast('已删除', 'success');
    } catch (err) {
      _toast('删除失败：' + ((err && err.message) || String(err)), 'error');
    }
  }

  // ✨ AI帮写：基于当前知识库（kbqa.askStream）流式生成草稿插入编辑器末尾。
  function _aiWrite() {
    const ed = document.getElementById('kb-notes-edit');
    if (!ed) return;
    if (!window.cogseed || typeof window.cogseed.stream !== 'function') {
      _toast('问答服务不可用', 'warning');
      return;
    }
    const title = _state.current ? _state.current.replace(/\.md$/, '') : '知识库笔记';
    const prompt = `请基于当前知识库的内容，为笔记「${title}」写一段约 100 字的草稿，直接输出正文内容，不要额外解释。`;
    if (!ed.innerText.trim() || ed.dataset.note === undefined) {
      // 没有打开笔记时也允许生成：追加到空编辑器
    }
    const tail = document.createElement('div');
    tail.className = 'kb-notes-ai-draft';
    ed.appendChild(tail);
    ed.scrollTop = ed.scrollHeight;
    try {
      const handle = window.cogseed.stream('kbqa.askStream', { question: prompt, space_id: null, k: 8 }, (ev) => {
        if (!ev) return;
        if (ev.type === 'delta' && ev.text) {
          tail.textContent += ev.text;
          ed.scrollTop = ed.scrollHeight;
        } else if (ev.type === 'error') {
          tail.textContent += '\n[生成失败]';
        }
      });
      if (handle && handle.promise) handle.promise.catch(() => { /* ignore */ });
    } catch (err) {
      tail.textContent = '\n[生成失败：' + ((err && err.message) || String(err)) + ']';
    }
  }

  window.renderKbNotes = renderKbNotes;
})();
