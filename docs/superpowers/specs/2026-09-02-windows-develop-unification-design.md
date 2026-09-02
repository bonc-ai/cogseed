# Windows 与 develop 统一设计

日期：2026-09-02
状态：待书面确认

## 目标

以最新 `origin/develop` 为唯一主线，把旧 `dev/windows` 上仍然有效的 Windows 适配能力完整并入 `develop`，形成同一套代码同时支持 macOS 和 Windows 的仓库状态。

本次工作止于 `develop`。不合并、不提交、不推送到 `main`。

## 当前事实

- 最新 `origin/develop`：`05f6adc8`。
- 最新 `origin/dev/windows`：`fb1814e0`。
- `dev/windows` 相对 `develop` 落后 50 个提交、领先 7 个提交。
- Ltt798599368923 的大型 UI 更新 `e80d8786` 已在 `develop`，不在旧 Windows 分支基线上。
- Windows 分支包含 Windows CLI 发现、`.cmd` 启动、进程树回收、强沙箱、P3394 适配、诊断脚本、Windows CI 和弹窗关闭按钮等增量。
- 直接合并会在 `p3394-gateway/gateway.cjs` 产生冲突，因为最新 `develop` 和 Windows 分支都修改了 Agent 启动路径。

## 备选方案

### 方案 A：从最新 develop 建立集成分支并合入 Windows（采用）

从 `origin/develop` 创建集成分支，再合入 `origin/dev/windows`。逐处进行语义冲突解析，验证后通过 PR 回到 `develop`。

优点是不会丢失最新产品、UI 和外部 Agent 能力，同时保留 Windows 分支的完整提交关系；风险集中在少量冲突文件，便于审查。

### 方案 B：把 dev/windows 变基到最新 develop

历史更线性，但会重写 Windows 分支的 7 个提交。多人协作时容易造成旧引用、重复提交和强制推送风险，因此不采用。

### 方案 C：逐个 cherry-pick Windows 提交

可以筛选提交，但 Windows 提交之间存在演进关系，容易遗漏修复或改变原始顺序；也会让后续追溯更加困难，因此不采用。

## 整合设计

### 分支与数据流

1. `integration/windows-unification` 固定从最新 `origin/develop` 创建。
2. 将 `origin/dev/windows` 以非快进方式合入集成分支。
3. 只在集成分支解决冲突和修复验证发现的问题。
4. 验证通过后创建 `integration/windows-unification → develop` PR。
5. 不对 `main` 执行任何操作。

### 冲突解析原则

- `develop` 的产品功能和数据结构是基准，不能被旧实现覆盖。
- Windows 分支提供平台适配，不建立长期独立业务逻辑。
- `p3394-gateway/gateway.cjs` 必须同时保留：
  - `develop` 的模型发现、模型选择、推理强度和用量统计；
  - Windows 的 `spawnCli`、引号感知参数拆分、`.cmd/.bat`、Node shebang 和进程树回收能力。
- Renderer 以 Ltt798599368923 已合入 `develop` 的 UI 体系为准，再叠加 Windows 分支的外接 Agent 弹窗关闭按钮。
- 平台差异通过 `process.platform`、路径解析和构建配置表达，不复制两套功能代码。

## 验证设计

### Windows 必过门禁

- `npm run typecheck`
- `npm run lint`
- `npm run test:platform-native`
- P3394 gateway 协议 smoke
- Codex CLI 发现与 `.cmd` 启动诊断
- Windows 打包至少成功生成 unpacked 应用；正式交付时生成 NSIS 安装包
- 打包内容包含 Windows sandbox launcher、运行时资源和所需 VC runtime

当前实测对比：最新 `develop` 的 Windows 平台原生测试为 16/18 文件通过、3 个测试失败并有 2 个未处理错误；候选语义合并为 18/18 文件通过、323 个测试通过、3 个跳过、0 个未处理错误。

### macOS 必过门禁

- `npm run typecheck`
- `npm run lint`
- `npm test`
- 现有 macOS 打包与签名流程
- Renderer 与 Main IPC 合同复核

Windows 主机不能替代 macOS 验证，最终 PR 必须取得 macOS CI 结果。

### 已知基线问题

- 外部 Agent 测试仍有 `/bin/echo`、Windows 脚本退出码和配置路径相关的既有跨平台失败；合并前后结果一致，但应明确记录或修复，不能误判为 Windows 分支回归。
- Windows 打包当前被 `packaged-resource-gate` 对 `builtin-packages` 的登记缺失阻断；合并前后均失败。Windows 可下载包发布前必须修复。
- 当前 CI 主要在 `cicd` 触发，`develop` PR 缺少自动验证。统一分支的 PR 应提供 macOS 与 Windows 两个平台的可见检查结果。

## GitHub 交付方式

- Git 拉取始终获取同一套跨平台源码，不按操作系统返回不同分支。
- Windows 和 macOS 的差异体现在 CI 构建矩阵与 Release artifacts。
- Windows 产物使用明确名称，例如 `CogSeed-<version>-windows-x64.exe`。
- macOS 产物分别标识 `arm64` 和 `x64`。
- 本次统一不发布 Release，也不进入 `main`。

## 完成标准

- 集成分支包含最新 `develop` 与 7 个 Windows 增量提交的有效能力。
- 所有冲突均按语义融合，`git diff --check` 无错误。
- Windows 平台门禁通过，并能产生可检查的 Windows 包。
- macOS CI 通过，最新 UI、外部 Agent 模型控制和 IPC 合同未回退。
- PR 目标仅为 `develop`，评审记录包含测试矩阵与已知基线问题。

## 非目标

- 不修改或合并 `main`。
- 不维持一套长期独立的 Windows 产品分支。
- 不为 Windows 复制 macOS 业务实现。
- 不在本次统一中发布正式版本。
