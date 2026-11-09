import type { CatalogEntry } from './types';

export const APPLE_ENTRIES: CatalogEntry[] = [
  {
    id: 'apple-reminders', display_name: 'Apple Reminders', icon_name: 'clipboard-list',
    category: 'productivity', auth_mode: 'local_mcp',
    description_zh: '在 Mac 上查询、新建、更新和完成 Apple 提醒事项。需要安装 RemCTL 并授予系统权限。',
    description_en: 'Find, create, update and complete Apple Reminders on your Mac. Requires RemCTL and macOS permissions.',
    transport_template: { kind: 'stdio', command: 'remctl', args: ['mcp', 'serve'] },
    default_enabled_subtools: ['today', 'upcoming', 'overdue', 'flagged', 'search', 'show_list', 'lists', 'get_list', 'get_reminder', 'create_reminder', 'update_reminder', 'set_completion', 'set_flagged', 'doctor'],
    setup: {
      install_url: 'https://github.com/viticci/remctl/releases',
      install_label_zh: '下载安装 RemCTL',
      install_label_en: 'Download RemCTL',
      steps_zh: ['仅支持 macOS。点击“下载安装 RemCTL”，选择适合本机的安装包并完成官方安装引导（已验证 2.4.0）。', '完成 RemCTL Capability Host 的授权引导；若拒绝过，在“系统设置 → 隐私与安全性 → 提醒事项”中检查该 Host 的访问权限。', '如需自动化访问，在“隐私与安全性 → 自动化”中允许 RemCTL Capability Host 控制提醒事项。', '若 RemCTL 诊断提示缺少完全磁盘访问权限，仅按其指引授权签名的 RemCTL Capability Host，并重启该 Host。', '安装完成后重新打开连接器页面，再点击“连接”；不会自动安装或自动授权。', '连接成功仅代表工具已发现，首次实际读写仍可能需要系统授权。'],
      steps_en: ['macOS only. Choose Download RemCTL, select the installer for your Mac and follow its installation guide (verified with 2.4.0).', 'Complete the RemCTL Capability Host permission flow. If previously denied, check the host under System Settings → Privacy & Security → Reminders.', 'For automation access, allow RemCTL Capability Host to control Reminders under Privacy & Security → Automation.', 'If RemCTL diagnostics require Full Disk Access, follow its instructions for the signed RemCTL Capability Host only, then restart that host.', 'After installation, reopen the connectors page and choose Connect. Nothing is installed or authorized automatically.', 'Connecting discovers tools; the first actual read or write may still require macOS authorization.'],
      docs_url: 'https://github.com/viticci/remctl',
      docs_label_zh: '查看权限与排障说明',
      docs_label_en: 'Permissions and troubleshooting',
      credential_note_zh: '不需要 OAuth 或 API 密钥。不会自动安装或启用；系统权限由 RemCTL 管理。',
      credential_note_en: 'No OAuth or API key. Not installed or enabled automatically; RemCTL manages system permissions.',
    },
  },
  {
    id: 'apple-notes', display_name: 'Apple Notes', icon_name: 'file-text',
    category: 'productivity', auth_mode: 'local_mcp',
    description_zh: '在 Mac 上搜索、读取、新建和更新 Apple 备忘录，保留内容哈希冲突检查。',
    description_en: 'Search, read, create and update Apple Notes on your Mac with content-hash conflict checks.',
    transport_template: { kind: 'stdio', command: 'npx', args: ['-y', 'apple-notes-mcp@2.15.14'] },
    default_enabled_subtools: ['list-folders', 'search-notes', 'get-note-content', 'get-note-by-id', 'create-note', 'update-note', 'append-to-note', 'get-capabilities', 'health-check'],
    setup: {
      install_url: 'https://nodejs.org/en/download',
      install_label_zh: '下载安装 Node.js',
      install_label_en: 'Download Node.js',
      steps_zh: ['仅支持 macOS。点击“下载安装 Node.js”，安装 20 或更新版本并包含 npm / npx。', '安装完成后重新打开连接器页面，点击“连接”；npx 将按需下载并运行固定版本 apple-notes-mcp@2.15.14。', '首次读写时允许系统提示中的责任应用控制备忘录；若拒绝过，到“系统设置 → 隐私与安全性 → 自动化”中检查。', '仅在所需能力提示权限不足时，按上游诊断报告为实际责任应用或 Node 可执行文件开启“完全磁盘访问权限”；不要假设终端授权等于 CogSeed 授权。', '修改完全磁盘访问权限后，完全退出并重新打开相应宿主应用；快捷指令等高级能力按官方文档另行配置。', '修改笔记前读取最新内容及哈希；不要用普通正文更新替换带附件的笔记。'],
      steps_en: ['macOS only. Choose Download Node.js and install version 20 or later with npm / npx.', 'Reopen the connectors page and choose Connect; npx downloads and runs pinned apple-notes-mcp@2.15.14 on demand.', 'On first read or write, allow the responsible app to control Notes. If previously denied, check System Settings → Privacy & Security → Automation.', 'Only when the required capability reports missing access, follow upstream diagnostics to grant Full Disk Access to the actual responsible app or Node executable. Terminal permission does not prove CogSeed permission.', 'After changing Full Disk Access, fully quit and relaunch the responsible host. Configure optional Shortcuts capabilities separately using upstream documentation.', 'Read the latest content and hash before updating. Do not replace attachment-bearing notes with plain body updates.'],
      docs_url: 'https://github.com/sweetrb/apple-notes-mcp#permissions-check',
      docs_label_zh: '查看权限与排障说明',
      docs_label_en: 'Permissions and troubleshooting',
      credential_note_zh: '无需 API 密钥。不会自动启用；连接成功不代表已获备忘录数据访问权限。',
      credential_note_en: 'No API key; never enabled automatically. Connecting does not verify permission to access Notes data.',
    },
  },
];
