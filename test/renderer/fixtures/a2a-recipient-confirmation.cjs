// Full production renderer/preload and shared controls. Only directory data,
// model entry and transport are isolated; no real account or service is used.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-recipient-page-'));
app.setPath('userData', path.join(temporary, 'electron'));
const tables = Object.fromEntries(['en', 'zh', 'ja', 'pt'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
const requests = [];
const scenario = process.argv[2] || '';
let boot;
const ready = new Promise(resolve => { boot = resolve; });
ipcMain.handle('cogseed.env', () => ({ ok: true, platform: process.platform, isDev: true }));
ipcMain.handle('cogseed.ping', () => ({ ok: true }));
ipcMain.on('cogseed:bootI18n', event => { event.returnValue = { ok: true, lang: 'en', tables }; });
ipcMain.on('cogseed.streamStart', (event, { requestId, channel, payload }) => {
  if (channel === 'conversations.sendStream') {
    requests.push({ channel, payload });
    event.sender.send(`stream:${requestId}`, {
      type: 'accepted', accepted: true, cid: payload.cid,
      submit_request_id: payload.submit_request_id,
    });
  }
  event.sender.send(`stream:${requestId}`, { type: 'done' });
});
ipcMain.handle('cogseed.invoke', async (_event, { channel, payload }) => {
  if (channel === 'a2a.conversation.prepare' || channel === 'a2a.question.send') {
    requests.push({ channel, payload });
    if (channel === 'a2a.conversation.prepare') return { prepared: true, requestId: 'd2-request' };
    if (channel === 'a2a.question.send') return scenario
      ? { sent: true, conversationId: 'd2-other' }
      : { sent: false, error: 'delivery_failed' };
  }
  if (channel === 'prefs.getOnboarding') return { ok: true, completed: true };
  if (channel === 'user.init') return { ok: true, user_id: 'd2-page-user' };
  if (channel === 'config.getLanguage') return { ok: true, language: 'en' };
  if (channel === 'conversations.create' && scenario.startsWith('local-')) {
    return { ok: true, conversation: { conversation_id: 'd2-local-created', title: 'D2 local' } };
  }
  if (channel === 'log.record') {
    if (payload?.module === 'boot' && /^boot total/.test(payload.message)) boot();
    return { ok: true };
  }
  return { ok: false, error: 'Unavailable in isolated D2 page fixture' };
});

app.whenReady().then(async () => {
  let window;
  const outcome = { checks: [], requests };
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false,
        preload: path.join(root, 'src/main/preload.js') } });
    await window.loadFile(path.join(root, 'src/renderer/index.html'));
    await Promise.race([ready, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('D2 renderer boot did not finish')), 10000);
      timer.unref();
    })]);
    outcome.checks = await window.webContents.executeJavaScript(`(async () => {
      const checks = [];
      const assert = (name, ok, details) => {
        if (!ok) throw new Error(name + (details ? ': ' + JSON.stringify(details) : ''));
        checks.push(name);
      };
      const wait = async (condition, name) => {
        for (let i = 0; i < 200; i += 1) {
          if (condition()) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Timed out: ' + name);
      };
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const selectCount = _aiSelectInstances.size;
      let localEntries = 0;
      const productionEnsureModel = _ensureModelOrCliFallback;
      _ensureModelOrCliFallback = async () => { localEntries += 1; return false; };
      _evaluateAutoRecipient = async () => {};
      startPolling = () => {};
      const contacts = [{ user_id: 'cs_bob', name: 'Bob', online: true },
        { user_id: 'cs_bob_2', name: 'Bob', online: true }];
      window.getComposerContactCandidates = () => contacts;
      window.getComposerAgentList = window.getComposerAgentCandidates = () => [{ agent_id: 'local-bob', name: 'Bob' }];
      conversations = [{ conversation_id: 'd2-ended', title: 'D2',
        a2a: { state: 'ended', peer_user_id: 'cs_bob' } }, { conversation_id: 'd2-other', title: 'Other' }];
      setView('conversation', 'd2-ended', { skipLoad: true });
      const input = document.getElementById('chat-input');
      const setText = value => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        syncChatRichComposerFromTextarea('chat-input');
      };
      const modal = () => document.querySelector('.ui-form-modal');
      const open = async () => {
        const trigger = document.getElementById('chat-send-btn');
        trigger.focus();
        trigger.click();
        await wait(modal, 'recipient modal');
        await frame();
        return modal();
      };
      const choose = key => {
        modal().querySelector('.ai-select-trigger').click();
        const option = [...document.querySelectorAll('.ai-select-item')]
          .find(node => node.querySelector('.ai-select-item-hint')?.textContent === key.slice(key.indexOf(':') + 1));
        if (!option) throw new Error('Missing identity ' + key);
        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      };

      const scenario = ${JSON.stringify(scenario)};
      if (scenario.startsWith('local-')) {
        const target = scenario.endsWith('new-chat') ? 'new-chat' : 'conversation';
        setView(target, target === 'conversation' ? 'd2-other' : undefined, { skipLoad: true });
        const textInput = document.getElementById(composerMembers.inputIdOf(target));
        loadConversations = async () => {};
        loadConversationHistory = async () => {};
        textInput.value = 'hello @Bob  ';
        textInput.dispatchEvent(new Event('input', { bubbles: true }));
        syncChatRichComposerFromTextarea(textInput.id);
        assert('local confirmation starts with no persistent members', composerMembers.getMembers(target).length === 0);
        document.getElementById(target === 'new-chat' ? 'new-chat-send-btn' : 'chat-send-btn').click();
        await wait(modal, 'trailing local confirmation');
        choose('agent:local-bob');
        modal().querySelector('[data-ui-form-submit]').click();
        await wait(() => !_a2aRecipientConfirmation, 'trailing local identity bound');
        assert('confirmation binds the chosen local stable identity', composerMembers.mentionIdsForTarget(target, textInput.value).join() === 'local-bob');
        assert('local confirmation preserves the full draft without membership', textInput.value === 'hello @Bob  '
          && composerMembers.getMembers(target).length === 0);
        assert('local confirmation alone never sends', localEntries === 0 && textInput.value === 'hello @Bob  ');
        _ensureModelOrCliFallback = productionEnsureModel;
        ensureModelConfigured = () => true;
        _maybeApplyCliFallback = async () => false;
        if (target === 'new-chat') await handleNewChatSubmit();
        else await handleChatSubmit();
        assert('local confirmation never persists membership after send', composerMembers.getMembers('conversation').length === 0);
        return checks;
      }
      if (scenario) {
        const target = scenario.endsWith('new-chat') ? 'new-chat' : 'conversation';
        const sourceCid = target === 'new-chat' ? DRAFT_CID : 'd2-other';
        conversations[1].a2a = { state: 'active', peer_user_id: 'cs_bob' };
        setView(target, target === 'conversation' ? sourceCid : undefined, { skipLoad: true });
        const textInput = document.getElementById(composerMembers.inputIdOf(target));
        const write = (textarea, text) => {
          textarea.value = text;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          syncChatRichComposerFromTextarea(textarea.id);
        };
        const pick = async (textarea, id) => {
          write(textarea, '@');
          const editor = getChatRichComposerEditor(textarea);
          editor.focus();
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          editor.dispatchEvent(new KeyboardEvent('keydown', { key: '@', bubbles: true }));
          const anchorId = textarea.id === 'chat-input' ? 'chat-recipient-chip' : 'new-chat-recipient-chip';
          await wait(() => document.getElementById('agent-picker').style.display !== 'none'
            && document.getElementById('agent-picker').dataset.anchorId === anchorId
            && document.querySelector('#agent-picker [data-composer-member="' + id + '"]'), 'real @ picker');
          document.querySelector('#agent-picker [data-composer-member="' + id + '"]').click();
          document.querySelector('#agent-picker [data-composer-members-done]').click();
          assert('picker completes through its real shared action', document.getElementById('agent-picker').style.display === 'none');
        };
        const beforeMembers = JSON.stringify(composerMembers.getMembers(target));
        if (scenario.startsWith('picker')) {
          await pick(textInput, 'cs_bob');
          assert('real contact picker preserves contact kind', composerMembers.mentionTokensForTarget(target, textInput.value)[0]?.kind === 'contact');
          write(textInput, textInput.value + 'hello');
        } else {
          write(textInput, '@Bob hello');
          document.getElementById(target === 'new-chat' ? 'new-chat-send-btn' : 'chat-send-btn').click();
          await wait(modal, 'typed recipient confirmation');
          choose('contact:cs_bob');
          modal().querySelector('[data-ui-form-submit]').click();
          await wait(() => !_a2aRecipientConfirmation, 'typed contact bound');
        }
        assert('contact binding never adds persistent local members', JSON.stringify(composerMembers.getMembers(target)) === beforeMembers);
        write(textInput, textInput.value + ' again');
        assert('later input never restores an external id as a local member', JSON.stringify(composerMembers.getMembers(target)) === beforeMembers);
        assert('binding has no implicit local dispatch', localEntries === 0);
        // Keep only directory/history loading and the transport outside this page test.
        loadConversations = async () => {};
        loadConversationHistory = async () => {};
        if (target === 'new-chat') await handleNewChatSubmit();
        else await handleChatSubmit();
        assert('successful external send clears the source draft', textInput.value === '');
        assert('successful external send clears source atoms', composerMembers.mentionSidecarSnapshot(target).length === 0);
        assert('successful external send leaves source members unchanged', JSON.stringify(composerMembers.getMembers(target)) === beforeMembers);
        assert('external send never enters the local path', localEntries === 0);
        const persisted = Object.values(JSON.parse(localStorage.getItem('chat.membersByCid') || '{}')).flat();
        assert('no contact identity is persisted as a local member', persisted.every(member => member.id !== 'cs_bob'));

        const localSends = [];
        _ensureModelOrCliFallback = async () => true;
        sendInCurrentConversation = async (content, extra) => {
          localSends.push({ content, extra });
          return { accepted: true, cid: currentCid, submit_request_id: extra.submit_request_id };
        };
        write(input, 'local follow-up');
        await handleChatSubmit();
        assert('unaddressed follow-up reaches the real local submission path', localSends.length === 1);
        assert('unaddressed follow-up has no external member or mention payload', !localSends[0].extra.member_agent_ids?.length
          && !localSends[0].extra.mention_agent_ids?.length);
        await pick(input, 'local-bob');
        assert('local picker retains agent type and member selection', composerMembers.mentionTokensForTarget('conversation', input.value)[0]?.kind === 'agent'
          && composerMembers.getMembers('conversation').some(member => member.id === 'local-bob' && member.kind === 'agent'),
          { text: input.value, tokens: composerMembers.mentionSidecarSnapshot('conversation'), members: composerMembers.getMembers('conversation') });
        write(input, input.value + 'local question');
        await handleChatSubmit();
        assert('local picker still routes the stable local member', localSends.length === 2
          && localSends[1].extra.member_agent_ids?.join() === 'local-bob'
          && (localSends[1].extra.mention_agent_ids || []).every(id => id === 'local-bob'), localSends);
        return checks;
      }

      setText('@Bob hello');
      let dialog = await open();
      assert('real shared form modal and selector', !!dialog.querySelector('form.ui-form #a2a-recipient-choice .ai-select-trigger'));
      assert('confirmation explicitly promises no send', dialog.textContent.includes(t('composer.a2a.recipient_hint')));
      assert('ended unresolved address has no local dispatch', localEntries === 0);
      dialog.querySelector('[data-ui-form-submit]').click();
      assert('no default recipient is selected', !!modal() && !dialog.querySelector('.ui-form-modal__feedback').hidden);
      dialog.querySelector('.ai-select-trigger').click();
      const identities = [...document.querySelectorAll('.ai-select-item')].map(node => node.textContent);
      assert('all three stable identities are listed', ['local-bob', 'cs_bob', 'cs_bob_2'].every(id => identities.some(text => text.includes(id))));
      assert('local and external roles are visible', identities.some(text => text.includes(t('composer.a2a.recipient_local')))
        && identities.some(text => text.includes(t('composer.a2a.recipient_external'))));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert('Escape first closes only the selector', !!modal() && !dialog.querySelector('.ai-select.open'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
      assert('IME Escape leaves the modal open', !!modal());
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(() => !modal(), 'Escape closes modal');
      await frame();
      assert('cancel preserves text and zero atoms', input.value === '@Bob hello' && composerMembers.mentionSidecarSnapshot('conversation').length === 0);
      // 无头/xvfb 下页面可能拿不到焦点，activeElement 不可能是按钮；此时退回
      // 「触发按钮仍存在且可见」这一结构等价判据，并把分支记进报告。
      const cancelFocusBack = document.activeElement.id === 'chat-send-btn';
      if (!cancelFocusBack && !document.hasFocus()) outcome.focusFallback = 'cancel focus asserted structurally';
      assert('cancel returns focus to the page trigger', cancelFocusBack
        || (!document.hasFocus() && !!document.getElementById('chat-send-btn') && document.getElementById('chat-send-btn').getClientRects().length > 0));
      assert('cancel releases shared selector instance', _aiSelectInstances.size === selectCount);

      dialog = await open();
      choose('agent:local-bob');
      for (const lang of ['zh', 'ja', 'pt', 'en']) {
        await setLang(lang);
        assert('modal relocalizes in ' + lang, dialog.querySelector('.ui-modal__title').textContent === t('composer.a2a.recipient_title'));
        assert('selected stable identity survives ' + lang, dialog.querySelector('#a2a-recipient-choice')._uiSelectApi.getValue() === 'agent:local-bob');
      }
      dialog.querySelector('[data-ui-form-submit]').click();
      await wait(() => !_a2aRecipientConfirmation, 'local atom bound');
      assert('confirmation leaves the draft intact', input.value === '@Bob hello');
      assert('confirmation binds the local stable id', composerMembers.mentionIdsForTarget('conversation', input.value).join() === 'local-bob');
      assert('rich editor shows a structured atom', !!document.querySelector('.chat-rich-editor [data-chat-mention-chip="1"]'));
      assert('confirmation alone has no local dispatch', localEntries === 0);
      document.getElementById('chat-send-btn').click();
      await wait(() => localEntries === 1, 'explicit local send');
      assert('structured same-name local token never reopens confirmation', !modal());

      composerMembers.setMentionSidecar('conversation', []);
      setText('@Bob hello');
      dialog = await open();
      choose('contact:cs_bob_2');
      setText('@Bob edited');
      setText('@Bob hello');
      dialog.querySelector('[data-ui-form-submit]').click();
      await wait(() => !_a2aRecipientConfirmation, 'edited modal settled');
      assert('edit then restore invalidates confirmation', composerMembers.mentionSidecarSnapshot('conversation').length === 0 && input.value === '@Bob hello');

      dialog = await open();
      choose('contact:cs_bob_2');
      setView('conversation', 'd2-other', { skipLoad: true });
      setText('new CID draft');
      dialog.querySelector('[data-ui-form-submit]').click();
      await wait(() => !_a2aRecipientConfirmation, 'CID modal settled');
      assert('CID switch preserves new draft and identity', input.value === 'new CID draft' && composerMembers.mentionSidecarSnapshot('conversation').length === 0);

      setView('new-chat');
      const newInput = document.getElementById('new-chat-input');
      newInput.value = '@Bob hello';
      newInput.dispatchEvent(new Event('input', { bubbles: true }));
      syncChatRichComposerFromTextarea('new-chat-input');
      document.getElementById('new-chat-send-btn').click();
      await wait(modal, 'new draft recipient modal');
      dialog = modal();
      choose('contact:cs_bob_2');
      dialog.querySelector('[data-ui-form-submit]').click();
      await wait(() => !_a2aRecipientConfirmation, 'contact atom bound');
      assert('new draft binds chosen duplicate contact id', composerMembers.mentionIdsForTarget('new-chat', newInput.value).join() === 'cs_bob_2');
      assert('new draft confirmation also dispatches nothing locally', localEntries === 1);
      document.getElementById('new-chat-send-btn').click();
      await wait(() => document.querySelector('.ui-dialog-message'), 'controlled transport failure');
      document.querySelector('[data-act="ok"]').click();
      await wait(() => !_newChatSubmitInFlight, 'send settled');
      assert('transport failure preserves the selected draft', newInput.value === '@Bob hello');

      const editor = document.getElementById('new-chat-input').parentElement.querySelector('.chat-rich-editor');
      const bodyNode = [...editor.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.nodeValue.includes('hello'));
      bodyNode.nodeValue += ' edited';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' edited' }));
      assert('body edit retains confirmed external identity', composerMembers.mentionTokensForTarget('new-chat', newInput.value)[0]?.kind === 'contact');
      contacts.length = 0;
      await handleNewChatSubmit();
      assert('disappeared external target never enters local dispatch', localEntries === 1);
      assert('disappeared target keeps its draft', newInput.value === '@Bob hello edited');
      contacts.push({ user_id: 'cs_bob', name: 'Bob', online: true });

      for (const target of ['new-chat', 'conversation']) {
        if (target === 'conversation') setView('conversation', 'd2-other', { skipLoad: true });
        const quoteCid = target === 'new-chat' ? DRAFT_CID : 'd2-other';
        const textInput = target === 'new-chat' ? newInput : input;
        composerMembers.setMentionSidecar(target, []);
        textInput.value = '@Bob';
        textInput.dispatchEvent(new Event('input', { bubbles: true }));
        syncChatRichComposerFromTextarea(textInput.id);
        _addQuote(quoteCid, { msgId: 'd2-quote', sourceCid: 'd2-source', text: 'Keep this quoted evidence' });
        const quoteSnapshot = JSON.stringify(_getQuotes(quoteCid));
        document.getElementById(target === 'new-chat' ? 'new-chat-send-btn' : 'chat-send-btn').click();
        await wait(modal, 'quote-only confirmation');
        choose('contact:cs_bob');
        modal().querySelector('[data-ui-form-submit]').click();
        await wait(() => !_a2aRecipientConfirmation, 'quote-only atom bound');
        if (target === 'new-chat') await handleNewChatSubmit();
        else await handleChatSubmit();
        assert(target + ': quote-only external intent never enters local dispatch', localEntries === 1);
        assert(target + ': quote-only draft and quote survive', textInput.value === '@Bob'
          && JSON.stringify(_getQuotes(quoteCid)) === quoteSnapshot);
        assert(target + ': explicit missing-question feedback', document.body.textContent.includes(t('composer.a2a.question_required')));
        _clearQuotes(quoteCid);
        composerMembers.setMentionSidecar(target, []);
      }
      for (const target of ['new-chat', 'conversation']) {
        setView(target, target === 'conversation' ? 'd2-other' : undefined, { skipLoad: true });
        const quoteCid = target === 'new-chat' ? DRAFT_CID : 'd2-other';
        const textInput = target === 'new-chat' ? newInput : input;
        textInput.value = '';
        textInput.dispatchEvent(new Event('input', { bubbles: true }));
        syncChatRichComposerFromTextarea(textInput.id);
        _addQuote(quoteCid, { msgId: 'd2-local-quote', sourceCid: 'd2-source', text: 'Local quote' });
        const beforeLocal = localEntries;
        if (target === 'new-chat') await handleNewChatSubmit();
        else await handleChatSubmit();
        assert(target + ': empty text with a local quote retains the local route', localEntries === beforeLocal + 1);
        _clearQuotes(quoteCid);
      }
      setView('new-chat');
      newInput.value = '@Bob hello';
      newInput.dispatchEvent(new Event('input', { bubbles: true }));
      syncChatRichComposerFromTextarea('new-chat-input');

      return checks;
    })()`);
    for (const width of scenario ? [] : [1280, 520]) {
      window.setSize(width, 900);
      const fits = await window.webContents.executeJavaScript(`(async () => {
        composerMembers.setMentionSidecar('new-chat', []);
        document.getElementById('new-chat-send-btn').click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const dialog = document.querySelector('.ui-form-modal');
        const rect = dialog?.getBoundingClientRect();
        const fits = !!rect && rect.left >= 0 && rect.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth + 1;
        dialog?.querySelector('[data-ui-form-cancel]').click();
        await Promise.resolve();
        return fits;
      })()`);
      if (!fits) throw new Error(`D2 modal overflow at ${width}px`);
      outcome.checks.push(`modal fits ${width}px`);
    }
  } catch (error) {
    outcome.error = error.message;
    outcome.stack = error.stack;
  } finally {
    // 结果必须最先、同步落 stdout：Windows 上 `process.stdout.write` 之后紧跟
    // `app.exit()` 会带走还没排空的管道写，收尾里的 `fs.rmSync` 也可能因为
    // Chromium 仍占着 userData 抛 EBUSY/EPERM——两者任一发生，测试侧看到的就是
    // 「空 stdout + 退出码 0」，断言退化成 reading 'length' of undefined。
    // `fs.writeSync(1, …)` 是阻塞写，不排在事件循环上。
    const resultLine = JSON.stringify(outcome) + '\n';
    try { fs.writeSync(1, resultLine); } catch (_) { /* 退回流写 */ try { process.stdout.write(resultLine); } catch (_) {} }
    try { window?.destroy(); } catch (_) { /* 收尾失败不影响结果 */ }
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) { /* 同上 */ }
    app.exit(outcome.error ? 1 : 0);
  }
});
