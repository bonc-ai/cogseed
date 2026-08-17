import { createLogger } from '../../logger';
import type { KstarCandidateProposal } from './types';

const log = createLogger('kstar.personal-assets');

/**
 * KStar → 「关于我」独立资产链路（2026-08-17，方案 C）。
 *
 * 背景：spec(3) 四视图「我的资产」包含「关于我」（personal）类型，但 KStar
 * 复盘线（gapType 只在 attribution=knowledge_gap 时返回 personal）从不产
 * personal 候选——用户长期偏好（"我以后的周报都要按这个格式"）被落成 rule
 * 或 template，或丢失。
 *
 * 本模块：任务闭环沉淀时，确定性扫描会话用户消息的长期偏好陈述，产 personal
 * 候选（suggestedType='personal', scope='personal'）→ 走统一候选池 → 用户
 * 「待我处理」确认 → 晋升为「关于我」正式资产（四视图可管理：版本/暂停/回滚）。
 *
 * 与 personal-profile-sync（方案 B，写 USER.md 画像）互补：
 *  - 方案 B：模型提名 lessonPersonal + 确定性校验 → 写 USER.md（画像注入）
 *  - 方案 C：确定性检测用户消息长期偏好 → personal 候选 → 独立资产
 * 两者都保留；方案 C 提供四视图中可管理的资产形态。
 *
 * 防误判（复用 capture 线既有语义）：
 *  - 一次性请求（今天/帮我/本周…）→ 不产
 *  - 项目事实（本周上线支付网关…）→ 不产
 *  - 重复偏好 → 语义查重/指纹去重合并
 */

/** 长期偏好陈述（用户原话层，确定性）。覆盖周报场景真实说法： */
export const PERSONAL_EVIDENCE = /(?:我以后的?[^，。！？]{0,14}(?:都要|都用|都按|都|要|就|会)|我以后(?:都|要|就|会)|以后(?:都|要|就|会)|我的[^，。！？]{0,14}(?:都要|习惯|偏好|风格|身份|角色)|我(?:的)?(?:风格|习惯|偏好|身份|角色|长期|一直|向来|通常|总是|每次都)|我(?:是|担任|负责)[^，。！？]{0,20}(?:团队|负责人|主管|经理|工程师|开发|设计|财务|运营)|我希望(?:以后|今后|未来|每次)|我喜欢|我不喜欢)/;

/** 一次性请求强信号（防误判）：只检查偏好句本身。注意不含"本周/这周/下周"
 *  ——"本周完成"是周报模板段落名，误伤会拦掉真实偏好。 */
const TRANSIENT = /(?:今天|今日|昨天|明天|本月|这次|本次|当前|目前|正在|眼下|帮我|请帮我|麻烦你|截止|deadline|会议|日程)/;

/** 从用户消息中提取长期偏好陈述（去重保序，最多 3 条）。 */
export function extractPersonalStatements(
  userMessages: ReadonlyArray<{ text?: string }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of userMessages) {
    const text = String(message.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // 找到偏好句子的起点：从命中的长期表达开始截取到句末。
    const match = PERSONAL_EVIDENCE.exec(text);
    if (!match) continue;
    const start = match.index;
    const sentence = text.slice(start).split(/[。！？\n]/)[0].trim().slice(0, 200);
    if (!sentence || seen.has(sentence)) continue;
    // 只检查偏好句本身是否含一次性强信号——消息其他部分的"帮我"不影响。
    if (TRANSIENT.test(sentence)) continue;
    seen.add(sentence);
    out.push(sentence);
    if (out.length >= 3) break;
  }
  return out;
}

/** 产 personal 候选（复用统一候选池的 proposal 形状）。 */
export function personalStatementsToProposals(
  statements: string[],
  sourceRefs: KstarCandidateProposal['sourceRefs'],
): KstarCandidateProposal[] {
  return statements.map((statement) => ({
    judgment: statement,
    summary: statement.slice(0, 80),
    uncertainty: '基于用户长期偏好陈述生成，使用前可复核。',
    suggestedType: 'personal',
    suggestedScope: 'personal',
    suggestedAction: 'create',
    sourceRefs,
    learningSignal: {
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'met_expected',
      confidence: 0.9,
      source: 'review',
    },
  }));
}

/**
 * 主题词提取：从句子中提取核心主题名词（≥2 字的词，去掉通用动词/连接词）。
 * 用于跨类型去重的第二层——语义查重（0.85）对"同主题不同措辞"失效
 * （实测：用户原话 vs 模型提炼相似度 <0.85），主题词重叠兜底。
 */
const THEME_STOPWORDS = /(?:我|我们|以后|都要|都用|都按|这个|格式|模板|结构|固定|采用|先按|再给|然后|以及|或者|需要|应该|应当|可以|不要|不能|必须|会|要|按|用|的|了|着|是|在|把|给|请|帮我|写|做|生成|制作|汇报|风险|阻塞|计划|完成|数据|指标|本周|下周|每月|每周|每次|时|中|里|内|上|下)/g;

/** 提取句子的核心名词 token（去停用词后按非词边界拆分，保留 ≥2 字片段）。 */
export function themeTerms(text: string): Set<string> {
  const cleaned = String(text || '')
    .replace(THEME_STOPWORDS, ' ')
    .replace(/[，。！？、：；「」『』（）()【】\d.\s]/g, ' ');
  const terms = new Set<string>();
  for (const chunk of cleaned.split(/\s+/)) {
    const stripped = chunk.replace(/[^\u4e00-\u9fffA-Za-z]/g, '');
    if (stripped.length >= 2) terms.add(stripped);
  }
  return terms;
}

/** 主题重叠：personal 偏好句与已有表达是否同主题。语义查重对"同主题不同
 *  措辞"失效（实测 <0.85），这里用核心名词**子串包含**兜底——"周报" ⊂
 *  "团队周报" 即视为同主题。 */
export function sharesTheme(preference: string, existing: string): boolean {
  const pref = themeTerms(preference);
  const ex = themeTerms(existing);
  for (const term of pref) {
    for (const other of ex) {
      if (term.length >= 2 && other.length >= 2 && (other.includes(term) || term.includes(other))) {
        return true;
      }
    }
  }
  return false;
}
