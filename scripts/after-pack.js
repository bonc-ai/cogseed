// after-pack hook: 在打包后、签名前执行
// 删除不需要签名的 archive 文件

const fs = require('fs');
const path = require('path');

const WINDOWS_SHERPA_PACKAGE = 'sherpa-onnx-win-x64';
const WINDOWS_SHERPA_FILES = Object.freeze([
  'sherpa-onnx.node',
  'onnxruntime.dll',
  'onnxruntime_providers_shared.dll',
  'sherpa-onnx-c-api.dll',
  'sherpa-onnx-cxx-api.dll',
]);

function verifyWindowsSherpaRuntime(resourcesPath) {
  const runtimeDir = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    WINDOWS_SHERPA_PACKAGE,
  );
  const missing = WINDOWS_SHERPA_FILES.filter((file) => !fs.existsSync(path.join(runtimeDir, file)));
  if (missing.length) {
    throw new Error(
      `Windows speech runtime is missing from the package: ${missing.join(', ')} (${runtimeDir})`,
    );
  }
}

exports.default = async function(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName;

  if (platform === 'darwin') {
    const appPath = path.join(appOutDir, `${context.packager.appInfo.productName}.app`);
    const resourcesPath = path.join(appPath, 'Contents', 'Resources');

    console.log('[after-pack] Removing archive files to prevent signing errors...');

    // 删除所有 archive 目录
    const runtimePath = path.join(resourcesPath, 'runtime');
    if (fs.existsSync(runtimePath)) {
      removeArchiveDirs(runtimePath);
    }
    return;
  }

  if (platform === 'win32') verifyWindowsSherpaRuntime(path.join(appOutDir, 'resources'));
};

exports.verifyWindowsSherpaRuntime = verifyWindowsSherpaRuntime;

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
