// Synthetic saved proposals exercise production IPC without a model or live data.
module.exports = async function confirmationScenario({ load, uid, window, js, check, waitFor, key, activate, capture, delay, outcome }) {
  // Headless runners (xvfb, no window manager) never give a *hidden* window OS
  // focus, and a real Enter keypress only reaches the document's focused element
  // when the page itself is focused. Show the window for this scenario so the
  // keyboard confirmation stays a real input path instead of a synthetic event.
  if (typeof window.isVisible === 'function' && !window.isVisible()) {
    window.show();
    window.focus();
    await delay(80);
  }
  const ontology = load('features/cognition/ontology/service.ts');
  const formation = load('features/recall/ontology-formation.ts');
  const stock = load('features/recall/stock-organization.ts');
  const candidates = load('features/recall/candidate-service.ts');
  const store = load('features/recall/store.ts');
  const ids = ['desktop-first', 'desktop-second', 'desktop-conflict', 'narrow-first', 'narrow-second', 'narrow-conflict'];
  const before = '检查设备前，核对温度、编号及报告来源；不得省略失败结果。仅当材料可读时使用，离线草稿除外。';
  const after = before.replace('；', '。\n').replace('仅当', '\n仅当');
  await ontology.commitOntologyCommand(uid, { commandId: 'synthetic-confirmation-seed', expectedRevision: 0, actions: [
    { intent: 'create', recordId: 'synthetic-confirmation-module', sourceLabel: 'Synthetic module', record: { kind: 'module', name: '合成检查模块', description: '', scope: { kind: 'personal' } } },
    ...ids.map(id => ({ intent: 'create', recordId: id, sourceLabel: 'Synthetic saved rule', record: { kind: 'rule',
      moduleId: 'synthetic-confirmation-module', name: '设备检查规范：温度、编号、来源和异常结果的记录要求 · ' + id,
      requirement: before, strength: 'required', condition: null, effect: { kind: 'note' }, exception: '离线草稿除外。' } })),
  ] });
  const rows = {};
  const units = await stock.inventoryStockOrganization(uid);
  for (const id of ids) {
    const jobId = 'synthetic-confirmation-' + id, candidateId = candidates.candidateIdForCaptureKey(jobId);
    const unit = units.find(unit => unit.key === 'ontology-' + id), at = new Date().toISOString();
    const plan = formation.parseOntologyFormationProposal(ontology.readOntologyDocument(uid), candidateId, {
      reason: '按检查要求和使用条件分段，保留否定及例外。', evidence: ['stored-version'], actions: [
        { intent: 'update', recordId: id, expectedVersion: 1, sourceLabel: 'Synthetic paragraph organization', patch: { requirement: after } },
      ],
    }, '', at, 'ontology');
    const prepared = { captureKey: jobId, proposalTarget: 'ontology', summary: unit.records.find(row => row.id === id).name,
      judgment: '按检查要求和使用条件分段，保留否定及例外。', evidenceSummary: '按检查要求和使用条件分段。',
      suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'create', risk: 'low',
      sourceRefs: [], evidenceRefs: [], ontologyFormation: plan,
      stockOrganizationProvenance: { kind: 'stock_organization', schemaVersion: 1, ownerId: uid, jobId, unitKey: unit.key,
        policyVersion: 1, checkedAt: at, originalSourceUnrecorded: true } };
    await store.writeRecallJsonRecord(uid, 'stock-organization', jobId, { schemaVersion: 1, ownerId: uid, id: jobId, candidateId,
      unit, prepared, fingerprint: 'synthetic-confirmation', state: 'prepared', updatedAt: at });
    rows[id] = await load('features/recall/stock-organization-provenance.ts').withStockOrganizationWrite(uid, prepared,
      () => candidates.saveRecallCandidate(uid, prepared));
  }
  // The confirmation control carries the candidate id. Targeting it (instead
  // of "any enabled adopt button") keeps a stale detail render from confirming
  // the previously reviewed candidate while this one is still being routed in.
  const adoptSelector = id => '[data-act="cand-adopt-with-form"][data-id="' + rows[id].id + '"]:not([disabled])';
  const open = async (id, narrow) => {
    await js(`(async()=>{await CogAssets.reload();CogAssets.router.go({name:'activity',candidateId:${JSON.stringify(rows[id].id)}});})()`);
    if (narrow) await activate(`[data-act="activity-select"][data-id="candidate:${rows[id].id}"]`);
    await waitFor('confirmation button ' + id, () => js(`!!document.querySelector(${JSON.stringify(adoptSelector(id))})`));
  };
  for (const narrow of [false, true]) {
    const mode = narrow ? 'narrow' : 'desktop';
    window.setSize(narrow ? 900 : 1440, narrow ? 740 : 960); await delay(120);
    for (const suffix of ['first', 'second']) {
      const id = mode + '-' + suffix;
      await open(id, narrow);
      await js(`document.querySelector(${JSON.stringify(adoptSelector(id))}).focus()`);
      // Enter is delivered as real input, so it must land on the confirmed
      // candidate's focused button; verify the focus instead of a fixed sleep.
      // On a headless CI runner (xvfb, hidden window, no window manager) the
      // document never gains OS focus, so `document.hasFocus() === false` and
      // `element.focus()` cannot become `document.activeElement` there. The
      // equivalent, focus-independent precondition for "Enter can only confirm
      // this candidate" is that the target is the *only* visible, enabled adopt
      // control in the document. The keypress effect is still verified below by
      // the candidate's own `integrated` status and saved body, so the business
      // assertion is unchanged; the probe records which branch was used.
      const focusProbe = async () => js(`(() => {
        const target = document.querySelector(${JSON.stringify(adoptSelector(id))});
        if (!target) return { present: false, hasFocus: document.hasFocus() };
        const adoptables = [...document.querySelectorAll('[data-act="cand-adopt-with-form"]')]
          .filter(button => button.getClientRects().length > 0 && !button.disabled);
        const active = document.activeElement;
        return {
          present: true,
          hasFocus: document.hasFocus(),
          activeIsTarget: active === target,
          activeAct: active?.dataset?.act || '',
          activeId: active?.dataset?.id || '',
          visible: target.getClientRects().length > 0,
          uniqueAdoptable: adoptables.length === 1 && adoptables[0] === target,
          adoptableCount: adoptables.length,
        };
      })()`);
      let probe = null;
      try {
        await waitFor('confirmation focus ' + id, async () => {
          probe = await focusProbe();
          return probe.activeIsTarget
            || (!probe.hasFocus && probe.present && probe.visible && probe.uniqueAdoptable);
        });
      } catch (error) {
        // Keep the last observation with the failure instead of losing it with
        // the timeout; the error is rethrown, never swallowed.
        (outcome.focusProbes ||= []).push({ id, mode, timedOut: true, ...(probe || {}) });
        throw error;
      }
      (outcome.focusProbes ||= []).push({ id, mode, ...probe });
      await key('Enter');
      await waitFor('confirmed ' + id, async () => (await candidates.readRecallCandidate(uid, rows[id].id)).status === 'integrated');
      check(mode + ' ' + suffix + ' saves the reviewed body', ontology.readOntologyDocument(uid).records[id].requirement === after);
    }
    const id = mode + '-conflict';
    await open(id, narrow);
    await capture(mode + '-before-conflict');
    let release;
    if (narrow) {
      const held = new Promise(resolve => { release = resolve; });
      outcome.beforePromotion = () => held;
    }
    await ontology.commitOntologyCommand(uid, { commandId: 'synthetic-edit-' + id, expectedRevision: ontology.readOntologyDocument(uid).revision,
      actions: [{ intent: 'update', recordId: id, expectedVersion: 1, sourceLabel: 'Synthetic concurrent update', patch: { name: '已修改的设备检查规范' } }] });
    await activate(adoptSelector(id));
    if (narrow) {
      await activate('[data-act="activity-edit"]');
      // 编辑态是异步渲染的：控件还没出现时直接赋值会抛
      // 「Cannot set properties of null」，等它出现再驱动。
      await waitFor('judgment field', () => js(`!!document.querySelector('[data-f="judgment"]')`));
      await js(`(()=>{const field=document.querySelector('[data-f="judgment"]');field.value='保留我的合成修改要求。';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      delete outcome.beforePromotion; release();
    }
    await waitFor('conflict alert', () => js(`!!document.querySelector('.ui-dialog-message')`));
    check(mode + ' conflict explains no save and retains suggestion', await js(`(()=>{const text=document.querySelector('.ui-dialog-message').textContent;return text.includes('本次没有保存')&&text.includes('原建议保留')&&!text.includes('稍后重试')&&!text.includes(${JSON.stringify(id)});})()`));
    await key('Escape');
    await waitFor('recovery focus', () => js(`document.activeElement?.dataset.act===${JSON.stringify(narrow ? 'activity-save-draft' : 'formation-recheck')}`));
    check(mode + ' recovery is visible and keyboard focused', await js(`(()=>{const b=document.activeElement; const r=b.getBoundingClientRect();return r.height>0&&r.top>=0&&r.bottom<=innerHeight;})()`));
    check(mode + ' preserves preview and stored record on rejection', (await candidates.readRecallCandidate(uid, rows[id].id)).ontologyFormation.commandId === rows[id].ontologyFormation.commandId && ontology.readOntologyDocument(uid).records[id].requirement === before);
    check(mode + ' fixed actions remain unobscured', await js(`(()=>{const r=document.querySelector('.ca-activity-detail-footer').getBoundingClientRect();return r.height>0&&r.top>=0&&r.bottom<=innerHeight;})()`));
    check(mode + ' retains reading or unsaved editing state', await js(narrow ? `document.querySelector('[data-f="judgment"]').value==='保留我的合成修改要求。'` : `!document.querySelector('[data-f="judgment"]')`));
    await capture(mode + '-conflict-recovery');
    if (narrow) {
      await activate('[data-act="activity-save-draft"]');
      await waitFor('retained draft recovery', () => js(`document.activeElement?.dataset.act==='formation-recheck'`));
      check('narrow saved draft reveals recheck without running it', await js(`!document.querySelector('[data-f="judgment"]') && !!document.querySelector('[data-act="formation-recheck"]')`));
      check('narrow draft is retained on the candidate, not applied to the ontology', (await candidates.readRecallCandidate(uid, rows[id].id)).judgment === '保留我的合成修改要求。' && ontology.readOntologyDocument(uid).records[id].requirement === before);
      await capture('narrow-recheck-after-draft');
    }
  }
  if (outcome.actions.some(action => action.channel === 'recall.candidates.recheckOntologyFormation')) throw new Error('Conflict invoked model recheck without a user click');
};
