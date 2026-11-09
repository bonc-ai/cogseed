// Production index/preload/shared UI with isolated IPC data and no network.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'consultation-page-'));
app.setPath('userData', path.join(temporary, 'electron'));
const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
let boot;
const ready = new Promise(resolve => { boot = resolve; });
const cid = 'a2a-0123456789abcdef0123';
const consultation = { id: 'acons-page', conversationId: cid, peerName: 'Visitor',
  state: 'pending', question: 'Private decision required', proposedReply: 'Owner approved wording' };
let rows = [];
let failAnswer = true;
const answers = [];
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'en', tables }; });
ipcMain.handle('cogseed.invoke', async (event, { channel, payload }) => {
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'consultation-page' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'en' };
  if (channel === 'agents.list') return { agents: [] };
  if (channel === 'spaces.list') return { spaces: [] };
  if (channel === 'contacts.list') return { ok: true, contacts: [] };
  if (channel === 'contacts.requests') return { ok: true, requests: [
    { id: 'incoming', direction: 'in', state: 'pending', phoneMasked: '138****1234' },
    { id: 'outgoing', direction: 'out', state: 'pending', phoneMasked: '139****5678' },
  ] };
  if (channel === 'a2a.reception.pending') return { pending: [] };
  if (channel === 'a2a.consultations.list') return { ok: true, consultations: rows };
  if (channel === 'a2a.conversationMarker') return { ok: true, marker: { role: 'receiver', state: 'active' } };
  if (channel === 'a2a.consultations.answer') {
    answers.push(payload);
    if (failAnswer) {
      rows = [{ ...consultation, state: 'approved', finalReply: consultation.proposedReply, delivery: { state: 'failed' } }];
      event.sender.send('a2a:consultation', { conversationId: cid });
      return { ok: false, error: 'isolated relay failure', code: 'E_CONSULTATION_DELIVERY_FAILED' };
    }
    rows = [];
    return { ok: true, consultation: { ...consultation, state: 'approved' } };
  }
  if (channel === 'log.record') { if (payload?.module === 'boot' && /^boot total/.test(payload.message)) boot(); return { ok: true }; }
  return { ok: false, error: 'Unavailable in isolated consultation page' };
});
app.whenReady().then(async () => {
  let window;
  const outcome = { widths: [], answers };
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('boot timeout')), 10000))]);
    const run = source => window.webContents.executeJavaScript(`(async()=>{
      const wait=async(fn,label)=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout '+label);};
      const assert=(ok,message)=>{if(!ok)throw new Error(message);};
      ${source}
    })()`);
    await run(`
      await consultationStrip.setConversation(${JSON.stringify(cid)});
      assert(document.getElementById('a2a-consultation-strip').hidden,'initial strip hidden');
      await contacts.refresh();
      await window.loadRendererFeature('contacts');
      setView('contacts'); contactsPage.setTab('requests');
      await wait(()=>document.querySelector('[data-request-row="incoming"]'),'incoming card');
      assert(document.querySelector('[data-request-row="incoming"]').textContent.includes('138****1234'),'incoming masked phone');
      assert(document.querySelector('[data-request-row="outgoing"]').textContent.includes('139****5678'),'outgoing masked phone');
      setView('conversation',${JSON.stringify(cid)});
    `);
    rows = [consultation];
    window.webContents.send('a2a:consultation', { conversationId: cid });
    for (const width of [1280, 640]) {
      window.setContentSize(width, 900);
      await run(`
        await wait(()=>document.querySelector('[data-consult-approve]'),'pushed private decision');
        const card=document.querySelector('[data-consult-card]');
        assert(card.textContent.includes('Private decision required'),'question visible');
        assert(card.textContent.includes('Owner approved wording'),'proposal visible');
        assert(card.querySelectorAll('button').length===3,'three shared decision buttons');
        const rect=card.getBoundingClientRect();
        assert(rect.width>0 && rect.right<=innerWidth+1,'card fits width');
      `);
      outcome.widths.push(width);
    }
    rows = [{ ...consultation, proposedReply: '', creationError: 'INTENT_UNAVAILABLE' }];
    window.webContents.send('a2a:consultation', { conversationId: cid });
    await run(`
      await wait(()=>document.querySelector('[data-consult-card]')?.textContent.includes('Draft unavailable'),'creation failure status');
      assert(!document.querySelector('[data-consult-approve]'),'unavailable draft cannot be approved');
      assert(!!document.querySelector('[data-consult-revise]') && !!document.querySelector('[data-consult-decline]'),'owner can write or decline');
    `);
    rows = [consultation];
    window.webContents.send('a2a:consultation', { conversationId: cid });
    await run(`
      await wait(()=>document.querySelector('[data-consult-approve]'),'restored draft');
      document.querySelector('[data-consult-approve]').click();
      await wait(()=>document.querySelector('.ui-modal:not(#auto-task-dialog-overlay .ui-modal)'),'failure feedback');
      assert(!document.getElementById('a2a-consultation-strip').hidden,'failed decision remains available');
      const modal=document.querySelector('.ui-modal-overlay:not(#auto-task-dialog-overlay)');
      assert(!!modal,'shared feedback modal');
      modal.querySelector('[data-act="ok"]').click();
      await wait(()=>!document.querySelector('.ui-modal-overlay:not(#auto-task-dialog-overlay)'),'feedback dismissed');
    `);
    failAnswer = false;
    await run(`
      await wait(()=>document.querySelector('[data-consult-retry]') && !document.querySelector('[data-consult-retry]').disabled,'retry ready');
      document.querySelector('[data-consult-retry]').click();
      await wait(()=>document.getElementById('a2a-consultation-strip').hidden,'delivered decision disappears');
    `);
  } catch (error) { outcome.error = error.message; outcome.stack = error.stack; }
  finally {
    window?.destroy();
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* Chromium may retain cache handles on Windows. */ }
    process.stdout.write('@@CONSULTATION_PAGE@@' + JSON.stringify(outcome) + '\n');
    app.exit(outcome.error ? 1 : 0);
  }
});
