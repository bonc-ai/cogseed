import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url);
// 结果行解析：没拿到结果就把子进程输出带进失败信息，而不是回落到 `{}`
// （Windows 上 stdout 为空会退化成 `output.checks` undefined，看不出是
// 「fixture 没产出结果」还是「断言写错」）。
function parseResult(result:any){
  const line=String(result.stdout).trim().split('\n').filter(Boolean).pop();
  expect(line,`fixture produced no JSON result\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBeTruthy();
  return JSON.parse(String(line));
}
it('edits nickname through the normal Settings page, real preload and shared UI at desktop/narrow widths',()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),[resolve(__dirname,'fixtures/hub-nickname.cjs')],{env,encoding:'utf8',timeout:45000, killSignal: 'SIGKILL'});
  expect(result.status,`${result.error||''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  const output=parseResult(result);
  expect(output.error).toBeUndefined();
  expect(output.checks.length).toBeGreaterThanOrEqual(24);
  expect(output.requests).toEqual(Array(2).fill({channel:'hub-account.update_profile',payload:{display_name:'  <>& New  '}}));
},50000);

it('keeps Escape focus when an older account refresh completes after draft cancellation',()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),[resolve(__dirname,'fixtures/hub-nickname.cjs'),'generation'],{env,encoding:'utf8',timeout:45000, killSignal: 'SIGKILL'});
  expect(result.status,`${result.error||''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  const output=parseResult(result);
  expect(output.checks).toHaveLength(3);
  expect(output.requests).toEqual([]);
},50000);

it('refreshes the real current member bar tooltip and @ picker without changing selected identities or drafts',()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),[resolve(__dirname,'fixtures/hub-nickname.cjs'),'roster'],{env,encoding:'utf8',timeout:45000, killSignal: 'SIGKILL'});
  expect(result.status,`${result.error||''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  const output=parseResult(result);
  expect(output.checks.length).toBeGreaterThanOrEqual(14);
  expect(output.requests).toEqual([]);
},50000);

it('keeps the real account chip nickname and cache when a same-session old GET arrives after profile save',()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),[resolve(__dirname,'fixtures/hub-nickname.cjs'),'chip-race'],{env,encoding:'utf8',timeout:45000, killSignal: 'SIGKILL'});
  expect(result.status,`${result.error||''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  const output=parseResult(result);
  expect(output.checks).toHaveLength(5);
  expect(output.requests).toEqual([{channel:'hub-account.update_profile',payload:{display_name:'New name'}}]);
},50000);
