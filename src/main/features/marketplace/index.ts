/**
 * Hub Skill 客户端完整生命周期 —— 新增能力的聚合导出。
 *
 * 新增能力集中在本目录（9 个模块），不散落到既有大文件中
 * （`marketplace.ts` 1712 行、`skills.ts` 4184 行已是高耦合点）。
 * 既有文件只做定点修改，不做搬迁或重构。
 *
 * Spec：specs/010-hub-skill-client-lifecycle/
 */
export * from './errors';
export * from './metadata-adapter';
export * from './source-fetch';
export * from './version-store';
export * from './version-gc';
export * from './installed-version';
export * from './current-switch-policy';
export * from './pin-scan';
export * from './usage-event';
export * from './fork-to-custom';
