# 排障手册（Troubleshooting v1.0）

> 用法：按「现象 → 错误码」定位，再走处理路径。错误码出现在插件返回的 `error.code`。

## 错误码总表

| 错误码 | 含义 | 谁处理 |
|---|---|---|
| `SEAT_NOT_LICENSED` | 席位未授权（未购/未开通） | 管理员在 /admin/licenses 开通 |
| `COURSE_NOT_LICENSED` | 课程未授权 | 管理员检查授权课程范围 |
| `LICENSE_CHECK_FAILED` | 授权中心不可达（飞书抖动/无缓存） | 平台运维：查飞书连通性，稍后自动恢复 |
| `AUTH_FAILED` / 401 | 密钥无效/过期 | 学生去 /companion 重新生成 |
| `ROLE_DENIED` | 越权（学生发挑战等） | 无需处理（系统正确拦截） |
| `CHALLENGE_NOT_FOUND` | 挑战不存在 | 检查挑战 ID 拼写 |
| `CHALLENGE_CLOSED` | 挑战已截止 | 教师决定是否延期 |
| `INPUT_MISSING` | 缺必填项 | 按提示补齐字段 |
| `REPO_PATTERN_MISMATCH` / `README_MISSING` | 交付物不齐 | 学生自查仓库（check-deliverables） |
| `DUPLICATE_SUBMISSION` | 重复提交 | 走"修改后重交"路径（同挑战可多次提交，会接学习链） |
| `NETWORK_ERROR` | 平台不可达 | 稍后重试；持续则查平台 |
| 503 | 平台忙/总线降级 | 稍后重试；平台运维查 Redis |

## 常见故障路径

### 学生全部提示"未授权"
1. 管理端 /admin/licenses 确认该学号在 active 名单；
2. 确认课程 ID 一致（插件 EDUSEED_COURSE_ID = 授权表 course_id）；
3. 确认到期时间未过（expires_at）。

### 学生全部提示"平台不可达"
1. `curl <平台>/api/health`（服务器上 `bash scripts/deploy-check.sh`）；
2. 检查 pm2 进程、nginx、Redis；
3. 查看 pm2 日志尾部错误。

### AI 初评全是 fallback（无分数波动）
1. 管理端 /admin/health：DEEPSEEK_API_KEY 是否存在、metrics 的 ai_eval_failed 是否在涨；
2. 检查 DeepSeek 余额/网络出口；
3. 换 key 走密钥轮换手册。

### 飞书通知收不到
1. 学生侧：检查学生 feishu_open_id 是否绑定（学生表字段）；
2. 群通知：确认 FEISHU_CLASS_CHAT_ID 已配置；
3. 飞书限流：metrics 的 feishu_error_total 突增 → 平台有退避重试，等 1-2 分钟。

### 提交任务卡"处理中"
1. 查 /api/admin/health 的 bus.pending 积压；
2. 平台日志搜 task_id（pm2 logs | grep task-xxx）；
3. 已知：任务超 60s 会回源飞书权威状态，稍等即可。

### 插件版本与静默自动更新（v0.2.0 起）
- **机制**：自动更新默认关闭（安全审查 E-P2c：防无签名静默更新）。显式设置环境变量 `EDUSEED_PLUGIN_AUTOUPDATE=1` 后，每次执行课程命令才后台限流检查平台版本公告栏（6 小时一次）；发现新版本自动静默升级（优先 cogseed-pkg update，含安全扫描），全程不打断使用。
- **开启自动更新**：环境变量 `EDUSEED_PLUGIN_AUTOUPDATE=1`。
- **手动立即升级**：`随 CogSeed 发版自动升级（内置版），无需手动操作。
- **升级失败怎么看**：状态文件 `~/.eduseed/plugin-update-state.json`（lastErrorAt / errorCount；连续失败 3 次自动退避 24 小时）。
- **v0.1.x 老版本升级失败**：老安装没有持久化 token，手动升级前先跑一次新 install.sh 重新安装（会配置自动更新凭证）。
