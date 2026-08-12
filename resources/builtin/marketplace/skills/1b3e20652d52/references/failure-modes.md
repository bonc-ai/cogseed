# Failure attribution — customer-profile-presales

失败时定位到哪一层（TBox/RBox/ABox/Skill/ToolBinding/Workflow/Eval/Policy/Execution/Memory）：

| 失败现象 | 归因层 | 说明 |
|---|---|---|
| 选错版本/话术 | RBox | R1 路由映射错或画像层级取值歧义 |
| 该删的禁讲项没删 | RBox / Policy | R2 颗粒度规则或治理策略未生效 |
| 异议卡取错/漏取 | ToolBinding | 《销售 QA 库》检索绑定或 id 映射问题 |
| 口径越界（点名友商/报硬数字/自进化词） | Policy（保护面） | R4/R5/R6/R3 被绕过——最高危，须回归红线兜底 |
| 定制稿自动定稿/发送 | Workflow | confirm HITL gate 缺失或被跳过 |
| 画像字段缺失即崩 | Skill / Schema | 必填字段校验或默认处理缺失 |
| 学了不该学的（临场手改却回流） | Eval / KSTAR | ΔA 门控失效，ΔR 被误用 |
| 用了客户机密数据 | Memory / 数据边界 | 画像未脱敏，违 §8.2 |

高危项（Policy 保护面）必须由回归测试红线覆盖，且永不可被自我演进补丁修改。
