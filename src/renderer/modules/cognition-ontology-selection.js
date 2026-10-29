/* 选中文字修改界面。建议在前端模拟，采用后由现有文档编辑器保存。 */
(function initOntologySelection(root) {
  'use strict';
  const parseRequest = (request, base) => {
    const value = request.trim();
    const english = value.match(/^(?:please\s+)?change to [“\"]([\s\S]*?)[”\"]\s*[.!]?$/i);
    if (english) return { replacement: english[1] };
    let match = value.match(/^(?:请)?(?:把|将)[“「"]([\s\S]*?)[”」"]\s*(?:替换为|改为|改成)[“「"]([\s\S]*?)[”」"]\s*[。！!]?$/);
    if (match) return match[1] && base.split(match[1]).length === 2 ? { replacement: base.replace(match[1], match[2]) } : { error: '要替换的原文须在当前建议中恰好出现一次。' };
    match = value.match(/^(?:请)?(?:从\s*\d{4}-\d{2}-\d{2}\s*起\s*)?(?:改为|改成|替换为|纠正为)[“「"]([\s\S]*?)[”」"]\s*[。！!]?$/);
    if (match) return { replacement: match[1], ...(/纠正/.test(value) ? { intent: 'correct' } : {}), ...(value.match(/从\s*(\d{4}-\d{2}-\d{2})\s*起/) ? { date: value.match(/从\s*(\d{4}-\d{2}-\d{2})\s*起/)[1] } : {}) };
    match = value.match(/^(?:请)?(?:在后面补充|追加|补充)[“「"]([\s\S]*?)[”」"]\s*[。！!]?$/);
    if (match) return { replacement: base + match[1] };
    if (/^(?:删除所选文字|删掉这段|删除这段)[。！!]?$/u.test(value)) return { replacement: '' };
    return { error: '这条指令不在本地模拟范围内。请写“改为「…」”“在后面补充「…」”，或“删除所选文字”；原文未改变。' };
  };
  function mount(container, { getDocument, save, text, esc }) {
    let draft = null, popup = null, destroyed = false;
    const findField = (id, field) => [...container.querySelectorAll('[data-ontology-edit]')].find(node => node.dataset.recordId === id && node.dataset.ontologyEdit === field);
    const displayValue = value => Array.isArray(value) ? value.join('、') : String(value ?? '');
    const getValue = (record, path) => path.split('.').reduce((value, key) => value?.[key], record);
    const t = (key, fallback) => text(key, fallback);
    const control = (label, action, attrs = {}, options = {}) => root.uiButton({ label, size: 'sm', role: options.primary ? 'primary' : 'ghost', className: options.className || '', disabled: !!options.disabled, attrs: { 'data-selection-action': action, ...attrs } });
    function clear() { popup?.remove(); popup = null; container.querySelectorAll('.ont-ai-preview').forEach(node => node.remove()); container.querySelectorAll('.ont-ai-target').forEach(node => node.classList.remove('ont-ai-target')); }
    function close(force = false, next) {
      if (!draft) return true;
      if (!force && draft.saving) return false;
      if (!force && (draft.request || draft.proposal)) { draft.dismiss = true; draft.pendingGo = next; draw(); return false; }
      const target = findField(draft.id, draft.field); clear(); draft = null; target?.focus(); return true;
    }
    function position() {
      if (!popup || !draft) return;
      const bounds = popup.parentElement.getBoundingClientRect();
      const anchor = draft.anchor, width = Math.min(368, bounds.width - 24), height = Math.min(popup.scrollHeight, bounds.height - 24);
      popup.style.width = width + 'px'; popup.style.maxHeight = Math.max(100, bounds.height - 24) + 'px';
      popup.style.left = Math.max(12, Math.min(anchor.left - bounds.left, bounds.width - width - 12)) + 'px';
      const below = anchor.bottom - bounds.top + 9;
      const top = below + height > bounds.height - 12 ? anchor.top - bounds.top - height - 9 : below;
      popup.style.top = Math.max(12, Math.min(top, bounds.height - height - 12)) + 'px';
    }
    function draw() {
      clear(); if (!draft || destroyed) return;
      const d = draft, field = findField(d.id, d.field); field?.classList.add('ont-ai-target');
      if (d.proposal && field) { const preview = document.createElement('span'); preview.className = 'ont-ai-preview'; preview.setAttribute('role', 'status'); preview.innerHTML = `<span class="ont-ai-diff-label">${esc(t('proposalPending', '待采用'))}</span><del>${esc(d.selected)}</del><ins>${esc(d.proposal.replacement || t('deleteText', '（删除）'))}</ins>`; field.closest('.ont-ai-field')?.append(preview); }
      popup = document.createElement('section'); popup.className = 'ont-ai-popup'; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', t('selectionEditTitle', '请求 AI 修改选中文字')); popup.tabIndex = -1;
      const proposal = d.proposal, isFact = getDocument()?.records[d.id]?.kind === 'assertion';
      const disabled = d.saving || (isFact && (!d.intent || (d.intent === 'change' && !d.effectiveFrom)));
      popup.innerHTML = `<header><span>${root.uiIconHtml('sparkles')} ${esc(t('editSelection', '修改选中文字'))} <small>${esc(t('localSuggestion', '本地模拟建议'))}</small></span>${control(t('close', '关闭'), 'close')}</header>
        <div class="ont-ai-popup-body">${d.dismiss ? `<p class="ont-ai-error">${esc(t('discardSelectionQuestion', '有尚未采用的建议，要放弃吗？'))}</p><div class="ont-ai-controls">${control(t('continueEditing', '继续编辑'), 'stay')}${control(t('discard', '放弃修改'), 'discard')}</div>` : `
        <p class="ont-ai-context">${esc(d.name)} · ${esc(text(d.field.split('.').at(-1), d.field))}</p>
        <blockquote>${esc(d.selected || t('emptyText', '（空白字段）'))}</blockquote>
        ${d.error ? `<p class="ont-ai-error" role="alert">${esc(d.error)}</p>` : ''}
        ${proposal ? `<div class="ont-ai-proposed"><span>${esc(t('selectionAfter', '修改后'))}</span><p>${esc(proposal.replacement || t('deleteText', '（删除所选文字）'))}</p></div><p class="ont-ai-impact">${esc(t('selectionOnly', '仅替换所选部分。'))}${isFact ? esc(t('selectionFactHistory', '旧事实与时间区间将按下方意图保留。')) : ''}</p>` : ''}
        ${isFact && proposal ? `<div class="ont-ai-intent"><span>${esc(t('selectionIntentQuestion', '这是哪一种变化？'))}</span><div class="row">${control(t('selectionCorrect', '以前记错了'), 'intent', { 'data-intent': 'correct', 'aria-pressed': String(d.intent === 'correct') })}${control(t('selectionChange', '现实发生变化'), 'intent', { 'data-intent': 'change', 'aria-pressed': String(d.intent === 'change') })}</div>${d.intent === 'change' ? `${root.uiField({ id: 'ontology-selection-effective-date', label: t('effectiveFrom', '生效日期'), showRequirement: false, control: { kind: 'input', type: 'date', value: d.effectiveFrom } })}` : ''}</div>` : ''}
        <label class="ont-ai-request-label" for="ontology-selection-request">${esc(proposal ? t('selectionContinueRequest', '继续告诉我怎么调整') : t('selectionTellRequest', '告诉我怎么改'))}</label>
        ${d.choices.length ? `<p class="ont-ai-limit">${d.choices.map(option => esc(option.label)).join(' / ')}</p>` : ''}
        ${root.uiTextarea({ id: 'ontology-selection-request', value: d.request, placeholder: t('selectionRequestPlaceholder', '例如：改为「新的表述」'), attrs: { rows: 2 } })}
        ${proposal ? '' : `${control(t('tryExample', '试试示例'), 'example', {}, { className: 'ont-ai-example' })}`}
        <div class="ont-ai-controls">${control(proposal ? t('selectionAdjust', '调整建议') : t('selectionGenerate', '生成修改'), 'generate')}${proposal ? `${control(d.saving ? t('saving', '正在保存…') : t('adopt', '采用修改'), 'adopt', {}, { primary: true, disabled })}` : ''}</div>
        <p class="ont-ai-limit">${esc(t('selectionLocalHint', '本地模拟 · 支持引号内替换、追加、删除 · 文本不外发'))}</p>`}</div>`;
      if (d.saving) popup.querySelectorAll('button,input,textarea').forEach(node => { node.disabled = true; });
      (container.querySelector('.ontology-workspace') || container).append(popup); position();
    }
    function open(id, field, start = 0, end) {
      const element = findField(id, field), record = getDocument()?.records[id];
      if (!element || !record || record.status !== 'active' || record.source?.kind === 'legacy') return;
      if (draft && !close()) return;
      const raw = getValue(record, field), choices = JSON.parse(element.dataset.editOptions || '[]'), full = choices.find(option => String(option.value) === String(raw))?.label ?? displayValue(raw);
      end = end ?? full.length;
      draft = { id, field, name: record.name || t('assertion', '事实'), version: record.version, base: displayValue(raw), choices, full, start, end, selected: full.slice(start, end), request: '', proposal: null, intent: '', effectiveFrom: '', error: '', anchor: element.getBoundingClientRect() };
      draw(); popup.querySelector('textarea')?.focus();
    }
    function selection(event) {
      if (event.target.closest('.ont-ai-popup')) return;
      const selected = root.getSelection(); if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return;
      const range = selected.getRangeAt(0), element = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('[data-ontology-edit]');
      if (!element || !container.contains(element) || !element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
      const before = range.cloneRange(); before.selectNodeContents(element); before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length; open(element.dataset.recordId, element.dataset.ontologyEdit, start, start + range.toString().length);
    }
    async function action(event) {
      const button = event.target.closest('[data-selection-action]'); if (!button || !draft) return;
      event.preventDefault(); if (draft.saving) return; const action = button.dataset.selectionAction;
      if (action === 'intent') { draft.intent = button.dataset.intent; draft.error = ''; draw(); return; }
      if (action === 'close') { close(); return; }
      if (action === 'discard') { const next = draft.pendingGo; close(true); next?.(); return; }
      if (action === 'stay') { draft.dismiss = false; draw(); return; }
      if (action === 'example') { draft.request = `改为「${draft.selected}」`; draw(); popup.querySelector('textarea')?.focus(); return; }
      if (action === 'generate' || action === 'regenerate') {
        draft.request = popup.querySelector('#ontology-selection-request').value;
        const proposal = parseRequest(draft.request, draft.proposal?.replacement ?? draft.selected); draft.error = proposal.error || ''; draft.proposal = proposal.error ? null : proposal; if (proposal.date) { draft.intent = 'change'; draft.effectiveFrom = proposal.date; } else if (proposal.intent) draft.intent = proposal.intent; if (!proposal.error) draft.request = ''; draw(); return;
      }
      if (action !== 'adopt' || !draft.proposal || draft.saving) return;
      const d = draft, record = getDocument()?.records[d.id];
      if (record?.kind === 'assertion' && (!d.intent || (d.intent === 'change' && !/^\d{4}-\d{2}-\d{2}$/.test(d.effectiveFrom)))) { d.error = t('selectionIntentRequired', '请区分事实纠正和现实变化，并填写生效日期。'); draw(); return; }
      if (!record || record.version !== d.version || displayValue(getValue(record, d.field)) !== d.base) { d.error = t('selectionConflict', '内容已经变化。建议仍保留，请重新核对当前记录。'); draw(); return; }
      let value = d.full.slice(0, d.start) + d.proposal.replacement + d.full.slice(d.end);
      const original = getValue(record, d.field);
      if (d.choices.length) { const matches = d.choices.filter(option => option.label === value.trim() || String(option.value) === value.trim()), choice = matches.length === 1 ? matches[0] : null; if (!choice) { d.error = t('invalidChoice', '请选择有效值：') + d.choices.map(option => option.label).join(' / '); draw(); return; } value = choice.value; }
      if (typeof original === 'number') { if (!value.trim() || !Number.isFinite(Number(value))) { d.error = t('invalidNumber', '请输入有效数字。'); draw(); return; } value = Number(value); }
      if (Array.isArray(original)) value = value.split(/[、,，\n]/).map(item => item.trim()).filter(Boolean);
      if (d.field === 'name' && !String(value).trim()) { d.error = t('documentNameRequired', '名称不能为空。'); draw(); return; }
      d.saving = true; d.error = ''; draw();
      try { await save(d.id, d.field, value, { intent: d.intent, effectiveFrom: d.effectiveFrom }); if (draft === d) close(true); }
      catch (error) { if (draft === d) { d.saving = false; d.error = error.message; draw(); } }
    }
    function input(event) { if (!draft) return; if (event.target.id === 'ontology-selection-request') draft.request = event.target.value; if (event.target.id === 'ontology-selection-effective-date') { draft.effectiveFrom = event.target.value; const adopt = popup.querySelector('[data-selection-action=adopt]'); if (adopt) adopt.disabled = draft.saving || !draft.effectiveFrom; } }
    function selectedByKeyboard(event) { if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) selection(event); }
    function keyboard(event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && draft && !draft.saving) { event.preventDefault(); popup.querySelector('[data-selection-action=generate]')?.click(); return; }
      if (event.key === 'Escape' && draft) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Enter' && !event.shiftKey && !draft) { const field = event.target.closest('[data-ontology-edit]'); if (field) { event.preventDefault(); open(field.dataset.recordId, field.dataset.ontologyEdit); } }
    }
    container.addEventListener('mouseup', selection); container.addEventListener('click', action); container.addEventListener('input', input); container.addEventListener('keydown', keyboard); container.addEventListener('keyup', selectedByKeyboard);
    root.addEventListener('resize', position);
    return { open, close, refresh: () => { if (draft) draw(); }, hasDraft: () => !!draft, destroy() { destroyed = true; clear(); container.removeEventListener('mouseup', selection); container.removeEventListener('click', action); container.removeEventListener('input', input); container.removeEventListener('keydown', keyboard); container.removeEventListener('keyup', selectedByKeyboard); root.removeEventListener('resize', position); } };
  }
  root.CogOntologySelection = { mount, parseRequest };
})(window);
