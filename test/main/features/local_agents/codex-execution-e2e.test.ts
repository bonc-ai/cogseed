import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
const enabled = process.env.ORKAS_RUN_REAL_CODEX === '1';
let root='';
beforeAll(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'real-codex-'));process.env.ORKAS_WORKSPACE_ROOT=root;process.env.ORKAS_BRIDGE_DISABLED='1';});
afterAll(()=>{delete process.env.ORKAS_WORKSPACE_ROOT;delete process.env.ORKAS_BRIDGE_DISABLED;fs.rmSync(root,{recursive:true,force:true});});
describe.skipIf(!enabled)('real Codex execution (set ORKAS_RUN_REAL_CODEX=1)',()=>{it('returns a real thread id and terminal result',async()=>{const runner=await import('../../../../src/main/features/local_agents/runner');const events:any[]=[];const result=await runner.run({uid:'real-codex-smoke',cid:'conversation-smoke',agentId:'agent-smoke',cli:'codex',prompt:'Reply with exactly: ORKAS_CODEX_OK',cwd:root,signal:new AbortController().signal,onEvent:e=>events.push(e)});expect(result.status).toBe('completed');expect(result.sessionId).toEqual(expect.any(String));expect(events.some(e=>e.type==='done')).toBe(true);},120000);});
