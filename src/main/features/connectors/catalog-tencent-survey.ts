import type { CatalogEntry } from './types';

export const TENCENT_SURVEY_ID = 'tencent-survey';
export const TENCENT_SURVEY_MCP_URL = 'https://wj.qq.com/api/v2/mcp';
export const TENCENT_SURVEY_ENTRY: CatalogEntry = {
  id: TENCENT_SURVEY_ID,
  display_name: '腾讯问卷',
  icon_name: 'connector-tencent-survey',
  category: 'productivity',
  description_zh: '授权所选团队后创建和编辑问卷、管理回收、读取回答；具体操作以服务端工具为准。',
  description_en: 'Create and edit surveys, manage collection and read answers in your authorized team, using the tools available from the service.',
  // Official Skill 1.3.0 setup.sh: provider device-auth init/poll, not DCR or a client-secret flow.
  auth_mode: 'provider_device',
  transport_template: { kind: 'streamable-http', url: TENCENT_SURVEY_MCP_URL },
};
