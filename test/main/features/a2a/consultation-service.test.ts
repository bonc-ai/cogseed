import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const UID = 'consult-owner', PEER = 'cs_peer', CID = 'a2a-0123456789abcdef0123';
let root: string, previous: string | undefined;
let scope: any, turnId: string;
let send: any;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consult-service-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  vi.doMock('../../../../src/main/features/users', () => ({ getActiveUserId: () => UID }));
  send = vi.fn(async () => ({ ok: true, messageId: 'relay-ack' }));
  vi.doMock('../../../../src/main/features/a2a/relay-client', () => ({ sendRelayMessageDetailed: send }));
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(UID, { session_id: 'normal', access_token: 'fixture', refresh_token: 'fixture', access_expires_at: new Date(Date.now()+3600000).toISOString(), refresh_expires_at: new Date(Date.now()+7200000).toISOString() });
  writeHubAccountState(UID, { account_id: UID });
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(UID, { conversationId: CID, title: 'Visit' });
  await chats.updateConversation(UID, CID, { a2a: { role: 'receiver', state: 'active', exchange_id: CID, peer_user_id: PEER, workspace: root } });
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(UID), { version: 1, contacts: [{ userId: PEER, addedAt: new Date().toISOString() }] });
  const conv = await chats.getConversation(UID, CID);
  const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
  await ledger.journalReception(UID, { messageId: 'question-1', conversationId: CID, peerUserId: PEER, text: 'Public question', generation: conv!._cogseed_result_generation!, toAccount: UID, createdAt: new Date().toISOString() });
  const [entry] = await ledger.readReceptionLedger(UID);
  await ledger.updateReceptionEntry(UID, entry, row => ({ ...row, admission: 'committed', status: 'running', stage: 'dispatching' }));
  scope = { conversationId: CID, sourceActorId: 'a2a_' + PEER, root };
  turnId = 'turn-a2a-in-' + createHash('sha256').update('question-1').digest('hex').slice(0,20);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../../../../src/main/features/users'); vi.doUnmock('../../../../src/main/features/a2a/relay-client');
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const service = () => import('../../../../src/main/features/a2a/consultation-service');
async function create() { return (await service()).requestConsultation(UID, { scope, turnId, question: 'Private reasoning', proposedReply: 'Approved offer' }); }
async function row(id: string) { return (await (await import('../../../../src/main/features/a2a/consultations')).listConsultations(UID)).find(x=>x.id===id)!; }

it('serializes store creation so simultaneous private requests are not lost', async () => {
  const store = await import('../../../../src/main/features/a2a/consultations');
  const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => store.createConsultation(UID, { conversationId: CID, peerUserId: PEER, question: 'q'+i, proposedReply: 'p' })));
  expect((await store.listConsultations(UID)).map(x=>x.id).sort()).toEqual(rows.map(x=>x.id).sort());
});
it('creates one host-bound private request per reception turn and emits metadata only', async () => {
  const s = await service(); const notices: any[] = [];
  const off = s.onConsultationChanged(n => notices.push(n));
  const results = await Promise.all([create(), create()]); off();
  expect(results[0].id).toBe(results[1].id); expect(send).not.toHaveBeenCalled();
  expect(results[0]).toMatchObject({ state: 'pending', peerUserId: PEER, sourceMessageId: 'question-1' });
  expect(notices).toEqual([{ userId: UID, conversationId: CID }]);
});
it.each(['source', 'root', 'turn', 'contact', 'state'])('rejects a stale or spoofed %s scope', async kind => {
  if (kind === 'source') scope.sourceActorId = 'a2a_attacker';
  if (kind === 'root') scope.root = path.dirname(root);
  if (kind === 'turn') turnId = 'unrelated-turn';
  const chats = await import('../../../../src/main/features/chats');
  if (kind === 'state') await chats.updateConversation(UID, CID, { a2a: { role:'receiver', state:'waiting', peer_user_id:PEER, exchange_id:CID, workspace:root } });
  if (kind === 'contact') {
    const { writeJson } = await import('../../../../src/main/storage'); const { userContactsFile } = await import('../../../../src/main/paths');
    await writeJson(userContactsFile(UID), { version:1, contacts:[] });
  }
  await expect(create()).rejects.toMatchObject({ code: 'E_CONSULTATION_SCOPE' }); expect(send).not.toHaveBeenCalled();
});
it.each(['approve', 'revise'] as const)('%s sends only chosen wording once under concurrent clicks', async decision => {
  const c = await create(), s = await service();
  const text = decision === 'revise' ? 'Owner final' : undefined;
  const results = await Promise.all([s.answerAndDeliverConsultation(UID,c.id,decision,text), s.answerAndDeliverConsultation(UID,c.id,decision,text)]);
  expect(results[0].delivery?.state).toBe('sent'); expect(results[1].delivery?.state).toBe('sent');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toEqual({ to: PEER, conversationId:CID, kind:'answer', text: text ?? 'Approved offer', requestId: expect.any(String), isCurrent: expect.any(Function) });
  expect(JSON.stringify(send.mock.calls)).not.toContain('Private reasoning');
});
it('declines without any peer payload and rejects invalid decisions/revisions', async () => {
  const c = await create(), s = await service();
  await expect(s.answerAndDeliverConsultation(UID,c.id,'bad' as any)).rejects.toMatchObject({code:'E_CONSULTATION_DECISION'});
  await expect(s.answerAndDeliverConsultation(UID,c.id,'revise',' ')).rejects.toThrow();
  expect((await row(c.id)).state).toBe('pending');
  expect(await s.answerAndDeliverConsultation(UID,c.id,'decline')).toMatchObject({state:'declined'});
  expect(send).not.toHaveBeenCalled();
});
it('keeps explicit rejection retryable but never resends an ambiguous transport outcome', async () => {
  const c = await create(), s = await service(); send.mockResolvedValueOnce({ok:false,code:'NOT_CONTACT'});
  await expect(s.answerAndDeliverConsultation(UID,c.id,'approve')).rejects.toMatchObject({code:'E_CONSULTATION_DELIVERY_FAILED'});
  expect((await row(c.id)).delivery?.state).toBe('failed');
  send.mockResolvedValueOnce({ok:false,code:'HUB_UNREACHABLE'});
  await expect(s.answerAndDeliverConsultation(UID,c.id,'approve')).rejects.toMatchObject({code:'E_CONSULTATION_DELIVERY_UNCERTAIN'});
  await expect(s.answerAndDeliverConsultation(UID,c.id,'approve')).rejects.toMatchObject({code:'E_CONSULTATION_DELIVERY_UNCERTAIN'});
  expect(send).toHaveBeenCalledTimes(2);
});
it.each([true, false])('real relay preserves delivery state when sign-out races the response (ack=%s)', async acknowledged => {
  vi.doUnmock('../../../../src/main/features/a2a/relay-client');
  const { clearHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const network = vi.fn(async () => {
    clearHubSession(UID);
    if (!acknowledged) throw new TypeError('response connection closed');
    return { ok: true, json: async () => ({ ok: true, data: { messageId: 'signed-out-ack' } }) };
  });
  vi.stubGlobal('fetch', network);
  const c = await create(), s = await service();
  if (acknowledged) {
    await expect(s.answerAndDeliverConsultation(UID, c.id, 'approve')).resolves.toMatchObject({ delivery: { state: 'sent', relayMessageId: 'signed-out-ack' } });
  } else {
    await expect(s.answerAndDeliverConsultation(UID, c.id, 'approve')).rejects.toMatchObject({ code: 'E_CONSULTATION_DELIVERY_UNCERTAIN' });
    expect((await row(c.id)).delivery?.state).toBe('uncertain');
    await expect(s.answerAndDeliverConsultation(UID, c.id, 'approve')).rejects.toMatchObject({ code: 'E_CONSULTATION_DELIVERY_UNCERTAIN' });
  }
  expect(network).toHaveBeenCalledTimes(1);
});
it('recovers prepared delivery but quarantines interrupted sending and never replays acknowledged sends', async () => {
  const c = await create(), s = await service();
  await expect(s.answerAndDeliverConsultation(UID,c.id,'approve',undefined,{afterStage:async stage=>{ if(stage==='prepared') throw new Error('crash'); }})).rejects.toThrow('crash');
  expect(send).not.toHaveBeenCalled(); await s.recoverConsultations(UID); expect(send).toHaveBeenCalledTimes(1);
  await s.recoverConsultations(UID); expect(send).toHaveBeenCalledTimes(1);
});
it('does not replay an interrupted send after restart', async () => {
  const c = await create(), s = await service();
  await expect(s.answerAndDeliverConsultation(UID,c.id,'approve',undefined,{afterStage:async stage=>{ if(stage==='sending') throw new Error('crash'); }})).rejects.toThrow('crash');
  await s.recoverConsultations(UID); expect(send).not.toHaveBeenCalled(); expect((await row(c.id)).delivery?.state).toBe('uncertain');
});
it('poll recovery delivers one five-minute nudge, preserving private question and proposal', async () => {
  const c = await create(), s = await service(), now = Date.parse(c.createdAt)+300001;
  await s.recoverConsultations(UID,{now:now-2}); expect(send).not.toHaveBeenCalled();
  await Promise.all([s.recoverConsultations(UID,{now}),s.recoverConsultations(UID,{now})]);
  expect(send).toHaveBeenCalledTimes(1); expect((await row(c.id)).nudgedAt).toBeTruthy();
  expect(JSON.stringify(send.mock.calls)).not.toMatch(/Private reasoning|Approved offer/);
  await s.recoverConsultations(UID,{now:now+300000}); expect(send).toHaveBeenCalledTimes(1);
});
it('revalidates identity at delivery and never redirects an old receipt to the new peer', async () => {
  const c = await create(), s = await service();
  const chats = await import('../../../../src/main/features/chats');
  await chats.updateConversation(UID,CID,{a2a:{role:'receiver',state:'active',peer_user_id:'cs_other',exchange_id:CID,workspace:root}});
  await expect(s.answerAndDeliverConsultation(UID,c.id,'approve')).rejects.toMatchObject({code:'E_CONSULTATION_SCOPE'});
  expect(send).not.toHaveBeenCalled();
});
it('structured tool has no peer field and terminates the reception turn', async () => {
  const { createA2AConsultationTools } = await import('../../../../src/main/model/core-agent/consultation-tools');
  const [tool] = createA2AConsultationTools({userId:UID,scope,turnId});
  expect((tool.inputSchema as any).additionalProperties).toBe(false);
  const result = await tool.execute({question:'Private reasoning',proposedReply:'Approved offer'},{} as any);
  expect(result).toMatchObject({endTurn:true}); expect(result.isError).not.toBe(true); expect(JSON.parse(result.content as string).consultationId).toMatch(/^acons-/); expect(send).not.toHaveBeenCalled();
});

it.each([false,true])('suppresses exact reception model final even when owner already declined=%s', async alreadyDeclined => {
  const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
  const [entry] = await ledger.readReceptionLedger(UID);
  await ledger.updateReceptionEntry(UID,entry,row=>({...row,status:'pending',stage:'admitted'}));
  const { runReception, recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
  let listener: any; const relay = vi.fn(async()=>({messageId:"unexpected-send"}));
  const result = await runReception(UID,{messageId:entry.messageId,fromAccount:PEER,toAccount:UID,createdAt:entry.createdAt,conversationId:CID,text:entry.text},{
    send:relay,addMember:async()=>true,timeoutMs:100,
    subscribe:async(_uid,_cid,fn)=>{listener=fn;return()=>{};},
    enqueue:async input=>{
      const c = await create();
      if (alreadyDeclined) await (await service()).answerAndDeliverConsultation(UID,c.id,'decline');
      listener({type:'message',turn_end:true,turn_id:input.dispatchTurnId,msg:{from:'commander',to:['user'],text:'PRIVATE PROPOSAL MUST NOT LEAK'}});
    },
  });
  expect(result).toEqual({status:'awaiting_owner'}); expect(relay).not.toHaveBeenCalled();
  await recoverClaimedReceptions(UID,{send:relay});
  expect((await ledger.readReceptionLedger(UID))[0].status).not.toBe('uncertain');
  expect(relay).not.toHaveBeenCalled();
});
it('existing relay pump recovers overdue consultations without another model turn', async () => {
  const c = await create();
  const store = await import('../../../../src/main/features/a2a/consultations');
  await store.updateConsultation(UID,c.id,row=>({...row,createdAt:new Date(Date.now()-300001).toISOString()}));
  const { pumpOnce } = await import('../../../../src/main/features/a2a/relay-pump');
  await pumpOnce({activeUserId:()=>UID,poll:async()=>[]});
  expect(send).toHaveBeenCalledTimes(1); expect((await row(c.id)).nudgedAt).toBeTruthy();
});
it('owner IPC creation derives peer and dispatch from host state', async () => {
  const s = await service();
  const c = await s.requestConsultationForConversation(UID,{conversationId:CID,question:'Private reasoning',proposedReply:'Approved offer'});
  expect(c).toMatchObject({peerUserId:PEER,turnId,sourceMessageId:'question-1'});
  expect(send).not.toHaveBeenCalled();
});
it('rejects owner IPC creation without an active dispatch rather than guessing a peer', async () => {
  const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
  const [entry] = await ledger.readReceptionLedger(UID);
  await ledger.updateReceptionEntry(UID,entry,row=>({...row,status:'answered',stage:'sent'}));
  await expect((await service()).requestConsultationForConversation(UID,{conversationId:CID,question:'q',proposedReply:'p'})).rejects.toMatchObject({code:'E_CONSULTATION_SCOPE'});
});
it('retains ambiguous acknowledgement after relay success followed by a crash', async () => {
  const c = await create(), s = await service();
  await expect(s.answerAndDeliverConsultation(UID,c.id,'approve',undefined,{afterStage:async stage=>{if(stage==='relay') throw new Error('crash-after-accept');}})).rejects.toThrow('crash-after-accept');
  expect(send).toHaveBeenCalledTimes(1);
  await s.recoverConsultations(UID); expect(send).toHaveBeenCalledTimes(1);
  expect((await row(c.id)).delivery?.state).toBe('uncertain');
});
it('serializes owner decision against a due nudge, with no nudge after a decided reply', async () => {
  const c = await create(), s = await service();
  const now=Date.parse(c.createdAt)+300001;
  await Promise.all([s.answerAndDeliverConsultation(UID,c.id,'approve'),s.recoverConsultations(UID,{now})]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1].text).toBe('Approved offer');
});
it('does not send after identity changes between preparing and delivery', async () => {
  const c = await create(), s = await service();
  await expect(s.answerAndDeliverConsultation(UID,c.id,'approve',undefined,{afterStage:async stage=>{
    if(stage==='prepared') {
      const {writeHubAccountState} = await import('../../../../src/main/features/hub_account/state');
      writeHubAccountState(UID,{account_id:'other-login'});
    }
  }})).rejects.toMatchObject({code:'E_CONSULTATION_SCOPE'});
  await s.recoverConsultations(UID); expect(send).not.toHaveBeenCalled();
});
it('reception guidance requests a structured private decision instead of merely promising later confirmation', () => {
  const prompt = fs.readFileSync(path.resolve('src/main/prompts/a2a_reception.md'),'utf8');
  expect(prompt).toContain('use the structured private-consultation entry');
  expect(prompt).not.toContain("say plainly that it needs the user's own confirmation");
});
it.each(['invalid_proposal', 'unreadable_store'])('suppresses partial private model output when creation fails before a row exists: %s', async failure => {
  const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
  const [entry] = await ledger.readReceptionLedger(UID);
  await ledger.updateReceptionEntry(UID,entry,row=>({...row,status:'pending',stage:'admitted'}));
  const { runReception, recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
  let listener: any;
  const relay = vi.fn(async()=>({messageId:'private-leak'}));
  const result = await runReception(UID,{messageId:entry.messageId,fromAccount:PEER,toAccount:UID,createdAt:entry.createdAt,conversationId:CID,text:entry.text},{
    send:relay,addMember:async()=>true,timeoutMs:100,
    subscribe:async(_uid,_cid,fn)=>{listener=fn;return()=>{};},
    enqueue:async input=>{
      const {createA2AConsultationTools} = await import('../../../../src/main/model/core-agent/consultation-tools');
      const [tool] = createA2AConsultationTools({userId:UID,scope,turnId});
      if (failure === 'unreadable_store') {
        const {userA2AConsultationsFile} = await import('../../../../src/main/paths');
        const file = userA2AConsultationsFile(UID); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'{PRIVATE broken');
      }
      expect(await tool.execute({question:'Private question',proposedReply:failure === 'invalid_proposal' ? '' : 'private proposal'},{} as any)).toMatchObject({isError:true,endTurn:true});
      listener({type:'message',turn_end:true,turn_id:input.dispatchTurnId,msg:{from:'commander',to:['user'],text:'PARTIAL PRIVATE RESPONSE'}});
    },
  });
  expect(relay).not.toHaveBeenCalled(); expect(result.status).toBe('awaiting_owner');
  const store = await import('../../../../src/main/features/a2a/consultations');
  if (failure === 'unreadable_store') await expect(store.listConsultations(UID)).rejects.toThrow('preserved for recovery');
  else {
    const [failed] = await store.listConsultations(UID);
    expect(failed).toMatchObject({ state: 'pending', creationError: 'INVALID_INPUT', proposedReply: '' });
    await expect((await service()).answerAndDeliverConsultation(UID, failed.id, 'approve')).rejects.toMatchObject({ code: 'E_CONSULTATION_DECISION' });
    await expect((await service()).answerAndDeliverConsultation(UID, failed.id, 'revise', 'Owner supplied reply')).resolves.toMatchObject({ delivery: { state: 'sent' } });
    expect(send.mock.calls[0][1].text).toBe('Owner supplied reply');
  }
  expect((await ledger.readReceptionLedger(UID))[0].consultationRequested).toBe(true);
  await recoverClaimedReceptions(UID,{send:relay}); expect(relay).not.toHaveBeenCalled();
});

it('recovers a journaled private creation after restart without redispatching the model or resetting its clock', async () => {
  const store = await import('../../../../src/main/features/a2a/consultations');
  vi.spyOn(store, 'createConsultation').mockRejectedValueOnce(new Error('simulated card write interruption'));
  await expect(create()).rejects.toThrow('simulated card write interruption');
  const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
  const [entry] = await ledger.readReceptionLedger(UID);
  expect(entry).toMatchObject({ consultationRequested: true, consultationIntent: {
    question: 'Private reasoning', proposedReply: 'Approved offer', workspace: root, createdAt: expect.any(String),
  } });
  const createdAt = (entry as any).consultationIntent.createdAt;
  vi.restoreAllMocks();
  vi.resetModules();
  const restarted = await service();
  await Promise.all([restarted.recoverConsultations(UID, { now: Date.parse(createdAt) + 1 }), restarted.recoverConsultations(UID, { now: Date.parse(createdAt) + 1 })]);
  const rows = await (await import('../../../../src/main/features/a2a/consultations')).listConsultations(UID);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ createdAt, question: 'Private reasoning', proposedReply: 'Approved offer', sourceMessageId: 'question-1' });
  const run = vi.fn();
  await (await import('../../../../src/main/features/a2a/reception-run')).recoverClaimedReceptions(UID, { run });
  expect(run).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  await restarted.recoverConsultations(UID, { now: Date.parse(createdAt) + 300001 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1].text).not.toMatch(/Private reasoning|Approved offer/);
});

it('materializes a legacy orphan as an owner-revisable failure instead of redispatching or inventing a proposal', async () => {
  const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
  const [entry] = await ledger.readReceptionLedger(UID);
  const marked = await ledger.updateReceptionEntry(UID, entry, row => ({ ...row, consultationRequested: true }));
  const s = await service();
  await s.recoverConsultations(UID, { now: Date.parse(marked!.at) + 1 });
  const [failed] = await (await import('../../../../src/main/features/a2a/consultations')).listConsultations(UID);
  expect(failed).toMatchObject({ state: 'pending', question: entry.text, proposedReply: '', creationError: 'INTENT_UNAVAILABLE', createdAt: marked!.at });
  await expect(s.answerAndDeliverConsultation(UID, failed.id, 'approve')).rejects.toMatchObject({ code: 'E_CONSULTATION_DECISION' });
  await expect(s.answerAndDeliverConsultation(UID, failed.id, 'decline')).resolves.toMatchObject({ state: 'declined' });
  expect(send).not.toHaveBeenCalled();
});

it('recovers a private creation once the unreadable card store is repaired, preserving its original time', async () => {
  const { userA2AConsultationsFile } = await import('../../../../src/main/paths');
  const file = userA2AConsultationsFile(UID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{PRIVATE damaged');
  await expect(create()).rejects.toThrow('preserved for recovery');
  const [entry] = await (await import('../../../../src/main/features/a2a/reception-ledger')).readReceptionLedger(UID);
  expect((entry as any).consultationIntent).toBeDefined();
  fs.renameSync(file, file + '.preserved');
  vi.resetModules();
  await (await service()).recoverConsultations(UID, { now: Date.parse((entry as any).consultationIntent.createdAt) + 1 });
  const rows = await (await import('../../../../src/main/features/a2a/consultations')).listConsultations(UID);
  expect(rows).toHaveLength(1);
  expect(rows[0].createdAt).toBe((entry as any).consultationIntent.createdAt);
  expect(fs.readFileSync(file + '.preserved', 'utf8')).toBe('{PRIVATE damaged');
  expect(send).not.toHaveBeenCalled();
});

it('retries definitely rejected nudges after durable backoff, including restart and concurrent polls', async () => {
  const c = await create(), s = await service(), now = Date.parse(c.createdAt) + 300001;
  send.mockResolvedValueOnce({ ok: false, code: 'HUB_429' });
  await s.recoverConsultations(UID, { now });
  expect((await row(c.id)).nudgeDelivery).toMatchObject({ state: 'failed', attempts: 1, lastAttemptAt: new Date(now).toISOString(), nextAttemptAt: new Date(now + 60000).toISOString() });
  vi.resetModules();
  const restarted = await service();
  await restarted.recoverConsultations(UID, { now: now + 59999 });
  expect(send).toHaveBeenCalledTimes(1);
  await Promise.all([restarted.recoverConsultations(UID, { now: now + 60000 }), restarted.recoverConsultations(UID, { now: now + 60000 })]);
  expect(send).toHaveBeenCalledTimes(2);
  expect((await row(c.id)).nudgeDelivery).toMatchObject({ state: 'sent', attempts: 2 });
  expect(send.mock.calls[1][1].requestId).toBe(send.mock.calls[0][1].requestId);
});

it('bounds definitely rejected nudge attempts and never retries an uncertain attempt', async () => {
  const c = await create(), s = await service(), now = Date.parse(c.createdAt) + 300001;
  send.mockResolvedValue({ ok: false, code: 'HUB_429' });
  await s.recoverConsultations(UID, { now });
  await s.recoverConsultations(UID, { now: now + 60000 });
  expect((await row(c.id)).nudgeDelivery).toMatchObject({ attempts: 2, nextAttemptAt: new Date(now + 180000).toISOString() });
  await s.recoverConsultations(UID, { now: now + 179999 });
  expect(send).toHaveBeenCalledTimes(2);
  await s.recoverConsultations(UID, { now: now + 180000 });
  await s.recoverConsultations(UID, { now: now + 86400000 });
  expect(send).toHaveBeenCalledTimes(3);
  expect((await row(c.id)).nudgeDelivery?.state).toBe('failed');
  expect((await row(c.id)).nudgeDelivery?.nextAttemptAt).toBeUndefined();
});

it.each(['HUB_UNREACHABLE', 'HUB_ACKNOWLEDGEMENT_UNKNOWN'])('does not replay uncertain nudges after %s or restart', async code => {
  const c = await create(), s = await service(), now = Date.parse(c.createdAt) + 300001;
  send.mockResolvedValueOnce({ ok: false, code });
  await s.recoverConsultations(UID, { now });
  vi.resetModules();
  await (await service()).recoverConsultations(UID, { now: now + 86400000 });
  expect(send).toHaveBeenCalledTimes(1);
  expect((await row(c.id)).nudgeDelivery?.state).toBe('uncertain');
});

it('keeps unrelated relay admission and polling alive with corrupt consultations while suppressing the affected final', async () => {
  await create();
  const { userA2AConsultationsFile } = await import('../../../../src/main/paths');
  const file = userA2AConsultationsFile(UID), damaged = '{PRIVATE do not log';
  fs.writeFileSync(file, damaged);
  const s = await service();
  expect(await s.hasConsultationRequestForReception(UID, CID, 'question-1')).toBe(true);
  const incomingCid = 'a2a-0123456789abcdef0999';
  const poll = vi.fn(async () => [{ messageId: 'unrelated-question', fromAccount: PEER, toAccount: UID, conversationId: incomingCid, kind: 'question' as const, text: 'New public question', createdAt: new Date().toISOString() }]);
  const { pumpOnce } = await import('../../../../src/main/features/a2a/relay-pump');
  await pumpOnce({ activeUserId: () => UID, poll });
  expect(poll).toHaveBeenCalledTimes(1);
  const entries = await (await import('../../../../src/main/features/a2a/reception-ledger')).readReceptionLedger(UID);
  expect(entries.find(row => row.messageId === 'unrelated-question')).toMatchObject({ conversationId: incomingCid, admission: 'committed' });
  expect(await s.hasConsultationRequestForReception(UID, incomingCid, 'unrelated-question')).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(damaged);
  expect(send).not.toHaveBeenCalled();
  (await import('../../../../src/main/features/a2a/reception-nudge')).resetReceptionNudges();
});
