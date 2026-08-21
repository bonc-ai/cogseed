# 应用更新检查 —— 服务端接口契约

客户端更新提醒功能（v1）依赖一个服务端接口。本文档是与后端对齐的契约，客户端实现见
`src/main/features/updater/client.ts`，状态与提醒规则见 `src/main/features/updater/state.ts`。

## 端点

```
GET {COGSEED_API_BASE_URL}/updates/latest
```

- 基址解析优先级（与 `features/hub_account` 同一模式，见 `features/api_base.ts`）：
  1. 环境变量 `COGSEED_API_BASE_URL`（联调/部署覆盖，必须是干净的 HTTPS origin/path）；
  2. 构建通道默认：release / packaged-dev 包内建 `https://cogseed-open.bonc.com.cn`（否则打包后的 app 不跑
     run.sh、拿不到任何环境变量，更新检查会静默失败）；dev 模式默认 `http://localhost:3000`。
- 无查询参数。客户端元数据全部走请求头（见下）。
- 响应沿用项目统一的 envelope 格式：`{ "code": 0, "data": ... }`。

## 请求头（客户端自动携带，无需后端要求之外的特殊处理）

| Header | 示例 | 说明 |
|---|---|---|
| `CogSeed-App-Version` | `0.0.5` | 当前应用版本（semver 风格） |
| `CogSeed-Platform` | `darwin` / `win32` / `linux` | 平台 |
| `CogSeed-OS-Version` | `24.5.0` | 系统版本 |
| `CogSeed-Arch` | `arm64` / `x64` | 架构 |
| `CogSeed-Channel` | `open` | 渠道（开源构建恒为 `open`） |

## 成功响应（有新版本）

```json
{
  "code": 0,
  "data": {
    "latest_version": "0.0.6",
    "url": "https://download.example.com/CogSeed-0.0.6-mac-arm64.dmg",
    "sha256": "0123abcd...（64 位 hex）",
    "size": 381344829,
    "notes": "修复了若干问题，新增 XX 功能。",
    "min_app_version": "0.0.5",
    "released_at": "2026-08-21T00:00:00Z",
    "mandatory": false
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `latest_version` | 是 | 最新版本号。客户端用 `compareVersions` 与当前版本比较，必须大于当前版本才视为更新 |
| `url` | 是 | 安装包下载地址，**必须 HTTPS**；客户端会拒绝非 https 地址 |
| `sha256` | 是 | 安装包 sha256（hex）。下载完成后客户端逐字节校验，不匹配则丢弃文件并提示重试 |
| `size` | 否 | 字节数，用于下载进度展示 |
| `notes` | 否 | 更新说明（纯文本，客户端原样展示） |
| `min_app_version` | 否 | 该版本要求的最低当前版本（信息性） |
| `released_at` | 否 | 发布时间（ISO-8601，信息性） |
| `mandatory` | 否 | 是否强制更新（v1 仅展示，不强制） |

## 成功响应（已是最新）

```json
{ "code": 0, "data": null }
```

`data` 缺失 / 为 `null` / 为空对象 均视为"无更新"。客户端不会仅凭 `latest_version` 相等就报更新——
只有严格大于当前版本才提示。

## 错误

沿用 envelope 约定：`code != 0` 视为失败，`msg` 携带原因。客户端对失败静默处理
（启动检查不打扰用户；设置页手动检查展示 `msg`）。

```
{ "code": 1, "msg": "…" }
```

## 客户端行为摘要（对齐用）

- **启动时静默检查**（deferred boot 任务，失败只记日志）+ **设置页手动检查**。
- 提醒节流：同一版本**每 24 小时最多提醒一次**；用户"跳过此版本"后不再自动提醒
  （手动检查仍会如实报告新版本）。
- 下载：应用内流式下载到 `<uid>/local/updates/`，sha256 校验通过后才可打开安装包。
- mac v1 形态：下载 dmg → 校验 → 打开 Finder → 用户拖入 Applications。
  二期计划支持 zip 包自动替换（届时打包侧需正式签名 + 公证，见项目打包配置）。
- 隐私：请求只携带版本/平台/架构/渠道头，无账号、无设备指纹以外的标识，不采集用户数据。

## 发布流程（后端侧）

1. 新版本安装包产出后（同事打包），计算 sha256 与 size。
2. 更新 `/updates/latest` 返回的 `data`（或静态文件）。
3. 校验：客户端 `updates.check`（设置页）→ 下载 → 校验 → 打开，全链路走通后对外发布。
