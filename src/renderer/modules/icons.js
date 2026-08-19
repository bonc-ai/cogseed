// Shared inline SVG icons for the PC renderer.
// Keep all reusable app icons here; call sites render by name instead of
// hardcoding SVG paths or using emoji.
(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico']);
  const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv']);
  const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'opus', 'flac', 'm4a', 'aac']);
  const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'log', 'rst', 'tex']);
  const DATA_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xlsx', 'xlsm', 'xls', 'xml', 'ini', 'conf']);
  const SPREADSHEET_EXTS = new Set(['xlsx', 'xlsm', 'xls', 'csv', 'tsv']);
  const PRESENTATION_EXTS = new Set(['pptx', 'pptm', 'ppt']);
  const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
  const CODE_EXTS = new Set([
    'py', 'pyi', 'ipynb',
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
    'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
    'php', 'swift', 'lua', 'pl', 'pm', 'r', 'dart',
    'sql', 'graphql', 'gql', 'proto',
  ]);

  function wrapUiIcon(name, inner, className) {
    const cls = `${className || 'ui-icon'} is-${name}`;
    return `<svg class="${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }

  function wrapFileIcon(kind, inner) {
    return `<svg class="chat-file-kind-icon is-${kind}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }

  const UI_ICONS = {
    search: '<circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path>',
    // Fine-tune drawer icons (lucide-style).
    film: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"></path>',
    music: '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
    type: '<path d="M4 7V5h16v2M9 19h6M12 5v14"></path>',
    loader: '<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"></path>',
    lock: '<path d="M5 11h14v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z M8 11V7a4 4 0 0 1 8 0v4"></path>',
    scissors: '<circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M8.1 8.1 20 20 M8.1 15.9 20 4"></path>',
    coin: '<circle cx="8" cy="8" r="6"></circle><path d="M18.09 10.37A6 6 0 1 1 10.34 18"></path><path d="M7 6h1v4"></path><path d="m16.71 13.88.7.71-2.82 2.82"></path>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14 M2 6h14a2 2 0 0 1 2 2v14"></path>',
    undo: '<path d="M9 14 4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-4"></path>',
    redo: '<path d="M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h4"></path>',
    'message-square': '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
    'qr-code': '<rect x="3" y="3" width="6" height="6"></rect><rect x="15" y="3" width="6" height="6"></rect><rect x="3" y="15" width="6" height="6"></rect><path d="M15 15h3v3h3M15 21h3M21 15v3"></path>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
    sparkles: '<path d="M12 3l1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4z"></path><path d="M19 13l.9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9z"></path><path d="M5 14l.8 1.7L7.5 16.5l-1.7.8L5 19l-.8-1.7-1.7-.8 1.7-.8z"></path>',
    plug: '<path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M6 8h12v4a6 6 0 0 1-12 0z"></path>',
    'git-branch': '<line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>',
    'book-open': '<path d="M12 7v14"></path><path d="M3 5.5A3.5 3.5 0 0 1 6.5 2H12v19H6.5A3.5 3.5 0 0 1 3 17.5z"></path><path d="M21 5.5A3.5 3.5 0 0 0 17.5 2H12v19h5.5a3.5 3.5 0 0 0 3.5-3.5z"></path>',
    palette: '<path d="M12 22a10 10 0 1 1 10-10 5 5 0 0 1-5 5h-2.4a1.6 1.6 0 0 0-1.3 2.5l.3.4A1.4 1.4 0 0 1 12 22z"></path><circle cx="7.5" cy="10" r="1" fill="currentColor" stroke="none"></circle><circle cx="10" cy="6.8" r="1" fill="currentColor" stroke="none"></circle><circle cx="14" cy="6.8" r="1" fill="currentColor" stroke="none"></circle><circle cx="16.5" cy="10" r="1" fill="currentColor" stroke="none"></circle>',
    globe: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a14 14 0 0 1 0 18"></path><path d="M12 3a14 14 0 0 0 0 18"></path>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"></path><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"></path>',
    'layout-grid': '<rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect>',
    settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>',
    terminal: '<path d="m8 8 4 4-4 4"></path><path d="M14 16h4"></path><rect x="3" y="4" width="18" height="16" rx="3"></rect>',
    x: '<path d="M18 6 6 18M6 6l12 12"></path>',
    trash: '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 15H6L5 6"></path><path d="M10 11v6M14 11v6"></path>',
    pin: '<path d="M12 17v5"></path><path d="M5 17h14"></path><path d="M7 3h10l-1 8 3 6H5l3-6z"></path>',
    'pin-off': '<path d="M12 17v5"></path><path d="M5 17h12"></path><path d="M7 3h7"></path><path d="M16 11l3 6"></path><path d="M8 11l.6-4.8"></path><path d="M3 3l18 18"></path>',
    mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"></path><path d="M19 11a7 7 0 0 1-14 0"></path><path d="M12 18v3"></path><path d="M8 21h8"></path>',
    send: '<path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4 20-7z"></path>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"></rect>',
    'chevron-down': '<path d="m6 9 6 6 6-6"></path>',
    'chevron-up': '<path d="m6 15 6-6 6 6"></path>',
    'chevron-right': '<path d="m9 6 6 6-6 6"></path>',
    'chevron-left': '<path d="m15 6-6 6 6 6"></path>',
    'thumbs-up': '<path d="M7 10v12"></path><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"></path>',
    'thumbs-down': '<path d="M17 14V2"></path><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"></path>',
    'brain-circuit': '<path d="M12 4.5a2.5 2.5 0 0 0-4.96-.46 2.5 2.5 0 0 0-1.98 3 2.5 2.5 0 0 0-1.32 4.24 3 3 0 0 0 .34 5.58 2.5 2.5 0 0 0 2.96 3.08A2.5 2.5 0 0 0 12 19.5a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 12 4.5"></path><path d="m12 5 3 3"></path><path d="m12 13-3-3"></path><path d="m12 9-2 2"></path><path d="M12 13v6"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    'file-text': '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><path d="M9.5 11h5"></path><path d="M9.5 14h5"></path><path d="M9.5 17h3"></path>',
    presentation: '<rect x="4" y="4" width="16" height="11" rx="2"></rect><path d="M12 15v5"></path><path d="M8 20h8"></path><path d="M8 9h8"></path><path d="M8 12h5"></path>',
    'arrow-right': '<path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"></path>',
    external: '<path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"></path>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>',
    'more-horizontal': '<circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"></circle><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"></circle>',
    'panel-list': '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M15 4v16"></path><path d="M7 8h4"></path><path d="M7 12h4"></path><path d="M7 16h4"></path>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M15 4v16"></path>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
    'folder-open': '<path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"></path><path d="M3.2 10.5A2 2 0 0 1 5.1 9h14.2a1.5 1.5 0 0 1 1.4 1.9l-1.5 5.7A3 3 0 0 1 16.3 19H5.2a2 2 0 0 1-2-1.6L2 12.4a1.6 1.6 0 0 1 1.2-1.9z"></path>',
    file: '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path>',
    'clipboard-list': '<rect x="4" y="4" width="16" height="18" rx="2"></rect><path d="M9 4h6M9 8h6M8 12h8M8 16h8M8 20h5"></path><path d="M9 2h6v4H9z"></path>',
    hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"></path>',
    clock: '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 16 14"></polyline>',
    play: '<circle cx="12" cy="12" r="9"></circle><path d="M10 8l6 4-6 4z"></path>',
    'play-triangle': '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"></path>',
    check: '<path d="M5 12l4 4L19 6"></path>',
    'check-circle': '<circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.6 2.6L16.5 9"></path>',
    'x-circle': '<circle cx="12" cy="12" r="9"></circle><path d="M9 9l6 6M15 9l-6 6"></path>',
    'skip-forward': '<path d="M5 7l6 5-6 5z"></path><path d="M13 7l6 5-6 5z"></path><path d="M21 6v12"></path>',
    'document-pencil': '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><path d="M9 17l1-3 5.5-5.5 2 2L12 16l-3 1z"></path>',
    'edit-pencil': '<path d="M4 20h4.2L19.1 9.1a2.2 2.2 0 0 0 0-3.1L18 4.9a2.2 2.2 0 0 0-3.1 0L4 15.8V20z"></path><path d="M13.7 6.1l4.2 4.2"></path><path d="M4 20l4.2-1.1"></path>',
    refresh: '<path d="M20 12a8 8 0 0 1-13.7 5.7"></path><path d="M4 12A8 8 0 0 1 17.7 6.3"></path><path d="M17 3v4h-4M7 21v-4h4"></path>',
    shield: '<path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6z"></path><path d="m9 12 2 2 4-4"></path>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path>',
    sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"></path>',
    warning: '<path d="M12 3l10 18H2z"></path><path d="M12 9v5"></path><path d="M12 18h.01"></path>',
    square: '<rect x="5" y="5" width="14" height="14" rx="3"></rect>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.5"></circle>',
    command: '<path d="M9 9H6.5a3 3 0 1 1 3-3V18a3 3 0 1 1-3-3H18a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3H9z"></path>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"></path>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><circle cx="8.5" cy="9" r="1.6"></circle><path d="M5 17l4.4-4.4a1.5 1.5 0 0 1 2.1 0L14 15l2-2a1.5 1.5 0 0 1 2.1 0L20 14.9"></path>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"></path><path d="M4 6h.01M4 12h.01M4 18h.01"></path>',
    'list-ordered': '<path d="M10 6h10M10 12h10M10 18h10"></path><path d="M4 5h1v3M4 8h2"></path><path d="M4 11.5h2L4 14h2"></path><path d="M4 17h2v3H4"></path>',
    'at-sign': '<circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"></path>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>',
    quote: '<path d="M9 7H5v5h4v5H4"></path><path d="M20 7h-4v5h4v5h-5"></path>',
    code: '<path d="m9 8-4 4 4 4"></path><path d="m15 8 4 4-4 4"></path>',
    'code-block': '<path d="M8 9l-3 3 3 3"></path><path d="M16 9l3 3-3 3"></path><path d="M12 6l-2 12"></path><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect>',
    circle: '<circle cx="12" cy="12" r="7"></circle>',
    squareFilled: '<rect x="6" y="6" width="12" height="12" rx="2"></rect>',
    diamond: '<path d="M12 4l8 8-8 8-8-8z"></path>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"></circle>',
    output: '<path d="M5 7l6 5-6 5z"></path><path d="M13 7h6"></path><path d="M13 12h6"></path><path d="M13 17h6"></path>',
    info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>',
    paperclip: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 1 1-3-3L16 7"></path>',
    live: '<path d="M12 4a8 8 0 1 1-8 8"></path><path d="M12 4v8h8"></path>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><path d="M3.3 7 12 12l8.7-5"></path><path d="M12 22V12"></path>',
    star: '<path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.1 20.9l1.1-6.5L2.5 9.8l6.5-.9z"></path>',
    // Hub account surface icons (lucide-style, matching the library above).
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8M12 16v4"></path>',
    layout: '<rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect>',
    'credit-card': '<rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path>',
    'smartphone': '<rect x="7" y="2.5" width="10" height="19" rx="2.5"></rect><path d="M12 18h.01"></path>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"></path>',
    'shield-check': '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"></path><path d="m9 12 2 2 4-4"></path>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .4-9 7 7 0 0 0-13.6-1A5 5 0 0 0 5 19z"></path>',
    globe: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"></path>',
    key: '<circle cx="8" cy="15" r="4"></circle><path d="m10.8 12.2 8.7-8.7M14 5l3 3M17 8l2-2"></path>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="m16 17 5-5-5-5M21 12H9"></path>',
    'trash-2': '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"></path>',
    'database': '<ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"></path><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path>',
    'hard-drive': '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><path d="M6 12h.01M10 12h.01"></path>',
  };

  // Multi-color messaging marks bypass the stroke-based ui-icon wrapper. The
  // Feishu artwork is a bundled raster supplied for this surface; the remaining
  // brands stay vector so they remain crisp at menu and detail-header sizes.
  const BRAND_ICONS = {
    feishu: '<img class="is-feishu" src="../resources/icons/feishu.png" alt="" draggable="false" aria-hidden="true">',
    lark: '<svg class="is-lark" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#00C2B8" d="M8 9h25l7 7-16 23H8z"/><path fill="#175CE6" d="M7 21l13 14c7 7 16 4 21-2l-7-7-8 5z"/><path fill="#0A3EAA" d="M7 21l13 14 14-9-12-11z"/></svg>',
    wechat: '<svg class="is-wechat" viewBox="-4 -8 356 364" width="24" height="24" aria-hidden="true"><g fill-rule="evenodd" fill="none"><path fill="#07C160" d="M0 103.374c0 31.012 16.907 59.345 43.037 78.105 2.306 1.531 3.458 3.829 3.458 6.892 0 .765-.384 1.914-.384 2.68-1.921 7.657-5.38 20.292-5.764 20.675-.384 1.148-.768 1.914-.768 3.062 0 2.298 1.921 4.212 4.227 4.212.768 0 1.537-.383 2.305-.766l27.283-15.697c1.92-1.149 4.226-1.915 6.532-1.915 1.153 0 2.69 0 3.843.383 12.68 3.829 26.513 5.743 40.731 5.743 68.782 0 124.5-46.327 124.5-103.374S193.282 0 124.5 0 0 46.327 0 103.374"/><path fill="#FFFFFF" stroke="#D5D8DB" stroke-width="3" d="M240.5 267.585c11.883 0 23.383-1.543 33.733-4.629.767-.386 1.917-.386 3.067-.386 1.917 0 3.833.772 5.367 1.543l22.616 13.116c.767.385 1.15.771 1.917.771a3.447 3.447 0 003.45-3.472c0-.771-.383-1.543-.383-2.7 0-.386-3.067-10.8-4.6-17.358-.384-.772-.384-1.543-.384-2.315 0-2.314 1.15-4.243 3.067-5.786C330.2 230.553 344 207.023 344 180.792 344 132.96 297.617 94 240.5 94S137 132.574 137 180.792c0 47.833 46.383 86.793 103.5 86.793z"/><path fill="#187E28" d="M99 70c0 8.93-7.07 16-16 16s-16-7.07-16-16 7.07-16 16-16 16 7.07 16 16m83 0c0 8.93-7.07 16-16 16s-16-7.07-16-16 7.07-16 16-16 16 7.07 16 16"/><path fill="#858C8C" d="M262 154c0 7.778 6.222 14 14 14s14-6.222 14-14-6.222-14-14-14-14 6.222-14 14m-69 0c0 7.778 6.222 14 14 14s14-6.222 14-14-6.222-14-14-14-14 6.222-14 14"/></g></svg>',
    wecom: '<svg class="is-wecom" viewBox="-2 -2 38 38" width="24" height="24" aria-hidden="true"><g fill-rule="evenodd"><path fill="#0082F0" d="M13.604 2.172c-.546 0-1.112.032-1.68.095-3.33.365-6.357 1.803-8.522 4.047a11.47 11.47 0 0 0-2.065 2.938 10.325 10.325 0 0 0-1.058 4.55c0 2.03.613 4.035 1.771 5.793.605.918 1.585 2.048 2.438 2.813l.047.042v.063l-.418 3.27c-.012.034-.025.067-.032.102-.008.03-.01.063-.012.096l-.008.059c-.002.014-.004.027-.004.041 0 .017.003.032.005.048l.006.045a.895.895 0 0 0 .886.813.878.878 0 0 0 .443-.123l.071-.042 3.908-1.98.053.015c.778.225 1.593.383 2.49.483a15.084 15.084 0 0 0 6.465-.685 2.035 2.035 0 0 1-1.041-1.768c-.734.223-1.487.38-2.242.466a13.232 13.232 0 0 1-2.937.009l-.186-.025-.11-.016a12.597 12.597 0 0 1-1.925-.407 1.17 1.17 0 0 0-.921.096.8.8 0 0 0-.075.038l-2.466 1.467c-.252.147-.476-.012-.476-.242l.372-1.474.193-.74a.866.866 0 0 0-.305-.965 11.008 11.008 0 0 1-1.002-.85 9.906 9.906 0 0 1-1.42-1.695c-.945-1.435-1.444-3.063-1.444-4.708 0-1.279.29-2.52.86-3.692a9.461 9.461 0 0 1 1.702-2.42c1.822-1.887 4.38-3.098 7.204-3.407a12.831 12.831 0 0 1 2.936.006c2.81.323 5.354 1.54 7.161 3.426a9.44 9.44 0 0 1 1.694 2.425 8.367 8.367 0 0 1 .843 3.81c.7-.322 1.522-.21 2.114.29a10.325 10.325 0 0 0-1.029-4.99 11.46 11.46 0 0 0-2.055-2.946c-2.148-2.242-5.157-3.687-8.473-4.068a15.44 15.44 0 0 0-1.755-.103" class="Fill_26"/><g transform="translate(21.378 23.14)"><path fill="#FB6500" d="M.445.694a.453.453 0 0 0-.031.603c.009.013.02.024.031.035.019.02.04.038.062.053a5.807 5.807 0 0 1 1.71 3.104 1.922 1.922 0 0 0 .063.384 1.9 1.9 0 0 0 .482.837 1.86 1.86 0 0 0 2.648 0c.73-.738.73-1.934 0-2.672a1.853 1.853 0 0 0-.903-.506 1.495 1.495 0 0 0-.112-.022c-.037-.007-.075-.011-.113-.017A5.716 5.716 0 0 1 1.26.883a3.968 3.968 0 0 1-.18-.189.441.441 0 0 0-.32-.133.437.437 0 0 0-.316.133z"/></g><g transform="translate(26.955 19.399)"><path fill="#0082EF" d="M2.479 1.447a1.892 1.892 0 0 0-.5.911 1.615 1.615 0 0 0-.022.114 1.603 1.603 0 0 0-.015.114A5.83 5.83 0 0 1 .346 5.639a4.55 4.55 0 0 1-.188.18v.002a.455.455 0 0 0 0 .639.444.444 0 0 0 .598.031c.012-.01.025-.02.035-.031a.465.465 0 0 0 .052-.063A5.728 5.728 0 0 1 3.918 4.67a1.828 1.828 0 0 0 .38-.064 1.85 1.85 0 0 0 .83-.486 1.902 1.902 0 0 0 0-2.673 1.86 1.86 0 0 0-2.648 0h-.001z"/></g><g transform="translate(23.237 14.721)"><path fill="#2DBC00" d="M.916.78a1.903 1.903 0 0 0 0 2.674 1.877 1.877 0 0 0 1.015.526c.038.006.075.012.113.016a5.734 5.734 0 0 1 3.024 1.61c.06.062.121.127.18.191a.446.446 0 0 0 .633 0 .456.456 0 0 0 .031-.604.463.463 0 0 0-.094-.088l-.13-.126A5.83 5.83 0 0 1 4.108 2a1.495 1.495 0 0 0-.02-.183A1.89 1.89 0 0 0 3.565.78 1.86 1.86 0 0 0 2.24.225 1.86 1.86 0 0 0 .916.779z"/></g><g transform="translate(17.66 17.528)"><path fill="#FC0" d="M5.57.934c-.012.01-.025.02-.035.031a.564.564 0 0 0-.053.064c-.04.044-.083.087-.124.13a5.733 5.733 0 0 1-2.95 1.597 1.856 1.856 0 0 0-.38.063 1.867 1.867 0 0 0-.83.486 1.902 1.902 0 0 0 0 2.673 1.86 1.86 0 0 0 2.648 0 1.88 1.88 0 0 0 .5-.911c.01-.037.016-.075.023-.113.006-.038.01-.075.015-.115a5.828 5.828 0 0 1 1.594-3.051c.064-.063.126-.125.19-.183a.454.454 0 0 0 0-.64.445.445 0 0 0-.598-.032z"/></g></g></svg>',
    telegram: '<svg class="is-telegram" viewBox="-36 -60 312 360" width="24" height="24" aria-hidden="true"><defs><linearGradient gradientUnits="userSpaceOnUse" y2="51.9" y1="11.536" x2="28.836" x1="46.136" id="tga"><stop offset="0" stop-color="#37aee2"/><stop offset="1" stop-color="#1e96c8"/></linearGradient></defs><g transform="scale(3.4682)"><circle fill="url(#tga)" r="34.6" cx="34.6" cy="34.6"/><path fill="#fff" d="M14.4 34.3l23.3-9.6c2.3-1 10.1-4.2 10.1-4.2s3.6-1.4 3.3 2c-.1 1.4-.9 6.3-1.7 11.6l-2.5 15.7s-.2 2.3-1.9 2.7c-1.7.4-4.5-1.4-5-1.8-.4-.3-7.5-4.8-10.1-7-.7-.6-1.5-1.8.1-3.2 3.6-3.3 7.9-7.4 10.5-10 1.2-1.2 2.4-4-2.6-.6l-14.1 9.5s-1.6 1-4.6.1c-3-.9-6.5-2.1-6.5-2.1s-2.4-1.5 1.7-3.1z"/></g></svg>',
    qq: '<svg class="is-qq" viewBox="-2 -42 125 226" width="24" height="24" aria-hidden="true"><path fill="#faab07" d="M60.503 142.237c-12.533 0-24.038-4.195-31.445-10.46-3.762 1.124-8.574 2.932-11.61 5.175-2.6 1.918-2.275 3.874-1.807 4.663 2.056 3.47 35.273 2.216 44.862 1.136zm0 0c12.535 0 24.039-4.195 31.447-10.46 3.76 1.124 8.573 2.932 11.61 5.175 2.598 1.918 2.274 3.874 1.805 4.663-2.056 3.47-35.272 2.216-44.862 1.136zm0 0"/><path d="M60.576 67.119c20.698-.14 37.286-4.147 42.907-5.683 1.34-.367 2.056-1.024 2.056-1.024.005-.189.085-3.37.085-5.01C105.624 27.768 92.58.001 60.5 0 28.42.001 15.375 27.769 15.375 55.401c0 1.642.08 4.822.086 5.01 0 0 .583.615 1.65.913 5.19 1.444 22.09 5.65 43.312 5.795zm56.245 23.02c-1.283-4.129-3.034-8.944-4.808-13.568 0 0-1.02-.126-1.537.023-15.913 4.623-35.202 7.57-49.9 7.392h-.153c-14.616.175-33.774-2.737-49.634-7.315-.606-.175-1.802-.1-1.802-.1-1.774 4.624-3.525 9.44-4.808 13.568-6.119 19.69-4.136 27.838-2.627 28.02 3.239.392 12.606-14.821 12.606-14.821 0 15.459 13.957 39.195 45.918 39.413h.848c31.96-.218 45.917-23.954 45.917-39.413 0 0 9.368 15.213 12.607 14.822 1.508-.183 3.491-8.332-2.627-28.021"/><path fill="#fff" d="M49.085 40.824c-4.352.197-8.07-4.76-8.304-11.063-.236-6.305 3.098-11.576 7.45-11.773 4.347-.195 8.064 4.76 8.3 11.065.238 6.306-3.097 11.577-7.446 11.771m31.133-11.063c-.233 6.302-3.951 11.26-8.303 11.063-4.35-.195-7.684-5.465-7.446-11.77.236-6.305 3.952-11.26 8.3-11.066 4.352.197 7.686 5.468 7.449 11.773"/><path fill="#faab07" d="M87.952 49.725C86.79 47.15 75.077 44.28 60.578 44.28h-.156c-14.5 0-26.212 2.87-27.375 5.446a.863.863 0 00-.085.367.88.88 0 00.16.496c.98 1.427 13.985 8.487 27.3 8.487h.156c13.314 0 26.319-7.058 27.299-8.487a.873.873 0 00.16-.498.856.856 0 00-.085-.365"/><path d="M54.434 29.854c.199 2.49-1.167 4.702-3.046 4.943-1.883.242-3.568-1.58-3.768-4.07-.197-2.492 1.167-4.704 3.043-4.944 1.886-.244 3.574 1.58 3.771 4.07m11.956.833c.385-.689 3.004-4.312 8.427-2.993 1.425.347 2.084.857 2.223 1.057.205.296.262.718.053 1.286-.412 1.126-1.263 1.095-1.734.875-.305-.142-4.082-2.66-7.562 1.097-.24.257-.668.346-1.073.04-.407-.308-.574-.93-.334-1.362"/><path fill="#fff" d="M60.576 83.08h-.153c-9.996.12-22.116-1.204-33.854-3.518-1.004 5.818-1.61 13.132-1.09 21.853 1.316 22.043 14.407 35.9 34.614 36.1h.82c20.208-.2 33.298-14.057 34.616-36.1.52-8.723-.087-16.035-1.092-21.854-11.739 2.315-23.862 3.64-33.86 3.518"/><path fill="#eb1923" d="M32.102 81.235v21.693s9.937 2.004 19.893.616V83.535c-6.307-.357-13.109-1.152-19.893-2.3"/><path fill="#eb1923" d="M105.539 60.412s-19.33 6.102-44.963 6.275h-.153c-25.591-.172-44.896-6.255-44.962-6.275L8.987 76.57c16.193 4.882 36.261 8.028 51.436 7.845h.153c15.175.183 35.242-2.963 51.437-7.845zm0 0"/></svg>',
    dingtalk: '<svg class="is-dingtalk" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><rect x="6" y="6" width="36" height="36" rx="10" fill="#3B9DFF"/><path fill="#fff" d="M16 17l16 7-8 10-2-7z"/></svg>',
    discord: '<svg class="is-discord" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#5865F2" d="M38.5 13.2A39 39 0 0 0 31.9 11l-.7 1.4a36 36 0 0 0-14.4 0L16.1 11a39 39 0 0 0-6.6 2.2C5.3 19.4 4.2 25.4 4.7 31.3A39.8 39.8 0 0 0 12.6 36l2.2-3.6c-1.2-.5-2.4-1.1-3.5-1.8l.9-.7c5.6 2.6 11.4 2.6 17 0l.9.7c-1.1.7-2.3 1.3-3.5 1.8L28.9 36a39.8 39.8 0 0 0 7.9-4.7c.6-6.9-1-12.8-3.3-18.1zM19 27.5c-1.6 0-2.9-1.5-2.9-3.3s1.3-3.3 2.9-3.3 2.9 1.5 2.9 3.3-1.3 3.3-2.9 3.3zm10 0c-1.6 0-2.9-1.5-2.9-3.3s1.3-3.3 2.9-3.3 2.9 1.5 2.9 3.3-1.3 3.3-2.9 3.3z"/></svg>',
  };

  const FILE_ICONS = {
    image: wrapFileIcon('image', '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><circle cx="8.5" cy="9" r="1.6"></circle><path d="M5 17l4.4-4.4a1.5 1.5 0 0 1 2.1 0L14 15l2-2a1.5 1.5 0 0 1 2.1 0L20 14.9"></path>'),
    video: wrapFileIcon('video', '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"></rect><path d="M10 9.2v5.6l5-2.8-5-2.8z"></path>'),
    audio: wrapFileIcon('audio', '<path d="M9 18V6l9-2v12"></path><circle cx="6.5" cy="18" r="2.5"></circle><circle cx="15.5" cy="16" r="2.5"></circle>'),
    pdf: wrapFileIcon('pdf', '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><path d="M8.8 15.5h6.4"></path><path d="M9.8 12h4.4"></path>'),
    doc: wrapFileIcon('doc', '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><path d="M9.5 11h5"></path><path d="M9.5 14h5"></path><path d="M9.5 17h3.5"></path>'),
    spreadsheet: wrapFileIcon('spreadsheet', '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><rect x="9" y="10.5" width="6" height="7" rx=".7"></rect><path d="M9 13.8h6M12 10.5v7"></path>'),
    presentation: wrapFileIcon('presentation', '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><rect x="9" y="10.5" width="6" height="4.8" rx=".7"></rect><path d="M12 15.3V18M10 18h4"></path>'),
    text: wrapFileIcon('text', '<path d="M6.5 4.5h11v15h-11z"></path><path d="M9 9h6"></path><path d="M9 12h6"></path><path d="M9 15h4"></path>'),
    data: wrapFileIcon('data', '<rect x="4.5" y="5.5" width="15" height="13" rx="2"></rect><path d="M4.5 10h15"></path><path d="M9.5 5.5v13"></path><path d="M14.5 5.5v13"></path>'),
    archive: wrapFileIcon('archive', '<path d="M5 8.5 12 5l7 3.5-7 3.5L5 8.5z"></path><path d="M5 8.5v7L12 19l7-3.5v-7"></path><path d="M12 12v7"></path>'),
    code: wrapFileIcon('code', '<path d="m9 8-4 4 4 4"></path><path d="m15 8 4 4-4 4"></path><path d="m13 6-2 12"></path>'),
    file: wrapFileIcon('file', '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path>'),
  };

  function extOf(name) {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
  }

  function normalizeFileKind(kind, ext) {
    const raw = String(kind || '').toLowerCase();
    if (raw === 'docx' || raw === 'doc') return 'doc';
    if (raw === 'spreadsheet') return 'spreadsheet';
    if (raw === 'presentation') return 'presentation';
    if (raw === 'legacy_office') return 'doc';
    if (raw === 'binary') return 'file';
    if (['image', 'video', 'audio', 'pdf', 'doc', 'spreadsheet', 'presentation', 'text', 'data', 'archive', 'code', 'file'].includes(raw)) return raw;
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx' || ext === 'docm' || ext === 'doc') return 'doc';
    if (SPREADSHEET_EXTS.has(ext)) return 'spreadsheet';
    if (PRESENTATION_EXTS.has(ext)) return 'presentation';
    if (TEXT_EXTS.has(ext)) return 'text';
    if (DATA_EXTS.has(ext)) return 'data';
    if (ARCHIVE_EXTS.has(ext)) return 'archive';
    if (CODE_EXTS.has(ext)) return 'code';
    return 'file';
  }

  function uiIconHtml(name, className) {
    const key = String(name || 'info');
    const brand = BRAND_ICONS[key];
    if (brand) return brand;
    return wrapUiIcon(key, UI_ICONS[key] || UI_ICONS.info, className);
  }

  function fileKindForName(name, kind) {
    return normalizeFileKind(kind, extOf(name));
  }

  function fileKindIconHtml(name, kind) {
    const normalized = fileKindForName(name, kind);
    return FILE_ICONS[normalized] || FILE_ICONS.file;
  }

  function hydrateUiIcons(rootEl) {
    if (typeof document === 'undefined') return;
    const scope = rootEl || document;
    const nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-ui-icon]') : [];
    nodes.forEach((node) => {
      const name = node.getAttribute('data-ui-icon');
      const className = node.getAttribute('data-ui-icon-class') || 'ui-icon';
      node.innerHTML = uiIconHtml(name, className);
      node.setAttribute('aria-hidden', 'true');
      // Wrapper must be a flex item so the inner SVG sits at the visual center
      // (not the text baseline) of its host — without this, every hydrated
      // icon drifts upward by descender space.
      node.style.display = 'inline-flex';
      node.style.alignItems = 'center';
    });
  }

  root.uiIconHtml = uiIconHtml;
  root.hydrateUiIcons = hydrateUiIcons;
  root.fileKindForName = fileKindForName;
  root.fileKindIconHtml = fileKindIconHtml;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => hydrateUiIcons(), { once: true });
    } else {
      hydrateUiIcons();
    }
  }
})();
