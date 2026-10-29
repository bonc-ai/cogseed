/* A readable projection of one canonical ontology module. No record IDs are printed as prose. */
(function initOntologyDocument(root) {
  'use strict';

  function today() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }

  function render({ doc, moduleId, text, esc, drafts = {}, editable = true, at = today(), expandedId = '', inspector = () => '', openDetails = {} }) {
    const records = doc?.records || {};
    const module = records[moduleId];
    if (!module || module.kind !== 'module') return '';
    const t = (key, fallback, vars) => text(key, fallback, vars);
    const e = value => esc(value == null ? '' : String(value));
    const clip = (value, max) => {
      const textValue = String(value || '').trim();
      return textValue.length > max ? textValue.slice(0, max - 1) + '…' : textValue;
    };
    const control = (label, action, className, attrs = {}, icon = '', iconOnly = false) => root[iconOnly ? 'uiIconButton' : 'uiButton']({ label, role: 'ghost', size: 'sm', className, ...(icon ? { icon } : {}), attrs: { 'data-ontology-action': action, ...attrs } });
    const actionButton = (label, action, attrs = {}) => root.uiButton({ label, role: 'ghost', className: 'ontology-doc-inline-action', attrs: { 'data-ontology-action': action, ...attrs } });
    const chevron = className => root.uiIconHtml('chevron-right', className);
    const local = Object.values(records).filter(record => record && record.moduleId === moduleId);
    const byKind = kind => local.filter(record => record.kind === kind && record.status === 'active');
    const definitions = byKind('definition');
    const entities = byKind('entity');
    const assertions = local.filter(record => record.kind === 'assertion');
    const rules = byKind('rule');
    const references = byKind('reference');

    const currentFacts = assertions.filter(record => record.status === 'active'
      && (!record.validity?.from || record.validity.from <= at.slice(0, record.validity.precision === 'month' ? 7 : 10))
      && (!record.validity?.until || record.validity.until > at.slice(0, record.validity.precision === 'month' ? 7 : 10)));
    const historicalFacts = assertions.filter(record => !currentFacts.includes(record));
    const sourceGroups = [];
    const sourceNumber = new Map();
    for (const record of [module, ...local]) {
      if (!record.source) continue;
      const key = JSON.stringify(record.source);
      let index = sourceGroups.findIndex(group => group.key === key);
      if (index < 0) { index = sourceGroups.length; sourceGroups.push({ key, source: record.source, records: [] }); }
      sourceGroups[index].records.push(record);
      sourceNumber.set(record.id, index + 1);
    }
    const writable = record => editable && module.status === 'active' && module.source?.kind !== 'legacy'
      && record.status === 'active' && record.source?.kind !== 'legacy';
    const recordActions = record => {
      const attrs = { 'data-record-id': record.id };
      const detail = writable(record) && ['definition', 'entity', 'rule', 'reference'].includes(record.kind)
        ? actionButton(t('editDetails', '详细编辑'), 'edit-record', attrs) : '';
      const history = record.source?.kind !== 'legacy' && record.kind !== 'module'
        ? actionButton(t('history', '变更记录'), 'record-details', attrs) : '';
      const factActions = writable(record) && record.kind === 'assertion'
        ? actionButton(t('changeFact', '从某天起变更'), 'change-fact', attrs) + actionButton(t('correctFact', '纠正记错的事实'), 'correct-fact', attrs) : '';
      const actions = detail + factActions + history;
      return actions ? `<details class="ontology-doc-record-menu"><summary aria-label="${e(t('recordActions', '记录操作'))}">⋯</summary><div>${actions}</div></details>` : '';
    };
    const draftValue = (record, path) => {
      const changes = drafts instanceof Map ? drafts.get(record.id)?.changes : drafts?.[record.id]?.changes;
      if (changes && Object.prototype.hasOwnProperty.call(changes, path)) return changes[path];
      return path.split('.').reduce((value, part) => value?.[part], record);
    };
    const label = (id, fallbackKey = 'unavailableObject') => {
      const record = records[id];
      return record && typeof record.name === 'string' ? record.name : t(fallbackKey, '不可用对象');
    };
    const edit = (record, path, tag = 'span', type = '', choices = []) => {
      const raw = draftValue(record, path);
      const selectedChoice = choices.find(option => String(option.value) === String(raw));
      const value = selectedChoice ? selectedChoice.label : Array.isArray(raw) ? raw.join('、') : raw == null ? '' : String(raw);
      if (!writable(record)) return `<${tag}>${e(value)}</${tag}>`;
      const field = t(path.split('.').at(-1), path);
      const content = `<span class="ont-ai-field"><span class="ontology-doc-edit ont-ai-text" tabindex="0" data-ontology-edit="${e(path)}" data-record-id="${e(record.id)}"${choices.length ? ` data-edit-options="${e(JSON.stringify(choices))}"` : ''}${type ? ` data-edit-type="${type}"` : ''} aria-label="${e(t('selectFieldEdit', '{field}，选中文字或按 Enter 请求修改', { field }))}">${e(value)}</span>${control(t('requestFieldEdit', '请求修改{field}', { field }), 'selection-edit', 'ont-ai-trigger', { 'data-record-id': record.id, 'data-field': path }, 'sparkles', true)}</span>`;
      return tag === 'span' ? content : `<${tag}>${content}</${tag}>`;
    };
    const enumLabel = key => t(key === 'one' ? 'cardinalityOneLabel' : key === 'many' ? 'cardinalityManyLabel' : key, ({ entity: '对象', text: '文字', number: '数字', boolean: '是或否', date: '日期', one: '单值', many: '多值', subject: '以起点为准', object: '以终点为准', required: '必须遵守', default: '默认采用', suggestion: '建议', logic: '逻辑关系' })[key] || key);
    const empty = () => `<p class="ontology-doc-empty ont-section-empty">${e(t('boxEmpty', '这里还没有内容。'))}</p>`;
    const recordState = record => {
      const parts = [];
      if (record.status !== 'active') parts.push(t(record.status, ({ paused: '已暂停', archived: '已归档', corrected: '已纠正' })[record.status] || record.status));
      if (record.source?.kind === 'legacy') parts.push(t('legacyReadOnlyShort', '旧内容只读'));
      if (record.certainty && record.certainty !== 'confirmed') parts.push(t(record.certainty === 'unknown' ? 'unknownCertainty' : record.certainty, record.certainty === 'inferred' ? '推断' : '未知'));
      return parts.length ? `<span class="ontology-doc-state">${e(parts.join(' · '))}</span>` : '';
    };
    const provenance = record => {
      const number = sourceNumber.get(record.id);
      const parts = [];
      if (record.access === 'owner_only' && module.access !== 'owner_only') parts.push(t('privateAccess', '仅自己查看，不提供给任务'));
      return `<div class="ontology-doc-provenance">${Number.isInteger(number) ? `<a href="#ontology-doc-source-${number}" data-ontology-action="document-source" data-record-id="${e(record.id)}" title="${e(record.source?.label)}">S${number}</a>` : ''}${parts.length ? ` · ${e(parts.join(' · '))}` : ''}${recordState(record)}</div>`;
    };
    const typeNames = ids => ids?.length ? ids.map(id => label(id, 'unavailableType')).join('、') : t('noTypeLimit', '不限定');
    const valueName = value => value?.kind === 'entity' ? label(value.id) : value?.kind === 'literal'
      ? typeof value.value === 'boolean' ? t(value.value ? 'yes' : 'no', value.value ? '是' : '否') : String(value.value ?? '') : t('unknown', '未知');
    const conditionName = condition => {
      if (!condition) return t('noCondition', '所有任务');
      if (condition.kind === 'task') return `${t(condition.field, condition.field)} = ${condition.equals}`;
      if (condition.kind === 'assertion') return `${label(condition.subjectId)} · ${label(condition.definitionId, 'unavailableDefinition')}${condition.object ? ` · ${valueName(condition.object)}` : ''}`;
      if (condition.kind === 'not') return `${t('not', '不满足')} ${conditionName(condition.condition)}`;
      return (condition.conditions || []).map(conditionName).join(` ${t(condition.kind === 'all' ? 'and' : 'or', condition.kind === 'all' ? '并且' : '或者')} `);
    };
    const disclosure = record => control(t('toggleRecordDetails', '展开或收起记录详情：{name}', { name: record.name || `${label(record.subjectId)} · ${label(record.definitionId)}` }), 'document-disclosure', 'ont-record-disclosure', { 'data-record-id': record.id, 'aria-expanded': String(expandedId === record.id), 'aria-controls': `ontology-record-panel-${record.id}` }, 'chevron-right', true);
    const extra = record => {
      const body = expandedId === record.id ? inspector(record) : '';
      return `<div class="ont-fact-expanded-panel" id="ontology-record-panel-${e(record.id)}" data-ontology-panel="${e(record.id)}" ${body ? '' : 'hidden'}>${body}</div>`;
    };
    const add = (label, action) => editable ? control(label, action, 'ont-section-add', {}, 'plus') : '';
    const group = (list, key) => {
      const groups = new Map();
      for (const record of list) { const name = key(record); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(record); }
      return [...groups];
    };
    const sourceNumberOf = record => Number.isInteger(sourceNumber.get(record.id)) ? sourceNumber.get(record.id) : 0;
    const dominantSource = list => {
      const counts = new Map();
      for (const record of list) { const n = sourceNumberOf(record); if (n) counts.set(n, (counts.get(n) || 0) + 1); }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
    };
    const sourceNoteFor = list => {
      const groups = new Map();
      for (const record of list) { const n = sourceNumberOf(record); if (!n) continue; if (!groups.has(n)) groups.set(n, []); groups.get(n).push(record); }
      if (!groups.size) return '';
      const parts = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([n, records]) => {
        const short = String(records[0].source?.label || '').split(' · ')[0];
        return `S${n}${short ? ' · ' + short : ''}（${records.length} 条）`;
      });
      return t('sourceNote', '来源 {sources}', { sources: parts.join(' · ') });
    };
    const sourceChip = (record, dominant) => {
      const n = sourceNumberOf(record);
      return n && dominant && n !== dominant ? `<span class="ont-scan-schip">S${n}</span>` : '';
    };
    const recordMarks = record => `${record.access === 'owner_only' && module.access !== 'owner_only' ? `<span class="ont-scan-rec-flag">${e(t('privateAccess', '仅自己查看，不提供给任务'))}</span>` : ''}${recordState(record)}`;
    const sharedStartDate = list => {
      const dates = new Set(list.map(record => `${record.validity?.from || ''}|${record.validity?.until || ''}`));
      return dates.size === 1 && list[0]?.validity?.from && !list[0]?.validity?.until ? list[0].validity.from : '';
    };
    const recordRow = (record, body, marks = '') => `<div class="ont-scan-rec" data-record-id="${e(record.id)}"><div class="ont-scan-rec-line"><span class="ont-scan-rec-name">${edit(record, 'name')}${marks}</span><span class="ont-scan-rec-body">${body}</span><span class="ont-scan-rec-menu">${disclosure(record)}</span></div>${extra(record)}</div>`;
    const recordList = (list, dominant, body) => list.length
      ? `<div class="ont-scan-records">${list.map(record => recordRow(record, body(record), `${sourceChip(record, dominant)}${recordMarks(record)}`)).join('')}</div>`
      : empty();
    const definitionBody = record => {
      if (record.definitionKind === 'type') return edit(record, 'description', 'span');
      const target = record.definitionKind === 'relation' ? typeNames(record.objectTypes) : enumLabel(record.valueType);
      return `<span class="ont-scan-rec-sig">${e(typeNames(record.subjectTypes))} → ${e(target)}</span><span class="ont-scan-rec-meta">${edit(record, 'cardinality', 'span', '', ['one', 'many'].map(value => ({ value, label: enumLabel(value) })))}</span><span class="ont-scan-rec-text">${edit(record, 'description', 'span')}</span>`;
    };
    const ruleBody = record => `<span class="ont-scan-rec-text">${edit(record, 'requirement', 'span')}</span>`;
    const ruleCapability = (record) => {
      if (record.effect?.kind === 'required_section' && record.strength === 'required')
        return t('ruleCapabilityPrecondition', '操作前检查：缺少必需章节会阻断写入');
      if (record.strength !== 'required') return t('ruleCapabilityContext', '任务上下文约束，不阻断');
      if (record.effect?.kind !== 'note') return t('ruleCapabilityNoAdapter', '尚无执行适配');
      return t('ruleCapabilityNote', '仅说明');
    };
    const ruleFlags = (record, uniformStrength) => {
      const flags = [ruleCapability(record)];
      if (record.strength !== uniformStrength) flags.push(enumLabel(record.strength));
      if (record.condition) flags.push(t('conditionChip', '条件：{condition}', { condition: conditionName(record.condition) }));
      return `<span class="ont-scan-rec-meta">${e(flags.join(' · '))}</span>`;
    };
    const objectDominant = dominantSource(entities);
    const objectGroups = group(entities, record => record.typeId || '').map(([typeId, list]) => `<div class="ont-scan-object-group"><h4>${e(label(typeId, 'unavailableType'))}</h4><div class="ont-scan-object-list">${list.map(record => `<div class="ont-scan-object" data-record-id="${e(record.id)}"><span class="ont-scan-object-main"><span class="ont-scan-object-name">${edit(record, 'name')}${sourceChip(record, objectDominant)}${record.identityStatus !== 'confirmed' ? `<small class="ont-unknown">${e(t('identityUnknown', '身份待核对'))}</small>` : ''}${recordMarks(record)}</span><span class="ont-scan-object-menu">${disclosure(record)}</span></span><div class="ont-object-record-extra" id="ontology-record-panel-${e(record.id)}" data-ontology-panel="${e(record.id)}" ${expandedId === record.id ? '' : 'hidden'}>${expandedId === record.id ? inspector(record) : ''}</div></div>`).join('')}</div></div>`).join('');
    const factValueText = record => {
      if (record.object?.kind === 'entity') return label(String(draftValue(record, 'object.id')), 'unavailableObject');
      const value = draftValue(record, 'object.value');
      if (record.object?.valueType === 'boolean') return t(value ? 'yes' : 'no', value ? '是' : '否');
      return value == null ? t('unknown', '未知') : String(value);
    };
    const factEntry = (record, sharedStart, factDominant) => {
      const marks = [];
      const from = record.validity?.from || '';
      const until = record.validity?.until || '';
      if (!sharedStart || from !== sharedStart || until) marks.push(from ? `${from}${until ? ' 至 ' + until : ' 起'}` : t('unknownDate', '起点未知'));
      if (record.certainty && record.certainty !== 'confirmed') marks.push(t('unconfirmed', '待核对'));
      if (record.access === 'owner_only' && module.access !== 'owner_only') marks.push(t('privateAccess', '仅自己查看，不提供给任务'));
      if (record.status !== 'active') marks.push(t(record.status, ({ paused: '已暂停', archived: '已归档', corrected: '已纠正' })[record.status] || record.status));
      return `<span class="ont-scan-fact-value">${control(factValueText(record), 'document-disclosure', 'ont-scan-value-entry', { 'data-record-id': record.id })}${sourceChip(record, factDominant)}${marks.length ? `<small class="ont-scan-fact-mark">${e(marks.join(' · '))}</small>` : ''}</span>`;
    };
    const facts = list => {
      const start = sharedStartDate(list);
      const dominant = dominantSource(list);
      return group(list, record => record.subjectId).map(([subject, subjectFacts]) => {
        const rows = group(subjectFacts, record => record.definitionId).map(([definitionId, predFacts]) => `<div class="ont-scan-fact-row"><span class="ont-scan-fact-pred">${e(label(definitionId, 'unavailableDefinition'))}</span><span class="ont-scan-fact-values">${predFacts.map(record => factEntry(record, start, dominant)).join('<span class="ont-scan-value-sep">·</span>')}</span></div>`).join('');
        return `<div class="ont-scan-fact-group"><h4>${e(label(subject))}</h4><div class="ont-scan-fact-content">${rows}${subjectFacts.map(record => extra(record)).join('')}</div></div>`;
      }).join('') || empty();
    };
    const reference = record => `<li data-record-id="${e(record.id)}"><strong>${e(label(record.targetModuleId, 'unavailableModule'))}</strong>${record.targetRecordId ? ` → ${e(label(record.targetRecordId))}` : ''}<span class="ontology-doc-cell-note"> · ${e(t('versionPolicy', '引用版本方式'))}：${e(t(record.versionPolicy === 'pinned' ? 'pinnedVersion' : 'currentVersion', record.versionPolicy))}${record.targetVersion ? ` v${e(record.targetVersion)}` : ''}</span>${provenance(record)}${recordActions(record)}</li>`;
    const sourceRows = sourceGroups.map((group, index) => {
      const source = group.source;
      const refs = (Array.isArray(source.refs) ? source.refs : []).filter(ref => !/^ontimport-[a-f0-9]{64}$/.test(ref.id || ''));
      const details = refs.map(ref => {
        const refLabel = `${t(ref.kind, ref.kind)} · ${ref.id}`;
        return `<li>${e(refLabel)}</li>`;
      }).join('');
      const metadata = group.records.map(record => {
        const name = 'name' in record ? record.name : record.kind === 'assertion'
          ? `${label(record.subjectId)} · ${label(record.definitionId, 'unavailableDefinition')}` : t(record.kind, record.kind);
        const dates = [record.createdAt && `${t('createdAt', '创建时间')}：${record.createdAt}`,
          record.updatedAt && record.updatedAt !== record.createdAt && `${t('updatedAt', '更新时间')}：${record.updatedAt}`].filter(Boolean);
        return `<li>${e(name)}${dates.length ? ` · ${e(dates.join(' · '))}` : ''}</li>`;
      }).join('');
      return `<li id="ontology-doc-source-${index + 1}"><details class="ont-source-row"><summary class="ont-source-summary"><span class="ont-source-title"><strong>S${index + 1} · ${e(source.label || t(source.kind, '未知来源'))}</strong><span class="ont-source-count">${group.records.length} ${e(t('sourceRecordCount', '条记录'))}</span><span class="ontology-doc-cell-note"> · ${e(t(source.kind, source.kind))}</span></span><span class="ont-source-chevron">${chevron('')}</span></summary><div class="ont-source-body">${source.recordId ? `<div class="ontology-doc-cell-note">${e(t('sourceRecord', '来源记录'))}：${e(source.recordId)}</div>` : ''}${refs.length ? `<div class="ontology-doc-cell-note">${e(t('refs', '引用来源'))}</div><ul>${details}</ul>` : ''}<div class="ontology-doc-cell-note">${e(t('sourceMetadata', '关联记录与时间'))}</div><ul>${metadata}</ul></div></details></li>`;
    });
    const types = definitions.filter(record => record.definitionKind === 'type'), relations = definitions.filter(record => record.definitionKind !== 'type');
    const ruleStrength = rules.length && rules.every(record => record.strength === rules[0].strength) ? rules[0].strength : '';
    const enforcedRuleCount = rules.filter(record => record.effect?.kind === 'required_section' && record.strength === 'required').length;
    const allRulesEnforced = enforcedRuleCount > 0 && enforcedRuleCount === rules.length;
    const ruleCapabilitySummary = enforcedRuleCount
      ? allRulesEnforced
        ? t('rulesAllExecuted', '这 {count} 条规则已接入写入前检查：缺少必需章节会阻断写入。是否遵守以任务回执和人工核对为准。', { count: rules.length })
        : t('rulesPartiallyExecuted', '其中 {executed} 条规则已接入写入前检查：缺少必需章节会阻断写入；其余 {remaining} 条未接入写入前检查，只作为任务上下文约束或说明保存。是否遵守以任务回执和人工核对为准。', { executed: enforcedRuleCount, remaining: rules.length - enforcedRuleCount })
      : t('rulesNotExecuted', '这 {count} 条规则未接入写入前检查，只作为任务上下文约束或说明保存。', { count: rules.length });
    const ruleCalloutTitle = enforcedRuleCount
      ? t('rulesExecutionWhy', '哪些规则会参与执行？')
      : t('rulesNotExecutedWhy', '为什么说尚未接入执行？');
    const ruleCalloutBody = enforcedRuleCount
      ? t('rulesExecutionBody', '规则是否执行以任务回执为准；需要写入前检查的规则会在写入时校验必需章节，其余规则只作为任务上下文约束或说明。')
      : t('rulesNotExecutedBody', '本体里的规则是规格说明；是否遵守由任务执行和人工核对分别判断，不能仅凭记录声称已执行。');
    const ruleFlagText = enforcedRuleCount
      ? t(allRulesEnforced ? 'rulesAllExecutedFlag' : 'rulesPartiallyExecutedFlag',
        allRulesEnforced ? '规则已接入写入前检查' : '部分规则已接入写入前检查')
      : t('rulesNotExecutedFlag', '未接入写入前检查');
    const boundaryText = enforcedRuleCount
      ? t('boundaryFootlinePartial', '规则是否执行以任务回执为准；需要写入前检查的规则会校验必需章节，其余规则不表示已经接入执行。结论是整理，不改变原始记录。')
      : t('boundaryFootline', '规则是规格说明，不表示已经接入执行；结论是整理，不改变原始记录。');
    const rulesNote = [sourceNoteFor(rules), ruleStrength ? t('strengthUniform', '均为{strength}', { strength: enumLabel(ruleStrength) }) : '', rules.every(record => !record.condition) ? t('conditionsAllTasks', '适用所有任务') : ''].filter(Boolean).join(' · ');
    const scope = t(module.scope?.kind === 'workspace' ? 'workspaceScopeLabel' : module.scope?.kind, ({ personal: '个人', project: '项目', workspace: '工作空间' })[module.scope?.kind] || '');
    const createdAt = String(module.createdAt || '').slice(0, 10);
    const updatedAt = String(module.updatedAt || '').slice(0, 10);
    const accessLabel = module.access === 'owner_only' ? t('privateOnly', '仅自己可见') : t('visibleToTask', '可在任务中使用');
    const versionLabel = t('versionLabel', '第 {version} 版', { version: module.version || '—' });
    const scopeNote = String(module.scopeNote || '').trim()
      || t(module.access === 'owner_only' ? 'scopeNotePrivate' : 'scopeNoteTask',
        module.access === 'owner_only' ? '这份本体属于{scope}范围，仅自己可见；结论是整理，不改变原始记录。' : '这份本体属于{scope}范围，可在任务中使用；结论是整理，不改变原始记录。', { scope });
    const summaryPoints = (Array.isArray(module.summaryPoints) ? module.summaryPoints : [])
      .slice(0, 5).filter(point => point && typeof point.text === 'string' && point.text.trim());
    const evidenceKinds = new Set(['definition', 'rule', 'entity', 'assertion']);
    const evidenceIdsOf = point => [...new Set(Array.isArray(point.evidenceIds) ? point.evidenceIds : [])];
    const evidenceRecord = id => {
      const record = records[id];
      return record && record.moduleId === moduleId && evidenceKinds.has(record.kind) ? record : null;
    };
    const activeEvidence = point => evidenceIdsOf(point).map(evidenceRecord).filter(record => record?.status === 'active');
    const evidenceTags = list => {
      const tags = new Set();
      for (const record of list) {
        if (record.kind === 'definition') tags.add('T');
        else if (record.kind === 'rule') tags.add('R');
        else if (record.kind === 'entity') tags.add('A');
        else if (record.kind === 'assertion') {
          tags.add('A');
          if (records[record.definitionId]?.kind === 'definition') tags.add('T');
        }
      }
      return ['T', 'R', 'A'].filter(tag => tags.has(tag));
    };
    const evidenceCounts = list => {
      const counts = { assertion: 0, rule: 0, entity: 0, definition: 0 };
      for (const record of list) if (Object.prototype.hasOwnProperty.call(counts, record.kind)) counts[record.kind]++;
      return [
        counts.assertion ? `${counts.assertion} ${t('factCount', '条事实')}` : '',
        counts.rule ? `${counts.rule} ${t('rulesCount', '条规则')}` : '',
        counts.entity ? `${counts.entity} ${t('objectCount', '个对象')}` : '',
        counts.definition ? `${counts.definition} ${t('definitionsCount', '个定义')}` : '',
      ].filter(Boolean).join(' + ');
    };
    const evidenceSources = list => {
      const numbers = [...new Set(list.map(record => sourceNumber.get(record.id)).filter(Number.isInteger))].sort((a, b) => a - b);
      return numbers.map(number => `S${number}`).join(' · ');
    };
    const evidenceRow = (record, showSource = true) => {
      const source = showSource && Number.isInteger(sourceNumber.get(record.id)) ? `S${sourceNumber.get(record.id)}` : '';
      if (record.kind === 'assertion') {
        const notAtDate = currentFacts.includes(record) ? '' : t('summaryEvidenceNotAtDate', '所选日期无此事实');
        const meta = [source, notAtDate].filter(Boolean).join(' · ');
        return `<div class="ont-evidence-row" data-evidence-record-id="${e(record.id)}"><span class="ont-evidence-row-tag">A</span><span class="ont-evidence-row-text">${e(label(record.subjectId))} · ${e(label(record.definitionId, 'unavailableDefinition'))} · ${e(valueName(record.object))}</span><span class="ont-evidence-row-meta">${e(meta)}</span></div>`;
      }
      if (record.kind === 'rule') return `<div class="ont-evidence-row" data-evidence-record-id="${e(record.id)}"><span class="ont-evidence-row-tag">R</span><span class="ont-evidence-row-text">${e(record.name)} · ${e(record.requirement)}</span><span class="ont-evidence-row-meta">${e(source)}</span></div>`;
      if (record.kind === 'entity') return `<div class="ont-evidence-row" data-evidence-record-id="${e(record.id)}"><span class="ont-evidence-row-tag">A</span><span class="ont-evidence-row-text">${e(record.name)} · ${e(record.description || t('noDescription', '还没有填写简介。'))}</span><span class="ont-evidence-row-meta">${e(source)}</span></div>`;
      const signature = record.definitionKind === 'relation'
        ? `${typeNames(record.subjectTypes)} → ${typeNames(record.objectTypes)}`
        : `${typeNames(record.subjectTypes)} → ${enumLabel(record.valueType)}`;
      return `<div class="ont-evidence-row" data-evidence-record-id="${e(record.id)}"><span class="ont-evidence-row-tag">T</span><span class="ont-evidence-row-text">${e(record.name)} · ${e(record.description || signature)}</span><span class="ont-evidence-row-meta">${e(source)}</span></div>`;
    };
    const conclusionItems = summaryPoints.map((point, index) => {
      const active = activeEvidence(point);
      const unavailable = evidenceIdsOf(point).length - active.length;
      const tags = evidenceTags(active);
      const meta = [evidenceCounts(active), evidenceSources(active)].filter(Boolean).join(' · ');
      const uniformSource = new Set(active.map(sourceNumberOf)).size <= 1;
      const body = active.length ? active.map(record => evidenceRow(record, !uniformSource)).join('') : `<p class="ont-evidence-empty">${e(t('summaryEvidenceEmpty', '没有可核对的依据'))}</p>`;
      const missing = unavailable ? `<p class="ont-evidence-missing">${e(t('summaryEvidenceUnavailable', '{count} 条依据当前不可用', { count: unavailable }))}</p>` : '';
      return `<li class="ont-conclusion"><details class="ont-conclusion-details" data-document-details="conclusion:${index}"${openDetails[`conclusion:${index}`] ? ' open' : ''}><summary class="ont-conclusion-summary"><span class="ont-conclusion-num" aria-hidden="true">${index + 1}</span><p class="ont-conclusion-text">${e(point.text)}</p><span class="ont-conclusion-chevron">${chevron('')}</span></summary><div class="ont-conclusion-panel"><div class="ont-conclusion-meta">${tags.map(tag => `<span class="ont-evidence-tag">${tag}</span>`).join('')}<span class="ont-evidence-count">${e(meta)}</span></div><div class="ont-evidence-body">${body}${missing}</div></div></details></li>`;
    }).join('');
    const summaryStale = summaryPoints.some(point => evidenceIdsOf(point).length > activeEvidence(point).length);
    const summaryHtml = summaryPoints.length
      ? `<p class="ont-section-note">${e(t('conclusionsExpandHint', '点击任一条可以展开它引用的记录。'))}</p><ol class="ont-conclusions">${conclusionItems}</ol>${at !== today() ? `<p class="ont-evidence-notice">${e(t('summaryAsOfNotice', '结论按当前整理，不随所选日期变化。'))}</p>` : ''}${summaryStale ? `<p class="ont-evidence-notice">${e(t('summaryMayBeStale', '有依据当前不可用；结论文字可能已过时，请核对。'))}</p>` : ''}`
      : `<p class="ont-section-note">${e(t('summaryEmpty', '还没有整理结论。本页有 {facts} 条当前事实和 {rules} 条规则。', { facts: currentFacts.length, rules: rules.length }))}</p>`;

    const tExample = types.length >= 2
      ? t('tBoxExampleTypes', '「{first}」和「{second}」是两类概念。', { first: types[0].name, second: types[1].name })
      : types.length ? t('tBoxExampleType', '「{type}」是一个概念类型。', { type: types[0].name }) : '';
    const tRelationExample = relations.length ? t('tBoxExampleRelation', '「{relation}」是它们之间的一种关系。', { relation: relations[0].name }) : '';
    const rExample = rules.length ? t('rBoxExample', '「{rule}」要求：{requirement}', { rule: rules[0].name, requirement: clip(rules[0].requirement, 160) }) : '';
    const firstFact = currentFacts[0];
    const aExample = firstFact
      ? t('aBoxExampleFact', '「{subject} · {predicate} · {value}」是一条事实。', { subject: label(firstFact.subjectId), predicate: label(firstFact.definitionId, 'unavailableDefinition'), value: valueName(firstFact.object) })
      : entities.length ? t('aBoxExampleEntity', '「{entity}」是一个对象。', { entity: entities[0].name }) : '';
    const boxOpen = (key, list) => !!openDetails[key] || !!expandedId && list.some(record => record.id === expandedId);
    const boxDetails = (letter, title, count, question, example, body, list, extra = '') => `<details class="ont-box-details ont-box-merged" data-document-details="box:${letter}" data-document-box-details="${letter}"${boxOpen(`box:${letter}`, list) ? ' open' : ''}><summary class="ont-box-title"><span class="ont-box-line"><span class="ont-box-letter">${e(letter)}</span><span class="ont-box-name">${e(title)}</span><span class="ont-box-count">${e(count)}</span>${extra}<span class="grow"></span><span class="ont-box-chevron">${chevron('')}</span></span><span class="ont-box-question"><b>${e(t('boxQuestionLabel', '它回答'))}</b>${e(question)}</span>${example ? `<span class="ont-box-example"><b>${e(t('boxExampleLabel', '例如'))}</b>${e(example)}</span>` : ''}</summary><div class="ont-box-body">${body}</div></details>`;

    return `<article class="ontology-doc ont-document-paper" aria-label="${e(t('documentView', '本体文档'))}"><header class="ont-doc-heading ont-scan-heading"><div class="ont-scan-title-line">${edit(module, 'name', 'h1')}<span class="ont-scan-meta">${e(accessLabel)} · ${e(versionLabel)}${createdAt ? ` · ${e(createdAt)}` : ''} · ${sourceGroups.length} ${e(t('sourcesCount', '份来源'))}${editable ? '' : ` · ${e(t('readonly', '只读'))}`}</span></div><p class="ont-doc-scope-note">${e(scopeNote)}</p><details class="ont-scan-about" data-document-details="about"${openDetails.about ? ' open' : ''}><summary>${e(t('moduleDescription', '本体说明'))}</summary>${edit(module, 'description', 'p')}${provenance(module)}</details></header>
      <div class="ont-scan-document"><section id="ontology-doc-conclusions" class="ont-scan-section ont-conclusions-section"><div class="ont-scan-section-heading"><h2>${e(t('conclusionsTitle', '结论'))}</h2><span>${summaryPoints.length} ${e(t('summaryPointsCount', '条'))}</span></div>${summaryHtml}</section>
      <div class="ont-scan-section-heading"><h2>${e(t('structureTitle', '结构'))}</h2></div>
      <section id="ontology-doc-tbox" class="ont-scan-section" data-box="T">${boxDetails('T', t('conceptsStructure', '概念与结构'), `${types.length} ${t('concepts', '概念')} · ${relations.length} ${t('relationsCount', '个关系/属性')}`, t('tBoxQuestion', '这个本体里有哪些类型的东西，它们之间怎么连？'), [tExample, tRelationExample].filter(Boolean).join(' '), `<p class="ont-scan-source-note">${e(sourceNoteFor(definitions))}</p><div class="ont-scan-subheading"><h3>${e(t('conceptDefinitions', '概念定义'))} <small>${types.length}</small></h3>${add(t('addConcept', '添加概念'), 'create-definition')}</div>${recordList(types, dominantSource(definitions), definitionBody)}<div class="ont-scan-subheading"><h3>${e(t('relationAndAttributeDefinitions', '关系与属性定义'))} <small>${relations.length}</small></h3>${add(t('addRelationAttribute', '添加关系或属性'), 'create-relation-definition')}</div>${recordList(relations, dominantSource(definitions), definitionBody)}`, definitions)}</section>
      <section id="ontology-doc-rbox" class="ont-scan-section" data-box="R">${boxDetails('R', t('rulesConstraints', '规则与约束'), `${rules.length} ${t('rulesCount', '条规则')}`, t('rBoxQuestion', '哪些要求必须遵守，哪些边界不能越过？'), rExample, `<p class="ont-scan-source-note">${e(rulesNote)}</p><div class="ont-rule-callout">${e(ruleCapabilitySummary)}<details data-document-details="rules:why"${openDetails['rules:why'] ? ' open' : ''}><summary>${e(ruleCalloutTitle)}</summary><p>${e(ruleCalloutBody)}</p></details></div><div class="ont-scan-subheading"><h3>${e(t('ruleStatements', '规则原文'))} <small>${rules.length}</small></h3>${add(t('addRule', '添加规则'), 'create-rule')}</div>${recordList(rules, dominantSource(rules), record => `${ruleBody(record)}${ruleFlags(record, ruleStrength)}`)}`, rules, `<span class="ont-box-flag">${e(ruleFlagText)}</span>`)}</section>
      <section id="ontology-doc-abox" class="ont-scan-section" data-box="A">${boxDetails('A', t('objectsFacts', '对象与事实'), `${entities.length} ${t('objectCount', '个对象')} · ${currentFacts.length} ${t('factCount', '条事实')}`, t('aBoxQuestion', '具体有哪些东西，它们之间发生了什么？'), aExample, `<p class="ont-scan-source-note">${e(sourceNoteFor(entities))}</p><div class="ont-scan-subheading"><h3>${e(t('objects', '具体对象'))} <small>${entities.length}</small></h3>${add(t('addEntity', '添加对象'), 'create-entity')}</div><div class="ont-scan-object-table">${objectGroups || empty()}</div><div class="ont-scan-subheading"><h3>${e(t('relationsFacts', '关系与事实'))} <small>${currentFacts.length}</small></h3><div class="row">${control(t('asOf', '截至') + ' ' + at, 'document-date', 'ont-date-link', {}, 'chevron-down')}${add(t('addFact', '添加事实'), 'create-assertion')}</div></div><p class="ont-scan-source-note">${e([sharedStartDate(currentFacts) ? t('factsSameStart', '均自 {date} 起', { date: sharedStartDate(currentFacts) }) : '', sourceNoteFor(currentFacts)].filter(Boolean).join(' · '))}</p><div class="ont-scan-fact-table">${facts(currentFacts)}</div>${historicalFacts.length ? `<details class="ont-scan-evidence-disclosure" data-document-details="abox:historical"${openDetails['abox:historical'] ? ' open' : ''}><summary>${e(t('historicalFactsDocument', '历史及非当前事实'))} · ${historicalFacts.length}</summary><div class="ont-scan-fact-table">${facts(historicalFacts)}</div></details>` : ''}`, [...entities, ...assertions])}</section>
      <section id="ontology-doc-sources" class="ont-scan-section"><div class="ont-scan-section-heading"><h2>${e(t('sourcesVersionTitle', '来源与版本'))}</h2></div><ul class="ontology-doc-sources">${sourceRows.join('')}</ul><div class="ont-source-footlines">${updatedAt && updatedAt !== createdAt ? `<div><b>${e(t('updated', '更新'))}</b>${e(t('updatedFootline', '更新于 {date}', { date: updatedAt }))}</div>` : ''}${references.length ? `<div><b>${e(t('relatedOntologies', '相关本体'))}</b>${e(references.map(record => label(record.targetModuleId, 'unavailableModule')).join('；'))}</div>` : ''}<div><b>${e(t('boundary', '边界'))}</b>${e(boundaryText)}</div></div><details class="ont-crosscut" data-document-details="sources:references"${openDetails['sources:references'] ? ' open' : ''}><summary>${e(t('referencesInactiveTitle', '引用与停用记录'))}</summary><section id="ontology-doc-references"><div class="ont-scan-subheading"><h3>${e(t('references', '跨本体引用'))}</h3>${add(t('createReference', '添加引用'), 'create-reference')}</div>${references.length ? `<ul class="ontology-doc-references">${references.map(reference).join('')}</ul>` : empty()}${local.some(record => record.status !== 'active' && record.kind !== 'assertion') ? `<details class="ont-secondary-block" data-document-details="sources:inactive"${openDetails['sources:inactive'] ? ' open' : ''}><summary>${e(t('inactiveRecords', '停用与纠正记录'))}</summary>${local.filter(record => record.status !== 'active' && record.kind !== 'assertion').map(record => `<p>${e(record.name)}${recordState(record)}${provenance(record)}${recordActions(record)}</p>`).join('')}</details>` : ''}</section></details></section></div></article>`;

  }

  root.CogOntologyDocument = { render, today };
})(window);
