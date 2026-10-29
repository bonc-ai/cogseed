/**
 * 单一实现边界：依据源码检查写入、采用判定、版本比对和工具目录。
 *
 * 检查四条约束：
 *   ① KSTAR历史适配器保留结果兼容，域内没有认知候选/资产/经验写入调用。
 *   ② 不存在第二处「采用判定」：`'applied'` 字面量只允许出现在显式清单里的文件
 *      （写入侧 / 展示侧 / 另一个域的枚举），且**两条件并判**（`applied` + `real`）
 *      只允许在权威口径 `asset-usage-receipt.ts` 里；准入门自己不得重判状态。
 *   ③ 不存在第二处版本比对：拿「期望/依据版本」与资产**当前在用版**比大小的表达式
 *      只允许在 `asset-service.ts`；且那处判定必须在 `updateAbilityAsset` 的
 *      **锁内**（`updateRecallJsonRecord` 回调里）。
 *   ④ `tool-catalog.ts` 未新增 recall 组工具：catalog 的 recall 组与三个工厂
 *      （`createRecallToolSuite` / `createAssetStewardTools` / `createPersonalOntologyTools`）
 *      的工具面一致，且等于下面的冻结基线。
 *
 * 派生而非抄名单：
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
import { describe, expect, it, vi } from 'vitest';

import { createAssetStewardTools } from '../../../../src/main/model/core-agent/asset-steward-tools';
import { createPersonalOntologyTools } from '../../../../src/main/model/core-agent/personal-ontology-tools';
import { createCognitionKernelTools } from '../../../../src/main/model/core-agent/cognition-kernel-tools';
import { createCognitionCreateTools } from '../../../../src/main/model/core-agent/cognition-create-tools';
import { createCognitionEditTools } from '../../../../src/main/model/core-agent/cognition-edit-tools';
import { createMeetingOntologyTools } from '../../../../src/main/model/core-agent/meeting-ontology-tools';
import { createRecallToolSuite } from '../../../../src/main/model/core-agent/recall-tools';
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
  usageClaim: 'src/main/features/recall/asset-usage-claim.ts',
  assetService: 'src/main/features/recall/asset-service.ts',
  candidateService: 'src/main/features/recall/candidate-service.ts',
  automaticPolicy: 'src/main/features/recall/nightly-automatic-approval.ts',
  automaticSupport: 'src/main/features/recall/nightly-automatic-support.ts',
  standingAuthority: 'src/main/features/recall/standing-preference-authority.ts',
  automaticFormationUndo: 'src/main/features/recall/automatic-formation-undo.ts',
  outputCheck: 'src/main/features/recall/cognition-output-check.ts',
  approvalService: 'src/main/features/recall/asset-approval-service.ts',
  profileSync: 'src/main/features/recall/personal-profile-sync.ts',
  cleanupReport: 'src/main/features/recall/cleanup-report-service.ts',
  contentOrganization: 'src/main/features/recall/content-organization.ts',
  feedbackVersionContext: 'src/main/features/recall/feedback-version-context.ts',
  captureService: 'src/main/features/recall/capture-service.ts',
  stockProvenance: 'src/main/features/recall/stock-organization-provenance.ts',
  stockOrganization: 'src/main/features/recall/stock-organization.ts',
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
    // Regex literals can contain quotes (`/["\\u0000-\\u001f]/`); treating the
    // quote as a string start swallows a following block comment. A slash after
    // an operator/opening token starts a regex; a slash after a value is division.
    if (ch === '/' && /[=(:,[!&|?{};>]/.test(previousSignificant(source, i))) {
      i = skipRegex(source, i) + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function previousSignificant(source: string, index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!/\s/.test(source[i])) return source[i];
  }
  return '';
}

function skipRegex(source: string, slashIndex: number): number {
  let inClass = false;
  for (let i = slashIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let end = i + 1;
      while (/[a-z]/i.test(source[end] || '')) end += 1;
      return end - 1;
    } else if (ch === '\n') return i;
  }
  return source.length - 1;
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

describe('① 两条沉淀线都经同一个准入门', () => {
  /** 允许写候选的 kstar 文件（唯一出口 + 零调用点的历史桥）：每项都必须给理由。 */
  // 2026-10-07 收敛（SPEC §3 提取管线唯一）：kstar 域不再直调
  // `saveRecallCandidate`——KSTAR 的候选提交是统一提取管线（cognition/
  // candidate-submission → routeAndSubmit）的子线程/适配器。白名单随之
  // 清空：直调本身就是漂移，不再需要"允许的直调者"。
  const candidateWriteAllowlist: Array<{ file: string; why: string }> = [];

  it('KSTAR兼容适配器没有认知写调用，隔离开关不能恢复旧写线', async () => {
    const kstarFiles = mainTsFiles().filter(file => rel(file).startsWith('src/main/features/kstar/'));
    for (const name of ['saveRecallCandidate', 'submitCognitionCandidate', 'autoApplyRecallCandidate', 'createAbilityAsset', 'createExperience']) {
      expect(filesWithCallSites(kstarFiles, name), `KSTAR不得调用认知写口 ${name}`).toEqual([]);
    }
    expect(kstarCandidateWriters()).toEqual(candidateWriteAllowlist.map(entry => entry.file).sort());
    for (const file of [F.direct, F.bridge]) expect(stripComments(readSource(file))).not.toContain('cognitionIntegrationIsolated');
    const bridge = await import('../../../../src/main/features/kstar/recall-bridge');
    expect(await bridge.saveKstarCandidateProposals('adapter-user', [{ judgment: 'Do not write this task lesson.' } as never])).toEqual([]);
    const direct = await import('../../../../src/main/features/kstar/direct-experience-assets');
    const empty = { createdAssetIds: [], candidateIds: [], experienceIds: [], mergedIntoIds: [], updateCandidateIds: [], failureIds: [] };
    expect(await direct.precipitateDirectExperienceAssets('adapter-user', { id: 'adapter-episode' } as never, [{} as never])).toEqual(empty);
    expect(await direct.precipitateDirectExperienceFromSource('adapter-user', { id: 'adapter-source' }, [{} as never], {} as never, {} as never)).toEqual(empty);
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
    for (const source of declaredSources) expect(sources, '既有任务线来源必须已登记').toContain(source);
  });


});

describe('② 不存在第二处「采用判定」', () => {
  /** `'applied'` 字面量的显式允许清单：**每项都要说清它为什么不是第二套采用判定**。 */
  const appliedLiteralAllowlist: Array<{ file: string; why: string }> = [
    {
      file: F.outputCheck,
      why: '最终结果遵从检查的回执写入侧：根据已保存结果与真实供应版本写observed usage，不读取或解释既有applied回执，不产生效果实证。',
    },
    {
      file: F.usageClaim,
      why: '显式采用报告的写入侧：绑定当轮真实供应版本和最终消息后，调用权威回执服务写入；不解释已有回执，不参与候选准入或效果验证。',
    },
    {
      file: F.usageReceipt,
      why: '`status === \'applied\' && boundary === \'real\'` 的判定在这里，读取走 `listAppliedUsageReceipts`。',
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
    {
      file: F.candidateService,
      why: '**另一个域**的状态枚举：候选记录启动迁移的逐条日志状态（applied/current/failed/blocked/missing），与资产采用判定和准入无关。',
    },
    {
      file: F.contentOrganization,
      why: '**另一个域**的执行结果：候选内容组织/整理的回执状态，表示组织动作是否已提交，不读取采用回执也不决定资产准入。',
    },
  ];

  const APPLIED_LITERAL = /['"]applied['"]/g;
  const isUsageDecision = (line: string) => /boundary/.test(line)
    && /(?:={2,3}|!={1,2})\s*['"]applied['"]|['"]applied['"]\s*(?:={2,3}|!={1,2})/.test(line);
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
      .filter((hit) => hit.file !== F.usageReceipt && isUsageDecision(hit.text));
    expect(sameLine, `出现清单外文件里的「applied + boundary」同判形状（等于第二套采用判定）：\n${hitSummary(sameLine)}`)
      .toEqual([]);
  });

  it('赋值写入不算采用判定，状态比较和边界同判仍受守卫约束', () => {
    expect(isUsageDecision("status: 'applied', boundary: 'real'")).toBe(false);
    expect(isUsageDecision("receipt.status === 'applied' && receipt.boundary === 'real'")).toBe(true);
    expect(isUsageDecision("receipt.status == 'applied' && receipt.boundary != 'test-double'")).toBe(true);
  });
});

describe('③ 不存在第二处版本比对', () => {
  /** 版本比对允许处：每项都写清为什么它不是「第二套重检」。 */
  const versionCompareAllowlist: Array<{ file: string; currentVersionHits: number; why: string }> = [
    {
      file: F.feedbackVersionContext,
      currentVersionHits: 1,
      why: '夜间反馈的只读上下文标注：把反馈版本与当前在用版比较后标成 current/historical，仅用于展示与后续复盘，不校验调用方基线、不做准入重检、不写资产。',
    },
    {
      file: F.captureService,
      currentVersionHits: 1,
      why: '夜间形成反馈的只读版本标注：把已评估的历史版本与快照中的当前版比较后标成 current/historical，仅用于提示与复盘，不校验提交基线、不做准入重检、不写资产。',
    },
    {
      file: F.assetService,
      currentVersionHits: 7,
      why: '资产版本链入口：① `updateAbilityAsset` 锁内 `expectedVersion` 重检；'
        + '② `rollbackAbilityAsset` 的「已经在目标版」no-op 判定 `current.version === toVersion`（版本链内部操作，不对外做重检）；'
        + '③ `setStatus` 锁内 `expectedVersion` 并发保护只约束暂停/恢复等状态操作，不重复准入重检；'
        + '④ 同一更新写锁内核对宿主私有长期偏好审阅凭证的版本基线，只绑定原子凭证，不增加保存入口或另一处用户CAS；'
        + '⑤⑥ 成熟度推进与验证计数在此唯一 owner 写锁内核对实际成果版本，防止旧证明归到新版；'
        + '⑦ 暂停/重做推荐在同一 owner 写锁内绑定实际反馈版本，不另建保存或准入重检入口。',
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

  it('提交版本判断只在资产服务；自动确认可读基线预检，仍交由同一写锁复核', () => {
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

    // 两处用户内容/状态CAS及三处成果版本绑定都在资产唯一 owner 写锁内。
    const expectationHits = expectationCompareHits();
    const commitHits = expectationHits.filter(hit => hit.file === F.assetService);
    expect(commitHits).toHaveLength(5);
    const userCasHits = commitHits.filter(hit => hit.text.includes('throw') === false
      && hit.text.includes('current.version !== input.expectedVersion') && !hit.text.includes('return current'));
    expect(userCasHits).toHaveLength(2);
    const outcomeCasHits = commitHits.filter(hit => hit.text.includes('return current'));
    expect(outcomeCasHits).toHaveLength(3);
    // 当前在用版由 activeVersionOf() 统一收口（activeVersion || version），
    // 不能因为辅助函数抽取而把三处成果绑定当成缺失。
    expect(outcomeCasHits.every(hit => hit.text.includes('activeVersionOf(current) !== expectedVersion')
      || hit.text.includes('activeVersionOf(current) !== input.expectedVersion')),
      `成果版本绑定必须以当前在用版为基线：\n${outcomeCasHits.map(hit => `${hit.line} ${hit.text}`).join('\n')}`).toBe(true);
    const policyHits = expectationHits.filter(hit => hit.file === F.automaticPolicy);
    expect(policyHits).toHaveLength(1);
    const supportHits = expectationHits.filter(hit => hit.file === F.automaticSupport);
    expect(supportHits).toHaveLength(1);
    expect(supportHits.every(hit => hit.text.includes('targetVersionUsed'))).toBe(true);
    const historicalProofHits = expectationHits.filter(hit => hit.file === F.standingAuthority);
    expect(historicalProofHits).toHaveLength(1);
    expect(historicalProofHits[0].text).toContain('candidate.targetVersionUsed !== proof.previousVersion');
    // This compares the two immutable historical anchors of a committed proof.
    // It does not compare a supplied baseline with the currently active asset.
    // Live version comparisons remain confined to the asset owner above.
    // Independent model observations bind their proof to the exact read target.
    // They cannot mutate assets or promote candidates; authoritative version
    // validation still runs once inside the asset service's write lock.
    // Undo 的版本比较只把候选记录的**历史锚点**与当前版比「是否同一版」：
    // 回退目标必须严格早于当前版（回退到当前版不是撤销），它不校验任何
    // 调用方提供的基线、不做准入重检，实际回退仍走资产 owner 的回退写锁。
    const undoHits = expectationHits.filter(hit => hit.file === F.automaticFormationUndo);
    expect(undoHits).toHaveLength(1);
    // 其余三处只比对已冻结的历史锚点/准备快照：形成复检把候选记录的
    // targetVersionUsed 与准备时的版本对齐（capture-service），stock 组织
    // 重放要求提交的 targetVersionUsed 与 job.prepared 完全一致（provenance），
    // 本体命令则绑定 job 内记录的 expectedVersion（stock-organization）。
    // 它们都不读取资产当前在用版，也不承担准入重检。
    expect(expectationHits.every(hit => [F.assetService, F.automaticPolicy, F.automaticSupport, F.standingAuthority,
      F.automaticFormationUndo, F.captureService, F.stockProvenance, F.stockOrganization].includes(hit.file as typeof F.assetService)), hitSummary(expectationHits)).toBe(true);
    const standingCode = stripComments(readSource(F.standingAuthority));
    expect(standingCode).not.toMatch(/\b(?:createAbilityAsset|updateAbilityAsset|promoteRecallCandidate|persistCognitionSource|writeRecallJsonRecord|updateRecallJsonRecord)\s*\(/);
    const supportCode = stripComments(readSource(F.automaticSupport));
    expect(supportCode).not.toMatch(/\b(?:createAbilityAsset|updateAbilityAsset|promoteRecallCandidate|revokeAbilityAsset|deleteAbilityAsset|rollbackAbilityAsset|withOntologyFormationPromotion|persistCognitionSource)\s*\(/);
    expect(supportCode).not.toMatch(/\bupdateRecallJsonRecord\s*\(/);
    // Both persistence calls are audit/observation stores: the compact support
    // receipt and the reusable source observation. Neither writes an asset or
    // opens a second publication gateway.
    expect(supportCode).toContain("const COLLECTION = 'automatic-source-support'");
    expect([...supportCode.matchAll(/\bwriteRecallJsonRecord\s*\(/g)]).toHaveLength(2);
    expect(supportCode).toMatch(/\bwriteRecallJsonRecord\s*\(\s*userId,\s*COLLECTION,\s*id,\s*receipt\s*\)/);
    expect(supportCode).toMatch(/\bwriteRecallJsonRecord\s*\(\s*userId,\s*OBSERVATIONS,\s*observation\.id,\s*observation\s*\)/);
    const policyBody = sliceFunctionBody(stripComments(readSource(F.automaticPolicy)), 'evaluateNightlyAutomaticApproval');
    expect(policyBody).not.toMatch(/(?:updateAbilityAsset|promoteRecallCandidate|writeRecallJsonRecord|updateRecallJsonRecord)\s*\(/);
    expect(policyHits.every(hit => hit.text.includes('targetVersionUsed'))).toBe(true);
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
    const standingAt = body.indexOf('current.version !== standingBaseline.version');
    expect(standingAt, '宿主授权版本同样只由资产服务在同一写锁内核对').toBeGreaterThan(lockAt);
    expect(body.indexOf('attachStandingPreferenceAuthority(', standingAt)).toBeGreaterThan(standingAt);

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

describe('④ tool-catalog recall 组工具面受控扩展', () => {
  /**
   * 工具名基线与工厂输出保持一致。工具增删须更新工厂、catalog 和行为测试。
   * 关系查询返回关系证据与元数据，不读取资产正文。
   */
  const RECALL_GROUP_BASELINE = [
    // 冻结工具名称与工厂保持对应，覆盖保存和采用入口，排除已退役的形成入口。
    'report_ability_asset_usage',
    'personal_ontology_fields',
    // develop 会议本体线：两个 in-process 工厂工具 + 一个 Runtime 主机别名。
    'ontology_graph_read',
    'ontology_projection_apply',
    'list_ontology_graph',
    'personal_fields_check',
    'cognition_ontology_query',
    'transcript_corrections_query',
    'search_ability_assets',
    'ontology_query',
    'list_task_experiences',
    'read_task_experience',
    'list_ability_assets',
    'read_ability_asset',
    'list_asset_change_proposals',
    'create_cognition',
    'edit_cognition',
    'edit_ability_asset',
    'merge_ability_assets',
    'archive_ability_asset',
    'delete_ability_asset',
    'restore_ability_asset',
    'rollback_ability_asset',
  ];

  // `list_ontology_graph` is a host-facing legacy name (the Runtime mapping
  // replaces it with ontology_graph_read); it has no in-process factory, so it
  // is frozen in the catalog baseline but is not part of the factory surface.
  const CATALOG_ONLY_RECALL_TOOLS = ['list_ontology_graph'];

  it('catalog 的 recall 组 = 工厂的实际工具面 + 已登记主机别名 = 冻结基线', () => {
    const catalogRecall = TOOL_CATALOG.filter((entry) => entry.group === 'recall').map((entry) => entry.name);
    // ontology_query is opt-in at runtime. This contract checks the complete
    // catalog surface, so only its factory enumeration enables Semantica.
    vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '1');
    let factoryNames: string[];
    try {
      factoryNames = [
        ...createRecallToolSuite({ userId: 'admission-guard', turnId: 'guard-turn', onAssetUsageClaim: () => {} }).tools,
        ...createAssetStewardTools({ userId: 'admission-guard' }),
        ...createPersonalOntologyTools({ userId: 'admission-guard' }),
        ...createExperienceTools({ userId: 'admission-guard' }),
        ...createCognitionKernelTools({ userId: 'admission-guard', cid: 'authorized-conversation' }),
        ...createCognitionCreateTools({ userId: 'admission-guard', cid: 'authorized-conversation' }),
        ...createCognitionEditTools({ userId: 'admission-guard', cid: 'authorized-conversation' }),
        ...createMeetingOntologyTools({ userId: 'admission-guard', cid: 'authorized-conversation' }),
      ].map((tool) => tool.name);
    } finally {
      vi.unstubAllEnvs();
    }

    expect([...catalogRecall].sort(), 'recall 组工具集合必须等于已登记能力')
      .toEqual([...RECALL_GROUP_BASELINE].sort());
    expect(factoryNames.length, '工厂产出的工具名不得重复').toBe(new Set(factoryNames).size);
    const factoryBaseline = RECALL_GROUP_BASELINE.filter((name) => !CATALOG_ONLY_RECALL_TOOLS.includes(name));
    expect([...factoryNames].sort(), 'catalog 的 recall 组必须与各工厂的实际工具面逐一对上（缺一行/多一行都要红）')
      .toEqual([...factoryBaseline].sort());
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
