// Isolated Electron page lane: production index/preload/components; synthetic IPC only.
const {app, BrowserWindow, ipcMain, session}=require('electron');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-nickname-page-'));
app.setPath('userData',path.join(temp,'electron'));
const tables=Object.fromEntries(['en','zh','ja','pt'].map(lang=>[lang,JSON.parse(fs.readFileSync(path.join(root,'src/renderer/locales/'+lang+'.json'),'utf8'))]));
const requests=[]; const rosterTrace=[]; let name='Original'; let peerName='Old peer'; let release; let boot;
const chipRace=process.argv[2]==='chip-race';
let holdMe=chipRace, enteredMe, releaseMe;
const oldMeStarted=new Promise(r=>{if(chipRace) enteredMe=r;});
let meReads=0;
const ready=new Promise(r=>{boot=r;});
ipcMain.handle('cogseed.env',()=>({ok:true,platform:process.platform,isDev:true}));
ipcMain.handle('cogseed.ping',()=>({ok:true}));
ipcMain.on('cogseed:bootI18n',event=>{event.returnValue={ok:true,lang:'en',tables};});
ipcMain.handle('cogseed.invoke',async (event,{channel,payload})=>{
  if(process.argv[2]==='roster' && ['log.record','groupChat.listMembers','conversations.history'].includes(channel)) rosterTrace.push({channel,payload});
  if(channel==='log.record') {if(payload?.module==='boot' && /^boot total/.test(payload.message)) boot(); return {ok:true};}
  if(channel==='prefs.getOnboarding') return {ok:true,completed:true};
  if(channel==='user.init') return {ok:true,user_id:'t6-synthetic'};
  if(channel==='config.getLanguage') return {ok:true,language:'en'};
  if(channel==='config.setLanguage') return {ok:true};
  if(channel==='contacts.list') return {ok:true,contacts:[{userId:'cs_peer',name:peerName,online:true}]};
  if(channel==='contacts.requests') return {ok:true,requests:[]};
  if(channel==='conversations.history') return {ok:true,conversation:{conversation_id:'nickname-chat',title:'Nickname roster'},history:[
    {id:'old-question',ts:'2026-10-27T00:00:00Z',from:'user',to:['a2a_cs_peer_assistant'],text:'Historical question',a2a:{visibility:'cross',recipient_user:'cs_peer',recipient_name:'Old peer'}},
  ]};
  if(channel==='groupChat.listMembers') return {ok:true,actors:[
    {kind:'agent',id:'a2a_cs_peer',name:peerName,joined_at:'original'},
    {kind:'agent',id:'a2a_cs_peer_assistant',name:peerName+' 的助理',joined_at:'assistant-original'},
    {kind:'agent',id:'local-agent',name:'Old peer',joined_at:'local-original'},
    ...(process.argv[2]==='roster'?[{kind:'agent',id:'unselected-local',name:'Unselected local',joined_at:'unselected-original'}]:[]),
  ]};
  if(channel==='hub-account.status') return {ok:true,status:{signed_in:true,release_enabled:true,account_id:'profile-self',hub_reachable:true}};
  if(channel==='hub-account.devices') return {ok:true,devices:[]};
  if(channel==='hub-account.consents') return {ok:true,consents:[]};
  if(channel==='hub-account.me') {
    meReads++;
    const snapshot=name;
    if(holdMe) {holdMe=false;enteredMe();await new Promise(r=>{releaseMe=r;});}
    return {ok:true,me:{account:{account_id:'profile-self',community_profile:{display_name:snapshot}}}};
  }
  if(channel==='hub-account.update_profile') {
    requests.push({channel,payload});
    if(!chipRace && requests.length===1) return {ok:false,code:'HUB_NETWORK_ERROR',error:'synthetic failure'};
    await new Promise(r=>{release=r;});
    name=payload.display_name.trim();
    peerName='New peer';
    event.sender.send('hub-account:state-changed',{reason:'profile_updated'});
    return {ok:true,me:{account:{account_id:'profile-self',community_profile:{display_name:name}}}};
  }
  return {ok:false,error:'Unavailable in isolated T6 page fixture'};
});
app.whenReady().then(async()=>{
 let window; const outcome={checks:[],requests};
 try {
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>cb({cancel:true}));
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,preload:path.join(root,'src/main/preload.js')}});
  await window.loadFile(path.join(root,'src/renderer/index.html'));
  await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Renderer boot timeout')),10000);timer.unref();})]);
  if(chipRace) {
    await oldMeStarted;
    await window.webContents.executeJavaScript(`(async()=>{
      // chip race 场景同样是「等到出现才继续」：2s 的预算在满载 runner 上等不到
      // 详情/昵称渲染完成，会把真实失败记成 chip race wait timeout。提到有界的 10s。
      window.t6Wait=async(fn)=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error('chip race wait timeout');};
      await loadRendererFeature('settings');
      setView('settings',null,{settingsTab:'account'});
      await t6Wait(()=>document.getElementById('hub-account-edit-name'));
      document.getElementById('hub-account-edit-name').click();
      const dialog=document.querySelector('.ui-form-modal');
      dialog.querySelector('input').value='New name';
      dialog.querySelector('[data-ui-form-submit]').click();
    })()`);
    if(requests.length!==1) throw new Error('Expected one profile save');
    release();
    await window.webContents.executeJavaScript(`t6Wait(()=>document.querySelector('#hub-account-chip [data-chip-role="name"]')?.textContent==='New name')`);
    releaseMe();
    outcome.checks=await window.webContents.executeJavaScript(`(async()=>{
      // Drain the released IPC response and its production promise callbacks.
      await new Promise(r=>setTimeout(r,100));
      const checks=[];
      const assert=(label,ok)=>{if(!ok)throw new Error(label);checks.push(label);};
      const visibleName=()=>document.querySelector('#hub-account-chip [data-chip-role="name"]')?.textContent;
      assert('late old GET cannot overwrite visible chip',visibleName()==='New name');
      document.getElementById('hub-account-chip').click();
      await t6Wait(()=>document.getElementById('hub-account-chip-menu').textContent.includes('New name'));
      assert('subsequent menu reads keep new cached nickname',!document.getElementById('hub-account-chip-menu').textContent.includes('Original'));
      window.dispatchEvent(new Event('i18n-change'));
      await t6Wait(()=>visibleName()==='New name');
      assert('subsequent chip render keeps new cached nickname',visibleName()==='New name');
      const status=await window.cogseed.invoke('hub-account.status',{});
      assert('same signed-in account throughout',status.status.signed_in && status.status.account_id==='profile-self');
      return checks;
    })()`);
    const readsBefore=meReads;
    await window.webContents.executeJavaScript(`(async()=>{window.dispatchEvent(new Event('i18n-change'));await new Promise(r=>requestAnimationFrame(r));})()`);
    if(meReads!==readsBefore) throw new Error('Cache read unexpectedly refetched profile');
    outcome.checks.push('cache reuse without another GET');
    return;
  }
  if(process.argv[2]==='roster') {
    await window.webContents.executeJavaScript(`(async()=>{
      window.t6Checks=[];
      window.t6Assert=(label,ok)=>{if(!ok) throw new Error(label);t6Checks.push(label);};
      window.t6Wait=async(fn,label)=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error('T6 roster wait timeout: '+(label||'')+JSON.stringify({view:currentView,cid:currentCid,members:composerMembers.getMembers('conversation')}));};
      await contacts.refresh();await setLang('zh');
      conversations=[{conversation_id:'nickname-chat',title:'Nickname roster'}];
      setView('conversation','nickname-chat');
      await t6Wait(()=>composerMembers.getMembers('conversation').length===4,'initial roster');
      await t6Wait(()=>document.querySelector('#chat-history [data-msg-id="old-question"]'),'history bubble');
      window.t6History=document.querySelector('#chat-history [data-msg-id="old-question"]').textContent;
      t6Assert('normal conversation renders old member bar',document.getElementById('chat-recipient-name').textContent==='Old peer');
      document.getElementById('chat-recipient-chip').click();
      await t6Wait(()=>document.querySelector('#agent-picker [data-composer-member="unselected-local"]'),'initial selection');
      document.querySelector('#agent-picker [data-composer-member="unselected-local"]').click();
      document.querySelector('#agent-picker [data-composer-members-done]').click();
      t6Assert('user deselects a roster actor through the real picker',composerMembers.getMembers('conversation').length===3);
      const input=document.getElementById('chat-input');
      input.value='@Old peer draft';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      composerMembers.setMentionSidecar('conversation',[{id:'cs_peer',name:'Old peer',kind:'contact',start:0,text:'@Old peer '}]);
      syncChatRichComposerFromTextarea('chat-input');
      window.t6Draft=input.value;
      window.t6Tokens=JSON.stringify(composerMembers.mentionSidecarSnapshot('conversation'));
      window.t6Members=composerMembers.getMembers('conversation');
      window.t6NewChat=JSON.stringify(composerMembers.getMembers('new-chat'));
    })()`);
    peerName='New <>& peer';
    outcome.checks=await window.webContents.executeJavaScript(`(async()=>{
      await contacts.refresh();
      await t6Wait(()=>_groupMembersCache.get('nickname-chat')?.[0]?.name==='New <>& peer');
      const chip=document.getElementById('chat-recipient-chip');
      t6Assert('visible member bar updates the existing stable actor',document.getElementById('chat-recipient-name').textContent==='New <>& peer');
      t6Assert('visible member tooltip updates visitor and assistant, retains local name',chip.title===t('composer.members.entry_title',{names:'New <>& peer、New <>& peer 的助理、Old peer',n:3}));
      t6Assert('member bar escapes nickname text',!document.getElementById('chat-recipient-name').children.length);
      const members=composerMembers.getMembers('conversation');
      t6Assert('selection identities kinds and order survive',JSON.stringify(members.map(m=>[m.kind,m.id]))===JSON.stringify(t6Members.map(m=>[m.kind,m.id])));
      t6Assert('no contact is inserted as a local agent',members.every(m=>m.id!=='cs_peer') && members.find(m=>m.id==='local-agent').name==='Old peer');
      const input=document.getElementById('chat-input');
      t6Assert('rename preserves draft and structured token snapshot',input.value===t6Draft && JSON.stringify(composerMembers.mentionSidecarSnapshot('conversation'))===t6Tokens);
      t6Assert('other composer direction unchanged',JSON.stringify(composerMembers.getMembers('new-chat'))===t6NewChat);
      t6Assert('visible historical message unchanged',document.querySelector('#chat-history [data-msg-id="old-question"]').textContent===t6History && t6History.includes('Historical question'));
      chip.click();
      await t6Wait(()=>document.getElementById('agent-picker').style.display!=='none' && document.querySelector('#agent-picker [data-composer-member="a2a_cs_peer_assistant"]'),'member picker');
      for(const [id,label] of [['a2a_cs_peer','New <>& peer'],['a2a_cs_peer_assistant','New <>& peer 的助理'],['cs_peer','New <>& peer']]) {
        const row=document.querySelector('#agent-picker [data-composer-member="'+id+'"]');
        t6Assert('visible member picker name '+id,!!row && row.textContent.includes(label) && !row.textContent.includes('Old peer'));
      }
      document.getElementById('agent-picker-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await t6Wait(()=>document.getElementById('agent-picker').style.display==='none','member picker cancel');
      t6Assert('picker cancel preserves selection draft and tokens',JSON.stringify(composerMembers.getMembers('conversation'))===JSON.stringify(members) && input.value===t6Draft && JSON.stringify(composerMembers.mentionSidecarSnapshot('conversation'))===t6Tokens);
      // Exercise the real rich-editor @ entry and candidate rows, then cancel.
      const editor=getChatRichComposerEditor(input);
      editor.focus();
      const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);
      window.getSelection().removeAllRanges();window.getSelection().addRange(range);
      editor.dispatchEvent(new KeyboardEvent('keydown',{key:'@',bubbles:true}));
      await t6Wait(()=>document.getElementById('agent-picker').style.display!=='none' && document.querySelector('#agent-picker [data-composer-member="cs_peer"]'),'@ picker');
      t6Assert('real @ candidate shows refreshed contact by stable account id',document.querySelector('#agent-picker [data-composer-member="cs_peer"]').textContent.includes('New <>& peer'));
      document.getElementById('agent-picker-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await t6Wait(()=>document.getElementById('agent-picker').style.display==='none','@ picker cancel');
      t6Assert('@ cancel preserves draft and contact token identity',input.value===t6Draft && JSON.stringify(composerMembers.mentionSidecarSnapshot('conversation'))===t6Tokens);
      return t6Checks;
    })()`);
    return;
  }
  if(process.argv[2]==='generation') {
    await window.webContents.executeJavaScript(`(async()=>{
      await loadRendererFeature('settings');
      setView('settings',null,{settingsTab:'account'});
      for(let i=0;i<400 && !document.getElementById('hub-account-edit-name');i++) await new Promise(r=>setTimeout(r,25));
      if(!document.getElementById('hub-account-edit-name')) throw new Error('Settings did not load');
    })()`);
    const started=new Promise(r=>{enteredMe=r;});
    holdMe=true;
    await window.webContents.executeJavaScript('window.t6PendingRender=initHubAccountSettings(); undefined');
    await started;
    await window.webContents.executeJavaScript(`(async()=>{
      window.t6Trigger=document.getElementById('hub-account-edit-name');
      t6Trigger.focus();t6Trigger.click();
      const dialog=document.querySelector('.ui-form-modal');
      if(!dialog) throw new Error('Nickname dialog missing');
      dialog.querySelector('input').value='Unsaved generation draft';
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await Promise.resolve();
      if(document.querySelector('.ui-form-modal')) throw new Error('Escape did not close');
    })()`);
    releaseMe();
    outcome.checks=await window.webContents.executeJavaScript(`(async()=>{
      await t6PendingRender;
      if(document.getElementById('hub-account-edit-name')!==t6Trigger || !t6Trigger.isConnected) throw new Error('Late refresh replaced the return-focus trigger');
      if(document.activeElement!==t6Trigger) throw new Error('Late refresh lost Escape focus');
      if(document.querySelector('.hub-account-name').textContent!=='Original') throw new Error('Cancel changed profile');
      return ['late refresh cannot replace trigger after cancel','Escape focus survives late refresh','cancel leaves profile unchanged'];
    })()`);
    if(requests.length) throw new Error('Generation test unexpectedly wrote profile');
    return;
  }
  outcome.checks=await window.webContents.executeJavaScript(`(async()=>{
    const checks=[];
    window.t6Assert=(label,ok)=>{if(!ok) throw new Error(label); checks.push(label);};
    // 2s 的预算在满载 runner 上等不到设置页/对话框渲染完成（真实失败会被记成超时），
    // 提到有界的 10s：仍然是「等到出现才继续」，只是允许慢机器。
    window.t6Wait=async(fn)=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error('T6 wait timeout');};
    await loadRendererFeature('settings');
    setView('settings',null,{settingsTab:'account'});
    await t6Wait(()=>document.getElementById('hub-account-edit-name'));
    window.t6Dialog=()=>document.querySelector('.ui-form-modal');
    window.t6Open=async()=>{const action=document.getElementById('hub-account-edit-name');action.focus();action.click();await t6Wait(t6Dialog);return t6Dialog();};
    await _chipDisplayName();
    let dialog=await t6Open();
    t6Assert('production page uses shared form/input/modal',!!dialog.querySelector('form.ui-form .ui-field .ui-input'));
    const input=dialog.querySelector('input'); input.value='Unsaved';input.dispatchEvent(new Event('input',{bubbles:true}));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true}));
    t6Assert('IME Escape preserves modal',!!t6Dialog());
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await t6Wait(()=>!t6Dialog());await new Promise(r=>requestAnimationFrame(r));
    t6Assert('Escape returns focus to edit action',document.activeElement.id==='hub-account-edit-name');
    dialog=await t6Open();
    t6Assert('cancel never saved draft',dialog.querySelector('input').value==='Original');
    dialog.querySelector('input').value='  <>& New  ';dialog.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));
    for(const lang of ['zh','ja','pt','en']) {
      await setLang(lang);
      t6Assert('modal title relocalized '+lang,dialog.querySelector('.ui-modal__title').textContent===t('hub.account.nickname_title'));
      t6Assert('draft retained '+lang,dialog.querySelector('input').value==='  <>& New  ');
      t6Assert('field label relocalized '+lang,dialog.querySelector('label').textContent.includes(t('hub.account.nickname_label')));
    }
    const composing=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true});
    dialog.querySelector('input').dispatchEvent(composing);
    t6Assert('IME submission prevented',composing.defaultPrevented);
    dialog.querySelector('[data-ui-form-submit]').click();
    await t6Wait(()=>!dialog.querySelector('.ui-form-modal__feedback').hidden);
    t6Assert('inline retry error shown',dialog.querySelector('.ui-form-modal__feedback').textContent===t('hub.account.nickname_error'));
    t6Assert('error retains draft',dialog.querySelector('input').value==='  <>& New  ');
    dialog.querySelector('[data-ui-form-submit]').click();
    await t6Wait(()=>dialog.querySelector('form').getAttribute('aria-busy')==='true');
    t6Assert('busy disables input and submit',dialog.querySelector('input').disabled && dialog.querySelector('[data-ui-form-submit]').disabled);
    dialog.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await setLang('zh');
    t6Assert('busy relocalized without losing draft',dialog.querySelector('[data-ui-form-submit]').textContent.includes(t('hub.account.nickname_saving')) && dialog.querySelector('input').value==='  <>& New  ');
    window.t6Checks=checks;
    return checks;
  })()`);
  if(requests.length!==2) throw new Error('Cancel/IME/duplicate submit mutated profile');
  release();
  const more=await window.webContents.executeJavaScript(`(async()=>{
    await t6Wait(()=>!t6Dialog());
    await t6Wait(()=>document.querySelector('.hub-account-name')?.textContent==='<>& New');
    t6Assert('saved text safely escaped',!document.querySelector('.hub-account-name > *'));
    t6Assert('hub state event invalidates chip nickname cache',await _chipDisplayName()==='<>& New');
    return t6Checks;
  })()`);
  outcome.checks=more;
  for(const width of [1280,390]) {
    window.setSize(width,900);
    const checks=await window.webContents.executeJavaScript(`(async()=>{
      const dialog=await t6Open();await new Promise(r=>requestAnimationFrame(r));
      const rect=dialog.getBoundingClientRect();
      t6Assert('modal fits ${width}px',rect.left>=0 && rect.right<=innerWidth && dialog.scrollWidth<=dialog.clientWidth+1);
      dialog.querySelector('[data-ui-form-cancel]').click();await t6Wait(()=>!t6Dialog());
      return t6Checks;
    })()`);
    outcome.checks=checks;
  }
 }catch(error){outcome.error=error.message;outcome.stack=error.stack;if(rosterTrace.length){outcome.rosterTrace=rosterTrace;outcome.checks=await window.webContents.executeJavaScript('window.t6Checks||[]').catch(()=>[]);}}
 // Windows 上 `process.stdout.write` 之后紧跟 `app.exit()` 会带走还没排空的管道
 // 写，收尾里的 `fs.rmSync` 也可能因为 Chromium 仍占着 userData 抛 EBUSY/EPERM：
 // 任一发生，测试侧看到的是「空 stdout + 退出码 0」，断言退化成 reading 'length'
 // of undefined。结果因此最先、同步写（`fs.writeSync` 不排在事件循环上），
 // 收尾各自隔离，失败不再吞掉结果。
 finally {const resultLine=JSON.stringify(outcome)+'\n';try{fs.writeSync(1,resultLine);}catch(_){try{process.stdout.write(resultLine);}catch(_){}}try{window?.destroy();}catch(_){}try{fs.rmSync(temp,{recursive:true,force:true});}catch(_){}app.exit(outcome.error?1:0);}
});
