# 认知资产样例

仅为本地设计与交互样例，未接入客户端 IPC。颜色、字体、按钮、输入框、页签、图标与空状态复用现有设计系统；保留既有页面组合、认知树呈现和样例导航；有限优化只涉及展示与可访问性，不改变业务回调。

## 页面入口

| 层级 | 页面 | 地址 |
| --- | --- | --- |
| 一级 | 我的认知树 | [打开](cognition.html) |
| 一级 | 待我处理 | [打开](cognition.html?view=inbox) |
| 一级 | 复用与证明 | [打开](cognition.html?view=proofs) |
| 一级 | 版本与治理 | [打开](cognition.html?view=governance) |
| 二级 | 资产工作台 | [打开](cognition.html?view=assets&group=3&asset=cross) |
| 二级 | 候选审核 | [打开](cognition.html?view=candidate&candidate=candidate-1) |
| 二级 | 关于我 | [打开](cognition.html?view=about) |
| 二级 | 管理来源 | [打开](cognition.html?view=sources) |
| 二级 | 沉淀活动 | [打开](cognition.html?view=captures) |
| 二级 | 版本历史 | [打开](cognition.html?view=versions&asset=evidence) |
| 二级 | 复用记录 | [打开](cognition.html?view=proof-detail&asset=cross) |

一级页签与二级页使用同一外壳。`view` 决定页面，`group`、`asset`、`candidate` 决定所选内容。导航更新地址，刷新恢复对应页及初始示例数据；浏览器前进/后退恢复地址对应的视图。更深层的原文编辑、模板管理、原始回执、授权、技能编辑、回滚和删除等流程不展开，对应控件禁用。

## 源码对应

| 页面 | 参考源码 |
| --- | --- |
| 一级骨架、树与四类资产 | `src/renderer/index.html#panel-recall`；`skills.js::_renderCognitionPageHeader`、`_renderCognitionTreeFirstPage`、`_renderCognitionTreeContent`、`renderSkillsCognitionAssets` |
| 待办与候选 | `skills.js::renderSkillsCognitionInbox`、`renderSkillsCognitionCandidateDetail` |
| 复用与治理 | `skills.js::renderSkillsCognitionProofs`、`renderSkillsCognitionGovernance`、`_renderRecallAssetHistory` |
| 来源与沉淀 | `skills.js::renderSkillsCognitionSources`、`renderSkillsCognitionCaptures` |
| 关于我 | `personal-ontology.js` 中个人本体、角色模板与记忆分组 |

保留候选与正式资产分离、传递证明与效果证明分离、个人本体独立于四类资产列表、五类来源完整显示等边界。金融工作内容和日期均为样例，不能作为真实业务数据或产品能力的验证依据。候选审核演示确认、推迟、拒绝；确认后增加一项浅叶并减少待办，不产生复用证明，不自动合并或覆盖已有资产。

## 状态与验证

页面不展示审阅工具栏。可用 [空白种子](cognition.html?state=empty)、[只有候选](cognition.html?state=candidates)、[读取失败](cognition.html?state=error) 检查特殊状态。

本轮构建成功，完成 11 个视图的组件展开检查、候选处理后的跨页计数、搜索与无结果、来源展开、活动筛选、选中资产直达、异常重试，以及本地资源和设计变量引用检查。这些是组件与静态检查，不等于真实浏览器点击或布局验证。

此前本地文件访问受浏览器策略阻止；2026-09-05 改用已有 HTTP 预览服务进行了下述有限检查。统一构建与验证的当前结果仍以 [验证记录](../../verification.md) 为准。


## 有限优化评估（2026-09-05）

结论：现有四个主视图与七个二级视图已足以作为本轮设计基线，不重排信息架构，不扩展安装版流程。只修复两类有证据的问题：

| 问题 | 调整层级与处理 |
| --- | --- |
| 关于我、版本与治理的列表选中仅由颜色表达，辅助技术无法读出所选项 | 页面组合补 `aria-pressed`，与资产工作台已有语义保持一致；继续使用共享 Button，选择回调不变 |
| 沉淀活动展开详情贴在容器左边，无内边距与背景分区 | 专属 CSS 的后代选择器与兄弟节点结构不匹配，修正为 `.cg-capture-expanded`，恢复已有 token 间距与浅底，不改展开逻辑 |

已通过独立 Chrome 的 HTTP 预览查看全部 11 个视图；实测来源展开、活动 Enter 展开、关于我/治理项 Enter 选择、证明筛选（效果评价剩 3 项）、资产搜索无结果与清空恢复、资产选中地址/返回及刷新恢复。候选内容保持只读；回滚、删除、重新连接和原始回执等仍禁用，没有执行真实资产写入或授权。

本轮不更改候选确认、推迟、拒绝、限域、证明生成与治理的状态逻辑，也不补候选编辑、沉淀设置或角色模板管理。资产详情返回根页、治理列表局部选择和证明筛选离页后重置等现有导航行为保留，未为优化上下文记忆引入新状态。

检查范围为现有桌面视口与页面中的样例长文；窄视口、真实 IME 组合输入、跨共享浮层的 Escape/焦点回归未在此次专属检查中重测，交由共享组件整体验证，不作为本轮已通过结论。此次页面代码未增加快捷键或浮层。

统一构建后已再次回归两类改动：关于我/治理项的 `aria-pressed` 随键盘选择同步更新；沉淀活动 Enter 展开后的详情恢复内边距与浅底分区，浏览器截图确认不再贴边。专属文件 `git diff --check` 通过；整套 `verify.cjs` 结果由集成任务记录，不能以本次局部回归替代。
