import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises'; import * as os from 'node:os'; import * as path from 'node:path';
let root=''; const UID='contextInjectionUser';
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'context-injection-'));process.env.COGSEED_WORKSPACE_ROOT=root;});
afterEach(async()=>{delete process.env.COGSEED_WORKSPACE_ROOT;await fs.rm(root,{recursive:true,force:true});});

describe('P3394 prepared execution context',()=>{
  it('binds receipt/session/context and only approved roots',async()=>{
    const p=await import('../../../../src/main/features/p3394');
    await p.prepareReceipt(UID,{receiptId:'receipt-ctx-1',executionId:'receipt-exec-ctx-1',targetSessionId:'gmember-target',targetContextId:'ctx-target',reusedRefs:['memory:one'],omittedRefs:[],permissionMode:'workspace-write',allowedScopes:['workspace:read','workspace:write'],boundary:'test-double'},{sessionId:'gmember-target',contextId:'ctx-target'});
    const sessions=await import('../../../../src/main/model/core-agent/session-store'); const sessionPath=sessions.resolveSessionPath(UID,'gmember-target'); await fs.mkdir(path.dirname(sessionPath),{recursive:true}); await fs.writeFile(sessionPath,'{}\n');
    const read=path.join(root,'read'); const write=path.join(root,'write'); await fs.mkdir(read); await fs.mkdir(write);
    const result=await p.prepareExecutionContext(UID,{executionId:'exec-ctx-1',sessionId:'gmember-target',contextId:'ctx-target',prompt:'Do work',readOnlyRoots:[read],writableRoots:[write],permissionMode:'workspace-write',receiptId:'receipt-ctx-1',receiptExecutionId:'receipt-exec-ctx-1'},{approvedReadOnlyRoots:[read],approvedWritableRoots:[write]});
    expect(result.ok).toBe(true); if(result.ok) expect(result.context).toMatchObject({receiptId:'receipt-ctx-1',prompt:'Do work',writableRoots:[write]});
  });
  it('returns a structured blocked result for root/context/permission escalation without completing receipt',async()=>{
    const p=await import('../../../../src/main/features/p3394');
    await p.prepareReceipt(UID,{receiptId:'receipt-ctx-2',executionId:'receipt-exec-ctx-2',targetSessionId:'gmember-target',targetContextId:'ctx-target',reusedRefs:[],omittedRefs:[],permissionMode:'read-only',allowedScopes:['workspace:read'],boundary:'test-double'},{sessionId:'gmember-target',contextId:'ctx-target'});
    const sessions=await import('../../../../src/main/model/core-agent/session-store'); const sessionPath=sessions.resolveSessionPath(UID,'gmember-target'); await fs.mkdir(path.dirname(sessionPath),{recursive:true}); await fs.writeFile(sessionPath,'{}\n');
    const approved=path.join(root,'approved'); await fs.mkdir(approved);
    const result=await p.prepareExecutionContext(UID,{executionId:'exec-ctx-2',sessionId:'gmember-target',contextId:'ctx-other',prompt:'Do work',readOnlyRoots:[approved],writableRoots:[path.join(root,'outside')],permissionMode:'workspace-write',receiptId:'receipt-ctx-2',receiptExecutionId:'receipt-exec-ctx-2'},{approvedReadOnlyRoots:[approved],approvedWritableRoots:[]});
    expect(result).toMatchObject({ok:false,status:'blocked',event:{type:'context-denied'}});
    expect((await p.readReceipt(UID,'receipt-exec-ctx-2')).status).toBe('prepared');
  });
});
