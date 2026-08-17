# 发布交接说明（给公司流程）

> 状态：包未发布。技术验证已完成，发布需公司 npm 组织账号决策后执行。

## 包信息

- 名称：`@cogseed/p3394-gateway`（包名/scope 归属待公司确认）
- 内容：`gateway.cjs`（核心，无依赖）+ `README.md` + `package.json`，共约 4.4kB
- Node >= 18，纯内置模块（http/child_process），零第三方依赖

## 发布步骤（公司流程定好后执行）

```bash
cd p3394-gateway
# 1. 预检（确认包内容、无多余文件）
npm pack --dry-run
# 2. 登录公司 npm 组织（或配置 token）
npm login --registry <目标 registry>
# 3. 正式发布
npm publish --registry <目标 registry>
# 4. 验证可安装
npm install -g @cogseed/p3394-gateway
p3394-gateway   # 打印 "hermes P3394 endpoint on http://127.0.0.1:9000"
```

## 发布前检查清单

- [ ] 包名/scope 归属确认（@cogseed 是否为公司所有）
- [ ] 目标 registry 决策（公网 npmjs.org 或公司私有 registry）
- [ ] 版本号确认（当前 0.1.0）
- [ ] 安全评审（代码边界：仅回环监听、参数数组无注入、幂等、无网络暴露）
- [ ] 自测通过：`cd p3394-gateway && node test/smoke.cjs`（11 项）

## 验证报告摘要

- 自测：smoke 11 项全过（manifest/鉴权/收件/转发/回发/幂等/空消息/校验）
- 真实环境：与真 Hermes 模型端到端互通（双向多轮），Commander 首次调用失败时自动给出安装引导
- CogSeed 侧配套：P3394 内建（入站对话流 + 出站 p3394_send 工具），828 测试全绿
