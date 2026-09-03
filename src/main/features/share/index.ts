/**
 * 分享模块出口（方案 A/B：飞书 wiki/docx 公网分享）。
 * 与 personal_context 只读同步严格隔离——本模块是唯一写入端点。
 */
export * from './feishu-share';
