/**
 * 个人上下文连接器模块入口（设计稿 §4 连接器层）。
 *
 * 本模块只做资源面（注册表/游标/发现/同步/撤销）；OAuth 状态机独立管理。
 * 场景层经本体 API 消费，不直接 import 本模块的 provider 细节。
 */
export * from './contract';
export * from './oauth-manager';
export * from './registry';
export * from './scope-manifest';
export * from './sync-scheduler';

export * as feishu from './feishu';
