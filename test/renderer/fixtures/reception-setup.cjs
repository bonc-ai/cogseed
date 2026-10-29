// Real production relay-inbox/preload/shared UI and real owning catalog APIs.
// No service/model/peer startup. Other page data and workspace preview are isolated.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 't4a-setup-'));
const dataRoot = path.join(temporary, 'data');
const userId = 'reception-setup-user';
process.env.COGSEED_WORKSPACE_ROOT = dataRoot;
app.setPath('userData', path.join(temporary, 'electron'));
require('tsx/cjs'); require('tsx/esm/api').register();
// Production main loads paths at startup, before any reception can open.
// Initialize only that machine skeleton; keep both user catalogs cold.
require(path.join(root,'src/main/paths.ts'));
const scenario = process.argv[2];
const tables = Object.fromEntries(['en','zh','ja','pt'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${lang}.json`), 'utf8'))]));
const userRoot = path.join(dataRoot, userId);
function json(file, value) { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, JSON.stringify(value)); }
if (scenario !== 'empty') {
  json(path.join(userRoot,'cloud/spaces/sp_owned.json'), { space_id:'sp_owned', name:'My space', instructions:'private space rules' });
  json(path.join(userRoot,'cloud/spaces/sp_broken.json'), { name:'Missing identity' });
  // A different user's space is never in this user's projection.
  json(path.join(dataRoot,'other-user/cloud/spaces/sp_other.json'), { space_id:'sp_other', name:'Other space' });
  const agent = (id, name, extra = {}) => ({ agent_id:id, name, workflow:'private workflow', ...extra });
  json(path.join(userRoot,'cloud/agents/local-dir/agent.json'), agent('local-stable','Local receiver'));
  json(path.join(userRoot,'cloud/agents/custom-duplicate/agent.json'), agent('shared-stable','Custom duplicate'));
  json(path.join(userRoot,'local/marketplace/agents/market-dir/agent.json'), agent('shared-stable','Market receiver'));
  json(path.join(userRoot,'cloud/agents/legacy/agent.json'), agent('legacy-cli','Legacy CLI',{ runtime:{ kind:'cli', cli:'codex' } }));
  json(path.join(userRoot,'cloud/agents/gateway/agent.json'), agent('gateway','Gateway',{ runtime:{ kind:'p3394-gateway', cli:'codex' } }));
  json(path.join(userRoot,'cloud/agents/disabled/agent.json'), agent('disabled','Disabled'));
  json(path.join(userRoot,'local/marketplace/agents/hub-disabled/agent.json'), agent('hub-disabled','Unavailable',{status:'disabled'}));
  // Hub can only update install metadata. agent.json stays enabled, so the only
  // disqualifying signal is `_install.json`; the owning catalog overlays it and
  // the reception projection must agree or it offers an unusable assistant.
  json(path.join(userRoot,'local/marketplace/agents/install-disabled/agent.json'), agent('install-disabled','Install disabled'));
  json(path.join(userRoot,'local/marketplace/agents/install-disabled/_install.json'), { version:'2.0.0', status:'disabled' });
  // Positive control for the same overlay: unreadable metadata must fall back to
  // agent.json (owning semantics) instead of dropping an otherwise valid agent.
  json(path.join(userRoot,'local/marketplace/agents/install-corrupt/agent.json'), agent('install-corrupt','Install corrupt metadata'));
  fs.writeFileSync(path.join(userRoot,'local/marketplace/agents/install-corrupt/_install.json'), '{not-json');
  // Shipped management-only Agent, seeded exactly as production does: in-process
  // runtime, no `interaction_mode` field — the canonical id alone forces
  // management_only at normalize time, and confirmation refuses it.
  json(path.join(userRoot,'local/marketplace/agents/c045605cb916/agent.json'), agent('c045605cb916','Reimbursement Agent',{ runtime:{ kind:'in_process' } }));
  json(path.join(userRoot,'cloud/config/component-enabled.json'), { version:1, agents:{disabled:false} });
}
function tree(dir, prefix = '') {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const entry of fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file = path.join(dir,entry.name), key = prefix + entry.name, stat = fs.lstatSync(file);
    out[key] = entry.isDirectory() ? ['dir',stat.mtimeMs] : ['file',stat.mtimeMs,fs.readFileSync(file,'base64')];
    if(entry.isDirectory()) Object.assign(out,tree(file,key+'/'));
  }
  return out;
}
const calls = [], languages = [];
let confirms = 0, projectionKeys = [], catalogPhase = false;
let boot;
const ready = new Promise(resolve=>{boot=resolve;});
ipcMain.handle('cogseed.env',()=>({ok:true,platform:process.platform,isDev:true}));
ipcMain.handle('cogseed.ping',()=>({ok:true}));
ipcMain.on('cogseed:bootI18n',event=>{event.returnValue={ok:true,lang:'en',tables};});
ipcMain.handle('cogseed.invoke',async (_event,{channel,payload})=>{
  if(channel==='prefs.getOnboarding') return {ok:true,completed:true};
  if(channel==='user.init') return {ok:true,user_id:userId};
  if(channel==='config.getLanguage') return {ok:true,language:'en'};
  if(channel==='log.record') { if(payload?.module==='boot' && /^boot total/.test(payload.message)) boot(); return {ok:true}; }
  // Boot's unrelated views must not warm/migrate catalogs before measurement.
  // Once measured, ordinary catalog calls remain real so a regression exposes
  // mkdir, metadata cache and legacy CLI migration instead of mocking them away.
  if(channel==='agents.list') { if(!catalogPhase)return {agents:[]}; calls.push(channel); return {agents:await require(path.join(root,'src/main/features/agents.ts')).listAgentSummariesForUser(userId)}; }
  if(channel==='spaces.list') { if(!catalogPhase)return {spaces:[]}; calls.push(channel); return {spaces:await require(path.join(root,'src/main/features/spaces.ts')).listSpaces(userId)}; }
  if(channel==='a2a.reception.setup') {
    calls.push(channel);
    const {invokeHandlers}=require(path.join(root,'src/main/ipc/a2a-reception.ts'));
    const result=await invokeHandlers[channel](payload,{userId});
    projectionKeys=Object.keys(result.agents[0]||{}).sort();
    return {ok:true,...result};
  }
  if(channel==='a2a.reception.pending') return {pending:[{conversationId:'a2a-0123456789abcdef0123',messageId:'q1',fromAccount:'cs_alice',text:'Question'}]};
  if(channel==='a2a.reception.preview') return {preview:{root:payload.workspace || '/server/default',snapshot:'fixture'}};
  if(channel==='a2a.reception.confirm') { confirms++; return {confirmed:false,error:'must not submit'}; }
  return {ok:false,error:'Unavailable in isolated reception setup fixture'};
});
app.whenReady().then(async()=>{
  let window;
  const result={scenario,languages,calls};
  try {
    // The unrelated idle workspace page uses ordinary mutating catalogs.
    // Exclude its lazy script, not any reception/shared/preload code or owner.
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*',
      pathToFileURL(path.join(root,'src/renderer/modules/workspace.js')).href]},(_details,callback)=>callback({cancel:true}));
    window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,preload:path.join(root,'src/main/preload.js')}});
    await window.loadFile(path.join(root,'src/renderer/index.html'));
    await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('boot timeout')),10000))]);
    calls.length=0;
    catalogPhase=true;
    const before=tree(dataRoot);
    result.ui=await window.webContents.executeJavaScript(`(async()=>{
      const wait=async(fn,label)=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout '+label);};
      const modal=()=>document.querySelector('.ui-form-modal');
      const assert=(ok,message)=>{if(!ok)throw new Error(message);};
      await wait(()=>document.querySelector('[data-relay-confirm]'),'pending');
      document.querySelector('[data-relay-confirm]').click();
      await wait(modal,'open');
      await wait(()=>modal().querySelector('[data-a2a-reception-preview]')?.textContent.includes('/server/default'),'preview');
      const assistantOptions=[...modal().querySelector('[data-a2a-reception-input="assistant"]').options];
      const agents=assistantOptions.map(option=>option.value);
      // Labels must be collected too: a duplicate id resolves to the same value
      // either way, so only the label proves which source won the identity.
      const agentLabels=Object.fromEntries(assistantOptions.map(option=>[option.value,option.textContent]));
      const spaces=[...modal().querySelector('[data-a2a-reception-input="space"]').options].map(option=>option.value);
      if(${JSON.stringify(scenario)}==='i18n'){
        const assistant=modal().querySelector('[data-a2a-reception-input="assistant"]');
        assistant.value='local-stable';assistant.dispatchEvent(new Event('change',{bubbles:true}));
        const scope=modal().querySelector('[data-a2a-reception-input="space"]');scope.value='custom';scope.dispatchEvent(new Event('change',{bubbles:true}));
        const input=modal().querySelector('[data-a2a-reception-input="workspace"]');input.value='/draft/preserved';input.dispatchEvent(new Event('input',{bubbles:true}));
        for(const lang of ['zh','ja','pt','en']){
          await setLang(lang);
          const select=modal().querySelector('[data-a2a-reception-input="assistant"]');
          assert(select.querySelector('option[value=""]').textContent===t('a2a.reception.assistant_default'),lang+' default assistant option must translate');
          assert(select.value==='local-stable',lang+' chosen assistant identity retained');
          assert(modal().querySelector('[data-a2a-reception-input="workspace"]').value==='/draft/preserved',lang+' draft retained');
          assert(modal().querySelector('[data-a2a-reception-input="space"]').value==='custom',lang+' custom selection retained');
        }
        // Also inspect the displayed default when it is selected, rather than
        // accepting a translated hidden label alongside a stale visible choice.
        const select=modal().querySelector('[data-a2a-reception-input="assistant"]');select.value='';
        await setLang('zh');
        assert(modal().querySelector('[data-a2a-reception-input="assistant"]').selectedOptions[0].textContent===t('a2a.reception.assistant_default'),'selected default option translates');
      }
      modal().querySelector('[data-ui-form-cancel]').click();await wait(()=>!modal(),'cancel');
      assert(!!document.querySelector('[data-relay-confirm]'),'cancel keeps waiting');
      return {agents,agentLabels,spaces};
    })()`);
    if(scenario==='i18n') languages.push('zh','ja','pt','en');
    // Cover the owning workspace_meta debounce (300ms): cancel must not leave
    // a queued cache write that only appears after the immediate comparison.
    await new Promise(resolve=>setTimeout(resolve,450));
    const after=tree(dataRoot);
    result.changedPaths=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>!key.startsWith('logs/') && key!=='logs' && JSON.stringify(before[key])!==JSON.stringify(after[key]));
    result.noWrites=result.changedPaths.length===0;
    result.agents=result.ui.agents;result.agentLabels=result.ui.agentLabels;result.spaces=result.ui.spaces;
  }catch(error){result.error=error.message;result.stack=error.stack;}
  finally{result.confirms=confirms;result.projectionKeys=projectionKeys;window?.destroy();
    // win32 上 Chromium 仍持有 userData/缓存句柄时递归删除会 EPERM。这一步在
    // finally 里、且在结果行之前：一旦抛出，测试侧只会读到空 stdout（
    // `JSON.parse(undefined)`），真正的用例结论反而丢了。清理失败不是用例信号，
    // 把临时树留给 OS 回收，结果行必须照常落盘。
    try{fs.rmSync(temporary,{recursive:true,force:true});}catch{}
    // 结果行带哨兵前缀：Electron 在 win32 上可能额外往 stdout 写自己的行，
    // 「取最后一行」会把噪音当结论（CI 里表现为
    // `Unexpected number in JSON at position 1`——解析到了别的行）。
    process.stdout.write('@@RECEPTION_SETUP@@'+JSON.stringify(result)+'\n');app.exit(result.error?1:0);}
});
