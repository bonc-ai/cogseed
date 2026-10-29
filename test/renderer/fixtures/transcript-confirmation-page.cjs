// Production page, history lifecycle, preload and shared controls; fixture IPC
// responses only. Never reads a real account or submits a correction decision.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-confirmation-page-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
app.setPath('userData', path.join(temporary, 'electron'));
const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
const cid = 'confirmation-fixture';
const confirmation = { confirm_id: 'confirm-fixture', cid, doc_id: 'doc', turn_id: 'turn', items: [
  { entryRef: 'fuzzy', wrong: 'ok', correct: 'Unrelated product', action: 'replace', riskLevel: 'low', count: 2, context: 'This is ok', ignoredCount: 0 },
  { entryRef: 'model', wrong: '<img src=x>', correct: 'Term', action: 'replace', riskLevel: 'medium', count: 1, context: 'Quoted source', fromModel: true, ignoredCount: 0 },
] };
let confirmed = 0;
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'transcript_glossary.pending') return { ok: true, confirmations: payload.cid === cid ? [confirmation] : [] };
  if (channel === 'transcript_glossary.visible') return { ok: true };
  if (channel === 'transcript_glossary.confirm') { confirmed++; return { ok: true }; }
  if (channel === 'conversations.history') return { ok: true, conversation: { cid, title: 'Correction fixture', processing: false, in_flight: [], active_turns: [] }, history: [], next_cursor: null };
  if (channel === 'groupChat.listMembers') return { ok: true, members: [] };
  if (channel === 'groupChat.runtimeStatus') return { ok: true, processing: false, backend_active: false, in_flight: [], active_turns: [] };
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'confirmation-page-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  return { ok: false, error: 'unavailable in isolated confirmation fixture' };
});
app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js'),
    } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer boot timeout')), 10000); timer.unref();
    })]);
    for (const width of [1280, 800]) {
      window.setSize(width, 900);
      const info = await window.webContents.executeJavaScript(`(async () => {
        currentCid = ${JSON.stringify(cid)};
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        document.getElementById('panel-conversation').classList.add('active');
        await loadConversationHistory(currentCid);
        for (let i=0; i<100 && !document.querySelector('.glossary-confirm-card'); i++) await new Promise(r=>setTimeout(r,20));
        const cards = document.querySelectorAll('#chat-history .glossary-confirm-card');
        const card = cards[0];
        if (!card) throw new Error('History did not recover the confirmation controls');
        const boxes = [...card.querySelectorAll('input[type="checkbox"]')];
        const apply = card.querySelector('[data-glossary-act="ok"]');
        const none = card.querySelector('[data-glossary-act="none"]');
        const defaults = boxes.every(box=>!box.checked) && apply.disabled && !none.disabled;
        boxes[0].focus(); boxes[0].click();
        const enabled = !apply.disabled;
        boxes[0].click();
        const disabled = apply.disabled;
        none.focus();
        return { count:cards.length, defaults, enabled, disabled, escaped:!card.querySelector('img'),
          focused:document.activeElement===none, fits:card.scrollWidth<=card.clientWidth+1,
          pending:pendingConvs.has(currentCid) };
      })()`);
      assert.deepEqual(info, { count: 1, defaults: true, enabled: true, disabled: true,
        escaped: true, focused: true, fits: true, pending: false });
    }
    assert.equal(confirmed, 0);
    process.stdout.write(JSON.stringify({ ok: true, reloads: 2, confirmed }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  } finally {
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
