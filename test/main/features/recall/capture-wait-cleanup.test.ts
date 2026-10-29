import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let tmp: string,previous: string|undefined;
beforeEach(()=>{vi.resetModules();tmp=fs.mkdtempSync(path.join(os.tmpdir(),'obsolete-wait-'));previous=process.env.COGSEED_WORKSPACE_ROOT;process.env.COGSEED_WORKSPACE_ROOT=tmp;});
afterEach(()=>{if(previous===undefined)delete process.env.COGSEED_WORKSPACE_ROOT;else process.env.COGSEED_WORKSPACE_ROOT=previous;fs.rmSync(tmp,{recursive:true,force:true});});
const wait={schemaVersion:1,ownerId:'alice',id:'rcap-old',status:'waiting_manual',executionPolicy:'manual',candidateIds:[]};
describe('明确删除未开始的旧整理记录',()=>{
 it('只删除原记录，重试幂等且不写其他内容',async()=>{const s=await import('../../../../src/main/features/recall/store');await s.writeRecallJsonRecord('alice','captures',wait.id,wait);await s.writeRecallJsonRecord('alice','captures','rcap-kept',{...wait,id:'rcap-kept',status:'completed',candidateIds:['cand-a']});expect(await s.discardUnstartedRecallCaptureWait('alice',wait.id)).toBe(true);expect(await s.discardUnstartedRecallCaptureWait('alice',wait.id)).toBe(false);expect(await s.readRecallJsonRecord('alice','captures','rcap-kept')).toMatchObject({status:'completed',candidateIds:['cand-a']});});
 it('不能删已有候选、已开始、正在写入或不同用户的记录',async()=>{const s=await import('../../../../src/main/features/recall/store');for(const patch of [{candidateIds:['cand-a']},{startedAt:'2026-10-11T00:00:00Z'},{stage:'candidate_save'},{writingCandidateId:'cand-a'},{status:'completed'},{executionPolicy:'nightly'}]){await s.writeRecallJsonRecord('alice','captures',wait.id,{...wait,...patch});await expect(s.discardUnstartedRecallCaptureWait('alice',wait.id)).rejects.toThrow();expect(await s.readRecallJsonRecord('alice','captures',wait.id)).toBeDefined();}expect(await s.discardUnstartedRecallCaptureWait('bob',wait.id)).toBe(false);});
});
