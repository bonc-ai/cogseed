// after-pack hook: 在打包后、签名前执行
// 删除不需要签名的 archive 文件

const fs = require('fs');
const path = require('path');
const { verifyPackagedEntrypointPayload } = require('../bin/packaged-entrypoint-gate.cjs');
const {
  verifySherpaOnnxRoot,
  verifySherpaOnnxWindowsNativeRoot,
  verifyMacHardenedRuntimeEntitlements,
} = require('../bin/packaged-resource-gate.cjs');

exports.default = async function(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName;
  const resourcesPath = platform === 'darwin'
    ? path.join(appOutDir, `${context.packager.appInfo.productName}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');

  verifyPackagedEntrypointPayload(
    path.join(resourcesPath, 'app.asar.unpacked'),
    { projectRoot: path.resolve(__dirname, '..') },
  );
  verifySherpaOnnxRoot(path.join(resourcesPath, 'sherpa-onnx'));

  if (platform === 'win32') {
    verifySherpaOnnxWindowsNativeRoot(path.join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'sherpa-onnx-win-x64',
    ));
  }

  if (platform === 'darwin') {
    const projectRoot = path.resolve(__dirname, '..');
    const packageJson = require(path.join(projectRoot, 'package.json'));
    verifyMacHardenedRuntimeEntitlements(packageJson.build, projectRoot);

    console.log('[after-pack] Removing archive files to prevent signing errors...');

    // 删除所有 archive 目录
    const runtimePath = path.join(resourcesPath, 'runtime');
    if (fs.existsSync(runtimePath)) {
      removeArchiveDirs(runtimePath);
    }
  }
};

function removeArchiveDirs(dir) {
  if (!fs.existsSync(dir)) return;

  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (item === 'archive') {
        console.log(`[after-pack] Removing: ${fullPath}`);
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        removeArchiveDirs(fullPath);
      }
    }
  }
}
