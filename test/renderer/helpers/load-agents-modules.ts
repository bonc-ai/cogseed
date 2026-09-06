import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// 渲染层 agents 模块按职责拆成多个 classic <script> 文件（顶层 let/const
// 经共享全局词法环境跨文件共享，加载顺序以 index.html 为准，见 index.html
// 顶部注释）。测试里整体求值时不能只读 agents.js —— 以 index.html 的
// <script> 顺序为唯一事实来源：解析出 agents 系文件按序执行，与真实
// 浏览器的加载语义保持一致。拆分/增删 agents 系文件时本 helper 自动跟随，
// 测试无需再改。

export interface AgentsModuleChunk {
  /** 与 vm 求值 {filename} 一致的文件名，例如 'agents-picker.js'。 */
  filename: string;
  code: string;
}

const rendererRoot = path.join(__dirname, '..', '..', '..', 'src', 'renderer');

/** index.html 里 agents 系（./modules/agents*.js）script 的加载顺序清单。 */
export function agentsModuleFilenames(): string[] {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const re = /<script src="\.\/modules\/(agents[\w.-]*\.js)"><\/script>/g;
  const files: string[] = [];
  for (const m of html.matchAll(re)) {
    if (!files.includes(m[1])) files.push(m[1]);
  }
  if (!files.includes('agents.js')) {
    throw new Error('index.html 未找到 agents.js 的 script 标签');
  }
  return files;
}

/** 按加载顺序读取 agents 系模块源码。 */
export function readAgentsModuleChunks(): AgentsModuleChunk[] {
  return agentsModuleFilenames().map((filename) => ({
    filename,
    code: fs.readFileSync(path.join(rendererRoot, 'modules', filename), 'utf8'),
  }));
}

/** 拼接后的 agents 系源码，供源码文本断言使用（单文件断言会随拆分漂移）。
 *  文件之间以换行分隔，避免首尾行粘连产生假匹配。 */
export function readAgentsModuleSource(): string {
  return readAgentsModuleChunks().map((chunk) => chunk.code).join('\n');
}

/** 在给定 vm context 里按 index.html 顺序执行 agents 系模块（求值语义与
 *  浏览器 classic script 一致：顶层声明进入 context 的全局词法环境）。 */
export function runAgentsModules(context: vm.Context) {
  for (const { filename, code } of readAgentsModuleChunks()) {
    vm.runInContext(code, context, { filename });
  }
}
