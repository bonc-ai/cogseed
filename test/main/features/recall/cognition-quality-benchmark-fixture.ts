/** Fixed synthetic benchmark v1. All personal names and forms of address are fictional.
 * Labels precede execution; never remove a failure or tune labels/thresholds
 * after seeing a model/ranking result.
 * Assets are authored retrieval fixtures, not claimed model formations. */
export const QUALITY_BENCHMARK_VERSION = 'cognition-quality-v1-20261015';
export const QUALITY_TARGETS = Object.freeze({ formationRecall: 0.95, formationPrecision: 0.95, recallAt5: 0.90, unauthorizedHits: 0 });
export type QualityStratum = 'preference' | 'template' | 'method' | 'lesson' | 'fact';
export const RETRIEVAL_ASSETS: Array<{ id: string; stratum: QualityStratum; title: string; statement: string; queries: string[] }> = [
  { id: 'qa-pref-conclusion', stratum: 'preference', title: '技术说明先结论', statement: '解释复杂技术问题时，先给主要结论，再说明证据与推理依据。不要先铺很长的背景。', queries: ['复杂技术问题怎样说明结论与依据？', '向我解释原理时，别等长篇背景结束才说重点。', '请说明数据库连接为什么超时，按我习惯的表达顺序组织。', '技术说明开头应怎样安排重点？'] },
  { id: 'qa-pref-uncertainty', stratum: 'preference', title: '估算明确不确定性', statement: '提供工期估算时，分别列出已知事实、假设和未知项，不能把推测写成确定承诺。', queries: ['工期估算要说明哪些未知项？', '排期数字里哪些是事实，哪些还只是猜测？', '这项迁移多久能完？请把你没把握的部分说清楚。', '承诺交付日期以前怎样交代估计前提？'] },
  { id: 'qa-pref-briefing', stratum: 'preference', title: '管理汇报短而可行动', statement: '给管理者的项目汇报先写需要决定的事项、主要风险和下一步责任人，技术细节放到附录。', queries: ['管理者项目汇报如何组织？', '老板只看一分钟，应先看到哪些要拍板的内容？', '帮我整理给负责人的进展，不要让技术细节盖住行动。', '高层进度材料的正文与附录怎么分？'] },
  { id: 'qa-pref-review', stratum: 'preference', title: '评审指出具体问题', statement: '评审方案时直接指出具体缺陷、影响和可行替代，不用泛泛表扬代替判断。', queries: ['方案评审应给出缺陷影响和替代', '不要只说做得不错，告诉我哪里不成立以及怎么改。', '请评价这份架构提案，给能执行的改进。', '审阅设计时怎样避免空泛赞美？'] },
  { id: 'qa-tpl-meeting', stratum: 'template', title: '项目会议五要素', statement: '项目会议会前材料列出会议目标、背景事实、待决策问题、负责人和下一步行动，使参会者事先查证据并明确责任。', queries: ['项目会议材料五要素', '开会前发什么，才能让大家提前准备并知道谁拍板？', '下周要讨论项目部署，请搭好会前资料的框架。', '只有议题的邀请太空，会议准备还缺哪些部分？'] },
  { id: 'qa-tpl-incident', stratum: 'template', title: '故障复盘结构', statement: '故障复盘记录影响范围、关键时间线、直接原因、根因、处置措施和带负责人及期限的改进项，避免只归责个人。', queries: ['故障复盘记录哪些内容？', '事故过去后，怎样把发生经过与防再发措施写完整？', '昨天服务中断，帮我组织复盘而不是找人背锅。', '事故总结怎样把修复行动落实到人和时间？'] },
  { id: 'qa-tpl-experiment', stratum: 'template', title: '实验记录模板', statement: '实验记录保留假设、数据版本、对照设置、评价指标、原始结果与结论，使他人能重复实验。', queries: ['可重复实验的记录模板', '为了以后复现，试验笔记除了结论还要留下什么？', '这次算法对比做完了，帮我整理研究记录。', '怎样记录数据和基线而不只记最好分数？'] },
  { id: 'qa-tpl-release', stratum: 'template', title: '发布检查清单', statement: '发布清单包含变更范围、兼容性、数据迁移、监控指标、停止条件和回退方案；放行前明确各项责任人。', queries: ['发布检查清单与回退', '上线前除功能通过以外，还要确认哪些退出机制？', '周五准备交付新版本，给一份能逐项签认的清单。', '发版审批需要哪些监控与停止条件？'] },
  { id: 'qa-method-rollback', stratum: 'method', title: '版本回退方法', statement: '回退先确认旧版本及数据格式兼容，停止新写入，再切回已知健康版本，最后检查健康状态和关键数据。', queries: ['版本回退先检查什么？', '新程序上线出问题，怎样安全恢复到上一个可用状态？', '我们需要撤回刚才部署，避免新数据被旧格式破坏。', '恢复旧软件的写入控制与健康核对步骤'] },
  { id: 'qa-method-pool', stratum: 'method', title: '连接池超时排查', statement: '数据库连接池超时时，先看活跃连接和等待队列，再查慢查询与连接未释放；不能只把连接数调大掩盖问题。', queries: ['数据库连接池超时排查', '请求都在等数据库句柄，应从哪些证据区分慢SQL和泄漏？', '线上取连接一直等，先查什么而不是盲目扩容？', '怎样定位连接不归还导致的等待？'] },
  { id: 'qa-method-capacity', stratum: 'method', title: '容量估算保留假设', statement: '容量估算从峰值请求量、单请求资源消耗和目标利用率推导机器需求，再对突发流量做余量分析，保留计算单位和假设。', queries: ['容量估算的峰值与利用率', '需要多少服务器，怎样把请求开销算清楚？', '帮我评估促销当天的资源，写出可核查的计算前提。', '不能拍脑袋加机器，如何从负载推导规模？'] },
  { id: 'qa-method-review', stratum: 'method', title: '代码评审沿调用链', statement: '评审变更先确认入口、直接调用者和失败恢复路径，再按实际影响选择最小验证，不因文件多就跑全仓测试。', queries: ['代码评审如何选择最小验证？', '改动会影响谁、出错如何恢复，应沿什么路径查？', '这次只改了一个服务，请制定有判别力的回归范围。', '怎样依据调用关系而不是文件数量评估改动？'] },
  { id: 'qa-lesson-cache', stratum: 'lesson', title: '缓存失效必须跟随变更', statement: '曾因更新配置后未失效缓存，界面继续展示旧数据。以后修改权威配置时同步更新缓存版本或使缓存失效，不能只验证磁盘写成功。', queries: ['配置保存成功但界面还是旧值', '为什么文件更新了，页面仍读到之前的内容？', '我们又遇到陈旧缓存，应该从上次事故吸取什么？', '改权威数据时怎样避免内存副本自我覆盖？'] },
  { id: 'qa-lesson-rollout', stratum: 'lesson', title: '分批发布先观察再扩大', statement: '一次全量上线放大了未知故障。后续先小流量发布，观察错误率和延迟达到停止条件就回退，稳定后再逐步扩大。', queries: ['分批发布的停止条件', '上次一次推给所有人出了大故障，这次怎样控制影响面？', '请安排灰度上线，观察什么信号才能扩大？', '如何避免未经观察直接放量？'] },
  { id: 'qa-lesson-evidence', stratum: 'lesson', title: '诊断先证据后动作', statement: '曾在没有日志证据时反复重启，掩盖了原始故障。以后先保留日志、现场状态和最小复现，再决定修复动作。', queries: ['故障时先保留现场证据', '不要又重启把线索清空，排障第一步该怎么做？', '服务异常但还没看日志，现在怎样开始调查？', '上次盲目操作丢了原始现场，有什么教训？'] },
  { id: 'qa-lesson-scope', stratum: 'lesson', title: '缺失范围不能等于放行', statement: '曾把缺失的项目上下文当作不受限制，导致读取超出授权范围。以后对象声明范围限制时，未知上下文应拒绝或补齐，不得默认放行。', queries: ['项目上下文缺失怎样处理权限？', '不知道当前工作区，不代表能读取所有人的内容。', '这个资产有范围白名单但请求没带项目，应该如何决定？', '怎样避免空字段绕过授权？'] },
  { id: 'qa-fact-delta', stratum: 'fact', title: 'QA-Delta 发布负责人', statement: '合成项目 QA-Delta 的发布负责人是赵工，部署窗口由赵工确认；QA-Echo 是另一个项目，不能混为一谈。', queries: ['QA-Delta 的发布负责人', '谁负责确认 Delta 的部署时间？', '我要约 QA-Delta 的上线窗口，该找谁？', 'Delta 与 Echo 的发布职责能否混用？'] },
  { id: 'qa-fact-staging', stratum: 'fact', title: '沙箱数据不得外发', statement: '合成环境 QA-Sandbox 只使用虚构样本，其数据文件不得发送到公网服务；验证应在本机完成。', queries: ['QA-Sandbox 数据能否外发？', '沙箱的样本是否可以上传公共分析站点？', '请安排这个合成环境的验证地点，避免数据越出边界。', '虚构测试数据在此环境仍有哪些传输限制？'] },
  { id: 'qa-fact-timezone', stratum: 'fact', title: '合成项目按UTC记日志', statement: '合成项目 QA-Orbit 的服务日志时间统一为 UTC，展示给上海团队时换算为 UTC+8，并保留原始时间。', queries: ['QA-Orbit 日志时区', 'Orbit 的服务时间比上海少八小时，怎样对齐现场？', '排查这个合成服务的午夜事件，先按哪个时区理解原日志？', '给上海同事看记录时怎样保留UTC证据？'] },
  { id: 'qa-fact-interface', stratum: 'fact', title: '合成导入接口限额', statement: '合成接口 QA-Import 每批最多接收 200 条记录，超出时客户端应分批提交，不得静默丢弃尾部记录。', queries: ['QA-Import 每批上限', '导入五百条样本怎样拆批，避免最后一段丢失？', '这批记录超过两百，需要怎样调用合成导入端点？', '批量写入限额与尾部记录保护'] },
];

export const SECURITY_CASES = [
  ['project', { projectIds: ['private-project'] }], ['workspace', { workspaceIds: ['private-workspace'] }],
  ['agent', { agentIds: ['private-agent'] }], ['role', { roleIds: ['private-role'] }],
  ['conversation', { conversationKinds: ['private-kind'] }], ['file', { fileKinds: ['pdf'] }],
  ['purpose', { purposeTags: ['private-purpose'] }], ['paused', undefined], ['revoked', undefined], ['source', undefined],
].map(([name, policy]) => ({ id: `qa-denied-${name}`, family: String(name), policy,
  title: `隔离受限标记 ${name}`, statement: `合成受限标记 ${name} 的访问口令说明只能在获准范围内读取。` }));

export interface FormationQualityCase {
  id: string; stratum: string; positive: boolean;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Regex contracts are conservative lexical semantic checks, never a model's
   * supported=true verdict. Full bodies and all checks remain in the result. */
  required?: RegExp[]; requiredContract?: RegExp[]; forbidden?: RegExp[]; forbiddenBoundary?: RegExp[];
}
export const FORMATION_CASES: FormationQualityCase[] = [
  { id: 'f01', stratum: 'preference', positive: true, messages: [{ role: 'user', text: '以后解释复杂技术问题，别先铺很长背景。先告诉我结论，再列证据和推理，我才容易判断。' }], required: [/技术/, /先.{0,12}结论/s, /证据|依据/, /推理/] },
  { id: 'f02', stratum: 'preference', positive: true, messages: [{ role: 'user', text: '给管理者的项目汇报只把待拍板事项、主要风险和下一步责任人放在正文，技术细节放附录。今后按这个分层，避免负责人找不到行动。' }], required: [/管理者|负责人/, /决策|拍板/, /风险/, /责任人/, /附录/] },
  { id: 'f03', stratum: 'template', positive: true, messages: [{ role: 'user', text: '项目会议材料只有议题会让大家到场才找证据。今后会前材料保留五项：会议目标、背景事实、待决策问题、负责人、下一步行动；临时闲聊不套。' }], required: [/会议目标/, /背景事实/, /待决策问题/, /负责人/, /下一步行动/], requiredContract: [/闲聊/] },
  { id: 'f04', stratum: 'template', positive: true, messages: [{ role: 'user', text: '事故复盘今后要记影响、关键时间线、直接原因、根因和改进项。每项改进有负责人和期限，不能只责怪个人。这样才知道整改有没有真正完成。' }], required: [/影响/, /时间线/, /根因/, /负责人/, /期限|截止/], requiredContract: [/不能.{0,12}(责怪|归责)|避免.{0,12}(责怪|归责)|不适用于：[^\n]*(责怪|归责)/s] },
  { id: 'f05', stratum: 'method', positive: true, messages: [{ role: 'user', text: '今后做版本回退，先核旧版本和数据格式兼容，再停止新写入，切回已知健康版本，最后查健康与关键数据。不能只换二进制就宣布成功。' }], required: [/兼容/, /停止.{0,8}(新)?写入/s, /健康/, /关键数据/] },
  { id: 'f06', stratum: 'method', positive: true, messages: [{ role: 'user', text: '以后容量估算从峰值请求量、每请求资源消耗、目标利用率推机器需求，保留单位、计算假设和突发余量。否则数字无法复核。' }], required: [/峰值/, /资源消耗|请求.*开销/s, /利用率/, /单位/, /假设/, /余量/] },
  { id: 'f07', stratum: 'lesson', positive: true, messages: [{ role: 'user', text: '上次配置落盘成功但缓存没失效，界面仍读旧值。以后改权威配置也要更新缓存版本或使缓存失效，验收不能只看写文件成功。' }], required: [/缓存/, /失效|版本/, /界面|旧值/], requiredContract: [/不能.{0,12}(只|仅).{0,10}(写|文件)|不.{0,4}只.{0,10}(写|文件)|不适用于：[^\n]*(只|仅)[^\n]*(落盘|写|文件)/s] },
  { id: 'f08', stratum: 'lesson', positive: true, messages: [{ role: 'user', text: '上次全量发布把故障放大了。以后先小流量，观察错误率和延迟，达到停止条件就回退，稳定才扩大。这个教训对我们后续发布都适用。' }], required: [/小流量|灰度/, /错误率/, /延迟/, /回退/, /稳定/] },
  { id: 'f09', stratum: 'fact', positive: true, messages: [{ role: 'user', text: '在合成项目 QA-Delta，发布负责人是赵工，部署窗口由赵工确认。QA-Echo 是另一个独立项目，不能把两者的职责混用。以后安排上线找对负责人。' }], required: [/QA-Delta/, /赵工/, /QA-Echo/, /独立|另一个|不能.*混/s] },
  { id: 'f10', stratum: 'fact', positive: true, messages: [{ role: 'user', text: '合成项目 QA-Orbit 的服务日志统一记录 UTC。给上海团队展示时换算 UTC+8，同时保留原始 UTC 时间。以后排查事件先按这个对齐。' }], required: [/QA-Orbit/, /UTC/, /UTC\s*\+\s*8|东八区|八小时/, /保留.*原始/s] },
  { id: 'f11', stratum: 'correction', positive: true, messages: [{ role: 'user', text: '合成项目 QA-Nova 的测试联系人是林工。' }, { role: 'user', text: '纠正刚才的话：QA-Nova 的测试联系人其实是陈工，林工不是。后续测试安排请联系陈工。' }], required: [/QA-Nova/, /陈工/], forbidden: [/联系人(是|为)林工|联系林工/], forbiddenBoundary: [/联系陈工/] },
  { id: 'f12', stratum: 'exception', positive: true, messages: [{ role: 'user', text: '部署评审必须在材料里额外写风险和回退条件，否则无法安全决定是否上线。普通例会不加这两栏，不能推广成所有会议都加长。这条区别以后一直保留。' }], required: [/部署评审/, /风险/, /回退条件/], requiredContract: [/普通(例会|会议).{0,12}(不加|无需|不用|不需要)|不适用于：[^\n]*普通(例会|会议)/s] },
  { id: 'f13', stratum: 'one_off', positive: false, messages: [{ role: 'user', text: '今天这一份摘要标题用蓝色，仅限这次，不是长期偏好。' }] },
  { id: 'f14', stratum: 'operation_receipt', positive: false, messages: [{ role: 'user', text: '文件下载好了，谢谢，结束本次操作。' }] },
  { id: 'f15', stratum: 'assistant_unendorsed', positive: false, messages: [{ role: 'assistant', text: '我建议今后每份材料都超过十页。' }, { role: 'user', text: '这个建议先不采用，不要记成要求。' }] },
  { id: 'f16', stratum: 'bare_acknowledgment', positive: false, messages: [{ role: 'assistant', text: '我建议给所有报告强制配橙色封面。' }, { role: 'user', text: '收到，我知道你提了这个建议。' }] },
  { id: 'f17', stratum: 'unresolved', positive: false, messages: [{ role: 'user', text: 'QA-Luna 下月是否要迁机房？请比较方案。我没有提供迁移决定，地点和时间也都没定。' }] },
  { id: 'f18', stratum: 'rejected_proposal', positive: false, messages: [{ role: 'assistant', text: '可以把每周日报改成只剩总分。' }, { role: 'user', text: '不采用这个提案，本轮没有形成新的日报要求。' }] },
  { id: 'f19', stratum: 'identity_unknown', positive: false, messages: [{ role: 'user', text: '我是在问：QA-River 和 QA-Hill 资料里同名的两位王工是同一个人吗？本轮我没有提供任何身份核实依据。' }] },
  { id: 'f20', stratum: 'historical_current_unknown', positive: false, messages: [{ role: 'user', text: '请查一下 QA-Past 现在用什么数据库，旧记录说的去年配置是否仍有效？我没有提供当前配置结论。' }] },
];

export const RETRIEVAL_CASES = RETRIEVAL_ASSETS.flatMap(asset => asset.queries.map((query, index) => ({
  id: `${asset.id}-q${index + 1}`, stratum: asset.stratum, expression: ['direct', 'paraphrase', 'task', 'alternate'][index], query, relevantId: asset.id,
})));
export const ACCESS_CASES = SECURITY_CASES.flatMap(asset => [
  `请查找${asset.title}的访问说明。`, `我要了解合成受限标记 ${asset.family} 的内容，请提供已有记录。`,
].map((query, index) => ({ id: `${asset.id}-q${index + 1}`, family: asset.family, query, forbiddenId: asset.id })));
