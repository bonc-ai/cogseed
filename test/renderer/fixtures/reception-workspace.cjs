// Isolated Electron using the production index, preload, relay-inbox and shared UI.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 't4a-page-'));
app.setPath('userData', path.join(temporary, 'electron'));
const tables = Object.fromEntries(['en', 'zh', 'ja', 'pt'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
const confirms = [];
const previews = [];
let version = 1;
let boot;
const ready = new Promise(resolve => { boot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'en', tables }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 't4a-page-user' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'en' };
  if (channel === 'agents.list') return { agents: [] };
  if (channel === 'spaces.list') return { spaces: [{ space_id: 'owned', name: 'My space' }] };
  if (channel === 'a2a.reception.setup') return { agents: [], spaces: [{ space_id: 'owned', name: 'My space' }] };
  if (channel === 'a2a.reception.pending') return { pending: [{ conversationId: 'a2a-0123456789abcdef0123', messageId: 'q1', fromAccount: 'cs_alice', text: 'Question', workspacePreview: '/server/default' },
    { conversationId: 'a2a-abcdefabcdefabcdefabcd', messageId: 'q2', fromAccount: 'cs_alice', text: 'Custom pending', defaultWorkspace: '/custom', workspacePreview: '/canonical/custom' }] };
  if (channel === 'a2a.reception.preview') {
    previews.push(payload);
    if (payload.workspace === '/slow') await new Promise(resolve => setTimeout(resolve, 70));
    if (payload.workspace === '/invalid') return { error: 'workspace is not a directory' };
    return { preview: payload.spaceId ? { root: '/server/space', snapshot: 'space' }
      : payload.workspace ? { root: '/canonical' + payload.workspace, snapshot: payload.workspace }
        : { root: version === 1 ? '/server/default' : '/server/changed', snapshot: 'default-v' + version } };
  }
  if (channel === 'a2a.reception.confirm') {
    confirms.push(payload);
    if (confirms.length === 1) { version = 2; return { confirmed: false, error: 'workspace_preview_changed', preview: { root: '/server/changed', snapshot: 'default-v2' } }; }
    return { confirmed: true, started: true };
  }
  if (channel === 'common.pickDirectory') return { path: '/picked' };
  if (channel === 'log.record') { if (payload?.module === 'boot' && /^boot total/.test(payload.message)) boot(); return { ok: true }; }
  return { ok: false, error: 'Unavailable in isolated T4a fixture' };
});
app.whenReady().then(async () => {
  let window;
  const outcome = { checks: [], confirms, previews };
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('boot timeout')), 10000))]);
    outcome.checks = await window.webContents.executeJavaScript(`(async () => {
      const checks = [];
      const assert = (label, condition) => { if (!condition) throw new Error(label); checks.push(label); };
      const wait = async (fn, label) => { for (let i=0;i<200;i++) { if(fn()) return; await new Promise(r=>setTimeout(r,10)); } throw new Error('timeout '+label); };
      const modal = () => document.querySelector('.ui-form-modal');
      const pathText = () => modal()?.querySelector('[data-a2a-reception-preview]')?.textContent || '';
      const choose = value => { const el = modal().querySelector('[data-a2a-reception-input="space"]'); el.value=value; el.dispatchEvent(new Event('change',{bubbles:true})); };
      const type = value => { const el = modal().querySelector('[data-a2a-reception-input="workspace"]'); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); };
      setView('contacts', undefined, { skipLoad:true });
      await wait(()=>document.querySelector('[data-relay-confirm]'),'pending hydration');
      const trigger = document.querySelector('[data-relay-confirm]');
      trigger.focus(); trigger.click();
      await wait(modal,'shared form');
      await wait(()=>pathText().includes('/server/default'),'initial default root');
      assert('restart pending displays actual default root', pathText().includes('/server/default'));
      choose('space:owned');
      await wait(()=>pathText().includes('/server/space'),'space root');
      assert('selected space displays server root', !pathText().includes('/server/default'));
      choose('custom'); type('/custom');
      await wait(()=>pathText().includes('/canonical/custom'),'custom root');
      assert('custom displays canonical server root', pathText().includes('/canonical/custom'));
      type('/slow'); type('/fast');
      await wait(()=>pathText().includes('/canonical/fast'),'latest custom root');
      await new Promise(r=>setTimeout(r,100));
      assert('late preview cannot replace newest selection', pathText().includes('/canonical/fast'));
      type('/invalid');
      await wait(()=>modal().querySelector('[role="alert"]')?.textContent.includes(t('a2a.reception.workspace_invalid')),'invalid scope');
      modal().querySelector('[data-ui-form-submit]').click();
      assert('invalid custom root clears displayed grant', !pathText().includes('/canonical/fast'));
      choose('custom'); type('/custom');
      await wait(()=>pathText().includes('/canonical/custom'),'recovered custom');
      modal().querySelector('[data-a2a-reception-pick]').click();
      await wait(()=>pathText().includes('/canonical/picked'),'picked root');
      assert('directory picker refreshes preview', pathText().includes('/canonical/picked'));
      for (const lang of ['zh','ja','pt','en']) {
        await setLang(lang);
        assert(lang+' scope labels rerender', modal().textContent.includes(t('a2a.reception.workspace')));
        assert(lang+' preview retained', pathText().includes('/canonical/picked'));
      }
      modal().querySelector('[data-ui-form-cancel]').click();
      await wait(()=>!modal(),'cancel');
      assert('cancel retains waiting reception', !!document.querySelector('[data-relay-confirm]'));
      await new Promise(r=>requestAnimationFrame(r));
      assert('cancel returns focus through shared modal', document.activeElement.matches('[data-relay-confirm]'));
      document.querySelector('[data-relay-confirm="q2"]').click();
      await wait(()=>pathText().includes('/canonical/custom'),'restart custom prefill');
      assert('restart retains selected custom scope', modal().querySelector('[data-a2a-reception-input="space"]').value === 'custom');
      modal().querySelector('[data-ui-form-cancel]').click();
      await wait(()=>!modal(),'custom pending cancel');

      document.querySelector('[data-relay-confirm]').click();
      await wait(()=>pathText().includes('/server/default'),'escape default');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await wait(()=>!modal(),'Escape cancellation');
      assert('Escape cancels without accepting', !!document.querySelector('[data-relay-confirm]'));
      document.querySelector('[data-relay-confirm]').click();
      await wait(()=>pathText().includes('/server/default'),'reopened default');
      modal().querySelector('[data-ui-form-submit]').click();
      await wait(()=>pathText().includes('/server/changed'),'stale root refresh');
      assert('stale confirmation stays open with clear error', modal().textContent.includes(t('a2a.reception.workspace_changed')));
      modal().querySelector('[data-ui-form-submit]').click();
      await wait(()=>!modal(),'successful confirmation');
      assert('second explicit confirmation closes modal', !modal());
      return checks;
    })()`);
    // Same production modal at desktop and constrained widths, cancellation only.
    for (const width of [1280, 390]) {
      window.setSize(width, 900);
      const fits = await window.webContents.executeJavaScript(`(async () => {
        a2aRelayInbox._push({ type:'question', awaitingConfirmation:true, message:{ messageId:'width', conversationId:'a2a-0123456789abcdef0123', fromAccount:'cs_alice', kind:'question', text:'Question' }});
        document.querySelector('[data-relay-confirm]').click();
        for(let i=0;i<200 && !document.querySelector('.ui-form-modal');i++) await new Promise(r=>setTimeout(r,10));
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const el=document.querySelector('.ui-form-modal'), rect=el?.getBoundingClientRect();
        const fits=!!rect && rect.left>=0 && rect.right<=innerWidth && el.scrollWidth<=el.clientWidth+1;
        el?.querySelector('[data-ui-form-cancel]').click(); return fits;
      })()`);
      if (!fits) throw new Error('modal overflow at ' + width);
      outcome.checks.push('fits ' + width);
    }
  } catch (error) { outcome.error = error.message; outcome.stack = error.stack; }
  finally {
    window?.destroy();
    // win32 上 Chromium 仍持有 userData/缓存句柄时递归删除会 EPERM。这一步在
    // finally 里、且在结果行之前：一旦抛出，测试侧只会读到空 stdout
    // （`JSON.parse(undefined)`），真正的用例结论反而丢了。清理失败不是用例
    // 信号，把临时树留给 OS 回收，结果行必须照常落盘。
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* OS 临时目录回收 */ }
    // 结果行带哨兵前缀：Electron 在 win32 上可能额外往 stdout 写自己的行，
    // 「取最后一行」会把噪音当结论（CI 里表现为
    // `Unexpected number in JSON at position 1`——解析到了别的行）。
    process.stdout.write('@@RECEPTION_WORKSPACE@@' + JSON.stringify(outcome) + '\n');
    app.exit(outcome.error ? 1 : 0);
  }
});
