# CI 与发布包合并规范

> 目的：避免“`develop` 能启动，但 `cicd` 打出的安装包不能用”。本规范适用于人和参与改动、审查、合并的 Agent。

## 分支与合并顺序

| 阶段 | 目标分支 | 通过条件 | 允许的动作 |
| --- | --- | --- | --- |
| 日常功能开发 | `develop` | `develop-gate.yml` 全绿、评审完成 | 功能 PR 合入 `develop` |
| 发布晋级 | `cicd` | `ci.yml`、`compliance.yml`、`email-gate.yml` 全绿 | 只将已验证的改动 PR 合入 `cicd` |
| 正式发布 | tag（仅来自 `cicd` 顶端） | `release.yml` 的所有硬门禁通过 | 创建版本 tag 和发布包 |

禁止直接 push 或直接 merge 到 `develop`、`cicd`。需要补丁时，始终从目标分支最新提交创建独立分支和 PR。若同一修复同时涉及开发和发布包，先合 `develop` PR，再合 `cicd` PR。

## Agent 的必读任务说明

把下面这段原样发给负责改动或准备合并的 Agent：

```text
先完整阅读 docs/CI_RELEASE_STANDARD.md，再开始改动。不要直接 push/merge develop、cicd 或 tag。
请先确认本 PR 的目标分支和受影响的发布面；运行与改动匹配的最小验证；如触及 Electron 打包、preload、主进程、native 模块、extraResources、运行时资源或 workflow，必须按本文“发布包硬标准”验证。CI 失败时先定位到具体步骤和根因，禁止通过 continue-on-error、跳过测试或放宽断言把 CI 强行变绿。最终报告：改动、验证命令和结果、未覆盖的平台风险。
```

## 提 PR 前的最低检查

1. 先读 `.github/workflows/develop-gate.yml`、`.github/workflows/ci.yml` 以及受影响脚本；不要凭“本地 `npm start` 正常”判断安装包正常。
2. 运行至少 `npm run typecheck`、`npm run lint`，以及覆盖本次改动的测试文件。测试输入、路径和断言必须同时兼容 macOS 与 Windows。
3. 提交作者邮箱只能使用 GitHub noreply 或 `business@bonc.com.cn`；提交信息、Co-authored-by 等 trailer 也不能含个人邮箱。
4. PR 描述必须写明：目标分支、是否影响安装包、实际运行过的命令、尚未验证的目标平台。
5. 不把无关功能、Dependabot 更新或大范围格式化夹带进 `develop → cicd` 晋级 PR。

## 发布包硬标准

只要改动涉及以下任一项，就按发布包改动处理：Electron main/preload/renderer、`package.json` 的 build 配置、`extraResources`、native 依赖、运行时二进制、签名/Fuses、安装器、`scripts/*pack*`、`.github/workflows/*`。

- 每个 `extraResources` 资源都必须在实际 `beforePack` 生命周期中准备并验证；不能依赖开发机曾经运行过 `npm start` 的副作用。
- 外部二进制必须锁定版本并校验哈希。OfficeCLI、Python/uv/Node 运行时、Windows VC runtime 都属于发布依赖。
- 对 macOS，Electron Fuses 会改写二进制；开发测试包若在 Fuses 之前 ad-hoc 签名，必须在 Fuses 之后重新签名并验证。正式包仍走官方签名流程。
- 不能只确认安装器生成成功。必须真实启动 unpacked 包，并由应用本身证明：`app.isPackaged`、`app.asar`、preload、renderer 和主进程 IPC 都可用。
- Windows 包还必须执行真实 STT 冒烟：媒体权限检查与请求、文件音频采样、`stt.start/pushAudio/stop`、最终转写事件均成功。该检查是阻断门禁，不能设为 `continue-on-error`。
- 主进程配置不要假定任意环境变量会自动传入 hardened renderer/preload。跨进程测试触发应使用主进程明确注入的私有参数，并由单元测试覆盖。

### 本机平台验证命令

按所在平台执行；不能执行的平台要在 PR 中明确说明，交给对应 CI 运行器验证。

```bash
# 所有平台：静态检查和本次受影响测试
npm run typecheck
npm run lint
npm exec -- vitest run <受影响的测试文件>

# macOS：开发态真实打包和启动
npm run package:dev:mac
npm run verify:package:dev:mac

# Windows：构建、真实启动和 STT 冒烟
npm run build:win
npm run verify:package:launch
npm run verify:package:stt:win
node scripts/check-fuses.cjs dist/win-unpacked/CogSeed.exe
```

## CI 红单处理

1. 在 Actions 中定位**第一个失败步骤**，保存失败命令和关键日志；不要只看 job 名称。
2. 区分三类：产品/发布包缺陷、测试跨平台缺陷、环境波动。只有有复现证据的环境波动才允许重试；重试不是修复。
3. 产品缺陷或测试缺陷必须用独立提交修复，并补回归测试；更新 PR 后让完整门禁重新运行。
4. 以下做法一律禁止：删除断言、增加无理由超时、`continue-on-error`、跳过 Windows STT/包启动校验、把失败资源改成“可选”以绕过发布门禁。
5. `cicd` PR 任一硬门禁失败都不能合；只有完整 CI 绿灯才进入发布/tag 阶段。

## 工作流责任边界

| 文件 | 职责 |
| --- | --- |
| `.github/workflows/develop-gate.yml` | PR → `develop` 的快速检查 |
| `.github/workflows/ci.yml` | PR/push → `cicd` 的 macOS、Windows、打包启动、STT 和 Fuses 发布门禁 |
| `.github/workflows/compliance.yml` | 晋级与发布合规检查 |
| `.github/workflows/email-gate.yml` | 提交及提交信息的邮箱卫生检查 |
| `.github/workflows/release.yml` | 仅对来自 `cicd` 顶端的 tag 构建和发布 |
