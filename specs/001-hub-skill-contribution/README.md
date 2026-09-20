# 客户端 Skill 贡献

- [功能规格](spec.md)与[质量清单](checklists/requirements.md)
- [高保真交互原型](prototype/prototype.html)：页面顶栏可直达入口、登录提示弹窗、补齐、校验、预览、提交与贡献管理各阶段
- [条款全文参考页](prototype/terms-v1.0.html)：供原型中的「查看条款全文」使用

原型可直接打开 prototype/prototype.html。顶栏「原型导览」位于模拟客户端窗口外，全部阶段均可点击直达；窗口内独立滚动。评审直达地址：

- [技能库与两个入口](prototype/prototype.html?view=skills)
- [未登录入口与登录提示弹窗](prototype/prototype.html?view=skills&auth=guest&modal=login)
- [版本与安全声明补齐](prototype/prototype.html?view=contribute&skill=imagegen&stage=complete)
- [本地检查](prototype/prototype.html?view=contribute&skill=plugin-creator&stage=check)
- [本地阻断状态](prototype/prototype.html?view=contribute&skill=plugin-creator&scenario=blocked)
- [检查不可用](prototype/prototype.html?view=contribute&skill=plugin-creator&scenario=unavailable)
- [提交预览与三项声明](prototype/prototype.html?view=contribute&skill=plugin-creator&stage=preview)
- [历史贡献与管理](prototype/prototype.html?view=contributions)

原型使用内存中的模拟数据，没有接入客户端 IPC、真实本地检查、账号或 Hub 接口；安全声明文件与校验结论均为交互示意，不能作为真实扫描报告。提交、刷新与撤回只改变当前页面状态；刷新页面会重置。自定义卡片的「贡献」在未登录时仍可见；点击「贡献」或「我的贡献」会复用同一登录提示弹窗，主按钮为「前往 Web 登录」，随后在弹窗中模拟 Web 登录完成并返回原操作，不会打开真实授权地址。三点菜单保留编辑、停用和卸载，平台卡片不显示「贡献」。技能图标在有资源时显示；没有资源或加载失败时，以名称首个汉字或拉丁字母配底色圆形头像回退。外观取自 cogseed-product/docs/design/opensource-design-system/ 的开源颜色、字体、间距与组件规范，品牌图和 Lucide 图标已复制到 prototype/prototype-assets/，供独立打开使用；图标授权文本见 prototype/prototype-assets/LUCIDE-LICENSE.txt。

条款参考页取自 Hub 侧 2026-09-18 标为 v1.0 正式稿的条款正文；其中第 12.3、12.4 条仍有待补内容。原型展示不表示条款已在 Hub 配置生效，也不表示客户端功能已实现、评审或验收。
