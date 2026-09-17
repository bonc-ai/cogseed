const SIDEBAR_RECENT = [
  { title: '项目里程碑与提醒', status: 'attention', meta: '步骤 4/7', time: '2 分钟前', active: true },
  { title: '项目月度进展简报 v3', status: 'success', meta: '产物待确认', time: '今天 11:20' },
  { title: '核对本周项目数据差异', status: 'idle', meta: '已归档', time: '昨天 17:40' }
];


const SPACE_CARDS = [
  { name: '产品研发', count: 6, sub: '项目全流程 · 规划到交付', icon: 'space', tags: [['solid', '项目'], ['solid', '项目'], ['outline', '项目资料']],
    tasks: [['attention', '项目材料清单核验'], ['idle', '跨项目依赖关系图谱'], ['idle', '交付风险提醒复核']],
    members: [{ name: '陈昱', self: true }, '李'], overflow: 5 },
  { name: '内容创作', count: 4, sub: '产品说明与客户适配', icon: 'space', tags: [['solid', '内容'], ['solid', '内容'], ['outline', '季度']],
    tasks: [['success', '产品说明书要点提取'], ['idle', '目标读者需求复核']],
    members: ['周'], overflow: 2 },
  { name: '资料与规范', count: 9, sub: '规范口径 · 全程留痕', icon: 'shield', tags: [['solid', '合规'], ['success', '数据不出域'], ['outline', '制度库']],
    tasks: [['attention', '资料来源与引用复核'], ['idle', '新规影响面梳理']],
    members: ['吴', '李'], overflow: 3 },
  { name:'日常运营', count:2, sub:'服务工单与日常运营', icon:'space', tags:[['solid','运营']], tasks:[['idle','服务工单周汇总']], members:[], overflow:0 }
];

const TEMPLATES = [
  { name: '项目交付工作台', sub: '材料清单核验、关联风险图谱、审批意见草拟三条流程', tags: [['mono', '3 技能'], ['outline', '项目资料'], ['outline', '公开资料']], uses: '团队内 34 次使用' },
  { name: '月度进展简报', sub: '取数、口径校验、图表与摘要成稿，按团队模板输出', tags: [['mono', '2 技能'], ['outline', '数据仓库'], ['outline', '定时运行']], uses: '团队内 28 次使用' },
  { name: '项目规范问答库', sub: '新规入库、条款溯源引用、答复留痕，答案必带出处', tags: [['mono', '4 技能'], ['success', '数据不出域'], ['outline', '制度库']], uses: '团队内 17 次使用' }
];

SPACE_CARDS.forEach((s,i)=>{s.hasPreviewRecords=true;s.roles=[['项目分析师'],['产品经理'],['质量复核员'],['产品经理']][i];s.updatedAt=Date.UTC(2026,8,5,4)-i*86400000;});

const SPACES = SPACE_CARDS.map(s => ({name:s.name,count:s.count,tasks:s.tasks.map(t => t[1])}));
const SIDEBAR_PINNED = [{ title: SPACES[0].tasks[0] }];
const ROWS = [
  { name: '华越精密制造（华东区域总部与供应链业务联合项目主体）', branch: '静安小组', due: '2026-09-18', amt: '3,200' },
  { name: '宁瑞新材料', branch: '虹口小组', due: '2026-09-22', amt: '1,850' },
  { name: '东岸供应链', branch: '浦东小组', due: '2026-09-30', amt: '6,400' }
];

Object.assign(window, { SIDEBAR_RECENT, SIDEBAR_PINNED, SPACES, SPACE_CARDS, TEMPLATES, ROWS });

// Fictional memory records used only by the settings preview.
const MEMORY_PREVIEW = {
  user: [
    { id: 'preference-1', text: '优先使用简体中文，先给结论，再说明依据与待确认事项。' },
    { id: 'preference-2', text: '工作内容以项目项目为主，汇报材料按客户、风险事项、下一步行动组织。' }
  ],
  shared: [
    { id: 'fact-1', text: '项目材料中的金额统一注明币种和单位，未核实的数据标记为待确认。' },
    { id: 'fact-2', text: '进展简报引用数据时保留统计时点与来源，避免混用不同月份的口径。' }
  ],
  groups: [
    { id: 'group-1', title: '月度进展简报', text: '结构依次为经营概览、重点客户进展、风险事项与下月计划。涉及同比或环比时，注明比较期间。' }
  ]
};
Object.assign(window, { MEMORY_PREVIEW });

// Content-only search fixtures; no user data, service requests or command actions.
const SEARCH_PREVIEW = [
  {id:'chat',label:'任务',items:[
    {id:'credit-message-1',title:'项目里程碑与提醒',meta:'项目助理 · 今天 14:02',snippet:'整理未来60天内到期的项目项目，按项目组汇总预算。'},
    {id:'credit-message-2',title:'项目里程碑与提醒',meta:'项目助理 · 今天 14:03',snippet:'已筛出137条到期项目，3户项目报告待补充。'},
    {id:'brief-message-1',title:'项目月度进展简报 v3',meta:'文档整理专员 · 今天 11:20',snippet:'进展简报产物已生成，等待确认统计口径。'}]},
  {id:'agent',label:'智能体',items:[{id:'credit',agentId:'credit',title:'项目助理',snippet:'整理项目材料，核验缺口与风险。'},{id:'research',title:'DeepResearcher',snippet:'深度研究与证据对比。'}]},
  {id:'skill',label:'技能',items:[{id:'materials',title:'材料核验',snippet:'检查材料清单、证据和缺失项。'},{id:'research',title:'deep-research',snippet:'收集研究资料、比较证据与引用来源。'}]},
  {id:'context',label:'资料库',items:[{id:'policy',title:'项目规范与操作指引',snippet:'项目材料要求、审批口径与流程参考。'}]}
];
Object.assign(window,{SEARCH_PREVIEW});
