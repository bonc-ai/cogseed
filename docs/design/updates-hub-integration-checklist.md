# hub 后端更新接口对齐清单（桌面端验证结论）

> 背景：桌面端更新功能在本地全链路验证通过（v1 提醒 + v2 Squirrel.Mac 自动更新）。
> 验证中发现两处 hub 后端必须对齐的契约点，以及生产发布联动的操作顺序。
> 桌面端代码已就绪；本清单供 hub 侧同事核对。

## 1. 版本门控契约（v2 feed，最重要）

桌面端 v2 用 Electron 内置 autoUpdater（Squirrel.Mac），请求
`GET {API_BASE}/updates/feed/mac-<arch>`。实测确认的行为：

- **客户端不做版本比较**：只要 200 且返回非空 feed JSON，客户端就进入
  downloading。版本门控**必须在服务端做**。
- 请求**不带 CogSeed-* 头**，调用方版本在 **User-Agent** 里：
  `CogSeed/0.0.6 CFNetwork/3860.600.21 Darwin/25.5.0`（应用名可能有空格被
  URL 编码，如 `CogSeed%20Dev`）。
- 服务端规则：
  - 解析 UA 中的版本（正则参考：`/\/(\d+\.\d+\.\d+(?:[0-9A-Za-z.\-+]*)?)\s+CFNetwork/i`）；
  - 最新 zip 版本 ≤ 调用方版本 → 返回 **204 No Content**（客户端进入
    idle/"已是最新"）；
  - 更新可用 → 200 + `{url, name, notes, pub_date}`（name = 版本号）。
- ⚠️ 当前 hub 的 feed 在"无更新"时返回 `200 + {}` —— 实测该形态会让客户端
  进入 **error 状态**而不是"已是最新"，需要改成 204。
- 参考实现与测试：`updates-server/server.cjs::handleFeed` +
  `updates-server/test/server.test.cjs`（UA 门控用例）。

## 2. 平台 token 契约（v1 /updates/latest）

- 桌面端（已修复）发送 `CogSeed-Platform: darwin | win32 | linux`，不是
  `mac`。hub 后台登记版本时的平台字段、以及 catalog 匹配逻辑必须用同一套
  token，否则永远匹配不上（桌面端静默显示"已是最新"）。
- 响应 envelope：`{code:0, data:{latest_version, url, sha256, size?, notes?, …}}`；
  无更新 `{code:0, data:null}`。url 必须 https，dmg 走 v1、zip 走 v2，互不串线。

## 3. 生产发布联动顺序（验证阶段与正式流程一致）

```
① 制品：CogSeed-X.Y.Z-darwin-arm64.dmg + .zip（正式走 GitHub Release 直链；
   验证阶段：本机 .hub-verify/artifacts/ 直接经 hub 后台表单上传，
   不必经过内网 GitLab 管道）
②【验证阶段】hub 后台 admin/updates：新建版本 → 上传 dmg（主安装包）+
   zip（自动更新包）→ 核对 SHA-256 → 点「发布」
  【正式流程】内网 GitLab：Run pipeline（main）：
   INSTALLER_URL=<dmg 直链>、AUTO_UPDATE_ZIP_URL=<zip 直链>
   → release:installer 登记草稿包（文件名须 CogSeed-<version>-darwin-arm64.<ext>）
③ hub 后台 admin/updates（发布员）：核对版本/文件名/SHA-256 → 点「发布」
④ 桌面端：启动/手动检查即提醒（v1）+ 后台静默下载（v2）
⑤ 验证完点「下线」，两通道同时清空；版本号递增校验门阻止误降级
```

## 5. hub 侧修复 MR

- 内网 GitLab hub 项目 MR !45：
  `fix(updates): feed 按 User-Agent 版本门控，已是最新回 204`
  （feed 无更新回 204 而非 `200+{}`；从 CFNetwork UA 解析版本做门控；
  合并到 main 自动部署）。合并前请 hub 侧 review。

## 4. 验证阶段注意事项

- 验证期制品是无证书 ad-hoc 密封包（仅本机测试客户端可用）；正式发布必须
  走 GitHub Actions 的签名+公证产物，v2 替换包才能被真实用户客户端校验通过。
- 生产 hub 发布测试条目后，真实用户客户端也会收到提醒——验证完立即「下线」，
  不留测试条目。
