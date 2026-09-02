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
 *
 * ## Schema identity（migration 的地基）
 *
 * catalog 是 schema authority；已安装的模板文件是实例 schema 与 A-box 的载体。
 * 两者靠 `id`（稳定）+ `title`/`name`（可变显示名）+ `previous_names`（历史名
 * 集合）对齐，规则见 `personal_ontology_migration.ts`。
 *
 * 改动本文件的三条硬约束：
 * 1. 已发布的 `id` 永不修改、永不复用 —— 它是跨版本认坑的唯一依据；
 * 2. 改显示名时，把旧名加进该坑的 `previous_names`，不要新造一个 id；
 * 3. 任何改动后 `validateRoleTemplateCatalog()` 必须仍然返回空数组
 *    （单测 `role_template_identity.test.ts` 守着这条）。
 */

export interface TemplateField {
  /**
   * 稳定 schema identity（模板内唯一）。**改 `name` 不等于改 identity** ——
   * 显示名可以随产品调整，`id` 一经发布不得再改；migration 靠它认出
   * “还是同一个坑”。id 只活在 catalog 里，**不写进用户 markdown 文件**
   * （那份文件用户可手改、可跨端同步，写进去的 id 不是可信身份）。
   */
  id: string;
  name: string;
  /** 可选：字段用途说明，渲染层展示在表单视图的字段名旁。 */
  description?: string;
  /** R-box：关系字段，值用 `A → B` 格式；App 不校验、不拆分。 */
  isRelation?: boolean;
  /**
   * 这个坑历史上叫过的所有名字（**集合语义，不是逐版本链**）。旧实例文件里
   * 的字段名命中其中任何一个，就解析到本 identity —— 所以 v1 用户和 v4 用户
   * 走同一次单跳 reconcile，不需要按版本顺序重放。
   */
  previous_names?: string[];
}

/**
 * 已退役的官方字段：曾经属于 T-box，现在 catalog 不再声明它，但用户实例里
 * 很可能还留着值。
 *
 * 它存在的唯一理由是**把「产品下架的旧官方字段」和「用户自建字段」区分开**。
 * 没有这条声明，两者在数据上完全同形（都是 catalog 认不出的名字），旧官方
 * 字段就会被重新解释成 `custom`——一个用户从没创建过的「自定义字段」。
 *
 * 退役不等于删除：值一条不动，只是不再是可写落点。
 */
export interface RetiredField {
  /** 该字段当年的 `id`。**不得与任何在役字段 id 重复，也不得复用**。 */
  id: string;
  /** 退役时的显示名 + 更早的历史名。至少要有一个，否则认不出实例里的旧字段。 */
  previous_names: string[];
  /** 退役发生在哪个 catalog 版本（纯记录，不参与判定）。 */
  retired_in?: string;
}

export interface PresetGroup {
  /** 稳定 schema identity（模板内唯一）。语义同 TemplateField.id。 */
  id: string;
  title: string;
  description?: string;
  /** 历史分节名集合；语义同 TemplateField.previous_names。 */
  previous_names?: string[];
  fields: TemplateField[];
  /** 本分节里已退役的官方字段（见 RetiredField）。 */
  retired_fields?: RetiredField[];
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
        id: "learning_background",
        title: "学习背景",
        description: "",
        fields: [
                    { id: "education_stage", name: "教育阶段" },
          { id: "major_and_study_direction", name: "专业与学习方向" }
        ],
      },
      {
        id: "goals_and_pace",
        title: "目标与节奏",
        description: "",
        fields: [
                    { id: "learning_goals", name: "学习目标" },
          { id: "learning_style", name: "学习风格" },
          { id: "learning_pace", name: "学习节奏" }
        ],
      },
      {
        id: "time_and_constraints",
        title: "时间与约束",
        description: "",
        fields: [
                    { id: "available_time", name: "可用时间" },
          { id: "time_constraints", name: "时间约束" }
        ],
      },
      {
        id: "mastery_state",
        title: "掌握状态",
        description: "",
        fields: [
                    { id: "strengths_and_weaknesses", name: "优势与薄弱领域" }
        ],
      },
      {
        id: "academic_integrity",
        title: "学术诚信",
        description: "",
        fields: [
                    { id: "academic_integrity_boundary", name: "学术诚信边界" }
        ],
      },
      {
        id: "term_and_courses",
        title: "学期与课程",
        description: "",
        fields: [
                    { id: "term_or_study_cycle", name: "学期／学习周期" },
          { id: "course_list", name: "课程清单" },
          { id: "teaching_requirements", name: "教学要求" }
        ],
      },
      {
        id: "tasks_and_deadlines",
        title: "任务与期限",
        description: "",
        fields: [
                    { id: "assignments", name: "作业" },
          { id: "exams", name: "考试" },
          { id: "deadlines", name: "截止时间" }
        ],
      },
      {
        id: "materials_and_mastery",
        title: "材料与掌握",
        description: "",
        fields: [
                    { id: "approved_materials", name: "获准学习材料" },
          { id: "knowledge_mastery_state", name: "知识掌握状态" }
        ],
      },
      {
        id: "plan_and_records",
        title: "计划与记录",
        description: "",
        fields: [
                    { id: "study_plan", name: "学习计划" },
          { id: "completion_records", name: "完成记录" }
        ],
      },
      {
        id: "collaboration_relations",
        title: "协作关系",
        description: "",
        fields: [
                    { id: "teachers_and_peers", name: "教师与同伴" },
          { id: "collaborative_projects", name: "协作项目" }
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
        id: "identity_and_domain",
        title: "身份与领域",
        description: "",
        fields: [
                    { id: "institution_and_position", name: "机构与职位" },
          { id: "discipline", name: "学科" },
          { id: "research_area_and_topics", name: "研究领域与主题" }
        ],
      },
      {
        id: "methods_and_tools",
        title: "方法与工具",
        description: "",
        fields: [
                    { id: "method_preference", name: "方法偏好" },
          { id: "research_tools", name: "研究工具" }
        ],
      },
      {
        id: "publishing_and_writing",
        title: "发表与写作",
        description: "",
        fields: [
                    { id: "target_venues", name: "目标期刊／会议" },
          { id: "writing_and_citation_preference", name: "写作与引用偏好" }
        ],
      },
      {
        id: "ethics_and_data",
        title: "伦理与数据",
        description: "",
        fields: [
                    { id: "ethics_and_data_boundary", name: "伦理与数据边界" },
          { id: "ethics_approval_ref", name: "伦理审批引用" }
        ],
      },
      {
        id: "research_questions",
        title: "研究问题",
        description: "",
        fields: [
                    { id: "research_question", name: "研究问题" },
          { id: "terminology_ontology", name: "术语本体" }
        ],
      },
      {
        id: "literature_and_evidence",
        title: "文献与证据",
        description: "",
        fields: [
                    { id: "literature_library_ref", name: "文献库引用" },
          { id: "inclusion_criteria", name: "纳入标准" },
          { id: "exclusion_criteria", name: "排除标准" },
          { id: "evidence_matrix", name: "证据矩阵" }
        ],
      },
      {
        id: "theory_and_method",
        title: "理论与方法",
        description: "",
        fields: [
                    { id: "theory_and_hypotheses", name: "理论与假设" },
          { id: "research_method", name: "研究方法" }
        ],
      },
      {
        id: "reproducibility",
        title: "复现",
        description: "",
        fields: [
                    { id: "dataset_ref", name: "数据集引用" },
          { id: "analysis_environment", name: "分析环境" },
          { id: "analysis_version", name: "分析版本" }
        ],
      },
      {
        id: "collaboration_and_progress",
        title: "协作与进度",
        description: "",
        fields: [
                    { id: "collaborators_and_roles", name: "合作者与分工" },
          { id: "research_milestones", name: "研究里程碑" }
        ],
      },
      {
        id: "citation_and_review",
        title: "引用与评审",
        description: "",
        fields: [
                    { id: "citation_records", name: "引用记录" },
          { id: "review_records", name: "审稿记录" }
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
        id: "professional_background",
        title: "专业背景",
        description: "",
        fields: [
                    { id: "industry_expertise", name: "行业专长" },
          { id: "technical_expertise", name: "技术专长" }
        ],
      },
      {
        id: "duties_and_authority",
        title: "职责与权限",
        description: "",
        fields: [
                    { id: "delivery_duties", name: "交付职责" },
          { id: "delivery_decision_authority", name: "交付决策权" }
        ],
      },
      {
        id: "communication_and_escalation",
        title: "沟通与升级",
        description: "",
        fields: [
                    { id: "solution_communication_preference", name: "方案沟通偏好" },
          { id: "risk_escalation_method", name: "风险升级方式" }
        ],
      },
      {
        id: "tools_and_boundaries",
        title: "工具与边界",
        description: "",
        fields: [
                    { id: "common_tech_and_tools", name: "常用技术与工具" },
          { id: "client_data_and_prod_boundary", name: "客户数据与生产边界" }
        ],
      },
      {
        id: "client_and_goals",
        title: "客户与目标",
        description: "",
        fields: [
                    { id: "client_or_account", name: "客户／账户" },
          { id: "business_goals", name: "业务目标" },
          { id: "success_criteria", name: "成功标准" }
        ],
      },
      {
        id: "client_and_organization",
        title: "客户与组织",
        description: "",
        fields: [
                    { id: "stakeholders", name: "干系人" },
          { id: "decision_chain", name: "决策链" }
        ],
      },
      {
        id: "current_state_and_integration",
        title: "现状与集成",
        description: "",
        fields: [
                    { id: "existing_systems", name: "现有系统" },
          { id: "data_sources", name: "数据源" },
          { id: "interface_list", name: "接口清单" },
          { id: "existing_processes", name: "现有流程" }
        ],
      },
      {
        id: "environment_and_compliance",
        title: "环境与合规",
        description: "",
        fields: [
                    { id: "deployment_environment", name: "部署环境" },
          { id: "security_and_compliance_requirements", name: "安全与合规要求" }
        ],
      },
      {
        id: "solution_and_plan",
        title: "方案与计划",
        description: "",
        fields: [
                    { id: "solution_scope", name: "方案范围" },
          { id: "solution_tradeoffs", name: "方案取舍" },
          { id: "key_dependencies", name: "关键依赖" }
        ],
      },
      {
        id: "delivery_and_acceptance",
        title: "交付与验收",
        description: "",
        fields: [
                    { id: "delivery_milestones", name: "交付里程碑" },
          { id: "acceptance_criteria", name: "验收标准" },
          { id: "risks_and_issues", name: "风险与问题" }
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
        id: "duties_and_experience",
        title: "职责与经验",
        description: "",
        fields: [
                    { id: "owned_product_domain", name: "负责产品／业务域" },
          { id: "product_duties", name: "产品职责" },
          { id: "user_and_industry_experience", name: "用户与行业经验" }
        ],
      },
      {
        id: "methods_and_preferences",
        title: "方法与偏好",
        description: "",
        fields: [
                    { id: "common_product_methods", name: "常用产品方法" },
          { id: "common_product_tools", name: "常用产品工具" },
          { id: "communication_and_delivery_preference", name: "沟通与交付偏好" }
        ],
      },
      {
        id: "judgment_boundaries",
        title: "判断边界",
        description: "",
        fields: [
                    { id: "product_principles", name: "产品原则" }
        ],
      },
      {
        id: "product_basics",
        title: "产品基础",
        description: "",
        fields: [
                    { id: "product_name", name: "产品名称" },
          { id: "product_positioning", name: "产品定位" },
          { id: "product_stage", name: "产品阶段" },
          { id: "current_version", name: "当前版本" }
        ],
      },
      {
        id: "users_and_scenarios",
        title: "用户与场景",
        description: "",
        fields: [
                    { id: "target_users_icp", name: "目标用户／ICP" },
          { id: "core_use_cases", name: "核心使用场景" }
        ],
      },
      {
        id: "goals_and_metrics",
        title: "目标与指标",
        description: "",
        fields: [
                    { id: "business_goals", name: "业务目标" },
          { id: "core_metrics", name: "核心指标" },
          { id: "evaluation_definition", name: "Evaluation口径" }
        ],
      },
      {
        id: "evidence_and_decisions",
        title: "证据与决策",
        description: "",
        fields: [
                    { id: "requirement_evidence_ref", name: "需求证据引用" }
        ],
      },
      {
        id: "roadmap_and_dependencies",
        title: "规划与依赖",
        description: "",
        fields: [
                    { id: "roadmap_and_priorities", name: "路线图与优先级" },
          { id: "key_dependencies", name: "关键依赖" }
        ],
      },
      {
        id: "collaboration_and_decisions",
        title: "协作与决策",
        description: "",
        fields: [
                    { id: "stakeholders", name: "干系人" },
          { id: "decision_records", name: "决策记录" },
          { id: "pending_decisions", name: "待决策项" }
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
        id: "duties_and_authority",
        title: "职责与权限",
        description: "",
        fields: [
                    { id: "project_decision_authority", name: "项目决策权" },
          { id: "project_management_duties", name: "项目管理职责" },
          { id: "resource_commitment_boundary", name: "资源承诺边界" }
        ],
      },
      {
        id: "methods_and_preferences",
        title: "方法与偏好",
        description: "",
        fields: [
                    { id: "common_methodologies", name: "常用方法论" },
          { id: "reporting_preference", name: "汇报偏好" }
        ],
      },
      {
        id: "risk_and_planning",
        title: "风险与计划",
        description: "",
        fields: [
                    { id: "risk_tolerance", name: "风险容忍度" },
          { id: "escalation_rules", name: "升级规则" },
          { id: "plan_granularity", name: "计划颗粒度" }
        ],
      },
      {
        id: "project_basics",
        title: "项目基础",
        description: "",
        fields: [
                    { id: "project_name", name: "项目名称" },
          { id: "project_goals", name: "项目目标" }
        ],
      },
      {
        id: "scope_and_deliverables",
        title: "范围与交付",
        description: "",
        fields: [
                    { id: "project_scope", name: "项目范围" },
          { id: "out_of_scope", name: "非项目范围" },
          { id: "deliverables", name: "交付物" },
          { id: "wbs_work_packages", name: "WBS／工作包" }
        ],
      },
      {
        id: "schedule_and_resources",
        title: "计划与资源",
        description: "",
        fields: [
                    { id: "milestones", name: "里程碑" },
          { id: "stakeholders_and_raci", name: "干系人与RACI" },
          { id: "resource_constraints", name: "资源约束" }
        ],
      },
      {
        id: "risk_and_execution",
        title: "风险与执行",
        description: "",
        fields: [
                    { id: "dependencies", name: "依赖" },
          { id: "risk_register", name: "风险台账" },
          { id: "issue_register", name: "问题台账" },
          { id: "action_items", name: "行动项" }
        ],
      },
      {
        id: "change_and_decisions",
        title: "变更与决策",
        description: "",
        fields: [
                    { id: "change_records", name: "变更记录" },
          { id: "decision_records", name: "决策记录" },
          { id: "approval_records", name: "审批记录" }
        ],
      },
      {
        id: "status_reporting",
        title: "状态汇报",
        description: "",
        fields: [
                    { id: "current_status", name: "当前状态" },
          { id: "reporting_cadence", name: "汇报周期" }
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
        id: "duties_and_audience",
        title: "职责与受众",
        description: "",
        fields: [
                    { id: "owned_doc_domain", name: "负责文档域" },
          { id: "target_audience_experience", name: "目标受众经验" }
        ],
      },
      {
        id: "writing_preferences",
        title: "写作偏好",
        description: "",
        fields: [
                    { id: "writing_style", name: "写作风格" },
          { id: "tone", name: "语气" }
        ],
      },
      {
        id: "terminology_and_structure",
        title: "术语与结构",
        description: "",
        fields: [
                    { id: "terminology_preference", name: "术语偏好" },
          { id: "information_architecture_method", name: "信息架构方法" },
          { id: "glossary", name: "术语表" },
          { id: "concept_relations", name: "概念关系" },
          { id: "doc_map", name: "文档地图" }
        ],
      },
      {
        id: "publishing_and_boundaries",
        title: "发布与边界",
        description: "",
        fields: [
                    { id: "review_and_release_process", name: "评审与发布流程" },
          { id: "code_sample_boundary", name: "代码示例边界" },
          { id: "source_usage_boundary", name: "来源使用边界" }
        ],
      },
      {
        id: "product_and_version",
        title: "产品与版本",
        description: "",
        fields: [
                    { id: "product_or_system", name: "产品／系统" },
          { id: "applicable_versions", name: "适用版本" }
        ],
      },
      {
        id: "audience_and_content",
        title: "受众与内容",
        description: "",
        fields: [
                    { id: "target_audience", name: "目标受众" }
        ],
      },
      {
        id: "source_governance",
        title: "来源治理",
        description: "",
        fields: [
                    { id: "authoritative_sources", name: "权威来源" },
          { id: "source_priority", name: "来源优先级" }
        ],
      },
      {
        id: "change_and_review",
        title: "变更与评审",
        description: "",
        fields: [
                    { id: "change_records", name: "变更记录" },
          { id: "impact_scope", name: "影响范围" },
          { id: "open_questions", name: "未决问题" },
          { id: "review_comments", name: "评审意见" }
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
        id: "role_coverage",
        title: "岗位覆盖",
        description: "",
        fields: [
                    { id: "owned_job_families", name: "负责岗位族" },
          { id: "owned_job_levels", name: "负责职级" }
        ],
      },
      {
        id: "process_and_authority",
        title: "流程与权限",
        description: "",
        fields: [
                    { id: "hiring_process", name: "招聘流程" },
          { id: "hiring_decision_authority", name: "招聘决策权限" }
        ],
      },
      {
        id: "assessment_preferences",
        title: "评估偏好",
        description: "",
        fields: [
                    { id: "common_assessment_methods", name: "常用评估方式" }
        ],
      },
      {
        id: "compliance_boundaries",
        title: "合规边界",
        description: "",
        fields: [
                    { id: "lawful_screening_boundary", name: "合法筛选边界" },
          { id: "prohibited_attributes", name: "禁止使用的特征" }
        ],
      },
      {
        id: "communication_preferences",
        title: "沟通偏好",
        description: "",
        fields: [
                    { id: "communication_preference", name: "沟通偏好" }
        ],
      },
      {
        id: "position_basics",
        title: "职位基础",
        description: "",
        fields: [
                    { id: "requisition_id", name: "职位需求ID" },
          { id: "position_title", name: "职位名称" },
          { id: "position_goals", name: "职位目标" },
          { id: "jd_version", name: "JD版本" }
        ],
      },
      {
        id: "qualification_criteria",
        title: "资格标准",
        description: "",
        fields: [
                    { id: "required_qualifications", name: "必需资格" },
          { id: "preferred_qualifications", name: "期望资格" },
          { id: "qualification_weights", name: "资格权重" },
          { id: "evidence_standards", name: "证据标准" }
        ],
      },
      {
        id: "candidate_materials",
        title: "候选材料",
        description: "",
        fields: [
                    { id: "candidate_material_ref", name: "候选材料引用" }
        ],
      },
      {
        id: "candidate_process",
        title: "候选流程",
        description: "",
        fields: [
                    { id: "process_stages", name: "流程阶段" },
          { id: "interview_records", name: "面试记录" },
          { id: "feedback_records", name: "反馈记录" },
          { id: "hiring_decision_and_rationale", name: "招聘决定与理由" }
        ],
      },
      {
        id: "data_governance",
        title: "数据治理",
        description: "",
        fields: [
                    { id: "data_retention_policy", name: "数据保留策略" },
          { id: "access_scope", name: "访问范围" }
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
        id: "technical_expertise",
        title: "技术专长",
        description: "",
        fields: [
                    { id: "languages_and_frameworks", name: "语言与框架" },
          { id: "technical_expertise", name: "技术专长" }
        ],
      },
      {
        id: "coding_preferences",
        title: "编码偏好",
        description: "",
        fields: [
                    { id: "coding_preference", name: "编码偏好" },
          { id: "review_preference", name: "评审偏好" }
        ],
      },
      {
        id: "quality_standards",
        title: "质量标准",
        description: "",
        fields: [
                    { id: "test_and_quality_standards", name: "测试与质量标准" }
        ],
      },
      {
        id: "tools_and_workflow",
        title: "工具与流程",
        description: "",
        fields: [
                    { id: "common_tools_and_workflow", name: "常用工具与工作流" }
        ],
      },
      {
        id: "permission_boundaries",
        title: "权限边界",
        description: "",
        fields: [
                    { id: "change_authority", name: "变更权限" },
          { id: "credential_and_network_boundary", name: "凭证与网络边界" }
        ],
      },
      {
        id: "codebase",
        title: "代码库",
        description: "",
        fields: [
                    { id: "repository_ref", name: "仓库引用" },
          { id: "module_scope", name: "模块范围" }
        ],
      },
      {
        id: "architecture_and_dependencies",
        title: "架构与依赖",
        description: "",
        fields: [
                    { id: "architecture_summary", name: "架构摘要" },
          { id: "tech_stack", name: "技术栈" },
          { id: "dependencies", name: "依赖" }
        ],
      },
      {
        id: "conventions_and_decisions",
        title: "规范与决策",
        description: "",
        fields: [
                    { id: "coding_conventions", name: "编码规范" },
          { id: "adr_ref", name: "ADR引用" }
        ],
      },
      {
        id: "build_and_test",
        title: "构建与测试",
        description: "",
        fields: [
                    { id: "build_commands", name: "构建命令" },
          { id: "test_commands", name: "测试命令" }
        ],
      },
      {
        id: "issues_and_changes",
        title: "问题与变更",
        description: "",
        fields: [
                    { id: "issue_or_defect_ref", name: "问题／缺陷引用" },
          { id: "change_status", name: "变更状态" }
        ],
      },
      {
        id: "environments_and_credentials",
        title: "环境与权限",
        description: "",
        fields: [
                    { id: "environment_ref", name: "环境引用" },
          { id: "credential_ref", name: "凭证引用" }
        ],
      },
      {
        id: "release_governance",
        title: "发布治理",
        description: "",
        fields: [
                    { id: "release_gate", name: "发布Gate" }
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
          id: "shop_and_category",
          title: "店铺与品类",
          fields: [
            { id: "shop_type", name: "店铺类型" },
            { id: "main_category", name: "主营类目" },
            { id: "target_audience_group", name: "目标人群" },
            { id: "price_band", name: "价格带" },
            { id: "platform", name: "平台" },
          ],
        },
        {
          id: "selection_and_products",
          title: "选品与商品",
          fields: [
            { id: "active_products", name: "在售商品" },
            { id: "selection_criteria", name: "选品标准" },
            { id: "competitor_list", name: "竞品名单" },
            { id: "gross_margin_target", name: "毛利目标" },
            { id: "inventory_model", name: "库存方式" },
          ],
        },
        {
          id: "content_and_channels",
          title: "内容与渠道",
          fields: [
            { id: "primary_channels", name: "主推渠道" },
            { id: "content_formats", name: "内容形式" },
            { id: "publishing_cadence", name: "发布节奏" },
            { id: "account_positioning", name: "账号定位" },
            { id: "asset_library", name: "素材库" },
          ],
        },
        {
          id: "data_and_targets",
          title: "数据与目标",
          fields: [
            { id: "monthly_sales_target", name: "月销目标" },
            { id: "core_metrics", name: "核心指标" },
            { id: "ad_budget", name: "广告预算" },
            { id: "retrospective_habit", name: "复盘习惯" },
          ],
        },
        {
          id: "aesthetics_and_brand",
          title: "审美与品牌",
          fields: [
            { id: "brand_tone", name: "品牌调性" },
            { id: "visual_style", name: "视觉风格" },
            { id: "forbidden_elements", name: "禁忌元素" },
            { id: "reference_shops", name: "参考店铺" },
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

// ── Catalog 自检 ───────────────────────────────────────────────────────────

/**
 * 一条 catalog identity 违规。`templateId` 之外的字段按违规类型出现。
 * 这些是**编译期就该拦下的作者错误**，不是运行期状态，所以只在单测与开发期
 * 断言里消费；运行路径不为它们做降级处理。
 */
export interface RoleTemplateCatalogIssue {
  kind:
    /** 同一模板内两个分节用了同一个 section id。 */
    | 'duplicate_section_id'
    /** 同一模板内两个字段用了同一个 field id（作用域是整模板，因为跨分节移动
     *  要靠 field id 认坑）。 */
    | 'duplicate_field_id'
    /** id 不是稳定标识该有的形状（小写字母开头 + 小写字母/数字/下划线）。 */
    | 'malformed_id'
    /** 显示名为空。 */
    | 'empty_display_name'
    /** 一个历史名同时被两个 identity 声明，或与另一个 identity 的当前名撞车
     *  —— 解析时无法判定归属，必须由作者消歧。 */
    | 'ambiguous_previous_name'
    /** 同一模板内两个分节 / 两个字段用了同一个显示名：名字寻址会撞。 */
    | 'duplicate_display_name'
    /** 退役字段没声明任何历史名 —— 那就永远认不出实例里的它。 */
    | 'retired_field_without_names';
  templateId: string;
  detail: string;
}

const ID_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 校验 catalog 的 identity 约束（见文件头三条硬约束）。返回空数组 = 合法。
 *
 * 歧义判定按「解析作用域」分别做：分节名在整模板内解析，字段名在其所属分节内
 * 解析 —— 所以两个不同分节里的字段可以同名（现网就有：「技术专长」在 fde 和
 * software_engineer 的不同分节各出现一次），但同一分节内不行。
 */
export function validateRoleTemplateCatalog(
  templates: ReadonlyArray<RoleTemplate> = BUILTIN_TEMPLATES,
): RoleTemplateCatalogIssue[] {
  const issues: RoleTemplateCatalogIssue[] = [];
  const add = (kind: RoleTemplateCatalogIssue['kind'], templateId: string, detail: string) =>
    issues.push({ kind, templateId, detail });

  for (const t of templates) {
    const sectionIds = new Set<string>();
    const sectionTitles = new Set<string>();
    const fieldIds = new Set<string>();
    // 分节名解析表：名字（当前名或历史名）→ 声明它的 section id。
    const sectionNameOwner = new Map<string, string>();

    for (const sec of t.preset_groups) {
      if (!ID_RE.test(sec.id || '')) add('malformed_id', t.template_id, `section id "${sec.id}"`);
      if (!String(sec.title || '').trim()) add('empty_display_name', t.template_id, `section "${sec.id}"`);
      if (sectionIds.has(sec.id)) add('duplicate_section_id', t.template_id, `section id "${sec.id}"`);
      sectionIds.add(sec.id);
      if (sectionTitles.has(sec.title)) add('duplicate_display_name', t.template_id, `section title "${sec.title}"`);
      sectionTitles.add(sec.title);

      for (const name of [sec.title, ...(sec.previous_names || [])]) {
        const owner = sectionNameOwner.get(name);
        if (owner && owner !== sec.id) {
          add('ambiguous_previous_name', t.template_id, `section name "${name}" claimed by both "${owner}" and "${sec.id}"`);
        }
        sectionNameOwner.set(name, sec.id);
      }

      // 字段名解析表是**分节内**的，每节重置。
      const fieldNameOwner = new Map<string, string>();
      const fieldNames = new Set<string>();
      for (const f of sec.fields) {
        if (!ID_RE.test(f.id || '')) add('malformed_id', t.template_id, `field id "${f.id}" in section "${sec.id}"`);
        if (!String(f.name || '').trim()) add('empty_display_name', t.template_id, `field "${f.id}"`);
        if (fieldIds.has(f.id)) add('duplicate_field_id', t.template_id, `field id "${f.id}"`);
        fieldIds.add(f.id);
        if (fieldNames.has(f.name)) add('duplicate_display_name', t.template_id, `field name "${f.name}" in section "${sec.id}"`);
        fieldNames.add(f.name);

        for (const name of [f.name, ...(f.previous_names || [])]) {
          const owner = fieldNameOwner.get(name);
          if (owner && owner !== f.id) {
            add('ambiguous_previous_name', t.template_id, `field name "${name}" in section "${sec.id}" claimed by both "${owner}" and "${f.id}"`);
          }
          fieldNameOwner.set(name, f.id);
        }
      }

      // 退役字段与在役字段共用同一套 id 空间和同一套名字解析空间：
      // id 复用会让「同一个坑」指向两个不同的东西；名字撞车会让实例里的一个
      // 旧字段既像在役又像退役，解析必须能唯一定夺。
      for (const r of sec.retired_fields || []) {
        if (!ID_RE.test(r.id || '')) add('malformed_id', t.template_id, `retired field id "${r.id}" in section "${sec.id}"`);
        if (fieldIds.has(r.id)) add('duplicate_field_id', t.template_id, `retired field id "${r.id}" reuses an active field id`);
        fieldIds.add(r.id);
        if (!r.previous_names?.length) {
          add('retired_field_without_names', t.template_id, `retired field "${r.id}" in section "${sec.id}"`);
          continue;
        }
        for (const name of r.previous_names) {
          const owner = fieldNameOwner.get(name);
          if (owner && owner !== r.id) {
            add('ambiguous_previous_name', t.template_id, `retired field name "${name}" in section "${sec.id}" claimed by both "${owner}" and "${r.id}"`);
          }
          fieldNameOwner.set(name, r.id);
        }
      }
    }
  }
  return issues;
}
