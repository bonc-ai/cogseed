# 更新功能本地验证 Runbook（不经过 GitHub / 生产服务器）

> 目标：在一台 macOS（arm64）上把「发布 → 旧客户端升级」全链路走一遍，
> 覆盖 v1 提醒通道（dmg）与 v2 自动更新通道（Squirrel.Mac zip）。
> 全程使用本机 HTTPS 服务与本地制品，不发布到 GitHub，不触碰生产
> `cogseed-open.bonc.com.cn`。参考生产发布流程见 `auto-update-release.md`。

## 真实 hub 联动验证（生产端点，验证完必须下线）

本地闭环验证通过后，可再做一次「真实 hub」联动：hub 后台点发布 → 桌面端
提醒。制品用 `scripts/build-hub-verify-artifacts.mjs` 构建（真实产品配置、
无证书 ad-hoc 密封），走内网 GitLab Release 资产直链 + `release:installer`
管道登记草稿包 → hub 后台发布 → 桌面测试客户端（release 渠道，默认指向
生产 API）验证 → 立即「下线」。hub 后端契约对齐点见
`updates-hub-integration-checklist.md`。

## 原理与组成

```
npm run package:dev:mac          → dist-dev/mac-arm64/CogSeed Dev.app（"旧版"，渠道
                                   packaged-dev；驱动以 COGSEED_SKIP_ADHOC_CODESIGN=1
                                   打包，跳过 afterPack 的深度 ad-hoc 重签——它会破坏
                                   Electron 官方嵌套框架的密封，导致 Squirrel 校验替换包
                                   失败；嵌套组件保留官方签名，驱动只给外层补 ad-hoc 签名）
scripts/test-update-local.mjs    → 一键驱动：
  1. 两遍真实构建（而非改 plist）：
     - 旧版：当前 package.json 版本 → dist-dev
     - 新版：临时把 package.json 版本改成 X.Y.Z → 构建到 dist-dev-new → 恢复
       electron-builder 会同时写入 bundle plist 与 asar package.json，
       两者版本一致——只改 plist 会让升级后的 app 仍自报旧版本
       （app.getVersion() 优先读 asar），v1/v2 都会再次提示更新形成循环
  2. 新版包 bottom-up ad-hoc 密封（helper/框架逐个补签名，外层带
     identifier 校验的 designated requirement——ad-hoc 默认 cdhash 指纹
     两包必不同，Squirrel 校验替换包时过不了）
  3. ditto 打 zip（自动更新制品，zip 根目录直接是 .app）
     hdiutil 打 dmg（v1 提醒制品）
  4. publish.cjs 把两个制品登记进一次性 catalog
     updates-server/.local-verify/releases.json（git-ignored，与仓库正式
     releases.json 无关）
  5. mkcert 生成本地受信证书（无 mkcert 时回退 openssl 自签 + 钥匙串导入）
  6. 以 TLS_KEY/TLS_CERT 启动 updates-server/server.cjs
     → https://127.0.0.1:4870，提供 /updates/latest、/updates/feed/mac-arm64、
       /downloads/*
  7. 以客户端同款请求断言服务端契约（含 sha256 一致性）
```

客户端侧硬约束（决定必须这么搭的原因）：

- `features/updater/auto.ts` 仅在 `app.isPackaged` 时启用自动更新 → 必须用打包产物；
- `features/api_base.ts` 校验 `COGSEED_API_BASE_URL` 必须 https；
- `features/updater/client.ts` 拒绝非 https 下载地址；
- Squirrel.Mac 检查要求 app 有签名（ad-hoc 即可），feed 返回裸
  `{url,name,notes,pub_date}` JSON（非业务 envelope）。

## 一次性准备（每台机器只需一次）

```sh
brew install mkcert                     # 本地 CA 工具
mkcert -CAROOT                          # 生成 rootCA.pem（首次自动创建）
# mkcert -install 需要 sudo；无 sudo 时改用 login 钥匙串：
security add-trusted-cert -d -r trustRoot -k \
  "$HOME/Library/Keychains/login.keychain-db" "$(mkcert -CAROOT)/rootCA.pem"
```

## 走一遍

```sh
# 1. 打包"旧版"客户端（改动后需重新打包一次；没改可跳过）
npm run package:dev:mac

# 2. 一键驱动：两遍构建 + 制品 + 本地发布 + HTTPS 服务 + 契约断言
node scripts/test-update-local.mjs --new-version 0.0.6 --notes "本地验证发布"
# （省略 --new-version 时自动取 package.json 版本号 +1；
#   首次会跑两遍 electron-builder，约 4-6 分钟）
# --skip-package 仅在 dist-dev 已就绪（旧版本、已密封）时用于加速复跑；
# 若 dist-dev 已被 ShipIt 升级到新版本，驱动会拒绝并提示去掉该参数。

# 3. 用隔离 HOME 启动旧版客户端（不污染真实数据）：
#    --ignore-certificate-errors 是因为 Electron 41 主进程 fetch 走 Chromium
#    信任库、不读 login 钥匙串；Squirrel 的 feed/下载走 NSURLSession 则已信任
rm -rf /tmp/cogseed-update-e2e-home && mkdir -p /tmp/cogseed-update-e2e-home
HOME=/tmp/cogseed-update-e2e-home \
NODE_EXTRA_CA_CERTS="$PWD/updates-server/.local-verify/tls/rootCA.pem" \
COGSEED_API_BASE_URL=https://127.0.0.1:4870 \
  "dist-dev/mac-arm64/CogSeed Dev.app/Contents/MacOS/CogSeed Dev" \
  --ignore-certificate-errors

# 4. 观察日志（无头验证）：
#    v1：启动静默检查请求 /updates/latest
#    v2：auto-update status checking → downloading → downloaded（版本 0.0.6）
grep -E "updater|auto-update" /tmp/cogseed-update-e2e-home/**/logs/*.log

# 5. 收尾：
node scripts/test-update-local.mjs --stop
```

## 应用内手动验收（点两下确认 UI 链路）

| 通道 | 步骤 | 预期 |
|---|---|---|
| v1 | 设置 → 立即检查更新 | 提示 0.0.6；下载进度；sha256 校验后打开 DMG（Finder 拖拽安装） |
| v2 | 启动后什么都不点 | 后台自动下载完成，设置页「自动更新」出现「重启并安装」 |
| v2 | 点击「重启并安装」 | 应用退出 → ShipIt 替换 → 自动重启 → 关于页版本变为 0.0.6 |
| 兜底 | 停掉服务再启动 app | 启动正常，设置页显示错误状态，v1 手动通道仍可用 |

## 已知限制（本地验证的边界）

- **无正式签名/公证**：制品是 ad-hoc 签名。为通过 Squirrel 替换包校验，
  驱动对新旧两包做 bottom-up ad-hoc 密封并签显式的 identifier 校验；
  正式发布使用 Developer ID 证书 + 公证（生产流程不变，见
  `auto-update-release.md`）。
- 客户端从 `dist-dev` 目录运行而非 `/Applications`，替换路径语义与生产不同，
  仅影响最后一步的观察。
- ShipIt 重启应用时不会带上自定义环境变量（HOME / COGSEED_API_BASE_URL）：
  重启后的实例会回到生产 API 地址、使用真实数据目录——这是真实用户的正常
  行为，本地验证时注意这一点即可。
- 一次性 catalog 在 `updates-server/.local-verify/`（已 git-ignore），
  每次驱动运行会重建；仓库正式 `updates-server/releases.json` 不会被改动。

## 服务端本地能力（本分支新增）

- `updates-server/server.cjs`：`TLS_KEY`/`TLS_CERT` 环境变量启用 HTTPS；
  新增 `GET /updates/feed/mac-<arch>` 路由（catalog 中最新 zip 的
  Squirrel.Mac feed JSON）；每请求一行访问日志（方法/路径/客户端元数据头）。
- **feed 版本门控在服务端**（Electron 客户端不做版本比较，任何 200 JSON
  feed 都视为"有更新"）：Squirrel 的 feed 请求不带 CogSeed-* 头，调用方
  版本在 User-Agent 的 CFNetwork token 里（`CogSeed Dev/0.0.6 CFNetwork/…`）；
  服务端解析后，若最新 zip 版本 ≤ 调用方版本则回 **204**（客户端进入
  idle/"已是最新"），否则回 200 feed JSON。生产 hub 同语义。
- `updates-server/lib/catalog.cjs`：`selectLatest` 支持 `ext` / `excludeExt`
  过滤（dmg 走 v1、zip 走 v2，互不串线）；`upsertRelease` 键加入文件扩展名，
  同版本 dmg+zip 并存。
- 测试：`npm run test:updates-server`（feed 路由与 UA 门控、通道隔离、
  upsert 语义）。

## 本地验证曾抓到的真实问题

- **v1 平台头契约不一致（已修复）**：`api_common.withCommonHeaders` 里
  `desktopPlatform()` 输出应用自有分类 `mac`/`windows`/`pc`，而更新契约
  （`updates-api.md`、catalog、参考服务）用 `darwin`/`win32`/`linux`。
  `mac` 匹配不到任何 catalog 条目 → `/updates/latest` 永远返回"已是最新"，
  v1 提醒通道在生产同样会静默失效。修复：`updater/client.ts` 只对更新请求
  把平台头映射为契约 token（不动其他共用头）。对应回归测试在
  `test/main/features/updater/client.test.ts`。
- **ad-hoc 签名无法过 Squirrel 校验（本地局限，非代码问题）**：生产用
  Developer ID 证书整体重签，天然满足 SecStaticCode；本地无证书时按上文
  步骤的 bottom-up ad-hoc 密封配方可完整走通。
