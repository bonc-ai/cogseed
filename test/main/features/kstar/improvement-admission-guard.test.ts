/**
 * specs/015 T046：反漂移断言——把四个「唯一处」钉在**源码事实**上，防长出第二套。
 *
 * 守四条（与 tasks.md T046 ①②③④ 一一对应，一个 `it` 一条）：
 *   ① 两条沉淀线都经**同一个准入门**（`improvement-admission.ts::admitKstarProposals`）：
 *      门的实现只有一处、调用点只有一处；需求级线与直通线都路由到那个出口；
 *      历史 drain 桥（`recall-bridge.ts::saveKstarCandidateProposals`）保持零调用点。
 *   ② 不存在第二处「采用判定」：`'applied'` 字面量只允许出现在显式清单里的文件
 *      （写入侧 / 展示侧 / 另一个域的枚举），且**两条件并判**（`applied` + `real`）
 *      只允许在权威口径 `asset-usage-receipt.ts` 里；准入门自己不得重判状态。
 *   ③ 不存在第二处版本比对：拿「期望/依据版本」与资产**当前在用版**比大小的表达式
 *      只允许在 `asset-service.ts`；且那处判定必须在 `updateAbilityAsset` 的
 *      **锁内**（`updateRecallJsonRecord` 回调里）。
 *   ④ `tool-catalog.ts` 未新增 recall 组工具：catalog 的 recall 组与三个工厂
 *      （`createRecallTools` / `createAssetStewardTools` / `createPersonalOntologyTools`）
 *      的工具面一致，且等于下面的冻结基线。
 *
 * 派生而非抄名单：
 *   · 门的「放行列表」字段名不是手写的——从 `KstarAdmissionResult` 接口里按
 *     类型（`KstarCandidateProposal[]`）派生，字段改名它跟着改，删掉它则报错。
 *   · 版本比对的模式是本文件里逐条**先核实存在**再写的（`current.version` 比较、
 *     「期望版本标识符参与比较」），不是想象的形状；后者按片段级判定（切 `&&`/括号后
 *     逐片段看），所以 `liveVersion !== targetVersionUsed` 这类裸标识符形状也覆盖得到，
 *     而 `typeof … !== 'string'` 与 `=== undefined` 天生不算比大小。
 *   · recall 组工具面 = 三个工厂实际产出的名字（不是另一套计数口径）。
 *
 * 已知残余风险（写在这里，不假装覆盖）：
 *   · 扫描按**单行**匹配（本项目比较表达式都在一行内）；跨行写法抓不到。
 *   · 注释已剥离：只在注释里提到 `'applied'` 不算命中。
 *   · `candidate-service.ts::candidateVersionRecheckPlan` 里的 `explicit !== target`
 *     比的是「用户选定的基线 vs 候选原锚」（重锚留痕），不碰当前在用版，
 *     因此不在本断言范围内（它是两个锚之间的比较，不是重检）。
 *   · 扫描范围是 `src/main/**`（①）、`features/kstar` + `features/recall`（②③）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAssetStewardTools } from '../../../../src/main/model/core-agent/asset-steward-tools';
import { createPersonalOntologyTools } from '../../../../src/main/model/core-agent/personal-ontology-tools';
import { createRecallTools } from '../../../../src/main/model/core-agent/recall-tools';
import { createExperienceTools } from '../../../../src/main/model/core-agent/experience-tools';
import { TOOL_CATALOG } from '../../../../src/main/model/core-agent/tool-catalog';

const repoRoot = path.resolve(__dirname, '../../../..');
const SRC_MAIN = path.join(repoRoot, 'src/main');
const KSTAR_DIR = path.join(SRC_MAIN, 'features/kstar');
const RECALL_DIR = path.join(SRC_MAIN, 'features/recall');

const F = {
  admission: 'src/main/features/kstar/improvement-admission.ts',
  direct: 'src/main/features/kstar/direct-experience-assets.ts',
  requirementLine: 'src/main/features/kstar/task-level-precipitation.ts',
  bridge: 'src/main/features/kstar/recall-bridge.ts',
  taskClosure: 'src/main/features/kstar/task-closure.ts',
  trace: 'src/main/features/kstar/trace.ts',
  usageReceipt: 'src/main/features/recall/asset-usage-receipt.ts',
  assetService: 'src/main/features/recall/asset-service.ts',
  candidateService: 'src/main/features/recall/candidate-service.ts',
  approvalService: 'src/main/features/recall/asset-approval-service.ts',
  profileSync: 'src/main/features/recall/personal-profile-sync.ts',
  cleanupReport: 'src/main/features/recall/cleanup-report-service.ts',
} as const;

function rel(abs: string): string {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

/** 递归列出 .ts（不含 .d.ts）：断言的对象是磁盘上的源码事实。 */
function listTsFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTsFiles(absolute);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) return [];
    return [absolute];
  });
}

let mainFilesCache: string[] | undefined;
let assetDomainFilesCache: string[] | undefined;
/** `src/main/**`：门的实现/调用点、历史桥的调用点在全仓范围内唯一（①）。 */
function mainTsFiles(): string[] {
  mainFilesCache ||= listTsFiles(SRC_MAIN);
  return mainFilesCache;
}
/** `features/kstar` + `features/recall`：采用口径与资产版本链的域内文件（②③）。 */
function assetDomainTsFiles(): string[] {
  assetDomainFilesCache ||= [...listTsFiles(KSTAR_DIR), ...listTsFiles(RECALL_DIR)];
  return assetDomainFilesCache;
}

const sourceCache = new Map<string, string>();
function readSource(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  sourceCache.set(file, text);
  return text;
}

/**
 * 去注释（保留换行 → 行号与原文一致）：注释里的 `'applied'`/比较式不算事实。
 * 逐字符状态机：块注释与行注释都按「不在字符串内」判定；模板串里的 `${}` 不展开
 * （注释写在 `${}` 里不会被剥离，属于保守方向，见文件头「残余风险」）。
 */
function stripComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i) + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      out[i] = ' '; out[i + 1] = ' ';
      i += 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function skipString(source: string, quoteIndex: number): number {
  const quote = source[quoteIndex];
  for (let i = quoteIndex + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === quote) return i;
  }
  return source.length - 1;
}

/** 分隔符配对（跳过字符串内容）：用来取函数体 / 接口体的真实范围。 */
function matchDelimiter(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(source, i); continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (!depth) return i;
    }
  }
  throw new Error(`源码扫描失败：${open}${close} 未闭合`);
}

function sliceFunctionBody(code: string, name: string): string {
  const head = new RegExp(`function[ \\t]+${name}[ \\t]*\\(`).exec(code);
  if (!head) throw new Error(`契约漂移：找不到函数 ${name}（断言按符号定位，不按行号）`);
  const paramsOpen = code.indexOf('(', head.index);
  const paramsClose = matchDelimiter(code, paramsOpen, '(', ')');
  const bodyOpen = code.indexOf('{', paramsClose);
  const bodyClose = matchDelimiter(code, bodyOpen, '{', '}');
  return code.slice(bodyOpen, bodyClose + 1);
}

/** 接口字段 → 声明类型（用于**派生**契约字段名，而不是手抄一个名字）。 */
function interfaceFieldTypes(code: string, name: string): Map<string, string> {
  const head = new RegExp(`interface[ \\t]+${name}[ \\t]*\\{`).exec(code);
  if (!head) throw new Error(`契约漂移：找不到接口 ${name}`);
  const open = code.indexOf('{', head.index);
  const close = matchDelimiter(code, open, '{', '}');
  const fields = new Map<string, string>();
  for (const line of code.slice(open + 1, close).split('\n')) {
    const match = /^[ \t]*(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)\??[ \t]*:[ \t]*(.+?);?[ \t]*$/.exec(line);
    if (match) fields.set(match[1], match[2].trim());
  }
  return fields;
}

interface SourceMatch { file: string; line: number; text: string }

/** 按文件收集匹配（附行号与原始行文本，失败信息能直接指出违规位置）。 */
function scan(files: readonly string[], pattern: RegExp): SourceMatch[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const hits: SourceMatch[] = [];
  for (const file of files) {
    const code = stripComments(readSource(rel(file)));
    const re = new RegExp(pattern.source, flags);
    for (const match of code.matchAll(re)) {
      const index = match.index ?? 0;
      const start = code.lastIndexOf('\n', index) + 1;
      const end = code.indexOf('\n', index);
      const line = code.slice(0, index).split('\n').length;
      hits.push({ file: rel(file), line, text: code.slice(start, end === -1 ? code.length : end).trim() });
    }
  }
  return hits;
}

function hitSummary(hits: readonly SourceMatch[]): string {
  return hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`).join('\n');
}

/** 「调用点」= 非函数声明处的 `name(`（`import { name }` 没有括号，不会误算）。 */
function callSites(code: string, name: string): number {
  return (code.match(new RegExp(`(?<!function\\s)${name}\\s*\\(`, 'g')) || []).length;
}

function filesWithCallSites(files: readonly string[], name: string): string[] {
  return files
    .filter((file) => callSites(stripComments(readSource(rel(file))), name) > 0)
    .map(rel)
    .sort();
}

/** 取 `export const NAME = ['a', 'b'] as const;` 的字面量（从常量取值，不抄名单）。 */
function stringLiteralsOfConst(code: string, name: string): string[] {
  const head = new RegExp(`const[ \\t]+${name}[ \\t]*=[ \\t]*\\[`).exec(code);
  if (!head) throw new Error(`契约漂移：找不到常量 ${name}——断言按符号定位，不按行号`);
  const close = matchDelimiter(code, code.indexOf('[', head.index), '[', ']');
  return [...code.slice(code.indexOf('[', head.index), close + 1).matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

/** 取类型里某字段的字符串字面量联合（`suggestedAction?: 'create' | 'update' | …`）。 */
function stringLiteralUnionOfField(code: string, field: string): string[] {
  const declaration = new RegExp(`\\b${field}\\??[ \\t]*:[^;]*;`).exec(code);
  if (!declaration) throw new Error(`契约漂移：找不到字段 ${field} 的字面量联合`);
  return [...declaration[0].matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

describe('T046 ① 两条沉淀线都经同一个准入门', () => {
  /** 允许写候选的 kstar 文件（唯一出口 + 零调用点的历史桥）：每项都必须给理由。 */
  const candidateWriteAllowlist: Array<{ file: string; why: string }> = [
    {
      file: F.direct,
      why: '两条沉淀线共用的**唯一候选出口**：`admitKstarProposals` 在此调用，`saveRecallCandidate` 排在它之后（放行的才落候选）。',
    },
    {
      file: F.bridge,
      why: '历史 drain 桥（`saveKstarCandidateProposals`）：`src/main` 内**零调用点**（下一条断言钉住），生产不可达；一旦被接线必须先接准入门。',
    },
  ];

  it('门的实现与调用点各只有一处，且两条线都路由到它', () => {
    const mainFiles = mainTsFiles();

    // 实现唯一：`function admitKstarProposals(` 只允许出现在 improvement-admission.ts。
    const implementations = mainFiles
      .filter((file) => /(?:async[ \t]+)?function[ \t]+admitKstarProposals[ \t]*\(/.test(stripComments(readSource(rel(file)))))
      .map(rel);
    expect(implementations, '准入门必须只有一处实现（第二套准入实现 = 漂移）')
      .toEqual([F.admission]);

    // 调用点唯一：`await admitKstarProposals(` 只允许出现在两条线共用的出口里。
    expect(filesWithCallSites(mainFiles, 'admitKstarProposals'), '准入门必须只有一处调用（第二处调用 = 长出第二个准入点）')
      .toEqual([F.direct]);

    // 需求级线：先建准入上下文，再走共用出口；自己不得写候选。
    const requirementLine = stripComments(readSource(F.requirementLine));
    expect(requirementLine, '需求级线必须建准入上下文（哪条线 + 采用证据范围）')
      .toContain('kstarPrecipitationAdmission(');
    expect(requirementLine, '需求级线必须走两条线共用的提交出口')
      .toContain('precipitateDirectExperienceFromSource(');
    expect(callSites(requirementLine, 'saveRecallCandidate'), '需求级线不得自己写候选（绕过出口 = 绕过准入）').toBe(0);
    expect(callSites(requirementLine, 'saveKstarCandidateProposals'), '需求级线不得改走历史桥').toBe(0);

    // 直通线（episode 级）：入口必须调共用出口。
    const direct = stripComments(readSource(F.direct));
    expect(direct, '直通线入口不得消失（两条线只剩一条 = 契约漂移）')
      .toContain('precipitateDirectExperienceAssets(');
    expect(sliceFunctionBody(direct, 'precipitateDirectExperienceAssets'), '直通线入口必须调两条线共用的提交出口')
      .toContain('precipitateDirectExperienceFromSource(');

    // kstar 域内允许写候选的文件 = 显式清单（新增第三个写入者 → 红）。
    const writers = kstarCandidateWriters();
    expect(writers, 'kstar 域内的候选写入者只有显式清单里的两个（新增写入者必须显式登记并说明它怎么过准入门）')
      .toEqual(candidateWriteAllowlist.map((entry) => entry.file).sort());
    for (const entry of candidateWriteAllowlist) {
      expect(entry.why.length, `${entry.file} 必须在允许清单里写清为什么允许`)
        .toBeGreaterThan(20);
    }

    // 历史桥必须保持不可达：否则它就是绕过准入门、不经 #1 出口的第二条候选写入路径。
    expect(callSites(stripComments(readSource(F.bridge)), 'saveKstarCandidateProposals'), '历史桥自身只有定义，没有自调用')
      .toBe(0);
    const bridgeCallers = filesWithCallSites(mainFiles, 'saveKstarCandidateProposals');
    expect(bridgeCallers, '历史桥一旦被生产调用 = 绕过准入门写候选（必须先接准入门再接线）').toEqual([]);
  });

  it('受控动作与两条线的来源都从导出常量派生（不另立一套名单）', () => {
    const admission = stripComments(readSource(F.admission));
    const gatedActions = stringLiteralsOfConst(admission, 'KSTAR_ADMISSION_GATED_ACTIONS');
    const sources = stringLiteralsOfConst(admission, 'KSTAR_ADMISSION_SOURCES');
    expect(gatedActions.length, '受控动作常量不得为空（空常量 = 门对所有提案都放行）').toBeGreaterThan(0);
    expect(sources.length, '来源常量不得为空').toBeGreaterThan(0);

    // 运行期判定集合必须由常量构造：另抄一份字面量数组就是「第二套名单」。
    expect(admission, '受控动作的运行期集合必须由常量构造').toContain('new Set<string>(KSTAR_ADMISSION_GATED_ACTIONS)');
    expect(admission, '来源的运行期集合必须由常量构造').toContain('new Set<string>(KSTAR_ADMISSION_SOURCES)');

    // 受控动作必须是提案契约里的动作：契约加了动作而门没跟上，门会对该类动作静默失效。
    const contractActions = stringLiteralUnionOfField(
      stripComments(readSource('src/main/features/kstar/types.ts')),
      'suggestedAction',
    );
    expect(contractActions.length, '无法从 KstarCandidateProposal 派生动作契约').toBeGreaterThan(0);
    for (const action of gatedActions) {
      expect(contractActions, `受控动作「${action}」不在 KstarCandidateProposal 的动作契约里——门会静默失效`)
        .toContain(action);
    }

    // 两条线声明的来源必须都在来源常量里：第三种来源 = 未登记的新沉淀线。
    const declaredSources = new Set<string>();
    for (const file of [F.requirementLine, F.direct]) {
      for (const match of stripComments(readSource(file)).matchAll(/source:[ \t]*'([a-z_]+)'/g)) {
        declaredSources.add(match[1]);
      }
    }
    expect([...declaredSources].sort(), '两条线声明的来源必须与 KSTAR_ADMISSION_SOURCES 一致（新来源 = 新沉淀线，必须先登记）')
      .toEqual([...sources].sort());
  });

  it('门不是死引用：出口真读放行结果，且写候选排在门之后', () => {
    const admission = stripComments(readSource(F.admission));
    // 字段名从接口派生：改名跟着改，删掉派生不出 → 报错（不是手抄的名字）。
    const resultFields = interfaceFieldTypes(admission, 'KstarAdmissionResult');
    const admittedFields = [...resultFields.entries()]
      .filter(([, type]) => type.includes('KstarCandidateProposal[]'))
      .map(([name]) => name);
    expect(admittedFields, '无法从 KstarAdmissionResult 派生「放行提案列表」字段——契约已变，请先核对准入门返回体')
      .toHaveLength(1);
    const admittedField = admittedFields[0];

    const exitBody = sliceFunctionBody(stripComments(readSource(F.direct)), 'precipitateDirectExperienceFromSource');
    const gateAt = exitBody.indexOf('admitKstarProposals(');
    const writeAt = exitBody.indexOf('saveRecallCandidate(');
    expect(gateAt, '唯一出口里必须有准入门调用').toBeGreaterThan(-1);
    expect(writeAt, '唯一出口里必须有候选写入').toBeGreaterThan(-1);
    expect(gateAt, '准入必须排在写候选之前（先过门再写）').toBeLessThan(writeAt);

    const between = exitBody.slice(gateAt, writeAt);
    expect(between, `门的放行结果必须被真读（\`.${admittedField}\`）——否则是死引用，门形同虚设`)
      .toContain(`.${admittedField}`);
    expect(between, '被拦的提案必须被跳过（continue），而不是照写不误').toContain('continue');
  });
});

describe('T046 ② 不存在第二处「采用判定」', () => {
  /** `'applied'` 字面量的显式允许清单：**每项都要说清它为什么不是第二套采用判定**。 */
  const appliedLiteralAllowlist: Array<{ file: string; why: string }> = [
    {
      file: F.usageReceipt,
      why: '权威口径本身（specs/011 定稿）：`status === \'applied\' && boundary === \'real\'` 的唯一判定在这里，读取一律走 `listAppliedUsageReceipts`。',
    },
    {
      file: F.taskClosure,
      why: '回执**写入侧**：把「宿主可观测到使用」记成 `applied`（配 `boundary: \'real\'`）；只写不判，不参与放行/产候选。',
    },
    {
      file: F.assetService,
      why: '资产详情的**用量计数**展示（按版本累计 `entry.applied`）；只影响界面效果列，不参与放行/产候选。',
    },
    {
      file: F.trace,
      why: '追踪面板的**状态映射**（回执状态 → ok/degraded 展示）；只读展示，不参与放行/产候选。',
    },
    {
      file: F.profileSync,
      why: '**另一个域**的状态枚举：画像投影 `ProjectionStatus`（把资产投影到画像记忆的执行结果），与「资产被采用」无关。',
    },
    {
      file: F.cleanupReport,
      why: '**另一个域**的状态枚举：大扫除条目的处置结果 `CleanupItemStatus`，与「资产被任务采用」无关。',
    },
  ];

  const APPLIED_LITERAL = /['"]applied['"]/g;
  /** 两条件并判（同行的 `applied` + `real`）：采用口径的形状本身，只允许权威处。 */
  const TWO_CONDITION = /=== 'applied'[^\n]*=== 'real'|=== 'real'[^\n]*=== 'applied'/g;

  it("'applied' 字面量只出现在显式清单里的文件，且只允许清单里的文件解释", () => {
    const files = assetDomainTsFiles();
    const hits = scan(files, APPLIED_LITERAL);
    const hitFiles = [...new Set(hits.map((hit) => hit.file))].sort();
    const allowed = appliedLiteralAllowlist.map((entry) => entry.file).sort();

    expect(hitFiles, `出现了清单外的 'applied' 判定（第二处采用判定）——若确属合法用途，请把它加进清单并写清理由：\n${hitSummary(hits)}`)
      .toEqual(allowed);

    // 清单不许腐烂：每项都必须仍然命中，且必须给理由。
    for (const entry of appliedLiteralAllowlist) {
      expect(entry.why.length, `${entry.file} 必须在清单里写清为什么允许`).toBeGreaterThan(20);
      expect(hitFiles, `${entry.file} 已不再命中 'applied'——清单过期，请删除该条（否则它会替未来的违规放行）`)
        .toContain(entry.file);
    }

    // 准入门自己不得重判状态：它必须委托权威口径读取。
    expect(hits.filter((hit) => hit.file === F.admission), '准入门不得自己判 `status === \'applied\'`（那是权威口径的职责）').toEqual([]);
    const admission = stripComments(readSource(F.admission));
    expect(admission, '准入门必须走 `listAppliedUsageReceipts` 读采用证据').toContain('listAppliedUsageReceipts(');
    expect(stripComments(readSource(F.usageReceipt)), '权威口径读取必须由 asset-usage-receipt.ts 导出')
      .toContain('export async function listAppliedUsageReceipts(');
  });

  it('两条件并判（applied + real）只有权威口径一处', () => {
    const hits = scan(assetDomainTsFiles(), TWO_CONDITION);
    expect(hits, `「applied + real」两条件并判只允许在权威口径里出现一处：\n${hitSummary(hits)}`)
      .toHaveLength(1);
    expect(hits[0].file).toBe(F.usageReceipt);

    // 同一行同时出现 `applied` 与 `boundary` = 自己重写采用判定的形状 → 只允许权威处。
    const sameLine = scan(assetDomainTsFiles(), APPLIED_LITERAL)
      .filter((hit) => hit.file !== F.usageReceipt && /boundary/.test(hit.text));
    expect(sameLine, `出现清单外文件里的「applied + boundary」同判形状（等于第二套采用判定）：\n${hitSummary(sameLine)}`)
      .toEqual([]);
  });
});

describe('T046 ③ 不存在第二处版本比对', () => {
  /** 版本比对允许处：每项都写清为什么它不是「第二套重检」。 */
  const versionCompareAllowlist: Array<{ file: string; currentVersionHits: number; why: string }> = [
    {
      file: F.assetService,
      currentVersionHits: 3,
      why: '资产版本链唯一 owner：① `updateAbilityAsset` 锁内 `expectedVersion` 重检（**唯一处**，specs/015 D9）；'
        + '② `rollbackAbilityAsset` 的「已经在目标版」no-op 判定 `current.version === toVersion`（版本链内部操作，不对外做重检）；'
        + '③ `setStatus` 锁内 `expectedVersion` 并发保护只约束暂停/恢复等状态操作，不重复准入重检。',
    },
  ];

  /** 拿「资产当前在用版」比大小（`current.version` / `currentVersion`）。 */
  const CURRENT_VERSION_COMPARE = /(?:currentVersion|current\.version)[ \t]*(?:!==|===)/g;
  /** 「期望/依据版本」标识符：参与比大小才算（见下）。 */
  const EXPECTATION_VERSION = /\b(?:expectedVersion|baselineVersion|targetVersionUsed)\b/;
  /** 只与 undefined/null/字符串字面量比 = 存在性检查或 `typeof` 类型守卫，不是版本比大小。 */
  const PRESENCE_OR_TYPE_COMPARE = /(?:!==|===)[ \t]*(?:undefined|null|'[^']*'|"[^"]*")/;

  /**
   * 「期望版本参与比大小」的行（**片段级**判定，避免手写正则漏形状——第一版就是
   * 只认「带接收者的 RHS」，漏掉 `liveVersion !== targetVersionUsed` 这种裸标识符）。
   * 按 `&&`/`||`/括号/逗号等切开后逐片段看：片段里有比较运算符 + 期望标识符，
   * 且不是纯粹的存在性/类型检查 → 命中。
   */
  function expectationCompareHits(): SourceMatch[] {
    const hits: SourceMatch[] = [];
    for (const file of assetDomainTsFiles()) {
      const code = stripComments(readSource(rel(file)));
      code.split('\n').forEach((line, index) => {
        const participates = line
          .split(/&&|\|\||[(),;{}?:]|=>/)
          .some((fragment) => (
            /(?:!==|===)/.test(fragment)
            && EXPECTATION_VERSION.test(fragment)
            && !PRESENCE_OR_TYPE_COMPARE.test(fragment)
          ));
        if (participates) hits.push({ file: rel(file), line: index + 1, text: line.trim() });
      });
    }
    return hits;
  }

  it('拿期望版本与当前在用版比大小的表达式只在 asset-service.ts', () => {
    const files = assetDomainTsFiles();
    const hits = scan(files, CURRENT_VERSION_COMPARE);
    const byFile = [...new Set(hits.map((hit) => hit.file))].sort();
    expect(byFile, `当前在用版比较出现在清单外文件（第二处重检）：\n${hitSummary(hits)}`)
      .toEqual(versionCompareAllowlist.map((entry) => entry.file).sort());
    for (const entry of versionCompareAllowlist) {
      expect(entry.why.length, `${entry.file} 必须在清单里写清为什么允许`).toBeGreaterThan(20);
      expect(hits.filter((hit) => hit.file === entry.file).length, `${entry.file} 的当前版比较处数变了——新增比较必须先说明它不是第二套重检`)
        .toBe(entry.currentVersionHits);
    }

    // 内容更新准入与状态变更并发保护各有一处，二者都在 asset-service 的写锁内。
    const expectationHits = expectationCompareHits();
    expect(expectationHits, `期望版本比较只允许在资产服务内的内容更新和状态变更：\n${hitSummary(expectationHits)}`)
      .toHaveLength(2);
    expect(expectationHits.every((hit) => hit.file === F.assetService)).toBe(true);
    expect(expectationHits.every((hit) => hit.text.includes('current.version !== input.expectedVersion'))).toBe(true);
  });

  it('唯一那处判定在 updateAbilityAsset 的锁内（检查与写入同一把锁）', () => {
    const code = stripComments(readSource(F.assetService));
    const body = sliceFunctionBody(code, 'updateAbilityAsset');
    expect(body, '重检必须在 updateAbilityAsset 内').toContain('current.version !== input.expectedVersion');
    const lockAt = body.indexOf("updateRecallJsonRecord(userId, 'ability-assets', assetId,");
    const checkAt = body.indexOf('current.version !== input.expectedVersion');
    expect(lockAt, 'updateAbilityAsset 必须走资产写锁').toBeGreaterThan(-1);
    expect(checkAt, '版本判定必须落在写锁回调**内部**（先锁后比，不存在比对与写入之间的窗口）')
      .toBeGreaterThan(lockAt);

    const statusBody = sliceFunctionBody(code, 'setStatus');
    expect(statusBody, '状态变更的乐观并发保护必须留在 setStatus 内').toContain('current.version !== input.expectedVersion');
    const statusLockAt = statusBody.indexOf("updateRecallJsonRecord(userId, 'ability-assets', assetId,");
    const statusCheckAt = statusBody.indexOf('current.version !== input.expectedVersion');
    expect(statusLockAt, 'setStatus 必须走资产写锁').toBeGreaterThan(-1);
    expect(statusCheckAt, '状态版本判定必须发生在写锁回调内部').toBeGreaterThan(statusLockAt);

    // 候选路径与审批路径只把基线交给这一个地方，自己不写第二处比对。
    const allExpectationHits = expectationCompareHits();
    for (const file of [F.candidateService, F.approvalService]) {
      const consumer = stripComments(readSource(file));
      expect(consumer, `${file} 必须把比对基线交给 updateAbilityAsset`).toContain('expectedVersion');
      expect(scan([path.join(repoRoot, file)], CURRENT_VERSION_COMPARE), `${file} 不得自己比当前在用版`)
        .toEqual([]);
      const ownExpectationHits = allExpectationHits.filter((hit) => hit.file === file);
      expect(ownExpectationHits, `${file} 不得自己拿期望版本比大小`).toEqual([]);
    }
  });
});

describe('T046 ④ tool-catalog 未新增 recall 组工具', () => {
  /**
   * 冻结基线（= 2 个既有 + 资产管家 9 个 + 经验目录 2 个只读）。口径与
   * `asset-steward-tools.test.ts` 的「3 读 + 6 写」一致（那一份按工厂名清单钉死，
   * 这里钉 catalog 的 recall 组面）。新增/删除任何一项都必须先与 owner 确认，再改这里。
   * 2026-09-25 +2：specs/016 T024 的 list_task_experiences / read_task_experience
   * （2 读 0 写、⊄只读白名单，另有 experience-tools.test.ts 钉行为）——Backlog
   * Epic 8 规格内的合法扩张，非口径漂移。
   * 2026-09-28 +1：list_ontology_graph（本体图谱只读工具）——09-27 本体切片
   * 已在工厂（personal-ontology-tools）与 catalog 双侧注册、行为测试在
   * personal-ontology-tools.test.ts，本基线随树重算补登记。
   */
  const RECALL_GROUP_BASELINE = [
    'personal_ontology_fields',
    'search_ability_assets',
    'list_task_experiences',
    'read_task_experience',
    'list_ontology_graph',
    'list_ability_assets',
    'read_ability_asset',
    'list_asset_change_proposals',
    'edit_ability_asset',
    'merge_ability_assets',
    'archive_ability_asset',
    'delete_ability_asset',
    'restore_ability_asset',
    'rollback_ability_asset',
  ];

  it('catalog 的 recall 组 = 三个工厂的实际工具面 = 冻结基线', () => {
    const catalogRecall = TOOL_CATALOG.filter((entry) => entry.group === 'recall').map((entry) => entry.name);
    const factoryNames = [
      ...createRecallTools({ userId: 'admission-guard' }),
      ...createAssetStewardTools({ userId: 'admission-guard' }),
      ...createPersonalOntologyTools({ userId: 'admission-guard' }),
      ...createExperienceTools({ userId: 'admission-guard' }),
    ].map((tool) => tool.name);

    expect([...catalogRecall].sort(), 'recall 组新增/删除了工具——「不新增模型工具」是 specs/015 D15 的硬约束，确要变更先找 owner')
      .toEqual([...RECALL_GROUP_BASELINE].sort());
    expect(factoryNames.length, '工厂产出的工具名不得重复').toBe(new Set(factoryNames).size);
    expect([...factoryNames].sort(), 'catalog 的 recall 组必须与三个工厂的实际工具面逐一对上（缺一行/多一行都要红）')
      .toEqual([...RECALL_GROUP_BASELINE].sort());
  });
});

/** kstar 域里出现候选写调用的文件（`saveRecallCandidate` / 历史桥）。 */
function kstarCandidateWriters(): string[] {
  const writers = new Set<string>();
  for (const file of listTsFiles(KSTAR_DIR)) {
    const code = stripComments(readSource(rel(file)));
    if (callSites(code, 'saveRecallCandidate') > 0 || callSites(code, 'saveKstarCandidateProposals') > 0) {
      writers.add(rel(file));
    }
  }
  return [...writers].sort();
}
