# CogSeed 自动更新发布 Runbook（v1：DMG 提醒 + zip 自动更新并存）

> 适用版本：本分支（feat/auto-update-squirrel）及之后。目标：桌面端「点完自己装好」。

## 架构速览

```
GitHub main 打 tag vX.Y.Z（发布节奏由团队决定，防呆只允许 main 上的 tag）
  → Build & Sign macOS：签名+公证产出 dmg（手动安装）+ zip（自动更新）
  → GitHub Release 挂两个文件
  → 内网 GitLab release:installer（INSTALLER_URL=dmg 直链，AUTO_UPDATE_ZIP_URL=zip 直链）
  → 服务器登记为运营平台「草稿包」（系统计算 SHA-256，不直写 catalog）
  → 发布员在运营平台核对后点「发布」
  → releases.json（老版本客户端提醒通道，dmg）+ /updates/feed/mac-arm64（新客户端自动更新）
```

两条通道并存：**尚未安装本分支版本的用户**走提醒 → 下载 DMG 手动安装一次；**已安装的用户**此后
后台静默检查 + 自动下载，设置页出现「重启并安装」，点击即完成替换。

## 发布步骤

1. **GitHub**：把代码合并进 `main` → Releases → Draft a new release → tag 填 `vX.Y.Z`
   （"Create new tag on publish"，target=main）→ Publish。
2. 等 Actions 跑完（约 10 分钟），Release 页应有两个资产：`CogSeed-X.Y.Z-mac-arm64.dmg` 与
   `CogSeed-X.Y.Z-mac-arm64.zip`。复制两者的下载直链（右键 → 复制链接地址）。
3. **内网 GitLab**（hub 项目）：CI/CD → Run pipeline（main 分支）：
   - `INSTALLER_URL` = dmg 直链
   - `AUTO_UPDATE_ZIP_URL` = zip 直链
   - （无 AUTO_UPDATE_ZIP_URL 也能登记，但用户将收不到自动更新）
4. **运营平台**（需要「更新发布员」角色）：「App 更新」→ 找到 `X.Y.Z` 版本：
   - 核对版本号、dmg/zip 文件名与 SHA-256
   - 编辑更新日志 → 保存草稿 → 发布日志修订（官网 changelog 即时更新）
   - 点「发布」（二次确认弹窗会展示对象与影响；无 zip 时会提示"用户只能手动安装"）
5. **回退/叫停**：平台点「下线」→ 两个通道同时清空；版本号递增校验门会阻止误降级。

## 端到端验收清单（首次发布必做）

1. 公网接口：
   - `curl https://cogseed-open.bonc.com.cn/updates/latest`（带低版本头）→ 返回新版本 dmg 信息
   - `curl https://cogseed-open.bonc.com.cn/updates/feed/mac-arm64` → `{url,name,notes,pub_date}`，url 为 zip
   - `curl https://cogseed-open.bonc.com.cn/updates/changelog` → 含新版本日志
2. **旧版本客户端**（如 0.0.5 安装包）：启动/手动检查 → 收到提醒 → 下载 DMG → 打开拖拽安装。
3. **新版本客户端**（本分支打包的正式安装包，签名+公证）：
   - 安装后打开设置页 → 「自动更新」状态行显示"已是最新版本"
   - 发布**更高**版本后：启动应用 → 后台自动下载（无需任何点击）→ 设置页出现
     「重启并安装」→ 点击 → 应用退出并自动替换重启 → 版本号更新成功
4. 失败兜底：断网/下载失败时应用正常启动，设置页显示错误状态；v1 手动通道仍可用。

## 关键约束（踩坑提示）

- autoUpdater 只在**打包+签名**的应用里生效；`npm run dev` 开发模式自动禁用（回落到 v1 手动流程）。
- zip 内必须直接包含 `CogSeed.app`（electron-builder 的 mac zip 目标天然满足）。
- 首次把用户从 DMG 版本切到自动更新版本需要一次手动安装；之后的升级才全自动。
- 自动更新包的签名必须与安装包同一开发者证书；换证书会触发"更新失败"。
- feed 的 `pub_date` 取发布时刻；同版本重复发布（补 zip）不会重复提醒。
