/** Password/app-password connectors are UI-configured, independently scoped read-only accounts. */
import type { CatalogEntry } from './types';
export const EMAIL_ENTRIES: CatalogEntry[] = [
  ['email-qq', 'QQ Mail', 'QQ 邮箱'],
  ['email-163', '163 Mail', '网易邮箱（163）'],
  ['email-enterprise', 'Enterprise Mail', '企业邮箱'],
].map(([id, name, zh]) => ({
  id, display_name: name, icon_name: id === 'email-enterprise' ? 'mail' : `connector-${id}`, category: 'communication', auth_mode: 'credentials',
  description_zh: `${zh}：只读检索邮件、总结待办并在对话中起草回复。不会发送或删除邮件。`,
  description_en: `${name}: read and search email, summarize tasks and draft replies in chat. No sending or deletion.`,
  transport_template: { kind: 'stdio', command: '${COGSEED_NODE}', args: ['${COGSEED_PC_DIR}/bin/email-mcp-server.cjs'] },
}));
export function isEmailConnector(id: string): boolean { return EMAIL_ENTRIES.some(e => e.id === id); }
