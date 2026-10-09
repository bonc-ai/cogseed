/**
 * 能力包（Ability Pack）线已按决策一删除；本文件只保留资产引用类型。
 *
 * **删除理由**：`buildCapabilityPack` / `loadCapabilityPackToTarget` 从来没有
 * 生产调用方——没有 IPC、没有 feature 调用，`cloud/cogseed/capability-packs/`
 * 恒为空目录，测试验证的是"自己造包再自己读包"。「Asset → Pack → Reuse 已打通」
 * 是假的。真实复用由两条**有回执与证明**的路径承担：
 *   - Context Projection（每回合自动投影 → prompt 注入 → ContextReuseReceipt）
 *   - 出生继承（`agent_inheritance` 冻结资产引用）
 *
 * **为什么类型留下**：`agent_inheritance` 与 `recall/cognition-selection` 在
 * 真实复用 `CapabilityPackAssetRef` 描述"被冻结的那一版资产"。它与 Pack 的
 * 组装/加载无关，是一个通用的「资产 id + 版本 + 内容哈希」引用形状。删包不删它。
 *
 * 不要重新引入 Pack：跨 Agent / 跨设备交付如果将来真有产品需求，必须**同时**
 * 给出生产入口与消费者，否则又会变成一个自证自洽的空目录。
 */

/** 一条被冻结的资产引用：哪条资产、哪一版、内容哈希（用于漂移检测）。 */
export interface CapabilityPackAssetRef {
  asset_id: string;
  version: string;
  content_hash?: string;
}
