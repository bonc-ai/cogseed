# Git / GitHub 规范（v1.0）

## 1. 基础纪律
- 仓库 public；README 是第一印象；
- commit 粒度 = 一个可解释的变更（"加了登录"而不是"改了一堆"）；
- commit message：动词开头 + 一句话说清 why（"fix: 修复 token 过期未重试"）；
- 提交前 `git status` / `git diff` 自查，别把密钥、node_modules、大文件交上去（用 .gitignore）。

## 2. 常见工作流
```bash
git clone <repo>          # 拿到别人的项目
git checkout -b feat/x    # 新功能开分支
git add . && git commit -m "feat: ..."
git push origin feat/x    # 推分支 → 开 Pull Request
```

## 3. 排错速查
| 现象 | 处理 |
|---|---|
| 403 / 认证失败 | 检查 SSH key 或 token 是否过期（`ssh -T git@github.com` 自测） |
| 冲突 conflict | 先 `git pull` 再解冲突，不 force push 覆盖他人 |
| 交错了文件 | `git rm --cached <file>` 移出跟踪，再加进 .gitignore |
| 想撤销上次 commit | `git reset --soft HEAD~1`（改动还在，重新提交） |

## 4. 平台校验口径（提交前必须满足）
- 仓库存在且可访问（public）；
- 有 README；
- 最新 commit 在提交前 24 小时内（"做完就交"，别攒一周）；
- 仓库文件树里有全部 required_deliverables（用 `check-deliverables` 自检）。
