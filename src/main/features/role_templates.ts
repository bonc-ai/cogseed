/**
 * Role Templates — 个人角色模板注册表（T-box 字段清单）。
 *
 * 模板 = 预置分组 + 每组的字段挖空清单。安装模板 = 按 preset_groups 创建一组
 * 分组，并在 groups.md 台账上记录 template_id/template_version；之后候选确认时
 * “对号入座”：有坑填坑（appendFieldValue）、没坑进流水区。
 *
 * 三层本体落点（详见 mate-agent-development skill 的 T/A/R-box 模式）：
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

export interface RoleTemplate {
  template_id: string;
  name: string;
  description: string;
  version: string;
  preset_groups: PresetGroup[];
}

const BUILTIN_TEMPLATES: RoleTemplate[] = [
  {
    template_id: 'student',
    name: '学生',
    description: '在校学生：课程、项目、技能与偏好的结构化记忆',
    version: '1.0.0',
    preset_groups: [
      {
        title: '课程',
        description: '修读课程信息',
        fields: [
          { name: '课程名称' },
          { name: '学校' },
          { name: '专业' },
          { name: '入学年份' },
        ],
      },
      {
        title: '项目',
        description: '参与的项目',
        fields: [
          { name: '项目名称' },
          { name: '角色' },
          { name: '状态' },
          { name: '所属课程', isRelation: true },
        ],
      },
      {
        title: '技能',
        description: '掌握的技能',
        fields: [
          { name: '技能名' },
          { name: '熟练度' },
        ],
      },
      {
        title: '偏好',
        description: '个人偏好',
        fields: [
          { name: '沟通风格' },
          { name: '工具偏好' },
        ],
      },
    ],
  },
  {
    template_id: 'scholar',
    name: '学者',
    description: '学术研究者：研究方向、论文、合作者与数据集',
    version: '1.0.0',
    preset_groups: [
      {
        title: '研究方向',
        description: '研究主题',
        fields: [
          { name: '方向' },
          { name: '关键词' },
        ],
      },
      {
        title: '论文',
        description: '论文产出',
        fields: [
          { name: '题目' },
          { name: '状态' },
          { name: '合作者', isRelation: true },
        ],
      },
      {
        title: '合作者',
        description: '合作者信息',
        fields: [
          { name: '姓名' },
          { name: '机构' },
          { name: '角色' },
        ],
      },
      {
        title: '数据集',
        description: '数据集信息',
        fields: [
          { name: '名称' },
          { name: '用途' },
          { name: '来源' },
        ],
      },
    ],
  },
  {
    template_id: 'fde',
    name: 'FDE',
    description: 'FDE（Full-Stack Developer / 前端工程师）：项目、技术栈、编码规范与交付物',
    version: '1.0.0',
    preset_groups: [
      {
        title: '项目',
        description: '开发项目',
        fields: [
          { name: '项目名称' },
          { name: '角色' },
          { name: '技术栈' },
          { name: '所属仓库', isRelation: true },
        ],
      },
      {
        title: '技术栈',
        description: '使用的技术',
        fields: [
          { name: '技术' },
          { name: '熟练度' },
          { name: '用途' },
        ],
      },
      {
        title: '编码规范',
        description: '编码规范约定',
        fields: [
          { name: '规范' },
          { name: '适用范围' },
        ],
      },
      {
        title: '交付物',
        description: '产出交付物',
        fields: [
          { name: '名称' },
          { name: '类型' },
          { name: '位置' },
        ],
      },
    ],
  },
];

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
