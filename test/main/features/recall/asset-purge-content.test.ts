import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedStoredAbilityAsset } from '../../../helpers/stored-ability-asset';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
vi.mock('../../../../src/main/features/kb_indexer', () => ({ enqueue() {}, async drain() {}, kbEvents: { on() {}, off() {}, emit() {} } }));
vi.mock('../../../../src/main/features/search', () => ({ upsertContext() {}, dropContext() {} }));
const uid = 'synthetic-purge-user', aid = 'synthetic-asset', marker = 'SYNTHETIC_PRIVATE_CONTENT';
let root: string, prev: string | undefined;
beforeEach(() => { vi.resetModules(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-purge-content-')); prev = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await drainMainRuntimeForTest(uid); if (prev === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = prev; fs.rmSync(root, {recursive: true, force: true}); });
async function setupReport() {
 const store = await import('../../../../src/main/features/recall/store');
 const assets = await import('../../../../src/main/features/recall/asset-service');
 const now = new Date().toISOString();
 await seedStoredAbilityAsset(uid, {schemaVersion: 1, ownerId: uid, id: aid, candidateId: 'synthetic-candidate', reviewDecisionId: 'rd_syntheticreview', type: 'rule', title: marker, statement: marker + ' synthetic body.', evidenceRefs: [], scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified', version:'1', createdAt:now, updatedAt:now} as any, {actor:'user',reason:'Synthetic seed'});
 await store.writeRecallJsonRecord(uid, 'cleanup-reports', 'synthetic-report', {schemaVersion:1,ownerId:uid,id:'synthetic-report',trigger:'user',scope:{},items:[],uncertain:[{assetId:'synthetic-peer',title:marker,question:'Compare with '+marker,reason:'Synthetic comparison'}],skippedSteps:[],createdAt:now,scanned:1});
 const original = store.updateRecallJsonRecord;
 const fault = vi.spyOn(store,'updateRecallJsonRecord').mockImplementation(async (u,c,i,fn) => {if(c==='cleanup-reports') throw new Error('synthetic disk write failure'); return original(u,c,i,fn);});
 return {store,assets,fault};
}
it('purge must report failure when a retained report copy cannot be cleared', async () => {
 const e=await setupReport();
 await expect(e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'})).rejects.toThrow('synthetic disk write failure');
});
it('purge retry and startup compensation must clear a cross-entry historical copy', async () => {
 const e=await setupReport();
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'}).catch(()=>{});
 e.fault.mockRestore();
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic retry'});
 await e.assets.sweepPurgedAbilityAssetVersionStreams(uid);
 const report=await e.store.readRecallJsonRecord(uid,'cleanup-reports','synthetic-report');
 expect(JSON.stringify(report)).not.toContain(marker);
});
it('purge must remove retained bodies from asset change approval proposals', async () => {
 const e=await setupReport(); e.fault.mockRestore();
 const approvals=await import('../../../../src/main/features/recall/asset-approval-service');
 const {proposal}=await approvals.createAssetChangeProposal(uid,{assetId:aid,baselineVersion:'1',fields:['statement'],before:'statement=41',after:'statement=49',beforeValues:{statement:marker+' synthetic body.'},payload:{statement:marker+' revised synthetic body.'},reason:'Synthetic wording edit'});
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'});
 const after=await approvals.readAssetChangeProposal(uid,proposal.id);
 expect(JSON.stringify(after)).not.toContain(marker);
});

it('failed ownership preparation leaves the asset content intact', async () => {
 const e = await setupReport();
 await expect(e.assets.purgeAbilityAsset(uid, aid, {actor:'user',reason:'Synthetic purge'})).rejects.toThrow('synthetic disk');
 expect(await e.assets.readAbilityAsset(uid, aid)).toMatchObject({status:'active',title:marker});
});

it.each(['retry', 'startup'] as const)('%s clears linked cross-entry copies after tombstoning and rejects stale report writes', async recovery => {
 const e = await setupReport(); e.fault.mockRestore();
 const original = e.store.updateRecallJsonRecord;
 const old = await e.store.readRecallJsonRecord(uid,'cleanup-reports','synthetic-report');
 const fault = vi.spyOn(e.store,'updateRecallJsonRecord').mockImplementation(async (u,c,i,fn) => {
  if(c==='cleanup-reports' && (await e.store.readRecallJsonRecord(u,'ability-assets',aid))?.status==='purged') throw new Error('synthetic clear failure');
  return original(u,c,i,fn);
 });
 await expect(e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'})).rejects.toThrow('synthetic clear failure');
 const linked:any = await e.store.readRecallJsonRecord(uid,'cleanup-reports','synthetic-report');
 expect(linked.uncertain[0].contentAssetIds).toContain(aid);
 expect(await e.assets.readAbilityAsset(uid,aid)).toMatchObject({status:'purged',statement:''});
 fault.mockRestore();
 if(recovery==='retry') await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic retry'});
 else await e.assets.sweepPurgedAbilityAssetVersionStreams(uid);
 const report:any = await e.store.readRecallJsonRecord(uid,'cleanup-reports','synthetic-report');
 expect(JSON.stringify(report)).not.toContain(marker);
 expect(report.uncertain[0]).toMatchObject({assetId:'synthetic-peer',contentPurgedAt:expect.any(String)});
 await expect(e.store.writeRecallJsonRecord(uid,'cleanup-reports','synthetic-report',old!)).rejects.toMatchObject({code:'recall_content_purged'});
 // A disposition is metadata, not restored content.
 await e.store.updateRecallJsonRecord(uid,'cleanup-reports','synthetic-report',raw => ({...raw!,uncertain:report.uncertain.map((row:any)=>({...row,decision:'dismissed'}))}));
});

it('inspection write failure remains retryable at startup without a version stream', async () => {
 const e=await setupReport(); e.fault.mockRestore();
 await e.store.writeRecallJsonRecord(uid,'inspection-runs','synthetic-inspection',{schemaVersion:1,ownerId:uid,id:'synthetic-inspection',trigger:'manual',scope:{statuses:['active']},startedAt:new Date().toISOString(),scanned:1,findings:[{key:'synthetic-finding',category:'conflict',assetIds:[aid],title:marker,detail:marker+' detail'}]});
 const original=e.store.updateRecallJsonRecord;
 const fault=vi.spyOn(e.store,'updateRecallJsonRecord').mockImplementation(async (u,c,i,fn)=>{if(c==='inspection-runs')throw new Error('synthetic inspection failure');return original(u,c,i,fn);});
 await expect(e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'})).rejects.toThrow('synthetic inspection failure');
 await expect(e.assets.sweepPurgedAbilityAssetVersionStreams(uid)).rejects.toThrow('cleanup remains incomplete');
 fault.mockRestore(); await e.assets.sweepPurgedAbilityAssetVersionStreams(uid);
 expect(JSON.stringify(await e.store.readRecallJsonRecord(uid,'inspection-runs','synthetic-inspection'))).not.toContain(marker);
});

it.each(['pending','confirmed','rejected'] as const)('clears %s approvals without changing their decision history or other assets', async state=>{
 const e=await setupReport(); e.fault.mockRestore();
 const approvals=await import('../../../../src/main/features/recall/asset-approval-service');
 const peer=await e.store.readRecallJsonRecord(uid,'ability-assets',aid);
 await e.store.writeRecallJsonRecord(uid,'ability-assets','synthetic-peer',{...peer!,id:'synthetic-peer',title:'Synthetic peer',statement:'Independent formal content'});
 const input={assetId:aid,baselineVersion:'1',fields:['statement'],before:marker,after:marker,beforeValues:{statement:marker},payload:{statement:marker},reason:marker};
 const {proposal}=await approvals.createAssetChangeProposal(uid,input);
 await e.store.updateRecallJsonRecord(uid,'asset-approvals',proposal.id,raw=>({...raw!,state,editedFrom:{statement:marker}}));
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'});
 const cleared=await approvals.readAssetChangeProposal(uid,proposal.id);
 expect(cleared).toMatchObject({state,contentPurgedAt:expect.any(String),payload:{},fields:[]});
 expect(JSON.stringify(cleared)).not.toContain(marker);
 expect(approvals.buildAssetChangeApprovalCard(cleared!,'')).toMatchObject({actions:[]});
 await expect(approvals.editAssetChangeProposal(uid,proposal.id,{statement:marker})).rejects.toMatchObject({code:'recall_content_purged'});
 await expect(approvals.decideAssetChangeProposal(uid,proposal.id,'confirm')).rejects.toMatchObject({code:'recall_content_purged'});
 await expect(approvals.createAssetChangeProposal(uid,input)).rejects.toMatchObject({code:'recall_content_purged'});
 await expect(e.store.writeRecallJsonRecord(uid,'asset-approvals',proposal.id,proposal)).rejects.toMatchObject({code:'recall_content_purged'});
 await expect(e.store.writeRecallJsonRecord(uid,'asset-approvals','synthetic-late-approval',{...proposal,id:'synthetic-late-approval'})).rejects.toMatchObject({code:'recall_content_purged'});
 expect(await e.assets.readAbilityAsset(uid,'synthetic-peer')).toMatchObject({status:'active',statement:'Independent formal content'});
});

it('hides legacy approval content while a failed cleanup awaits startup compensation',async()=>{
 const e=await setupReport();e.fault.mockRestore();
 const approvals=await import('../../../../src/main/features/recall/asset-approval-service');
 const {proposal}=await approvals.createAssetChangeProposal(uid,{assetId:aid,baselineVersion:'1',fields:['statement'],payload:{statement:marker},before:marker,after:marker,reason:marker});
 const original=e.store.updateRecallJsonRecord;
 const fault=vi.spyOn(e.store,'updateRecallJsonRecord').mockImplementation(async (u,c,i,fn)=>{if(c==='asset-approvals') throw new Error('synthetic approval write failure');return original(u,c,i,fn);});
 await expect(e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'})).rejects.toThrow('synthetic approval write failure');
 expect(JSON.stringify(await approvals.readAssetChangeProposal(uid,proposal.id))).not.toContain(marker);
 expect((await approvals.listAssetChangeProposals(uid))[0]).toMatchObject({contentPurgedAt:expect.any(String)});
 fault.mockRestore();await e.assets.sweepPurgedAbilityAssetVersionStreams(uid);
 expect(JSON.stringify(await e.store.readRecallJsonRecord(uid,'asset-approvals',proposal.id))).not.toContain(marker);
});

it('keeps the legacy marker-based cleanup entry callable after the owning asset is purged',async()=>{
 const e=await setupReport(); e.fault.mockRestore();
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'});
 // An imported historical report has no ownership link to the erased asset.
 await e.store.writeRecallJsonRecord(uid,'cleanup-reports','synthetic-legacy-report',{schemaVersion:1,ownerId:uid,id:'synthetic-legacy-report',trigger:'user',scope:{},items:[],uncertain:[{assetId:'synthetic-peer',title:marker,question:marker,reason:'Synthetic comparison'}],skippedSteps:[],createdAt:new Date().toISOString(),scanned:1});
 const cleanup=await import('../../../../src/main/features/recall/cleanup-report-service');
 await cleanup.sweepPurgedAssetFromCleanupReports(uid,aid,[marker]);
 expect(JSON.stringify(await e.store.readRecallJsonRecord(uid,'cleanup-reports','synthetic-legacy-report'))).not.toContain(marker);
});

it('redacts review decision text when the owning asset is purged',async()=>{
 const e=await setupReport(); e.fault.mockRestore();
 const decisions=await import('../../../../src/main/features/cognition/review-decision');
 const decision=await decisions.writeReviewDecision(uid,{targetRef:'recall_candidate:synthetic-candidate',decisionType:'modify',decision:'modify',actor:'user',reason:'reason '+marker,modifiedContent:'body '+marker});
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'});
 const raw=fs.readFileSync(decisions.reviewDecisionLogPath(uid,'recall_candidate:synthetic-candidate'),'utf8');
 expect(raw).not.toContain(marker);
 const latest=await decisions.readReviewDecision(uid,'recall_candidate:synthetic-candidate',decision.decision_id);
 expect(latest).toMatchObject({decision_id:decision.decision_id,target_ref:'recall_candidate:synthetic-candidate',decision_type:'modify'});
 expect(latest?.modified_content).toBeUndefined();
 expect(latest?.reason).toBeUndefined();
});

it('scrubs legacy audit text while keeping action coordinates',async()=>{
 const e=await setupReport(); e.fault.mockRestore();
 await e.store.appendRecallJsonlRecord(uid,'ability-asset-audit',aid,{schemaVersion:1,ownerId:uid,id:'synthetic-legacy-audit',assetId:aid,action:'updated',at:new Date().toISOString(),note:'note '+marker,reason:'reason '+marker,before:'statement=「'+marker+'…」',after:'title=「'+marker+'…」'});
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'});
 const audit=await e.assets.listAbilityAssetAudit(uid,aid);
 expect(JSON.stringify(audit)).not.toContain(marker);
 expect(audit.find(row=>row.id==='synthetic-legacy-audit')).toMatchObject({action:'updated',assetId:aid});
});

it('retry clears a late same-text candidate using the tombstone hash',async()=>{
 const e=await setupReport(); e.fault.mockRestore();
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'});
 const candidates=await import('../../../../src/main/features/personal_ontology_candidates');
 await candidates.addCandidate(uid,{candidate_id:'synthetic-late-same-text',summary:'Synthetic late',memory_text:marker+' synthetic body.'});
 await e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic retry'});
 const data=await candidates.listCandidates(uid);
 expect(data.candidate_updates.some(row=>row.candidate_id==='synthetic-late-same-text')).toBe(false);
});

it('clears unified version streams and PO history/trash copies while keeping manual values', async () => {
 const e = await setupReport(); e.fault.mockRestore();
 const contract = await import('../../../../src/main/features/personal_ontology_contract');
 const tmpl = await import('../../../../src/main/features/personal_ontology_template_files');
 const po = await import('../../../../src/main/features/po/store');
 const kernel = await import('../../../../src/main/features/cognition_kernel/store');
 await tmpl.installTemplateFile(uid, 'student');
 const target = (await contract.listRoleTemplateFieldTargets(uid)).find(t => t.label.endsWith('· 教育阶段'))!;
 expect(await contract.appendRoleTemplateFieldValue(uid, target.fieldRef, marker, '智能', undefined, aid)).toMatchObject({ ok: true });
 const row = tmpl.readGroups(uid).find(g => g.template_id === 'student')!;
 expect(await tmpl.appendFieldValueToRef(uid, tmpl.buildContentRef(row.group_id, '学期与课程'), '课程清单', 'Manual value kept', '手动')).toMatchObject({ ok: true });
 const groupId = row.group_id;
 po.appendPoAudit(uid, groupId, 'value_add', { field: '课程清单', afterSummary: 'SYNTHETIC_MANUAL_AUDIT' });
 const auditBefore = po.readPoGroupAudit(uid, groupId);
 expect(JSON.stringify(auditBefore)).toContain('SYNTHETIC_MANUAL_AUDIT');
 const live = po.loadPoDocSync(uid).groups.find(g => g.id === groupId)!;
 expect(JSON.stringify(live)).toContain(marker);
 expect(JSON.stringify(live)).toContain('Manual value kept');
 po.writePoGroupSnapshot(uid, groupId, live);
 await po.editPoDoc(uid, ctx => {
  ctx.doc.trash.push({ group: structuredClone(live), deletedAt: new Date().toISOString() });
 });
 const versionPath = path.join(path.dirname(kernel.cognitionStorePath(uid)), 'cognition-versions', `${aid}.jsonl`);
 fs.mkdirSync(path.dirname(versionPath), { recursive: true });
 fs.writeFileSync(versionPath, JSON.stringify({ statement: marker }) + '\n');

 await e.assets.purgeAbilityAsset(uid, aid, { actor: 'user', reason: 'Synthetic purge' });

 expect(fs.existsSync(versionPath)).toBe(false);
 const doc = po.loadPoDocSync(uid);
 expect(JSON.stringify(doc)).not.toContain(marker);
 expect(JSON.stringify(doc)).toContain('Manual value kept');
 let manualSurvivedInHistory = false;
 for (const entry of po.listPoGroupHistory(uid, groupId)) {
  const snapshot = po.readPoGroupSnapshot(uid, groupId, entry.id);
  expect(JSON.stringify(snapshot)).not.toContain(marker);
  if (JSON.stringify(snapshot).includes('Manual value kept')) manualSurvivedInHistory = true;
 }
 expect(manualSurvivedInHistory).toBe(true);
 expect(po.readPoGroupAudit(uid, groupId)).toEqual(auditBefore);
});

it('startup compensation sweeps version streams even when a retained run cannot be cleared',async()=>{
 const e=await setupReport(); e.fault.mockRestore();
 await e.store.writeRecallJsonRecord(uid,'inspection-runs','synthetic-inspection',{schemaVersion:1,ownerId:uid,id:'synthetic-inspection',trigger:'manual',scope:{statuses:['active']},startedAt:new Date().toISOString(),scanned:1,findings:[{key:'synthetic-finding',category:'conflict',assetIds:[aid],title:marker,detail:marker+' detail'}]});
 const original=e.store.updateRecallJsonRecord;
 const fault=vi.spyOn(e.store,'updateRecallJsonRecord').mockImplementation(async (u,c,i,fn)=>{if(c==='inspection-runs')throw new Error('synthetic inspection failure');return original(u,c,i,fn);});
 await expect(e.assets.purgeAbilityAsset(uid,aid,{actor:'user',reason:'Synthetic purge'})).rejects.toThrow('synthetic inspection failure');
 // Simulate a crash residual written before the tombstone boundary was visible.
 const paths=await import('../../../../src/main/features/recall/paths');
 const stream=paths.recallJsonlPath(uid,'ability-asset-versions',aid);
 fs.mkdirSync(path.dirname(stream),{recursive:true});
 fs.writeFileSync(stream,JSON.stringify({schemaVersion:1,ownerId:uid,id:aid+'-v1',assetId:aid,version:'1',at:new Date().toISOString(),snapshot:{title:marker,statement:marker}})+'\n');
 await expect(e.assets.sweepPurgedAbilityAssetVersionStreams(uid)).rejects.toThrow('cleanup remains incomplete');
 expect(await e.assets.listAbilityAssetVersions(uid,aid)).toHaveLength(0);
 fault.mockRestore(); await e.assets.sweepPurgedAbilityAssetVersionStreams(uid);
});
