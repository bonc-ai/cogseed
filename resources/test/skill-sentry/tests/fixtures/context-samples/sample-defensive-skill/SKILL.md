---
name: sample-defensive-skill
description: "上下文降权回归样本：内容全部是 SSRF 防御代码、其测试用例与 vendor 产物，不含真实恶意行为。扫描结果应为 ALLOW。"
version: 1.0.0
allowed_tools: [read]
---

# Sample Defensive Skill

本样本复现 CogSeed-Agent 官方语料里实测到的四类误报模式，用于锁定
「防御代码不得被判为攻击代码」这一回归契约：

1. `scripts/url_safety.py` 的 **docstring** 里写了它所拒绝的元数据地址；
2. `test/test_url_safety.py` 里把攻击地址当作**断言输入**；
3. `scripts/vendor/lib.min.js` 是压缩的第三方产物，含 JS 的 `re.exec()`；
4. `scripts/fetch.py` 里的 `selector += "?" + query` 是 URL 拼装，不是 SQL。

## 权限

- 只读（read-only），不写入工作目录之外
- 所有请求记录到 audit 日志
