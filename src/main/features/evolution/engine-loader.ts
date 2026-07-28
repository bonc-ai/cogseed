import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { metaSkillEnginePackageDir } from '../../paths';

// 引擎公共导出的进程内句柄类型。仅列本 feature 用到的成员。
export interface EngineModule {
  EvolutionOrchestrator: new (deps: { llm?: unknown }) => unknown;
  OntologyReader: new (dir: string) => unknown;
  OntologyWriter: new (dir: string) => unknown;
  SkillCreator: new () => unknown;
  ruleFallbackComplete: (prompt: string) => Promise<{ text: string; degraded: boolean }>;
  KSTAR_STEPS: readonly string[];
  [k: string]: unknown;
}

let cached: Promise<EngineModule> | null = null;

/**
 * 进程内动态加载引擎 ESM dist。缓存句柄。
 * 唯一的进程内引擎加载点——其余 feature 模块只经此函数拿引擎类。
 * 引擎必须已 build（npm run engine:build），dist/engine.js 存在。
 * 加载 dist/engine.js（纯库入口，不启动服务器），非 dist/index.js
 * （MCP 子进程入口，import 即启动 stdio 服务器）。
 */
export function loadEngine(): Promise<EngineModule> {
  if (!cached) {
    const dir = metaSkillEnginePackageDir();
    const entry = pathToFileURL(path.join(dir, 'dist', 'engine.js')).href;
    cached = import(entry) as Promise<EngineModule>;
  }
  return cached;
}

/** 测试用：重置缓存。 */
export function _resetEngineCache(): void { cached = null; }
