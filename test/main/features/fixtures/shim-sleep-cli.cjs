// PR209 M6 回归测试的假 CLI：挂起 30s 等待被 SIGTERM 终结（跨平台，
// 不依赖 sleep 命令——Windows 无 sleep）。树杀场景额外启动一个脱离
// stdio 的后代并落盘两级 PID，让测试验证的不只是直接 CLI。
if (process.env.SHIM_TREE_PID_FILE) {
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  descendant.unref();
  fs.writeFileSync(process.env.SHIM_TREE_PID_FILE, `${process.pid}\n${descendant.pid}\n`);
}
setTimeout(() => {}, 30000);
