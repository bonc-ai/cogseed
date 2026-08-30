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

  const _state = { rendered: false, notes: [], current: '', filter: 'all', selRange: null };

  function _toast(msg, variant) {
    if (typeof uiToast === 'function') uiToast(msg, variant ? { variant } : undefined);
  }

  // ── 选区保持机制：点击工具栏会清空编辑器选区，命令前恢复（execCommand 生效的前提）──
  function _trackEdSelection() {
    document.addEventListener('selectionchange', () => {
      const ed = document.getElementById('kb-notes-edit');
      const sel = window.getSelection();
      if (ed && sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
        try { _state.selRange = sel.getRangeAt(0).cloneRange(); } catch (_) { /* ignore */ }
      }
    });
  }

  // 恢复编辑器焦点 + 上次选区；无选区时把光标放到编辑器末尾
  function _restoreEdSel() {
    const ed = document.getElementById('kb-notes-edit');
    if (!ed) return;
    ed.focus();
    const sel = window.getSelection();
    if (_state.selRange && ed.contains(_state.selRange.startContainer)) {
      try {
        sel.removeAllRanges();
        sel.addRange(_state.selRange);
        return;
      } catch (_) { /* fallthrough */ }
    }
    // 无可用选区 → 光标移到末尾
    try {
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (_) { /* ignore */ }
  }

  // 需要选区（对选中文字生效）的命令：无选区时提示新手
  const _SEL_CMDS = new Set(['bold', 'italic', 'underline', 'strikeThrough', 'foreColor', 'hiliteColor', 'removeFormat']);

  // 统一命令执行器：恢复选区 → 执行 → 回焦
  function _execCmd(cmd, val) {
    _restoreEdSel();
    if (_SEL_CMDS.has(cmd)) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString()) {
        _toast('请先在正文中选中要修改的文字', 'info');
        return;
      }
    }
    try {
      document.execCommand(cmd, false, val);
    } catch (_) { /* ignore */ }
    const ed = document.getElementById('kb-notes-edit');
    ed?.focus();
  }

  function _execHtml(html) {
    _execCmd('insertHTML', html);
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
            <div class="kb-notes-filter">
              <span class="kb-notes-filter-tag${_state.filter === 'all' ? ' is-active' : ''}" data-nf="all">全部</span>
              <span class="kb-notes-filter-tag${_state.filter === '30d' ? ' is-active' : ''}" data-nf="30d">过去30天</span>
            </div>
            <div class="kb-notes-items" id="kb-notes-items"></div>
          </aside>
          <section class="kb-notes-editor">
            <div class="kb-notes-toolbar">
              <button type="button" class="ed-btn" data-cmd="undo" title="撤回">↩</button>
              <button type="button" class="ed-btn" data-cmd="redo" title="重做">↪</button>
              <span class="kb-sep"></span>
              <div class="kb-ed-dropdown">
                <button type="button" class="ed-btn" id="kb-notes-insert-btn" title="插入">插入 <span class="kb-caret">▾</span></button>
                <div class="kb-ed-menu kb-notes-insert-menu" id="kb-notes-insert-menu">
                  <div class="kb-notes-insert-item" data-insert="table">▦ 表格 <span class="kb-caret">▸</span>
                    <div class="kb-ed-menu kb-notes-insert-sub kb-table-picker" data-sub="table">
                      <div class="kb-table-picker-title">插入表格 <span class="kb-table-picker-size" id="kb-table-size">5 × 5</span></div>
                      <div class="kb-table-grid" id="kb-table-grid"></div>
                    </div>
                  </div>
                  <div class="kb-notes-insert-item" data-insert="link">🔗 链接</div>
                  <div class="kb-notes-insert-item" data-insert="image">🖼 图片</div>
                  <div class="kb-notes-insert-item" data-insert="hr">─ 分割线</div>
                  <div class="kb-notes-insert-item" data-insert="quote">❝ 引用</div>
                  <div class="kb-notes-insert-sep"></div>
                  <div class="kb-notes-insert-item" data-insert="audio">🎙 录音纪要</div>
                  <div class="kb-notes-insert-item" data-insert="attach">📎 附件 <span class="kb-caret">▸</span>
                    <div class="kb-ed-menu kb-notes-insert-sub" data-sub="attach"><div class="kb-notes-insert-item" data-insert="attach-file">上传附件</div></div>
                  </div>
                </div>
              </div>
              <span class="kb-sep"></span>
              <button type="button" class="ed-btn bold" data-cmd="bold" title="加粗">B</button>
              <button type="button" class="ed-btn italic" data-cmd="italic" title="斜体">I</button>
              <button type="button" class="ed-btn underline" data-cmd="underline" title="下划线">U</button>
              <button type="button" class="ed-btn strike" data-cmd="strikeThrough" title="删除线">S</button>
              <button type="button" class="ed-btn" data-cmd="hilite" title="背景颜色" id="kb-notes-hilite-btn">🖍</button>
              <div class="kb-ed-dropdown">
                <button type="button" class="ed-btn" id="kb-notes-color-btn" title="字体颜色">A<span class="kb-color-bar"></span></button>
                <div class="kb-ed-menu kb-notes-color-menu" id="kb-notes-color-menu" hidden></div>
              </div>
              <span class="kb-sep"></span>
              <div class="kb-ed-dropdown">
                <button type="button" class="ed-btn" id="kb-notes-size-btn" title="样式">正文1 <span class="kb-caret">▾</span></button>
                <div class="kb-ed-menu kb-notes-style-menu" id="kb-notes-size-menu">
                  <div class="kb-ed-mi kb-style-item" data-style="h1" style="font-size:17px;font-weight:700">标题</div>
                  <div class="kb-ed-mi kb-style-item" data-style="h2" style="font-size:15px;font-weight:600">标题1</div>
                  <div class="kb-ed-mi kb-style-item" data-style="h3" style="font-size:13.5px;font-weight:600">标题2</div>
                  <div class="kb-ed-mi kb-style-item" data-style="strong" style="font-size:13px;font-weight:600">标题3</div>
                  <div class="kb-ed-mi kb-style-item is-selected" data-style="p" style="font-size:13.5px">正文1</div>
                  <div class="kb-ed-mi kb-style-item" data-style="p4" style="font-size:14px">正文2</div>
                  <div class="kb-ed-mi kb-style-item" data-style="p5" style="font-size:15px">正文3</div>
                </div>
              </div>
              <div class="kb-ed-dropdown">
                <button type="button" class="ed-btn" id="kb-notes-align-btn" title="对齐">≡ <span class="kb-caret">▾</span></button>
                <div class="kb-ed-menu kb-notes-align-menu" id="kb-notes-align-menu">
                  <div class="kb-ed-mi kb-align-item" data-align="justifyLeft">⬅ 左对齐</div>
                  <div class="kb-ed-mi kb-align-item" data-align="justifyCenter">➡⬅ 居中</div>
                  <div class="kb-ed-mi kb-align-item" data-align="justifyRight">➡ 右对齐</div>
                  <div class="kb-ed-mi kb-align-item is-selected" data-align="justifyFull">☰ 两端对齐</div>
                </div>
              </div>
              <span class="kb-sep"></span>
              <button type="button" class="ed-btn" data-cmd="insertUnorderedList" title="列表">☰</button>
              <span class="kb-sep"></span>
              <button type="button" class="ed-btn" id="kb-notes-painter" title="格式刷，双击复用(⌘⇧C)">🖌</button>
              <button type="button" class="ed-btn" data-cmd="removeFormat" title="清除格式(⌘\)">⌫</button>
              <div class="kb-notes-toolbar-right">
                <button type="button" class="kb-wb-a-btn" id="kb-notes-to-lib" title="把当前笔记添加到个人或共享知识库">📚 添加到知识库</button>
                <button type="button" class="kb-wb-a-btn" id="kb-notes-ai" title="基于知识库生成/续写">✨ AI帮写</button>
                <button type="button" class="kb-wb-a-btn" id="kb-notes-save" title="保存 (Cmd/Ctrl+S)">保存</button>
                <div class="kb-ed-dropdown">
                  <button type="button" class="kb-wb-a-btn" id="kb-notes-more-btn" title="更多">⋯</button>
                  <div class="kb-ed-menu kb-notes-more-menu" id="kb-notes-more-menu">
                    <div class="kb-ed-mi" data-more="clear">清除格式</div>
                    <div class="kb-ed-mi kb-danger" data-more="del">删除笔记</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="kb-notes-body"><div class="kb-notes-edit" id="kb-notes-edit" contenteditable="true"><p>选择左侧笔记，或点击 ＋ 新建。</p></div></div>
          </section>
        </div>`;
      _trackEdSelection();
      _bindNoteAttachEvents();
      host.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
        const cmd = b.dataset.cmd;
        _execCmd(cmd);
      }));
      // 样式菜单（标题/标题1-3/正文1-3，选中浅绿对勾）
      document.getElementById('kb-notes-size-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('kb-notes-size-menu')?.classList.toggle('show');
      });
      host.querySelectorAll('#kb-notes-size-menu .kb-style-item').forEach((mi) => mi.addEventListener('click', () => {
        const st = mi.dataset.style;
        if (st === 'h1') _execCmd('formatBlock', 'h1');
        else if (st === 'h2') _execCmd('formatBlock', 'h2');
        else if (st === 'h3') _execCmd('formatBlock', 'h3');
        else if (st === 'strong') { _execCmd('formatBlock', 'p'); _execCmd('fontSize', '4'); }
        else if (st === 'p') { _execCmd('formatBlock', 'p'); _execCmd('fontSize', '3'); }
        else if (st === 'p4') { _execCmd('formatBlock', 'p'); _execCmd('fontSize', '4'); }
        else if (st === 'p5') { _execCmd('formatBlock', 'p'); _execCmd('fontSize', '5'); }
        host.querySelectorAll('#kb-notes-size-menu .kb-style-item').forEach((x) => x.classList.toggle('is-selected', x === mi));
        document.getElementById('kb-notes-size-btn').firstChild.textContent = mi.textContent.trim() + ' ';
        document.getElementById('kb-notes-size-menu')?.classList.remove('show');
      }));
      // 对齐（含两端对齐，选中态）
      document.getElementById('kb-notes-align-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('kb-notes-align-menu')?.classList.toggle('show');
      });
      host.querySelectorAll('#kb-notes-align-menu .kb-align-item').forEach((mi) => mi.addEventListener('click', () => {
        _execCmd(mi.dataset.align);
        host.querySelectorAll('#kb-notes-align-menu .kb-align-item').forEach((x) => x.classList.toggle('is-selected', x === mi));
        document.getElementById('kb-notes-align-menu')?.classList.remove('show');
      }));
      // 背景/文字颜色拾色器（6×10 色板）
      document.getElementById('kb-notes-hilite-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        _renderColorPanel('bg');
      });
      document.getElementById('kb-notes-color-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        _renderColorPanel('fg');
      });
      // 格式刷（单击复制格式，双击复用；对选中目标应用）
      let painterStyle = null;
      let painterArmed = false;
      const painterBtn = document.getElementById('kb-notes-painter');
      painterBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        _restoreEdSel();
        const sel = window.getSelection();
        const node = sel && sel.anchorNode && sel.anchorNode.parentElement;
        if (!painterStyle && node) {
          const cs = getComputedStyle(node);
          painterStyle = {
            color: cs.color, bg: cs.backgroundColor,
            bold: parseInt(cs.fontWeight, 10) >= 600,
            italic: cs.fontStyle === 'italic',
            underline: cs.textDecoration.includes('underline'),
            strike: cs.textDecoration.includes('line-through'),
            size: cs.fontSize,
          };
          painterBtn.classList.add('is-active');
          _toast(painterArmed ? '已复制格式，双击目标连续应用' : '已复制格式，请选中目标后再次点击应用', 'info');
        } else if (painterStyle) {
          const text = sel ? sel.toString() : '';
          if (text) {
            const style = `color:${painterStyle.color};background-color:${painterStyle.bg};font-weight:${painterStyle.bold ? 700 : 400};font-style:${painterStyle.italic ? 'italic' : 'normal'};text-decoration:${painterStyle.underline ? 'underline ' : ''}${painterStyle.strike ? 'line-through' : ''};font-size:${painterStyle.size}`;
            _execHtml(`<span style="${style}">${_esc(text)}</span>`);
          } else {
            _toast('请先在正文中选中要应用格式的文字', 'info');
          }
          if (!painterArmed) { painterStyle = null; painterBtn.classList.remove('is-active'); }
        } else {
          _toast('请先选中带格式的文字，再点格式刷复制', 'info');
        }
        document.getElementById('kb-notes-edit')?.focus();
      });
      painterBtn?.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        painterArmed = !painterArmed;
        painterBtn.classList.toggle('is-armed', painterArmed);
        _toast(painterArmed ? '格式刷已锁定，可连续应用（再双击解锁）' : '格式刷已解锁', 'info');
      });
      // 清除格式快捷键 ⌘\
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === '\\')) {
          const ed = document.getElementById('kb-notes-edit');
          if (ed && ed.dataset.note) { e.preventDefault(); _execCmd('removeFormat'); }
        }
      });
      // 插入菜单（含二级）
      document.getElementById('kb-notes-insert-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('kb-notes-insert-menu')?.classList.toggle('show');
      });
      host.querySelectorAll('#kb-notes-insert-menu .kb-notes-insert-item[data-insert]').forEach((it) => {
        const act = it.dataset.insert;
        if (act === 'table') {
          // 表格：10×10 网格选择器（悬浮选行列，点击插入）
          const sub = it.querySelector('.kb-notes-insert-sub');
          it.addEventListener('mouseenter', () => { sub.classList.add('show'); _renderTableGrid(); });
          it.addEventListener('mouseleave', () => { sub.classList.remove('show'); });
          it.addEventListener('click', (e) => { e.stopPropagation(); sub.classList.toggle('show'); _renderTableGrid(); });
          return;
        }
        if (act === 'attach') {
          // 二级：悬浮/点击展开子菜单
          const sub = it.querySelector('.kb-notes-insert-sub');
          if (sub) {
            it.addEventListener('mouseenter', () => { sub.classList.add('show'); });
            it.addEventListener('mouseleave', () => { sub.classList.remove('show'); });
            it.addEventListener('click', (e) => { e.stopPropagation(); sub.classList.toggle('show'); });
          }
          if (sub) sub.querySelectorAll('.kb-notes-insert-item').forEach((s) => s.addEventListener('click', (e) => {
            e.stopPropagation();
            _notesInsert(s.dataset.insert);
            document.getElementById('kb-notes-insert-menu')?.classList.remove('show');
          }));
          return;
        }
        it.addEventListener('click', (e) => {
          e.stopPropagation();
          _notesInsert(act);
          document.getElementById('kb-notes-insert-menu')?.classList.remove('show');
        });
      });
      // 更多菜单
      document.getElementById('kb-notes-more-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('kb-notes-more-menu')?.classList.toggle('show');
      });
      host.querySelectorAll('#kb-notes-more-menu .kb-ed-mi').forEach((mi) => mi.addEventListener('click', () => {
        document.getElementById('kb-notes-more-menu')?.classList.remove('show');
        if (mi.dataset.more === 'clear') {
          _execCmd('removeFormat');
        } else if (mi.dataset.more === 'del') {
          _deleteNote();
        }
      }));
      document.getElementById('kb-notes-new')?.addEventListener('click', _newNote);
      document.getElementById('kb-notes-save')?.addEventListener('click', _save);
      document.getElementById('kb-notes-ai')?.addEventListener('click', _aiWrite);
      document.getElementById('kb-notes-to-lib')?.addEventListener('click', _addToLib);
      host.querySelectorAll('.kb-notes-filter-tag').forEach((t) => t.addEventListener('click', () => {
        _state.filter = t.dataset.nf === '30d' ? '30d' : 'all';
        host.querySelectorAll('.kb-notes-filter-tag').forEach((x) => x.classList.toggle('is-active', x === t));
        _renderList();
      }));
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.kb-ed-dropdown')) {
          host.querySelectorAll('.kb-ed-menu').forEach((m) => m.classList.remove('show'));
        }
        if (!e.target.closest('.kb-code-lang')) {
          document.querySelectorAll('.kb-code-lang-menu').forEach((m) => { m.hidden = true; });
        }
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
    const cutoff = _state.filter === '30d' ? Date.now() - 30 * 24 * 3600 * 1000 : 0;
    const notes = _state.notes
      .filter((n) => !cutoff || (Number(n.mtime) || 0) * 1000 >= cutoff)
      .sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
    if (!notes.length) {
      box.innerHTML = `<div class="kb-notes-empty">${_state.filter === '30d' ? '过去 30 天没有笔记' : '暂无笔记，点击 ＋ 新建'}</div>`;
      return;
    }
    box.innerHTML = '';
    for (const n of notes) {
      const d = document.createElement('div');
      d.className = 'kb-notes-item' + (n.name === _state.current ? ' active' : '');
      const title = n.name.replace(/\.md$/, '');
      const date = n.mtime ? (() => {
        const dt = new Date(Number(n.mtime) * 1000);
        return `${dt.getMonth() + 1}/${dt.getDate()}`;
      })() : '';
      d.innerHTML = `<div class="kb-notes-item-title">${_esc(title)}</div><div class="kb-notes-item-date">${date}</div>`;
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
      // 富文本（含 HTML 标签）原样还原；纯文本（旧笔记）按行转段落
      if (/<[a-z][\s\S]*>/i.test(content)) {
        ed.innerHTML = content || '<p><br></p>';
      } else {
        ed.innerHTML = content ? _esc(content).split('\n').map((l) => l.trim() ? `<p>${_esc(l)}</p>` : '<p><br></p>').join('') : '<p><br></p>';
      }
      ed.dataset.note = name;
      _state.selRange = null; // 切换笔记后清空旧选区
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
        content: ed.innerHTML, // 富文本 HTML 持久化（加粗/颜色/表格/图片均保留）
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

  // ── 添加到知识库（对齐 ima「选择要添加的知识库」：个人库 + 共享库分组）──
  let _libPicker = null;

  function _closeLibPicker() {
    if (_libPicker) { _libPicker.remove(); _libPicker = null; }
  }

  async function _addToLib() {
    if (!_state.current) { _toast('请先打开一篇笔记', 'warning'); return; }
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') return;
    const [treeRes, spacesRes] = await Promise.all([
      window.cogseed.invoke('contexts.tree').catch(() => null),
      window.cogseed.invoke('spaces.list').catch(() => null),
    ]);
    const tree = (treeRes && Array.isArray(treeRes.tree)) ? treeRes.tree : [];
    const personal = tree.filter((n) => n.type === 'dir' && n.name !== 'notes').map((n) => ({ id: n.name, name: n.name }));
    const spaces = (spacesRes && Array.isArray(spacesRes.spaces)) ? spacesRes.spaces : [];
    if (!personal.length && !spaces.length) { _toast('暂无可添加的知识库', 'warning'); return; }

    _closeLibPicker();
    const overlay = document.createElement('div');
    overlay.className = 'kb-lib-picker-overlay';
    overlay.innerHTML = `
      <div class="kb-lib-picker">
        <div class="kb-lib-picker-title">选择要添加的知识库</div>
        <div class="kb-lib-picker-groups">
          ${personal.length ? `<div class="kb-lib-picker-group"><div class="kb-lib-picker-group-label">个人知识库</div>${personal.map((l) =>
            `<div class="kb-lib-picker-item" data-kind="lib" data-id="${_esc(l.id)}"><span class="kb-lib-picker-ico">📚</span><span>${_esc(l.name)}</span></div>`
          ).join('')}</div>` : ''}
          ${spaces.length ? `<div class="kb-lib-picker-group"><div class="kb-lib-picker-group-label">共享知识库</div>${spaces.map((s) =>
            `<div class="kb-lib-picker-item" data-kind="space" data-id="${_esc(s.space_id)}"><span class="kb-lib-picker-ico">🌐</span><span>${_esc(s.name || s.space_id)}</span></div>`
          ).join('')}</div>` : ''}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    _libPicker = overlay;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) _closeLibPicker();
    });
    overlay.querySelectorAll('.kb-lib-picker-item').forEach((item) => {
      item.addEventListener('click', () => {
        const kind = item.dataset.kind;
        const id = item.dataset.id;
        _closeLibPicker();
        _copyNoteToLib(kind, id);
      });
    });
  }

  // 把当前笔记内容复制到目标库（个人库 contexts.write / 共享库 createText+updateText）
  // 把当前笔记归档到目标库（移动语义：写入目标库成功后移除原笔记，绕开内容级 dedup）
  async function _copyNoteToLib(kind, id) {
    const ed = document.getElementById('kb-notes-edit');
    if (!ed || !_state.current) return;
    const content = ed.innerHTML || '';
    const name = _state.current;
    try {
      let finalName = name;
      if (kind === 'lib') {
        // 防重名：目标库已有同名 → 加 -2/-3
        const tree = await window.cogseed.invoke('contexts.tree');
        const lib = (tree && Array.isArray(tree.tree)) ? tree.tree.find((n) => n.type === 'dir' && n.name === id) : null;
        const existing = new Set((lib && lib.children || []).map((c) => c.name));
        if (existing.has(finalName)) {
          const base = finalName.replace(/\.md$/, '');
          let i = 2;
          while (existing.has(`${base}-${i}.md`)) i += 1;
          finalName = `${base}-${i}.md`;
        }
        let res = await window.cogseed.invoke('contexts.write', { path: `${id}/${finalName}`, content });
        if (res && res.ok === false && /duplicate|exists/i.test(res.error || '')) {
          // 内容级去重拦截（内容已存在于原笔记）→ 先移除原笔记再写入
          await window.cogseed.invoke('contexts.delete', { path: `notes/${name}` }).catch(() => {});
          res = await window.cogseed.invoke('contexts.write', { path: `${id}/${finalName}`, content });
        }
        if (res && res.ok === false) throw new Error(res.error || 'write failed');
        // 移动语义：移除原笔记（若仍在笔记面板）
        await window.cogseed.invoke('contexts.delete', { path: `notes/${name}` }).catch(() => {});
        _toast(`已添加到个人知识库「${id}」（原笔记已归档）`, 'success');
      } else {
        const res1 = await window.cogseed.invoke('spaces.files.createText', { spaceId: id, name: finalName });
        if (res1 && res1.ok === false) {
          // 已存在 → 加后缀
          const base = finalName.replace(/\.md$/, '');
          finalName = `${base}-${Date.now()}.md`;
          const r2 = await window.cogseed.invoke('spaces.files.createText', { spaceId: id, name: finalName });
          if (r2 && r2.ok === false) throw new Error(r2.error || 'create failed');
        }
        const res2 = await window.cogseed.invoke('spaces.files.updateText', { spaceId: id, name: finalName, content });
        if (res2 && res2.ok === false) throw new Error(res2.error || 'write failed');
        await window.cogseed.invoke('contexts.delete', { path: `notes/${name}` }).catch(() => {});
        _toast('已添加到共享知识库（原笔记已归档）', 'success');
      }
      // 笔记面板移除当前笔记
      _state.current = '';
      const edEl = document.getElementById('kb-notes-edit');
      if (edEl) { edEl.innerHTML = '<p>选择左侧笔记，或点击 ＋ 新建。</p>'; delete edEl.dataset.note; }
      await _loadNotes();
    } catch (err) {
      _toast('添加失败：' + ((err && err.message) || String(err)), 'error');
    }
  }

  // ── 背景/文字颜色拾色器（对齐 ima：标题 + 清除项 + 6×10 色板，选中绿框）──
  const KB_COLOR_PANEL = [
    ['#FFFFFF', '#DBEAFE', '#CFFAFE', '#D1FAE5', '#FEE2E2', '#FEF3C7', '#FEF9C3', '#EDE9FE', '#FCE7F3', '#FFF1F2'],
    ['#CCCCCC', '#93C5FD', '#67E8F9', '#6EE7B7', '#FCA5A5', '#FCD34D', '#FDE047', '#C4B5FD', '#F9A8D4', '#FDA4AF'],
    ['#999999', '#60A5FA', '#22D3EE', '#34D399', '#F87171', '#FBBF24', '#FACC15', '#A78BFA', '#F472B6', '#FB7185'],
    ['#666666', '#2563EB', '#06B6D4', '#10B981', '#EF4444', '#F59E0B', '#EAB308', '#7C3AED', '#EC4899', '#F43F5E'],
    ['#333333', '#1D4ED8', '#0E7490', '#047857', '#B91C1C', '#B45309', '#A16207', '#5B21B6', '#BE185D', '#BE123C'],
    ['#000000', '#172554', '#164E63', '#064E3B', '#450A0A', '#78350F', '#713F12', '#2E1065', '#831843', '#4C0519'],
  ];

  function _renderColorPanel(mode) {
    const menu = document.getElementById('kb-notes-color-menu');
    if (!menu) return;
    const isBg = mode === 'bg';
    menu.classList.add('show');
    menu.innerHTML = `
      <div class="kb-color-title">${isBg ? '背景颜色' : '文字颜色'}</div>
      <div class="kb-color-clear">${isBg ? '无颜色' : '默认颜色'}</div>
      <div class="kb-color-grid">
        ${KB_COLOR_PANEL.map((row) => row.map((c) =>
          `<div class="kb-color-cell${isBg && c === '#FFE58A' ? ' is-selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></div>`
        ).join('')).join('')}
      </div>`;
    menu.querySelectorAll('.kb-color-cell').forEach((cell) => cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = cell.dataset.color;
      if (isBg) _execCmd('hiliteColor', c);
      else _execCmd('foreColor', c);
      menu.classList.remove('show');
      document.getElementById('kb-notes-edit')?.focus();
    }));
    menu.querySelector('.kb-color-clear').addEventListener('click', (e) => {
      e.stopPropagation();
      if (isBg) _execCmd('hiliteColor', 'transparent');
      else _execCmd('foreColor', '#000000');
      menu.classList.remove('show');
      document.getElementById('kb-notes-edit')?.focus();
    });
  }

  // 表格 10×10 网格选择器（悬浮高亮行列，点击插入）
  function _renderTableGrid() {
    const grid = document.getElementById('kb-table-grid');
    const sizeEl = document.getElementById('kb-table-size');
    if (!grid || grid.dataset.rendered) return;
    grid.dataset.rendered = '1';
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const cell = document.createElement('div');
        cell.className = 'kb-table-cell';
        cell.dataset.r = String(r + 1);
        cell.dataset.c = String(c + 1);
        cell.addEventListener('mouseenter', () => {
          grid.querySelectorAll('.kb-table-cell').forEach((x) => x.classList.toggle('is-active', Number(x.dataset.r) <= r + 1 && Number(x.dataset.c) <= c + 1));
          if (sizeEl) sizeEl.textContent = `${r + 1} × ${c + 1}`;
        });
        cell.addEventListener('click', () => {
          _notesInsert(`table-${r + 1}x${c + 1}`);
          document.getElementById('kb-notes-insert-menu')?.classList.remove('show');
        });
        grid.appendChild(cell);
      }
    }
  }

  // 「插入」菜单：表格/链接/图片/分割线/引用（录音/附件/笔记留占位）
  function _notesInsert(act) {
    const ed = document.getElementById('kb-notes-edit');
    if (!ed) return;
    const t = (html) => { _execHtml(html); ed.focus(); };
    const tMatch = /^table-(\d+)x(\d+)$/.exec(act);
    if (tMatch) {
      const R = Number(tMatch[1]); const C = Number(tMatch[2]);
      const row = '<tr>' + '<td><br></td>'.repeat(C) + '</tr>';
      t(`<table class="kb-notes-table" cellpadding="6" cellspacing="0"><tbody>${row.repeat(R)}</tbody></table><p><br></p>`);
    }
    else if (act === 'link') { _openLinkDialog(); }
    else if (act === 'image') {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) { _toast('图片过大，请选择 2MB 以内的图片', 'warning'); return; }
        const reader = new FileReader();
        reader.onload = () => {
          _execCmd('insertImage', String(reader.result || ''));
          ed.focus();
        };
        reader.readAsDataURL(f);
      });
      input.click();
    }
    else if (act === 'hr') t('<hr>');
    else if (act === 'quote') t('<blockquote>引用内容</blockquote>');
    else if (act === 'attach-file') _uploadAttachment();
    else if (typeof uiToast === 'function') _toast('该插入能力即将上线', 'info');
  }

  // 🔗 插入链接弹窗（对齐 ima：文本 + 链接 双输入）
  function _openLinkDialog() {
    _closeLinkDialog();
    const overlay = document.createElement('div');
    overlay.className = 'kb-link-dlg-overlay';
    // 预填：当前有选中文字 → 作为链接文本
    let selText = '';
    try {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString()) selText = sel.toString().slice(0, 80);
    } catch (_) { /* ignore */ }
    overlay.innerHTML = `
      <div class="kb-link-dlg">
        <div class="kb-link-dlg-title">插入链接</div>
        <div class="kb-link-field"><label>文本</label><input type="text" class="kb-link-input" id="kb-link-text" placeholder="请输入文本" value="${_esc(selText)}" autocomplete="off" spellcheck="false" /></div>
        <div class="kb-link-field"><label>链接</label><input type="text" class="kb-link-input" id="kb-link-url" placeholder="请输入或粘贴链接" value="https://" autocomplete="off" spellcheck="false" /></div>
        <div class="kb-link-actions">
          <button type="button" class="kb-link-btn kb-link-ghost" id="kb-link-cancel">取消</button>
          <button type="button" class="kb-link-btn kb-link-primary" id="kb-link-ok" disabled>确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const urlInput = overlay.querySelector('#kb-link-url');
    const textInput = overlay.querySelector('#kb-link-text');
    const okBtn = overlay.querySelector('#kb-link-ok');
    const syncOk = () => { okBtn.disabled = !/^https?:\/\/\S+$/i.test(String(urlInput.value || '').trim()); };
    urlInput.addEventListener('input', syncOk);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !okBtn.disabled) _linkOk(); });
    textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !okBtn.disabled) _linkOk(); });
    overlay.querySelector('#kb-link-cancel').addEventListener('click', _closeLinkDialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeLinkDialog(); });
    okBtn.addEventListener('click', _linkOk);
    setTimeout(() => { if (!selText) textInput.focus(); else urlInput.focus(); }, 50);

    function _linkOk() {
      const url = String(urlInput.value || '').trim();
      if (!/^https?:\/\//i.test(url)) return;
      const text = String(textInput.value || '').trim() || url;
      _closeLinkDialog();
      _execHtml(`<a href="${_esc(url)}">${_esc(text)}</a>`);
      document.getElementById('kb-notes-edit')?.focus();
    }
  }

  function _closeLinkDialog() {
    const el = document.querySelector('.kb-link-dlg-overlay');
    if (el) el.remove();
  }

  // 📎 附件上传：文件 → base64 → contexts.upload 存到 notes/attachments/ → 插入附件引用卡片
  async function _uploadAttachment() {
    const input = document.createElement('input');
    input.type = 'file';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      if (f.size > 12 * 1024 * 1024) { _toast('附件不能超过 12MB', 'warning'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        const b64 = String(reader.result || '').split(',')[1] || '';
        const clean = f.name.replace(/[\\/:*?"<>|]/g, '_');
        try {
          const res = await window.cogseed.invoke('contexts.upload', { path: `notes/attachments/${clean}`, data: b64 });
          if (res && res.ok === false) { _toast('上传失败：' + (res.error || 'unknown'), 'error'); return; }
          _execHtml(`<div class="kb-note-attach" data-attach-path="notes/attachments/${_esc(clean)}"><span class="kb-note-attach-name">📎 ${_esc(f.name)}</span><button type="button" class="kb-note-attach-del" title="移除附件引用">✕</button></div>`);
          _toast('附件已上传', 'success');
        } catch (err) {
          _toast('上传失败：' + ((err && err.message) || String(err)), 'error');
        }
      };
      reader.readAsDataURL(f);
    });
    input.click();
  }

  // 附件卡片交互（删除引用 / 点击在文件管理器中定位）——事件委托
  function _bindNoteAttachEvents() {
    const editEl = document.getElementById('kb-notes-edit');
    if (!editEl || editEl.dataset.attachBound) return;
    editEl.dataset.attachBound = '1';
    editEl.addEventListener('click', (e) => {
      const del = e.target.closest('.kb-note-attach-del');
      if (del) { e.stopPropagation(); del.closest('.kb-note-attach').remove(); return; }
      const att = e.target.closest('.kb-note-attach');
      if (att) {
        e.stopPropagation();
        const p = att.dataset.attachPath;
        if (p && window.cogseed && typeof window.cogseed.invoke === 'function') {
          window.cogseed.invoke('contexts.reveal', { path: p }).catch(() => {});
        }
        _toast('已在文件管理器中定位附件', 'info');
      }
    });
  }

  // ✨ AI帮写：基于当前知识库（kbqa.askStream）流式生成草稿插入编辑器末尾。
  function _aiWrite() {    const ed = document.getElementById('kb-notes-edit');
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
