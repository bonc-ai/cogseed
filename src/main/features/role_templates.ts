/**
 * Role Templates — 个人角色模板注册表（T-box 字段清单）。
 *
 * 模板 = 预置分组 + 每组的字段挖空清单。安装模板 = 按 preset_groups 创建一组
 * 分组，并在 groups.md 台账上记录 template_id/template_version；之后候选确认时
 * “对号入座”：有坑填坑（appendFieldValue）、没坑进流水区。
 *
 * 三层本体落点（详见 cogseed-agent-development skill 的 T/A/R-box 模式）：
 * - T-box = 这里的 fields（“要填哪些空”）
 * - R-box = isRelation: true 的字段（关系值用 `A → B` 格式，App 不校验不拆分）
 * - A-box = 确认后写入组内容文件字段区/流水区的实际值
 *
 * 内置模板字段清单是产品拍板的契约（v1.0.0），渲染层“空坑”和技能“建议字段”
 * 候选池都以此为准 —— 修改字段清单属于产品变更，需要同步
 * `resources/builtin/system/skills/personal-ontology-candidate-builder/`。
 */

export interface TemplateField {
  name: string;
  /** 可选：字段用途说明，渲染层展示在表单视图的字段名旁。 */
  description?: string;
  /** R-box：关系字段，值用 `A → B` 格式；App 不校验、不拆分。 */
  isRelation?: boolean;
}

export interface PresetGroup {
  title: string;
  description?: string;
  fields: TemplateField[];
}

/**
 * 角色模板自带的技能/智能体捆绑（情境空间）。
 * id 引用当前用户可见资源：技能 = `listSkills()` 的 id（custom + marketplace），
 * 智能体 = `listAgents()` 的 id。派生时按有效集合过滤失效引用（见 spaces.ts）。
 */
export interface RoleTemplateBundle {
  skill_ids: string[];
  agent_ids: string[];
}

export interface RoleTemplate {
  template_id: string;
  name: string;
  description: string;
  version: string;
  preset_groups: PresetGroup[];
  /** 自带资源捆绑；缺省 = 空捆绑（兼容旧模板/自定义模板文件）。 */
  bundle?: RoleTemplateBundle;
}

const BUILTIN_TEMPLATES: RoleTemplate[] = [
  {
    template_id: "student",
    name: "学生",
    description: "学生学习空间：以真正理解而不是记忆为目标。通过诊断和苏格拉底追问引导你自己形成答案，把阅读转成论点—证据—问题式的主动笔记；按截止日、先修依赖与掌握度规划学期地图，每天只挑 1–3 个可完成的学习动作；每周用完成证据和误区日志调整负荷与复习间隔。内置学习研究、学习计划、练习反馈三个智能体，不代劳、不虚构学习证据。",
    version: '0.2.0-review.1',
    preset_groups: [
      {
        title: "学习背景",
        description: "",
        fields: [
                    { name: "教育阶段" },
          { name: "专业与学习方向" }
        ],
      },
      {
        title: "目标与节奏",
        description: "",
        fields: [
                    { name: "学习目标" },
          { name: "学习风格" },
          { name: "学习节奏" }
        ],
      },
      {
        title: "时间与约束",
        description: "",
        fields: [
                    { name: "可用时间" },
          { name: "时间约束" }
        ],
      },
      {
        title: "掌握状态",
        description: "",
        fields: [
                    { name: "优势与薄弱领域" }
        ],
      },
      {
        title: "学术诚信",
        description: "",
        fields: [
                    { name: "学术诚信边界" }
        ],
      },
      {
        title: "学期与课程",
        description: "",
        fields: [
                    { name: "学期／学习周期" },
          { name: "课程清单" },
          { name: "教学要求" }
        ],
      },
      {
        title: "任务与期限",
        description: "",
        fields: [
                    { name: "作业" },
          { name: "考试" },
          { name: "截止时间" }
        ],
      },
      {
        title: "材料与掌握",
        description: "",
        fields: [
                    { name: "获准学习材料" },
          { name: "知识掌握状态" }
        ],
      },
      {
        title: "计划与记录",
        description: "",
        fields: [
                    { name: "学习计划" },
          { name: "完成记录" }
        ],
      },
      {
        title: "协作关系",
        description: "",
        fields: [
                    { name: "教师与同伴" },
          { name: "协作项目" }
        ],
      },
    ],
    // 角色模板捆绑（字段表 + 包内 skill/task-agent 资源）
    bundle: {
      skill_ids: ["0e847fc8685e", "3def7f0eb34a", "4a8054f512e9", "4bb1813c8335", "aef5bf07573f"],
      agent_ids: ["3bf780cd23be", "54f102b6c1ee", "5a5fe1598ed0"],
    },
  },
  {
    template_id: "scholar",
    name: "学者",
    description: "学者研究空间：把宽泛主题收敛为可研究、可证伪、有贡献边界的问题；用可复现的检索与纳排标准构建文献证据表，综合证据强度、分歧与空白；以主张—证据—推理组织论文并核验引文对主张的真实支持；研究设计阶段检查问题—设计—样本—测量—结论的对齐、偏差与伦理风险，捕获环境与参数保证独立复跑。内置文献综述、研究设计评审、引文核验三个智能体，坚持不虚构证据。",
    version: '0.2.0-review.1',
    preset_groups: [
      {
        title: "身份与领域",
        description: "",
        fields: [
                    { name: "机构与职位" },
          { name: "学科" },
          { name: "研究领域与主题" }
        ],
      },
      {
        title: "方法与工具",
        description: "",
        fields: [
                    { name: "方法偏好" },
          { name: "研究工具" }
        ],
      },
      {
        title: "发表与写作",
        description: "",
        fields: [
                    { name: "目标期刊／会议" },
          { name: "写作与引用偏好" }
        ],
      },
      {
        title: "伦理与数据",
        description: "",
        fields: [
                    { name: "伦理与数据边界" },
          { name: "伦理审批引用" }
        ],
      },
      {
        title: "研究问题",
        description: "",
        fields: [
                    { name: "研究问题" },
          { name: "术语本体" }
        ],
      },
      {
        title: "文献与证据",
        description: "",
        fields: [
                    { name: "文献库引用" },
          { name: "纳入标准" },
          { name: "排除标准" },
          { name: "证据矩阵" }
        ],
      },
      {
        title: "理论与方法",
        description: "",
        fields: [
                    { name: "理论与假设" },
          { name: "研究方法" }
        ],
      },
      {
        title: "复现",
        description: "",
        fields: [
                    { name: "数据集引用" },
          { name: "分析环境" },
          { name: "分析版本" }
        ],
      },
      {
        title: "协作与进度",
        description: "",
        fields: [
                    { name: "合作者与分工" },
          { name: "研究里程碑" }
        ],
      },
      {
        title: "引用与评审",
        description: "",
        fields: [
                    { name: "引用记录" },
          { name: "审稿记录" }
        ],
      },
    ],
    // 角色模板捆绑（字段表 + 包内 skill/task-agent 资源）
    bundle: {
      skill_ids: ["17b2d5e85d87", "2b7f7c8621d5", "4ff31e1cab6f", "6c5609e76cf0", "86cea925e282"],
      agent_ids: ["37054bcc1740", "57f6f828af9f", "a37e8dbcc57e"],
    },
  },
  {
    template_id: "fde",
    name: "FDE 交付",
    description: "解决方案交付空间：从客户业务成果出发澄清现状、数据、系统与约束，建立事实与假设账本；把成果映射到能力与架构选项，明确非功能需求、权衡与 POC；设计可重复采集与签署的验收证据，把方案转成双方责任、依赖、readiness gate 与回滚路径清晰的交付计划。内置解决方案草案、客户 Context、集成验证三个智能体，不编造接口与验收证据。",
    version: '0.2.0-review.1',
    preset_groups: [
      {
        title: "专业背景",
        description: "",
        fields: [
                    { name: "行业专长" },
          { name: "技术专长" }
        ],
      },
      {
        title: "职责与权限",
        description: "",
        fields: [
                    { name: "交付职责" },
          { name: "交付决策权" }
        ],
      },
      {
        title: "沟通与升级",
        description: "",
        fields: [
                    { name: "方案沟通偏好" },
          { name: "风险升级方式" }
        ],
      },
      {
        title: "工具与边界",
        description: "",
        fields: [
                    { name: "常用技术与工具" },
          { name: "客户数据与生产边界" }
        ],
      },
      {
        title: "客户与目标",
        description: "",
        fields: [
                    { name: "客户／账户" },
          { name: "业务目标" },
          { name: "成功标准" }
        ],
      },
      {
        title: "客户与组织",
        description: "",
        fields: [
                    { name: "干系人" },
          { name: "决策链" }
        ],
      },
      {
        title: "现状与集成",
        description: "",
        fields: [
                    { name: "现有系统" },
          { name: "数据源" },
          { name: "接口清单" },
          { name: "现有流程" }
        ],
      },
      {
        title: "环境与合规",
        description: "",
        fields: [
                    { name: "部署环境" },
          { name: "安全与合规要求" }
        ],
      },
      {
        title: "方案与计划",
        description: "",
        fields: [
                    { name: "方案范围" },
          { name: "方案取舍" },
          { name: "关键依赖" }
        ],
      },
      {
        title: "交付与验收",
        description: "",
        fields: [
                    { name: "交付里程碑" },
          { name: "验收标准" },
          { name: "风险与问题" }
        ],
      },
    ],
    // 角色模板捆绑（字段表 + 包内 skill/task-agent 资源）
    bundle: {
      skill_ids: ["058e3bb57bf5", "464e3f3416cf", "90da4ae1fac4", "c65fa3eae763", "e12403164f5f"],
      agent_ids: ["373f22475ab4", "736cc1ac94b4", "7ece3121592e"],
    },
  },
  {
    template_id: "product_manager",
    name: "产品经理",
    description: "产品经理工作空间：从需求证据到交付评审的全流程支持。把访谈、工单、销售反馈等原始输入整理成可追溯的需求证据与问题主题；基于用户流程与产品目标产出可评审的 PRD、用户故事和可观察验收标准；设计指标体系与优先级框架做版本取舍；研究竞品与市场信号支撑定位和差异化决策。内置 PRD 一致性检查、竞品研究、客户需求评估三个智能体，全程遵循『不虚构证据、数据不可得时不编造』的原则。",
    version: '0.2.0-review.1',
    preset_groups: [
      {
        title: "职责与经验",
        description: "",
        fields: [
                    { name: "负责产品／业务域" },
          { name: "产品职责" },
          { name: "用户与行业经验" }
        ],
      },
      {
        title: "方法与偏好",
        description: "",
        fields: [
                    { name: "常用产品方法" },
          { name: "常用产品工具" },
          { name: "沟通与交付偏好" }
        ],
      },
      {
        title: "判断边界",
        description: "",
        fields: [
                    { name: "产品原则" }
        ],
      },
      {
        title: "产品基础",
        description: "",
        fields: [
                    { name: "产品名称" },
          { name: "产品定位" },
          { name: "产品阶段" },
          { name: "当前版本" }
        ],
      },
      {
        title: "用户与场景",
        description: "",
        fields: [
                    { name: "目标用户／ICP" },
          { name: "核心使用场景" }
        ],
      },
      {
        title: "目标与指标",
        description: "",
        fields: [
                    { name: "业务目标" },
          { name: "核心指标" },
          { name: "Evaluation口径" }
        ],
      },
      {
        title: "证据与决策",
        description: "",
        fields: [
                    { name: "需求证据引用" }
        ],
      },
      {
        title: "规划与依赖",
        description: "",
        fields: [
                    { name: "路线图与优先级" },
          { name: "关键依赖" }
        ],
      },
      {
        title: "协作与决策",
        description: "",
        fields: [
                    { name: "干系人" },
          { name: "决策记录" },
          { name: "待决策项" }
        ],
      },
    ],
    // 角色模板捆绑（字段表 + 包内 skill/task-agent 资源）
    bundle: {
      skill_ids: ["577787fb975e", "5a131fa3f845", "7432875f93bf", "a827416958f6", "afae324569e2", "bc0be37d6755"],
      agent_ids: ["0fdb4da8a080", "7c3138523589", "8dcba242d360"],
    },
  },
  {
    template_id: "project_manager",
    name: "项目经理",
    description: "项目管理空间：从会议材料中分离事实、决定与行动项并保留定位证据；把模糊目标拆成遵守 100% 规则、可验收且有责任人的 WBS，转成有依赖逻辑、容量约束与关键路径的可预测计划；基于基线与证据生成面向决策的状态与预测；建立带触发器、责任人、缓解与应急方案的 RAID 账本并按阈值升级。内置周度状态、项目风险扫描、项目计划三个智能体，只依据真实证据汇报。",
    version: '0.2.0-review.1',
    preset_groups: [
      {
        title: "职责与权限",
        description: "",
        fields: [
                    { name: "项目决策权" },
          { name: "项目管理职责" },
          { name: "资源承诺边界" }
        ],
      },
      {
        title: "方法与偏好",
        description: "",
        fields: [
                    { name: "常用方法论" },
          { name: "汇报偏好" }
        ],
      },
      {
        title: "风险与计划",
        description: "",
        fields: [
                    { name: "风险容忍度" },
          { name: "升级规则" },
          { name: "计划颗粒度" }
        ],
      },
      {
        title: "项目基础",
        description: "",
        fields: [
                    { name: "项目名称" },
          { name: "项目目标" }
        ],
      },
      {
        title: "范围与交付",
        description: "",
        fields: [
                    { name: "项目范围" },
          { name: "非项目范围" },
          { name: "交付物" },
          { name: "WBS／工作包" }
        ],
      },
      {
        title: "计划与资源",
        description: "",
        fields: [
                    { name: "里程碑" },
          { name: "干系人与RACI" },
          { name: "资源约束" }
        ],
      },
      {
        title: "风险与执行",
        description: "",
        fields: [
                    { name: "依赖" },
          { name: "风险台账" },
          { name: "问题台账" },
          { name: "行动项" }
        ],
      },
      {
        title: "变更与决策",
        description: "",
        fields: [
                    { name: "变更记录" },
          { name: "决策记录" },
          { name: "审批记录" }
        ],
      },
      {
        title: "状态汇报",
        description: "",
        fields: [
                    { name: "当前状态" },
          { name: "汇报周期" }
        ],
      },
    ],
    // 角色模板捆绑（字段表 + 包内 skill/task-agent 资源）
    bundle: {
      skill_ids: ["0d95910c7f2f", "15af984d02a5", "181e249741e9", "4334030f8314", "9a2bc04da822"],
      agent_ids: ["39f682807819", "662cb1c1de2c", "c0e5a377b91c"],
    },
  },
  {
    template_id: "technical_writer",
    name: "技术写作",
    description: "技术写作空间：从代码、规范和现有文档提取带版本与定位的事实账本；按受众任务设计可发现、可扩展的文档结构；维护带定义、别名、禁用词与审批记录的术语表；把用户目标写成可执行、可验证、可访问的技术内容；版本变更时输出受影响资产、迁移步骤与风险。内置文档一致性检查、来源探索、变更影响三个智能体，不虚构接口与步骤。",
    version: '0.2.0-review.1',
    preset_groups: [
      {
        title: "职责与受众",
        description: "",
        fields: [
                    { name: "负责文档域" },
          { name: "目标受众经验" }
        ],
      },
      {
        title: "写作偏好",
        description: "",
        fields: [
                    { name: "写作风格" },
          { name: "语气" }
        ],
      },
      {
        title: "术语与结构",
        description: "",
        fields: [
                    { name: "术语偏好" },
          { name: "信息架构方法" },
          { name: "术语表" },
          { name: "概念关系" },
          { name: "文档地图" }
        ],
      },
      {
        title: "发布与边界",
        description: "",
        fields: [
                    { name: "评审与发布流程" },
          { name: "代码示例边界" },
          { name: "来源使用边界" }
        ],
      },
      {
        title: "产品与版本",
        description: "",
        fields: [
                    { name: "产品／系统" },
          { name: "适用版本" }
        ],
      },
      {
        title: "受众与内容",
        description: "",
        fields: [
                    { name: "目标受众" }
        ],
      },
      {
        title: "来源治理",
        description: "",
        fields: [
                    { name: "权威来源" },
          { name: "来源优先级" }
        ],
      },
      {
        title: "变更与评审",
        description: "",
        fields: [
                    { name: "变更记录" },
          { name: "影响范围" },
          { name: "未决问题" },
          { name: "评审意见" }
        ],
      },
    ],
    // 角色模板捆绑（字段表 + 包内 skill/task-agent 资源）
    bundle: {
      skill_ids: ["06d69ee5f1bc", "13ac643c3ef9", "c07c2cab295d", "d5d2fb6337fb", "ffaad9705891"],
      agent_ids: ["2ec891859db3", "9a26f9f2336d", "fce0f5110ab2"],
    },
  },
  {
    template_id: "recruiter",
    name: "招聘专员",
    description: "招聘工作空间：把招聘需求转成与业务成果相连、可观察的胜任力评分卡；围绕胜任力假设设计一致的核心问题与行为锚点；从简历只抽取候选人明确陈述的可定位证据，用固定 rubric 生成要求—证据解释矩阵，暴露缺口而非自动淘汰；合并独立面试反馈时保留分歧与证据缺口。内置招聘评估缺口、简历批量解析、候选人对比三个智能体，不自动排序录用、不臆测未陈述经历。",
    version: '0.2.0-review.1',
    preset_groups: [
      {
        title: "岗位覆盖",
        description: "",
        fields: [
                    { name: "负责岗位族" },
          { name: "负责职级" }
        ],
      },
      {
        title: "流程与权限",
        description: "",
        fields: [
                    { name: "招聘流程" },
          { name: "招聘决策权限" }
        ],
      },
      {
        title: "评估偏好",
        description: "",
        fields: [
                    { name: "常用评估方式" }
        ],
      },
      {
        title: "合规边界",
        description: "",
        fields: [
                    { name: "合法筛选边界" },
          { name: "禁止使用的特征" }
        ],
      },
      {
        title: "沟通偏好",
        description: "",
        fields: [
                    { name: "沟通偏好" }
        ],
      },
      {
        title: "职位基础",
        description: "",
        fields: [
                    { name: "职位需求ID" },
          { name: "职位名称" },
          { name: "职位目标" },
          { name: "JD版本" }
        ],
      },
      {
        title: "资格标准",
        description: "",
        fields: [
                    { name: "必需资格" },
          { name: "期望资格" },
          { name: "资格权重" },
          { name: "证据标准" }
        ],
      },
      {
        title: "候选材料",
        description: "",
        fields: [
                    { name: "候选材料引用" }
        ],
      },
      {
        title: "候选流程",
        description: "",
        fields: [
                    { name: "流程阶段" },
          { name: "面试记录" },
          { name: "反馈记录" },
          { name: "招聘决定与理由" }
        ],
      },
      {
        title: "数据治理",
        description: "",
        fields: [
                    { name: "数据保留策略" },
          { name: "访问范围" }
        ],
      },
    ],
    // 角色模板捆绑（字段表 + 包内 skill/task-agent 资源）
    bundle: {
      skill_ids: ["78967e9cfe10", "8f090a1b0c27", "98e6c144f229", "d5041e397e79", "e117a4a3afef"],
      agent_ids: ["78ef7f901e81", "a0aaf36d3c37", "fb836f8b51ca"],
    },
  },
  {
    template_id: "software_engineer",
    name: "软件工程师",
    description: "软件工程空间：围绕变更意图建立最小代码地图，不盲目全量读取；把验收标准映射到文件、接口、数据迁移、测试、发布与回滚的有序计划；按风险覆盖正常、边界、错误、权限与恢复路径并保留可复跑测试证据；通过稳定复现与单变量实验定位根因，审查变更的正确性、安全、性能与可维护性。内置代码库探索、代码质量评审、测试运行三个智能体，不编造测试结果。",
    version: '0.2.0-review.1',
    preset_groups: [
      {
        title: "技术专长",
        description: "",
        fields: [
                    { name: "语言与框架" },
          { name: "技术专长" }
        ],
      },
      {
        title: "编码偏好",
        description: "",
        fields: [
                    { name: "编码偏好" },
          { name: "评审偏好" }
        ],
      },
      {
        title: "质量标准",
        description: "",
        fields: [
                    { name: "测试与质量标准" }
        ],
      },
      {
        title: "工具与流程",
        description: "",
        fields: [
                    { name: "常用工具与工作流" }
        ],
      },
      {
        title: "权限边界",
        description: "",
        fields: [
                    { name: "变更权限" },
          { name: "凭证与网络边界" }
        ],
      },
      {
        title: "代码库",
        description: "",
        fields: [
                    { name: "仓库引用" },
          { name: "模块范围" }
        ],
      },
      {
        title: "架构与依赖",
        description: "",
        fields: [
                    { name: "架构摘要" },
          { name: "技术栈" },
          { name: "依赖" }
        ],
      },
      {
        title: "规范与决策",
        description: "",
        fields: [
                    { name: "编码规范" },
          { name: "ADR引用" }
        ],
      },
      {
        title: "构建与测试",
        description: "",
        fields: [
                    { name: "构建命令" },
          { name: "测试命令" }
        ],
      },
      {
        title: "问题与变更",
        description: "",
        fields: [
                    { name: "问题／缺陷引用" },
          { name: "变更状态" }
        ],
      },
      {
        title: "环境与权限",
        description: "",
        fields: [
                    { name: "环境引用" },
          { name: "凭证引用" }
        ],
      },
      {
        title: "发布治理",
        description: "",
        fields: [
                    { name: "发布Gate" }
        ],
      },
    ],
    // 角色模板捆绑（字段表 + 包内 skill/task-agent 资源）
    bundle: {
      skill_ids: ["6ba6255ee930", "93d7b28fb6b4", "991ac94fc4e1", "a988c001dc65", "d3d406dffdbc"],
      agent_ids: ["36cb9c97ac31", "876218dd6c3f", "9099ea65848a"],
    },
  },
{
    template_id: 'ecommerce_ops',
    name: '电商运营',
    description: "电商运营空间：覆盖从选品到复盘的完整打法。从市场趋势、竞品表现与利润空间筛选潜力商品，拆解竞品店铺的选品结构、视觉与内容策略；多平台比价输出价格带分布与定价建议；从卖点提炼撰写详情页文案与小红书笔记；按周期汇总 GMV、转化、流量与广告数据，定位问题并给出下周行动建议。内置选品分析、内容创作、数据复盘三个智能体，数据不可得时不编造。",
    version: '1.0.0',
    preset_groups: [
        {
          title: "店铺与品类",
          fields: [
            { name: "店铺类型" },
            { name: "主营类目" },
            { name: "目标人群" },
            { name: "价格带" },
            { name: "平台" },
          ],
        },
        {
          title: "选品与商品",
          fields: [
            { name: "在售商品" },
            { name: "选品标准" },
            { name: "竞品名单" },
            { name: "毛利目标" },
            { name: "库存方式" },
          ],
        },
        {
          title: "内容与渠道",
          fields: [
            { name: "主推渠道" },
            { name: "内容形式" },
            { name: "发布节奏" },
            { name: "账号定位" },
            { name: "素材库" },
          ],
        },
        {
          title: "数据与目标",
          fields: [
            { name: "月销目标" },
            { name: "核心指标" },
            { name: "广告预算" },
            { name: "复盘习惯" },
          ],
        },
        {
          title: "审美与品牌",
          fields: [
            { name: "品牌调性" },
            { name: "视觉风格" },
            { name: "禁忌元素" },
            { name: "参考店铺" },
          ],
        }
    ],
        bundle: {
          skill_ids: ["8ac59333bc31", "79943922f937", "a5c864d6b267", "02d958231673", "a31023dd51a0"],
          agent_ids: ["1ce66a5d9875", "2a2d007ec7e2", "bc60fe682b5a"],
        },
  },
];

// ── 情境空间场景（Scenario）—— 建空间的 UX 入口，推荐角色模板组合 ──────────

/**
 * 场景 = 情境空间创建时的语义入口（教育/写作/职场+自定义）。
 * 场景推荐主+副角色模板组合 + 建议额外资源（基线之上再追加）。
 * 渲染层显示场景卡，点击后进入创建流程（模板预填）。
 *
 * 注意：场景是纯 UX 概念，不落盘；空间仍只存 primary/secondary/extra。
 */
export interface Scenario {
  scenario_id: string;
  /** 场景显示名（中文；UI 通过 i18n 覆盖可本地化）。 */
  name: string;
  description: string;
  /** emoji 图标 */
  icon: string;
  /** 建议主角色模板 id；无 = 自定义场景，由用户自选。 */
  suggested_primary_template_id?: string;
  /** 建议副角色模板 id 列表。 */
  suggested_secondary_template_ids: string[];
  /** 建议额外技能 id（模板 bundle 之外再追加）；空 = 不推荐。 */
  suggested_extra_skills: string[];
  /** 建议额外智能体 id（模板 bundle 之外再追加）；空 = 不推荐。 */
  suggested_extra_agents: string[];
}

const SCENARIOS: Scenario[] = [
  {
    scenario_id: 'education',
    name: '教育',
    description: '学生与学者的学习研究空间：课程管理、论文写作、知识体系构建',
    icon: '🎓',
    suggested_primary_template_id: 'student',
    suggested_secondary_template_ids: ['scholar'],
    suggested_extra_skills: [],
    suggested_extra_agents: [],
  },
  {
    scenario_id: 'writing',
    name: '写作',
    description: '技术写作与知识管理空间：文档体系、术语治理、内容发布',
    icon: '📝',
    suggested_primary_template_id: 'technical_writer',
    suggested_secondary_template_ids: [],
    suggested_extra_skills: [],
    suggested_extra_agents: [],
  },
  {
    scenario_id: 'workplace',
    name: '职场',
    description: '产品、项目与交付的专业协作空间：需求管理、进度追踪、方案交付',
    icon: '💼',
    suggested_primary_template_id: 'product_manager',
    suggested_secondary_template_ids: ['project_manager', 'fde'],
    suggested_extra_skills: [],
    suggested_extra_agents: [],
  },
  {
    scenario_id: 'custom',
    name: '自定义',
    description: '自由拼装：不预设模板，自行选择角色与资源组合',
    icon: '🧩',
    // 无 suggested_primary → 用户自选
    suggested_primary_template_id: undefined,
    suggested_secondary_template_ids: [],
    suggested_extra_skills: [],
    suggested_extra_agents: [],
  },
];

/** 返回场景列表（防御性拷贝）。 */
export function listScenarios(): Scenario[] {
  return SCENARIOS.map((s) => ({ ...s, suggested_secondary_template_ids: [...s.suggested_secondary_template_ids], suggested_extra_skills: [...s.suggested_extra_skills], suggested_extra_agents: [...s.suggested_extra_agents] }));
}

/** 按 scenario_id 查找场景；未命中返回 undefined。 */
export function getScenario(scenarioId: string): Scenario | undefined {
  const found = SCENARIOS.find((s) => s.scenario_id === scenarioId);
  return found ? { ...found, suggested_secondary_template_ids: [...found.suggested_secondary_template_ids], suggested_extra_skills: [...found.suggested_extra_skills], suggested_extra_agents: [...found.suggested_extra_agents] } : undefined;
}

// ── 模板查询 API ───────────────────────────────────────────────────────────

/** 返回内置模板列表（防御性拷贝，调用方改动不影响注册表）。 */
export function listRoleTemplates(): RoleTemplate[] {
  return BUILTIN_TEMPLATES.map((t) => JSON.parse(JSON.stringify(t)));
}

/** 按 template_id 查找内置模板；未命中返回 undefined。 */
export function getRoleTemplate(templateId: string): RoleTemplate | undefined {
  if (!templateId) return undefined;
  const found = BUILTIN_TEMPLATES.find((t) => t.template_id === templateId);
  return found ? JSON.parse(JSON.stringify(found)) : undefined;
}
