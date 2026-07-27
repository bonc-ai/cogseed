# Ontology Mapping

## 当前绑定的本体

| 本体 ID | 版本 | 用途 |
|---------|------|------|
| traffic_fee_dispute | v0.4.0 | 流量费争议补救处置 |
| finance_self_service | v0.1.0 | 财务自助取数 |
| bidding_legality_audit | v0.1.0 | 招标文件合法性审核 |

## TBox 引用

### traffic_fee_dispute
- Customer — 来电用户
- TrafficFeeDisputeCase — 争议工单
- BillingCharge — 账单明细
- TrafficUsageRecord — 流量使用记录
- TrafficReminder — 流量提醒
- PackagePlan — 套餐计划

## RBox 引用

### traffic_fee_dispute
- rule_01_block_high_charge — 费用突增审核
- rule_02_grace_period — 宽限期减免

## ABox 引用

- positive_fewshot_01 — 正例
- negative_fewshot_01 — 反例
