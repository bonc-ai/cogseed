# README 外链探测记录（2026-09-23）

范围：`README.md` + `README.zh-CN.md`。

1. `node scripts/check-readme-links.mjs --external` → **22 markdown 外链全部通过**（此前默认跳过的 externals）。
2. HTML `<a href>` 额外探测：`…/stargazers` 未认证 **HTTP 404** → 已改为仓库根 `https://github.com/bonc-ai/cogseed`（与页脚 Star 一致）。
3. 其余 GitHub / shields / 上游生态链接抽查均为 HTTP 200。

不保留不可达或非公开内链；本轮无发现内网域名出现在 README。
