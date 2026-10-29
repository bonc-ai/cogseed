// Real production page/preload/modal and main approval gate; isolated account, fixture CLI only.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tencent-permission-page-'));
process.env.COGSEED_WORKSPACE_ROOT = temporary;
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs');
const gate = require(path.join(root, 'src/main/features/action_approval.ts'));
const { callApprovedTencentMeetingChange } = require(path.join(root, 'src/main/features/connectors/tencent-meeting-approval.ts'));
const adapter = require(path.join(root, 'bin/tencent-meeting-mcp-server.cjs'));
const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang, JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
const args = { meeting_id: '123', meeting_record_id: 'record_fixture' };
const preview = { meeting_record_id: args.meeting_record_id, approval_name: '查看录制', subject: '<img src=x onerror=alert(1)> 项目评审', file_owner: '所有者甲', applicant: '申请人乙', apply_note: '用于整理会议纪要' };
let commits = 0;
let lastDecision;
let completeBoot;
const bootReady = new Promise(resolve => { completeBoot = resolve; });
adapter._setExecForTest(async argv => {
  if (argv[0] === 'meeting') return { data: { meeting_info_list: [{ meeting_id: args.meeting_id, records: [{ meeting_record_id: args.meeting_record_id, permission_status: 'can_apply', state: '转码完成' }] }] } };
  if (argv[1] === 'permission-apply-prepare') return { data: { preview, expires_in: 120 } };
  assert.equal(argv[1], 'permission-apply-commit');
  commits += 1;
  return { data: { status: 'pending', approval_url: 'https://meeting.tencent.com/approval/fixture' } };
});
const connection = { callTool: async (name, input) => ({ content: [{ type: 'text', text: JSON.stringify(await adapter.callTool(name, input)) }] }) };
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true, pong: 'pong' }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'zh', tables }; });
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'actionApproval.respond') {
    assert.equal(typeof payload.request_id, 'string');
    assert.ok(['approve', 'deny'].includes(payload.decision));
    lastDecision = payload;
    return { ok: true, ...await gate.respondActionApproval(payload.request_id, payload.decision) };
  }
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'permission-page-test' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'zh' };
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) completeBoot();
    return { ok: true };
  }
  return { ok: false, error: 'unavailable in isolated permission fixture' };
});
app.whenReady().then(async () => {
  let window;
  try {
    window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(root, 'src/main/preload.js'),
    } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([bootReady, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Renderer boot timeout')), 10000); timer.unref(); })]);
    gate._setActionApprovalBroadcastForTest((channel, payload) => { window.webContents.send(channel, payload); });
    for (const [width, decision] of [[1280, 'deny'], [600, 'approve']]) {
      window.setSize(width, 900);
      const pending = callApprovedTencentMeetingChange('permission-page-test', connection, 'apply_record_permission', args).then(value => ({ value }), error => ({ error: error.message }));
      const info = await window.webContents.executeJavaScript(`(async () => {
        for (let i=0; i<100 && !document.querySelector('.action-approval-details'); i++) await new Promise(r=>setTimeout(r,30));
        const body = document.querySelector('.action-approval-details');
        if (!body) throw new Error('Approval modal did not open');
        const modal = body.closest('.ui-modal');
        const deny = modal.querySelector('[data-ui-modal-action="deny"]');
        const approve = modal.querySelector('[data-ui-modal-action="approve"]');
        deny.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',shiftKey:true,bubbles:true}));
        const trapped = document.activeElement === approve;
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
        return {text:body.textContent, escaped: !body.querySelector('img'), trapped, escapeKept:modal.isConnected,
          fits:modal.getBoundingClientRect().width <= innerWidth && modal.scrollWidth <= modal.clientWidth + 1};
      })()`);
      for (const value of Object.values(preview).filter(Boolean)) assert.ok(info.text.includes(value), 'Official preview field must be visible');
      assert.ok(info.escaped && info.trapped && info.escapeKept && info.fits, JSON.stringify(info));
      assert.equal(commits, 0, 'No CLI commit before user click');
      await window.webContents.executeJavaScript(`document.querySelector('[data-ui-modal-action="${decision}"]').click()`);
      const settled = await pending;
      assert.deepEqual(Object.keys(lastDecision).sort(), ['decision', 'request_id']);
      if (decision === 'deny') assert.match(settled.error, /DENIED/);
      else assert.equal(JSON.parse(settled.value.content[0].text).data.status, 'pending');
    }
    assert.equal(commits, 1);
    process.stdout.write(JSON.stringify({ ok: true, widths: [1280, 600], previewEscaped: true, keyboard: true, denialBlocked: true, confirmedFixtureCommits: commits, provider: 'fixture only; no external application submitted' })+'\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack })+'\n');
    process.exitCode = 1;
  } finally {
    gate._resetActionApprovalForTest();
    window?.destroy();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
