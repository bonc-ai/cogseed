// PR209 M6 回归测试的假 CLI：挂起 30s 等待被 SIGTERM 终结（跨平台，
// 不依赖 sleep 命令——Windows 无 sleep）。
setTimeout(() => {}, 30000);
