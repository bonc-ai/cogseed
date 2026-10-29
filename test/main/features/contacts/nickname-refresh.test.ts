import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let root:string; let previous:string|undefined;
const uid='nickname-user', cid='nickname-chat', peer='cs_peer';
beforeEach(() => {
  root=fs.mkdtempSync(path.join(os.tmpdir(),'nickname-roster-'));
  previous=process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT=root;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if(previous===undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT=previous;
  fs.rmSync(root,{recursive:true,force:true});
});
async function fixture() {
  const {userChatsDir}=await import('../../../../src/main/paths');
  const {conversationLayout}=await import('../../../../src/main/util/project-layout');
  const layout=conversationLayout(uid,cid);
  fs.mkdirSync(layout.groupDir,{recursive:true});
  fs.writeFileSync(path.join(userChatsDir(uid),'_index.json'),JSON.stringify({items:[{conversation_id:cid},{conversation_id:'missing'}]}));
  const actor={kind:'agent',id:'a2a_'+peer,name:'Old',joined_at:'original',role:'reader',permissions:['read'],custom:{keep:true}};
  fs.writeFileSync(layout.membersFile,JSON.stringify({version:1,commander_spoken:true,actors:[actor,{kind:'agent',id:'same-name',name:'Old',joined_at:'other'}]}));
  const history=layout.messageFile;
  fs.writeFileSync(history,JSON.stringify({id:'historical-message',from:'user',content:'Original question',a2a:{visibility:'cross',recipient_name:'Old',recipient_user:peer}})+'\n');
  return {layout,actor,history};
}
it('authoritative refresh updates stable existing members and candidates, preserving fields and history', async () => {
  const {layout,actor,history}=await fixture(); const original=fs.readFileSync(history,'utf8');
  const {saveHubSession}=await import('../../../../src/main/features/hub_account/tokens');
  const {writeHubAccountState}=await import('../../../../src/main/features/hub_account/state');
  saveHubSession(uid,{session_id:'s',access_token:'synthetic',refresh_token:'r',access_expires_at:new Date(Date.now()+3600000).toISOString(),refresh_expires_at:new Date(Date.now()+7200000).toISOString()});
  writeHubAccountState(uid,{account_id:'self'});
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({ok:true,data:{contacts:[{accountId:peer,name:'New <>&',online:true}]}})})));
  const store=await import('../../../../src/main/features/contacts/store');
  expect(await store.refreshContactsFromHub(uid)).toBe(true);
  expect((await store.listContacts(uid))[0]).toMatchObject({userId:peer,name:'New <>&'});
  const state=await import('../../../../src/main/features/group_chat/state');
  const members=await state.readMembers(uid,cid);
  expect(members.actors[0]).toEqual({...actor,name:'New <>&'});
  expect(members.actors[1].name).toBe('Old');
  expect(members.commander_spoken).toBe(true);
  expect(fs.readFileSync(history,'utf8')).toBe(original);
  expect(fs.existsSync(layout.membersFile)).toBe(true);
});
it('renames both existing actor types including the real outbound assistant, preserving metadata and message snapshots', async () => {
  const {layout}=await fixture();
  const {userContactsFile}=await import('../../../../src/main/paths');
  const {writeJson}=await import('../../../../src/main/storage');
  await writeJson(userContactsFile(uid),{version:1,contacts:[{userId:peer,name:'Old',addedAt:'original'}]});
  const chats=await import('../../../../src/main/features/chats');
  await chats.updateConversation(uid,cid,{a2a:{outgoing:true,peer_user_id:peer,peer_name:'Old',state:'active',exchange_id:cid}});
  const {appendIncomingAnswer,a2aPeerAssistantActorId}=await import('../../../../src/main/features/a2a/outbound');
  // No record override: the production recorder must actually join the assistant.
  expect(await appendIncomingAnswer(uid,{
    messageId:'real-answer',fromAccount:peer,toAccount:'self',conversationId:cid,
    kind:'answer',text:'Historical answer',fromName:'Old',createdAt:'2026-10-27T00:00:00.000Z',
  })).toBe(true);
  const before=JSON.parse(fs.readFileSync(layout.membersFile,'utf8'));
  const assistant=before.actors.find((actor:{id:string})=>actor.id===a2aPeerAssistantActorId(peer));
  expect(assistant).toMatchObject({name:'Old 的助理',kind:'agent'});
  Object.assign(assistant,{role:'reader',permissions:['read'],custom:{keep:'assistant'}});
  fs.writeFileSync(layout.membersFile,JSON.stringify(before));
  const history=fs.readFileSync(layout.messageFile,'utf8');
  expect(history).toContain('Historical answer');
  const {saveHubSession}=await import('../../../../src/main/features/hub_account/tokens');
  const {writeHubAccountState}=await import('../../../../src/main/features/hub_account/state');
  saveHubSession(uid,{session_id:'s',access_token:'synthetic',refresh_token:'r',access_expires_at:new Date(Date.now()+3600000).toISOString(),refresh_expires_at:new Date(Date.now()+7200000).toISOString()});
  writeHubAccountState(uid,{account_id:'self'});
  const store=await import('../../../../src/main/features/contacts/store');
  const {setCurrentUiLang}=await import('../../../../src/main/i18n');
  for(const [lang,label] of [['zh','New <>& 的助理'],['en',"New <>&'s assistant"],['ja','New <>& のアシスタント'],['pt','Assistente de New <>&']] as const) {
    setCurrentUiLang(lang);
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({ok:true,data:{contacts:[{accountId:peer,name:'New <>&',online:true}]}})})));
    expect(await store.refreshContactsFromHub(uid)).toBe(true);
    const after=JSON.parse(fs.readFileSync(layout.membersFile,'utf8'));
    expect(after).toEqual({...before,actors:before.actors.map((actor:{id:string})=>({
      ...actor,...(actor.id==='a2a_'+peer?{name:'New <>&'}:actor.id===assistant.id?{name:label}:{}),
    }))});
    expect(fs.readFileSync(layout.messageFile,'utf8')).toBe(history);
  }
});
it('serializes nickname changes with member joins and never creates absent members/rosters', async () => {
  const {layout,actor}=await fixture();
  const state=await import('../../../../src/main/features/group_chat/state');
  await state.addMember(uid,cid,{kind:'agent',id:'a2a_'+peer+'_assistant',name:'Old 的助理'});
  const assistant=(await state.readMembers(uid,cid)).actors[2];
  const storage=await import('../../../../src/main/storage');
  const read=storage.readJson;
  let entered!:()=>void, release!:()=>void, memberReads=0;
  const started=new Promise<void>(r=>{entered=r;});
  const gate=new Promise<void>(r=>{release=r;});
  vi.spyOn(storage,'readJson').mockImplementation(async(...args)=>{
    if(args[0]===layout.membersFile) {
      memberReads+=1;
      const value=await read(...args);
      if(memberReads===1) {entered();await gate;}
      return value;
    }
    return read(...args);
  });
  const rename=state.refreshContactNamesInMembers(uid,[{accountId:peer,name:'New'},{accountId:'absent',name:'Absent'}],()=>true);
  await started;
  const joining=state.addMember(uid,cid,{kind:'agent',id:'joined-concurrently',name:'Local'});
  await new Promise<void>(r=>setImmediate(r));
  expect(memberReads).toBe(1); // The join cannot read stale state outside the lock.
  release(); await Promise.all([rename,joining]);
  const members=await state.readMembers(uid,cid);
  expect(members.actors[0]).toEqual({...actor,name:'New'});
  expect(members.actors[2]).toEqual({...assistant,name:'New 的助理'});
  expect(members.actors.map(a=>a.id)).toEqual(['a2a_'+peer,'same-name',assistant.id,'joined-concurrently']);
  const {conversationLayout}=await import('../../../../src/main/util/project-layout');
  expect(fs.existsSync(conversationLayout(uid,'missing').membersFile)).toBe(false);
});
it('checks the session fence after async roster reads', async () => {
  const {layout}=await fixture();
  const storage=await import('../../../../src/main/storage');
  const actual=storage.readJson;
  let current=true;
  vi.spyOn(storage,'readJson').mockImplementation(async (...args) => {
    const value=await actual(...args);
    if(args[0]===layout.membersFile) current=false;
    return value;
  });
  const state=await import('../../../../src/main/features/group_chat/state');
  await state.refreshContactNamesInMembers(uid,[{accountId:peer,name:'Stale'}],()=>current);
  expect(JSON.parse(fs.readFileSync(layout.membersFile,'utf8')).actors[0].name).toBe('Old');
});

it('revokes a nickname write at atomic storage commit without re-creating a removed roster', async()=>{
  const {layout}=await fixture();
  const storage=await import('../../../../src/main/storage');
  const write=storage.writeJson; let current=true;
  vi.spyOn(storage,'writeJson').mockImplementation(async(...args)=>{
    if(args[0]===layout.membersFile) current=false;
    return write(...args);
  });
  const state=await import('../../../../src/main/features/group_chat/state');
  await expect(state.refreshContactNamesInMembers(uid,[{accountId:peer,name:'Stale'}],()=>current)).rejects.toThrow();
  expect(JSON.parse(fs.readFileSync(layout.membersFile,'utf8')).actors[0].name).toBe('Old');
});
