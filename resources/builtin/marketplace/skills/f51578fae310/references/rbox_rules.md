# R-Box · 运营商数据安全运营知识问答

> 来源：《数据分类分级标准》截图（L1–L4 完整版，2026-06-26 提取）  
> 状态：草稿 · 全部条目待领域专家逐条确认 REASON  
> 关联本体：ontology_tbox.md

---

## 一、用户相关数据分级判定

### L4 极敏感

```
IF DataField.category_code = "1-1-1-4"（实体身份证明）
AND DataField.data_type IN [证件影印件, 电子照片, 指纹, 声纹, 虹膜, 掌纹, 人脸识别数据]
THEN DataField.sensitivity_level = L4（极敏感）
REASON 生物识别特征不可更改（身份证号可换，生物特征无法替换）；
       证件影印件含多维身份要素，可被直接用于冒充；
       损害一旦发生不可逆，修复成本极高
来源：分级标准 1-1-1-4
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code = "1-1-1-5"（用户私密资料）
THEN DataField.sensitivity_level = L4（极敏感）
REASON 私密资料直接涉及用户人格尊严和隐私权；
       泄露可能引发人身威胁或严重社会危害
来源：分级标准 1-1-1-5
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code = "1-2-1-1"
AND DataField.data_subtype = "密码/关联鉴权信息"
THEN DataField.sensitivity_level = L4（极敏感）
REASON 密码直接授权系统访问控制权限；
       泄露等同于账号被完全控制，影响范围不可预估
来源：分级标准 1-2-1-1（密码类）
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code = "1-2-1-1"
AND DataField.data_subtype = "通话/短信/消息内容"
THEN DataField.sensitivity_level = L4（极敏感）
REASON 通信内容受《电信条例》及保密法律保护；
       未经授权获取或披露属违法行为；
       是个人隐私最核心范围
来源：分级标准 1-2-1-1（服务内容数据）
确认状态：⏳ 待专家确认
```

---

### L3 高敏感

```
★ 核心规则（高频查询场景）

IF DataField.category_code = "1-1-1-1"（自然人身份标识）
AND DataField.data_type IN [姓名, 身份证号码, 驾照号, 军官证号, 港澳台通行证号, 银行账户号]
THEN DataField.sensitivity_level = L3（高敏感）
REASON 可直接识别自然人现实身份；
       ⚠️ 重要区分：身份证"号码字符串" = L3；身份证"影印件/扫描图" = L4（见上方规则）；
       两者混淆是高频误判，必须明确区分后作答
来源：分级标准 1-1-1-1
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code = "1-3-1-4"（位置数据）
AND DataField.precision_type IN [精确位置, 实时位置, 行动轨迹]
THEN DataField.sensitivity_level = L3（高敏感）
REASON 精确/实时位置可反推个人住所、工作地点和生活规律；
       属个人隐私核心范围，可能导致人身安全威胁
来源：分级标准 1-3-1-4（L3 列）
确认状态：⏳ 待专家确认（另注：L2 列也出现此代码，见第四节澄清事项）
```

```
IF DataField.category_code IN ["1-4-1", "1-4-2"]（用户使用习惯和行为分析数据）
THEN DataField.sensitivity_level = L3（高敏感）
REASON 行为分析数据可构建完整个人画像；
       间接揭露政治倾向、宗教信仰、健康状况等高度敏感属性
来源：分级标准 1-4-1/1-4-2
确认状态：⏳ 待专家确认
```

---

### L2 中敏感

```
IF DataField.category_code = "1-1-1-2"（网络身份标识）
AND DataField.data_type IN [手机号, 邮箱, IP地址, 网络账号, 即时通信账号, 社交账号]
THEN DataField.sensitivity_level = L2（中敏感）
REASON 网络标识不能直接定位物理身份，但可追踪网络行为；
       可被用于骚扰、精准营销或社会工程学攻击；
       危害程度低于真实身份标识（L3）
来源：分级标准 1-1-1-2
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code = "1-1-1-3"（用户基本资料）
AND DataField.data_type IN [职业, 工作单位, 年龄, 性别, 籍贯, 民族, 政治面貌, 学历, 兴趣爱好]
THEN DataField.sensitivity_level = L2（中敏感）
REASON 单个字段灵敏度有限；
       多字段组合可实现精确画像（见通用规则：组合风险）
来源：分级标准 1-1-1-3
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code IN ["1-3-1-1", "1-3-1-3"]（业务订购关系/消费信息和账单）
THEN DataField.sensitivity_level = L2（中敏感）
REASON 消费数据揭露用户经济状况和产品使用偏好；
       不含通信内容，危害程度低于行为分析（L3）
来源：分级标准 1-3-1-1/1-3-1-3
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code IN ["1-3-2-1", "1-3-2-2"]（终端设备标识/终端信息）
THEN DataField.sensitivity_level = L2（中敏感）
REASON 设备标识可跨场景追踪同一设备的活动；
       不能直接识别自然人身份，但可辅助识别
来源：分级标准 1-3-2-1/1-3-2-2
确认状态：⏳ 待专家确认
```

---

### L1 低敏感

```
IF DataField.category_code = "1-3-1-5"（违规记录数据）
THEN DataField.sensitivity_level = L1（低敏感）
REASON 违规记录为业务合规执行数据，不含个人隐私核心信息；
       已作为业务管理数据公开使用
来源：分级标准 1-3-1-5
确认状态：⏳ 待专家确认
```

---

## 二、企业自身数据分级判定

```
IF DataField.category_code STARTS_WITH "2-1-2"（网络与系统资源类）
OR DataField.category_code STARTS_WITH "2-1-3"（网络与系统运维类）
OR DataField.category_code STARTS_WITH "2-1-4"（网络安全管理类）
THEN DataField.sensitivity_level = L4（极敏感）
REASON 网络拓扑/运维账号密码/安全审计数据暴露可直接导致关键信息基础设施被攻击；
       属国家强制保护范围，泄露可能引发系统性安全事故
来源：分级标准 2-1-2-* / 2-1-3-* / 2-1-4-*
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code = "2-1-1-1"（网络规划类）
AND DataField.release_status = "发布前"
THEN DataField.sensitivity_level = L4（极敏感）
REASON 未发布网络规划含内部路由、核心节点信息；
       暴露可使攻击者提前布局
来源：分级标准 2-1-1-1（发布前）
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code STARTS_WITH "2-1-1"（网络规划类）
AND DataField.release_status = "发布后"
THEN DataField.sensitivity_level = L2（中敏感）
REASON 已公开发布的规划属于公告性信息，敏感性大幅下降
来源：分级标准 2-1-1-*（发布后）
确认状态：⏳ 待专家确认
```

```
IF DataField.category_code IN ["2-2-1-1", "2-2-2"]（产品信息/公开业务运营服务数据）
THEN DataField.sensitivity_level = L1（低敏感）
REASON 企业已对外公开发布，不含商业机密或个人信息
来源：分级标准 2-2-1-1 / 2-2-2
确认状态：⏳ 待专家确认
```

---

## 三、通用判定规则

```
IF 用户查询同一证件的分级
AND 未明确说明是"号码字段"还是"影印件/扫描件"
THEN 在回答中区分两种情况，分别给出等级
REASON 号码字段（L3）和影印件（L4）对应不同法律保护范围；
       混用会导致用户错误评估数据安全风险；
       这是数据安全运营场景的高频误判点
来源：本 KSTAR 会话 δR 发现（2026-06-26）
确认状态：⏳ 待专家确认
```

```
IF 查询 DataField 的分级
AND 该字段的 DataCategory 不在分级标准列表中
THEN 提示"该字段类型暂未在分级标准中找到明确对应"
AND 推荐参照最相近的类别，并标注为"待人工确认"
REASON 分级标准无法穷举所有字段类型；
       未匹配时宁可人工确认，不可随意定级（避免低估风险）
来源：分级标准边界判断
确认状态：⏳ 待专家确认
```

```
IF 多个 DataField 单独等级均 ≤ L2
AND 这些字段将被组合使用（联合导出/关联分析）
THEN 按各字段中最高单字段等级处理，不因组合自动升级
REASON 数据分类分级标准按字段本身的数据类型定级；
       L2 字段组合不自动升级为 L3；
       组合使用的合规风险通过对外共享审批流程管控，不改变字段本身的等级定义
来源：Round 2 KSTAR 验证（2026-06-27）专家确认
确认状态：✅ 专家已确认（原草稿规则错误，已修正）
```

---

## 四、待专家澄清事项

| # | 问题 | 当前假设 | 优先级 |
|---|------|---------|------|
| 1 | 位置数据（1-3-1-4）同时出现在 L3 和 L2 两个列表，区分条件是什么？ | L3 = 精确/实时；L2 = 历史/聚合 | 高 |
| 2 | 服务记录和日志（1-3-1-2）为何定 L3？ | 推测：含通话记录等敏感信息 | 中 |
| 3 | 银行账户号（1-1-1-1 下）是全号还是部分号（如后四位）定 L3？ | 推测：全号定 L3，部分号可能 L2 | 中 |

---

## 五、安全事件处置规则

```
IF SecurityIncident.incident_type = "批量异常导出"
AND SecurityIncident 涉及 DataField.sensitivity_level ≥ L3
THEN
  Step 1：立即冻结涉事账号的数据访问权限
  Step 2：固化操作日志（防止覆盖），记录账号/时间/字段/导出量/目标位置
  Step 3：30 分钟内向数据安全负责人内部上报
  （无外部监管上报义务）
REASON 批量导出 L3 数据属高风险安全事件；
       30 分钟内部上报确保响应及时、调查取证窗口完整；
       本场景不涉及外部监管上报
来源：Round 3 KSTAR 验证（2026-06-27）专家确认
确认状态：✅ 专家已确认
```

```
IF SecurityIncident.incident_type = "批量异常导出"
AND SecurityIncident 涉及 DataField.sensitivity_level ≤ L2
THEN
  Step 1：冻结账号，固化日志
  Step 2：调查操作动机（离职备份/误操作/故意外发）
  Step 3：按内部合规流程处置（警告/降权/通报）
REASON L2 及以下数据批量导出属内部合规事件，风险可控，内部处置即可
来源：Round 3 KSTAR 验证（2026-06-27）推导
确认状态：⏳ 待专家确认
```

---

## R-Box 统计

| 类别 | 条数 | 状态 |
|------|------|------|
| L4 极敏感 判定 | 4 | ⏳ 全部待确认 |
| L3 高敏感 判定 | 3 | ⏳ 全部待确认 |
| L2 中敏感 判定 | 4 | ⏳ 全部待确认 |
| L1 低敏感 判定 | 1 | ⏳ 全部待确认 |
| 企业数据判定 | 4 | ⏳ 全部待确认 |
| 通用规则 | 3 | ⏳ 全部待确认 |
| **合计** | **19** | ⏳ 草稿 |

> **下一步**：将此文件发给数据安全领域专家，逐条确认 REASON 是否准确。  
> 确认后将状态改为 ✅，未通过的规则标注原因后修正。
