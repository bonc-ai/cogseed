# README 外链探测记录（2026-09-23）

范围：`README.md` + `README.zh-CN.md` 中全部绝对 URL（共 19 条）。
命令：`curl -I -L --max-time 10 -A Mozilla/5.0`（失败项另用 GET 复核）。

本地相对链接由 `npm run readme:check` 覆盖，不在本表。

| HTTP | URL |
|---|---|
| 200 | `https://github.com/NousResearch/hermes-agent` |
| 200 | `https://github.com/Orkas-AI/Orkas` |
| 200 | `https://github.com/bonc-ai/cogseed` |
| 200 | `https://github.com/bonc-ai/cogseed.git` |
| 200 | `https://github.com/bonc-ai/cogseed/discussions` |
| 200 | `https://github.com/bonc-ai/cogseed/fork` |
| 200 | `https://github.com/bonc-ai/cogseed/issues` |
| 200 | `https://github.com/bonc-ai/cogseed/labels/documentation` |
| 200 | `https://github.com/bonc-ai/cogseed/labels/good%20first%20issue` |
| 200 | `https://github.com/bonc-ai/cogseed/labels/help%20wanted` |
| 200 | `https://github.com/bonc-ai/cogseed/releases` |
| 404 | `https://github.com/bonc-ai/cogseed/stargazers`（HEAD/GET 均为 404；未认证访问受限星标页常见，不阻塞） |
| 200 | `https://github.com/openclaw/openclaw` |
| 200 | `https://img.shields.io/badge/Release-v1.2.0-blue` |
| 200 | `https://img.shields.io/badge/Windows-x64-0078D4?logo=windows` |
| 200 | `https://img.shields.io/badge/macOS-12%2B-black?logo=apple` |
| 200 | `https://img.shields.io/github/downloads/bonc-ai/cogseed/total?label=Downloads` |
| 200 | `https://img.shields.io/github/license/bonc-ai/cogseed` |
| 200 | `https://img.shields.io/github/stars/bonc-ai/cogseed?style=flat` |

**摘要**：18×200 + 1×404。无超时/连接失败。不据此修改 README 星标页链接（盾牌 `stars` badge 本身 200）。
