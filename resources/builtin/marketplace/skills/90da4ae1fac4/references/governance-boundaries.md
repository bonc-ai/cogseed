# 治理边界与禁止宣称

```yaml
promotion_ceiling: staged
production_release_allowed: false
direct_resource_access: false
formal_asset_write: false
independent_review: pending
```

- `staged ≠ release_ready`；`release_ready ≠ production_release`。
- 评测/回放通过、执行成功、属主验证都不等于发布批准。
- Skill 只暴露契约字段，不解析真实身份、不持有令牌、不直接访问资源。
- LLM 只提出草稿或候选；形式化规则、HITL、审计和发布锁由确定性治理层裁决。
- 不得宣称 production-ready、已投产、自主/无人值守进化、真实业务价值已验证或第三方认证。
- `real/desensitized/synthetic/manual/stub` 必须逐证据标注；非真实证据的业务价值声明恒为否。
