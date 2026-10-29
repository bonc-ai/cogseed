/* 串行保存本体文档草稿；只有主档回读与回执通过后才报告已保存。 */
(function initOntologyDocumentEditor(root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const atPath = (record, path) => path.split('.').reduce((value, key) => value?.[key], record);

  function create(options) {
    const { invoke, getDocument } = options;
    const delay = options.delay ?? 650;
    const storage = options.storage;
    const storageKey = `ontology-document-drafts:${options.ownerId}`;
    const drafts = Object.create(null), aliases = new Map();
    let timer = null, running = null, disposed = false, needsRun = false;
    let lastStatus = 'idle';
    const resolveId = id => { let current = id; const seen = new Set(); while (aliases.has(current) && !seen.has(current)) { seen.add(current); current = aliases.get(current); } return current; };
    function persist() {
      try {
        if (Object.keys(drafts).length) storage?.setItem(storageKey, JSON.stringify({ version: 1, drafts }));
        else storage?.removeItem(storageKey);
      } catch (_) { /* 草稿仍留在当前页面；保存接口不依赖本地缓存。 */ }
    }
    function status() {
      const items = Object.values(drafts);
      const error = items.find(item => item.error);
      const value = error ? 'error' : running ? 'saving' : items.length ? 'pending' : lastStatus === 'idle' ? 'idle' : 'saved';
      options.onStatus?.(value, error || null);
    }
    function notify() { persist(); status(); options.onDrafts?.(drafts); }
    function schedule() {
      if (disposed) return;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void drain(false); }, delay);
    }
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
      if (saved?.version === 1 && saved.drafts && typeof saved.drafts === 'object') {
        for (const [id, item] of Object.entries(saved.drafts)) {
          if (!getDocument()?.records?.[id] || !item || typeof item !== 'object' || !item.changes || !Number.isInteger(item.baseVersion)) continue;
          drafts[id] = { ...item, changedAt: 0, error: item.error || null };
        }
      }
    } catch (_) { /* 无效缓存不影响正式主档。 */ }

    function enqueue(rawId, field, value) {
      if (disposed) return false;
      const id = resolveId(rawId), record = getDocument()?.records?.[id];
      if (!record || record.status !== 'active' || record.source?.kind === 'legacy') return false;
      let item = drafts[id];
      if (!item) {
        if (same(atPath(record, field), value)) return false;
        item = drafts[id] = { recordId: id, baseVersion: record.version, changes: {}, baseValues: {}, changedAt: Date.now(), error: null, command: null };
      }
      if (!Object.prototype.hasOwnProperty.call(item.baseValues, field)) item.baseValues[field] = clone(atPath(record, field) ?? null);
      item.changes[field] = clone(value);
      item.changedAt = Date.now();
      // 已发出的命令只允许原样重试；新文字留在 changes，等待其回执。
      if (!item.command) item.error = null;
      lastStatus = 'pending';
      notify(); schedule();
      return true;
    }

    async function perform(id, item) {
      const doc = getDocument(), record = doc.records[id];
      if (!record) throw Object.assign(new Error('ontology record unavailable'), { code: 'not_found' });
      if (!item.command) {
        item.command = {
          commandId: `doc-edit-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          recordId: id, expectedRevision: doc.revision, expectedVersion: item.baseVersion,
          changes: clone(item.changes),
        };
        persist();
      }
      const sent = clone(item.command);
      let result;
      try { result = await invoke('cognition.ontology.document.edit', sent); }
      catch (error) {
        if (error.code === 'baseline_changed') {
          const latest = await invoke('cognition.ontology.snapshot');
          options.onSnapshot?.(latest.ontology);
          const fresh = latest.ontology.records[id];
          // 只重试其它记录引起的全局 revision 变化；本条版本变了必须由用户决定。
          if (fresh?.version === sent.expectedVersion && fresh.status === 'active') {
            item.command = { ...sent, expectedRevision: latest.ontology.revision };
            persist();
            result = await invoke('cognition.ontology.document.edit', item.command);
          } else throw error;
        } else throw error;
      }
      const savedId = result?.recordId || id, saved = result?.ontology?.records?.[savedId];
      if (!result?.receipt?.changedIds?.includes(savedId) || !saved || result.ontology.revision < result.receipt.revision)
        throw Object.assign(new Error('ontology save read-back failed'), { code: 'commit_failed' });
      // 校验刚提交版本在主档历史/当前记录中存在；后续并发版本不会被误认为保存失败。
      const committed = result.ontology.history?.find(row => row.commandId === result.receipt.commandId && row.after?.id === savedId)?.after || saved;
      if (!committed || Object.entries(sent.changes).some(([field, value]) => !same(atPath(committed, field), value)))
        throw Object.assign(new Error('ontology saved values do not match draft'), { code: 'commit_failed' });
      const remaining = {};
      for (const [field, value] of Object.entries(item.changes)) if (!same(value, sent.changes[field])) remaining[field] = value;
      const successorDraft = savedId !== id ? drafts[savedId] : null;
      delete drafts[id];
      if (savedId !== id) aliases.set(id, savedId);
      if (Object.keys(remaining).length) {
        if (successorDraft) {
          const successorChangedAt = successorDraft.changedAt;
          for (const [field, value] of Object.entries(remaining)) {
            // An edit made directly on the successor after the old command was sent wins a same-field tie.
            if (Object.hasOwn(successorDraft.changes, field) && successorChangedAt >= item.changedAt) continue;
            successorDraft.changes[field] = value;
            if (!Object.hasOwn(successorDraft.baseValues, field))
              successorDraft.baseValues[field] = clone(atPath(saved, field) ?? null);
          }
          successorDraft.changedAt = Math.max(successorChangedAt, item.changedAt);
          // Keep its frozen command/error: an uncertain save must be retried with the same command ID.
        } else drafts[savedId] = {
          recordId: savedId, baseVersion: saved.version, changes: remaining,
          baseValues: Object.fromEntries(Object.keys(remaining).map(field => [field, clone(atPath(saved, field) ?? null)])),
          changedAt: item.changedAt, error: null, command: null,
        };
      }
      options.onCommit?.(result, { previousId: id });
      lastStatus = 'saved';
      persist();
    }

    function drain(force = true) {
      clearTimeout(timer); timer = null;
      if (running) {
        needsRun = true;
        // The in-flight automatic drain may skip a newly edited item for debounce.
        // A forced flush must wait for that drain, then save every remaining ready draft itself.
        return force ? running.then(() => drain(true)) : running;
      }
      if (disposed) return Promise.resolve(false);
      const work = async () => {
        do {
          needsRun = false;
          const next = Object.entries(drafts).find(([, item]) => !item.error);
          if (!next) break;
          const [id, item] = next;
          if (!force && Date.now() - item.changedAt < delay) { schedule(); break; }
          try { await perform(id, item); }
          catch (error) {
            item.error = { code: error.code || 'save_failed', message: error.message || 'save failed' };
            // 确定性错误可以在编辑修正后发新命令；传输失败保留原命令以防重复写入。
            if (['invalid_input', 'invalid_intent', 'invalid_type', 'not_authorized', 'invalid_reference', 'conflicting_facts', 'legacy_read_only'].includes(error.code)) item.command = null;
            options.onError?.(error, id);
            persist();
          }
        } while (Object.values(drafts).some(item => !item.error) || needsRun);
        return !Object.keys(drafts).length;
      };
      running = Promise.resolve().then(work).finally(() => {
        running = null; notify();
        if (!disposed && needsRun && Object.values(drafts).some(item => !item.error)) schedule();
      });
      status();
      return running;
    }
    function retry(id, rebase = false) {
      const ids = id ? [resolveId(id)] : Object.keys(drafts);
      for (const key of ids) {
        const item = drafts[key]; if (!item) continue;
        if (rebase) {
          const record = getDocument()?.records?.[key];
          if (!record || record.status !== 'active') continue;
          item.baseVersion = record.version; item.command = null;
          item.baseValues = Object.fromEntries(Object.keys(item.changes).map(field => [field, clone(atPath(record, field) ?? null)]));
        }
        item.error = null; item.changedAt = 0;
      }
      notify(); return drain(true);
    }
    function discard(id) { const key = resolveId(id); if (running && drafts[key]?.command) return false; delete drafts[key]; notify(); return true; }
    status();
    return { enqueue, flush: () => drain(true), retry, discard, resolveId,
      getDrafts: () => drafts, hasPending: () => Object.keys(drafts).length > 0,
      resume() { if (Object.values(drafts).some(item => !item.error)) schedule(); },
      destroy() { disposed = true; clearTimeout(timer); persist(); },
    };
  }
  root.CogOntologyEditor = { create };
})(typeof window !== 'undefined' ? window : globalThis);
