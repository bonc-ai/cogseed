# Mate Agent Brand Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** 将 Orkas × P3394 融合 MVP 的用户可见品牌和系统应用身份改为 Mate Agent / Mate 智伴，并用双节点伴星图标替换虎鲸图标，同时保留现有数据与连接器 OAuth 兼容能力。

**Architecture:** 以 `src/resources/brand.json` 作为运行时和脚本共享的品牌契约，`package.json` 保留打包所需的镜像字段，并由静态测试保证两者一致。Electron 主进程、通知权限和连接器协议从同一品牌契约读取名称、App ID 和协议；Renderer 只替换用户可见文案，`window.orkas`、`ORKAS_*`、`.orkas` 和现有 Conversation/Runtime 数据结构保持不变。

**Tech Stack:** Electron 41、TypeScript、JavaScript、Vitest、Python 3 + Pillow、SVG、PNG、ICNS、ICO、electron-builder 配置、macOS `plutil`/`codesign`/LaunchServices。

**Scope Guard:** 本计划不新增账号体系、云端同步、多设备或团队协作；不重写 Conversation、Message Store、Agent Runtime，也不迁移 `.orkas` 数据目录。

---

## File Structure

### New files

- `src/resources/brand.json` — Mate Agent 品牌契约：英文名、中文名、App ID、主协议、兼容协议、定位语。
- `src/main/brand.ts` — 为 TypeScript 主进程导出带类型的品牌常量。
- `scripts/generate-brand-icons.py` — 从确定的双节点伴星几何参数生成 SVG、PNG、ICNS 和 ICO。
- `src/resources/icons/mate-agent-master.svg` — 1024×1024 可维护图标母版。
- `test/main/brand.test.ts` — 品牌契约、打包身份、主进程身份与数据兼容边界测试。
- `test/main/brand-assets.test.ts` — 图标格式、尺寸、颜色、旧虎鲸资源替换测试。
- `test/main/util/source-branding.test.ts` — macOS 源码运行应用包、协议声明和启动脚本静态回归测试。

### Modified files

- `package.json` — productName、appId、描述、协议、artifactName、brand.json 打包清单。
- `src/main/index.ts` — 应用名、Windows AppUserModelID、Dock/窗口图标使用品牌契约。
- `src/main/features/notification_permissions.ts` — 通知设置使用新 App ID。
- `src/main/features/connectors/protocol.ts` — `mateagent://` 主协议与受限 `orkas://` OAuth 兼容协议。
- `test/main/features/connectors/protocol.test.ts` — 双协议 callback、安全边界、默认协议注册测试。
- `test/main/features/connectors/open-source-boundary.test.ts` — 打包同时声明主协议与兼容协议。
- `scripts/ensure-deps.cjs` — macOS 开发应用包迁移到 `Mate Agent.app`，并处理旧 `Orkas.app`。
- `scripts/prepare-source-protocol.cjs` — 新 Bundle ID、显示名和双协议声明。
- `run.sh` — Mate Agent 启动文案、应用包路径和协议注释。
- `src/renderer/index.html` — 页面标题、左上角名称、静态回退文案和新 Logo。
- `src/renderer/locales/{zh,en,ja,pt}.json` — 所有用户可见产品名称。
- `src/main/data/commander.json` — Commander 产品描述。
- `src/main/data/oss-projects.json` — 开源工具用户可见描述。
- `src/renderer/modules/settings.js` — 用户可见管理方徽标和通知注释。
- `src/renderer/modules/saved-apps.js` — “在 Mate Agent 中打开”的回退文案。
- `src/resources/icons/icon.png` — 512×512 新图标。
- `src/resources/icons/icon.icns` — macOS 新图标。
- `src/resources/icons/icon.ico` — Windows 新图标。
- `src/resources/icons/logo.png` — 应用内新 Logo。

### Explicitly unchanged compatibility surfaces

- `window.orkas`
- `ORKAS_*`
- `.orkas`
- `orkas-pkg.cjs`
- `__orkas-meta.json`
- Conversation、Message Store、Agent Runtime、P3394 数据模型与 IPC channel

---

### Task 1: Establish the shared brand contract

**Files:**
- Create: `src/resources/brand.json`
- Create: `src/main/brand.ts`
- Create: `test/main/brand.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing brand-contract test**

Create `test/main/brand.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Mate Agent brand contract', () => {
  it('defines the approved public identity', () => {
    const brand = readJson('src/resources/brand.json');
    expect(brand).toEqual({
      appName: 'Mate Agent',
      zhName: 'Mate 智伴',
      appId: 'com.mateagent.desktop',
      protocolScheme: 'mateagent',
      legacyConnectorScheme: 'orkas',
      taglineZh: '你的协作型智能体工作台',
    });
  });

  it('keeps electron-builder identity aligned with the contract', () => {
    const brand = readJson('src/resources/brand.json');
    const pkg = readJson('package.json');
    expect(pkg.description).toContain('Mate Agent');
    expect(pkg.build.productName).toBe(brand.appName);
    expect(pkg.build.appId).toBe(brand.appId);
    expect(pkg.build.artifactName).toBe('Mate-Agent-${version}-${os}-${arch}.${ext}');
    expect(pkg.build.protocols).toEqual([
      expect.objectContaining({
        name: 'Mate Agent Connector Callback',
        schemes: [brand.protocolScheme, brand.legacyConnectorScheme],
      }),
    ]);
    expect(pkg.build.files).toContain('src/resources/brand.json');
  });

  it('does not rename compatibility storage and bridge identifiers', () => {
    expect(read('src/main/paths.ts')).toContain('ORKAS_WORKSPACE_ROOT');
    expect(read('src/main/preload.js')).toContain('orkas');
    expect(read('src/main/install-data-root.cjs')).toContain("'.orkas'");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:js -- test/main/brand.test.ts
```

Expected: FAIL because `src/resources/brand.json` does not exist and `package.json` still declares Orkas.

- [ ] **Step 3: Add the brand contract and typed export**

Create `src/resources/brand.json`:

```json
{
  "appName": "Mate Agent",
  "zhName": "Mate 智伴",
  "appId": "com.mateagent.desktop",
  "protocolScheme": "mateagent",
  "legacyConnectorScheme": "orkas",
  "taglineZh": "你的协作型智能体工作台"
}
```

Create `src/main/brand.ts`:

```ts
import brand from '../resources/brand.json';

export const APP_BRAND = Object.freeze({
  appName: brand.appName,
  zhName: brand.zhName,
  appId: brand.appId,
  protocolScheme: brand.protocolScheme,
  legacyConnectorScheme: brand.legacyConnectorScheme,
  taglineZh: brand.taglineZh,
});

export const CONNECTOR_PROTOCOL_SCHEMES = Object.freeze([
  APP_BRAND.protocolScheme,
  APP_BRAND.legacyConnectorScheme,
] as const);
```

Update `package.json`:

```json
{
  "description": "Mate Agent desktop — collaborative agent workspace",
  "build": {
    "appId": "com.mateagent.desktop",
    "productName": "Mate Agent",
    "artifactName": "Mate-Agent-${version}-${os}-${arch}.${ext}",
    "protocols": [
      {
        "name": "Mate Agent Connector Callback",
        "schemes": ["mateagent", "orkas"],
        "role": "Viewer"
      }
    ],
    "files": [
      "src/resources/brand.json",
      "src/resources/icons/**/*"
    ]
  }
}
```

Keep the existing `build.files` entries; add `src/resources/brand.json` without deleting other resources.

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
npm run test:js -- test/main/brand.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the brand contract**

```bash
git add package.json src/resources/brand.json src/main/brand.ts test/main/brand.test.ts
git commit -m "feat: define Mate Agent brand identity"
```

---

### Task 2: Apply the OS application identity

**Files:**
- Modify: `src/main/index.ts:46-65,209-222,1058-1068`
- Modify: `src/main/features/notification_permissions.ts:44-46`
- Modify: `test/main/brand.test.ts`
- Modify: `test/main/features/notification_permissions.test.ts`

- [ ] **Step 1: Extend tests for the main-process identity**

Append to `test/main/brand.test.ts`:

```ts
it('uses the shared identity in the Electron main process', () => {
  const main = read('src/main/index.ts');
  expect(main).toContain("import { APP_BRAND } from './brand';");
  expect(main).toContain('app.setName(APP_BRAND.appName);');
  expect(main).toContain('app.setAppUserModelId(APP_BRAND.appId);');
  expect(main).not.toContain("const APP_USER_MODEL_ID = 'com.orkas.desktop'");
});

it('uses the shared App ID for system notification settings', () => {
  const source = read('src/main/features/notification_permissions.ts');
  expect(source).toContain("import { APP_BRAND } from '../brand';");
  expect(source).toContain('return APP_BRAND.appId;');
  expect(source).not.toContain("return 'com.orkas.desktop';");
});
```

In `test/main/features/notification_permissions.test.ts`, change expected macOS notification settings URLs from `com.orkas.desktop` to `com.mateagent.desktop` where the production helper is exercised.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm run test:js -- test/main/brand.test.ts test/main/features/notification_permissions.test.ts
```

Expected: FAIL on old app name and App ID.

- [ ] **Step 3: Replace hard-coded main-process identity**

In `src/main/index.ts`:

```ts
import { APP_BRAND } from './brand';

app.setName(APP_BRAND.appName);
```

Remove `APP_USER_MODEL_ID`; use:

```ts
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_BRAND.appId);
}
```

Keep the existing icon path, single-instance behavior, P3394 boot order and `.orkas` data-root initialization unchanged.

In `src/main/features/notification_permissions.ts`:

```ts
import { APP_BRAND } from '../brand';

function notificationAppId(): string {
  return APP_BRAND.appId;
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npm run test:js -- test/main/brand.test.ts test/main/features/notification_permissions.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit OS identity changes**

```bash
git add src/main/index.ts src/main/features/notification_permissions.ts test/main/brand.test.ts test/main/features/notification_permissions.test.ts
git commit -m "feat: apply Mate Agent desktop identity"
```

---

### Task 3: Migrate the connector protocol without breaking OAuth

**Files:**
- Modify: `src/main/features/connectors/protocol.ts`
- Modify: `test/main/features/connectors/protocol.test.ts`
- Modify: `test/main/features/connectors/open-source-boundary.test.ts`

- [ ] **Step 1: Write dual-scheme and security-boundary tests**

Update `test/main/features/connectors/protocol.test.ts` so the callback classifier assertions are:

```ts
expect(_test.connectorCallbackKind('mateagent://connectors/oauth/callback?exchange_code=x')).toBe('server');
expect(_test.connectorCallbackKind('mateagent://connectors/oauth/dcr-callback?exchange_code=x')).toBe('dcr');
expect(_test.connectorCallbackKind('orkas://connectors/oauth/callback?exchange_code=x')).toBe('server');
expect(_test.connectorCallbackKind('orkas://connectors/oauth/dcr-callback?exchange_code=x')).toBe('dcr');
expect(_test.connectorCallbackKind('orkas://account/login?token=x')).toBeNull();
expect(_test.connectorCallbackKind('mateagent://shell/run?command=rm')).toBeNull();
expect(_test.connectorCallbackKind('https://connectors/oauth/callback')).toBeNull();
```

After `registerConnectorProtocol()`, assert both schemes were registered:

```ts
expect(setAsDefaultProtocolClient).toHaveBeenCalledWith(
  'mateagent',
  expect.anything(),
  expect.any(Array),
);
expect(setAsDefaultProtocolClient).toHaveBeenCalledWith(
  'orkas',
  expect.anything(),
  expect.any(Array),
);
```

Update `test/main/features/connectors/open-source-boundary.test.ts`:

```ts
expect(pkg.build.protocols).toEqual(expect.arrayContaining([
  expect.objectContaining({ schemes: ['mateagent', 'orkas'] }),
]));
```

- [ ] **Step 2: Run tests and verify the new primary scheme fails**

```bash
npm run test:js -- test/main/features/connectors/protocol.test.ts test/main/features/connectors/open-source-boundary.test.ts
```

Expected: FAIL because the handler only registers and accepts `orkas`.

- [ ] **Step 3: Implement the approved dual-scheme receiver**

In `src/main/features/connectors/protocol.ts`:

```ts
import { CONNECTOR_PROTOCOL_SCHEMES } from '../../brand';

function _connectorCallbackKind(rawUrl: string): 'server' | 'dcr' | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return null; }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!CONNECTOR_PROTOCOL_SCHEMES.includes(scheme as typeof CONNECTOR_PROTOCOL_SCHEMES[number])) return null;
  if (parsed.host.toLowerCase() !== 'connectors') return null;
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (pathname === SERVER_CALLBACK_PATH) return 'server';
  if (pathname === DCR_CALLBACK_PATH) return 'dcr';
  return null;
}

export function registerConnectorProtocol(): void {
  for (const scheme of CONNECTOR_PROTOCOL_SCHEMES) {
    try {
      if (!app.isPackaged && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
      } else {
        app.setAsDefaultProtocolClient(scheme);
      }
    } catch (err) {
      log.warn('connector protocol registration failed', { scheme, error: (err as Error).message });
    }
  }
  // Preserve the existing open-url, second-instance and cold-launch handlers.
}
```

The legacy scheme must remain limited to host `connectors` and the two exact OAuth callback paths.

- [ ] **Step 4: Run connector protocol tests**

```bash
npm run test:js -- test/main/features/connectors/protocol.test.ts test/main/features/connectors/open-source-boundary.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit protocol compatibility**

```bash
git add src/main/features/connectors/protocol.ts test/main/features/connectors/protocol.test.ts test/main/features/connectors/open-source-boundary.test.ts
git commit -m "feat: add Mate Agent connector protocol"
```

---

### Task 4: Rename the macOS source application safely

**Files:**
- Create: `test/main/util/source-branding.test.ts`
- Modify: `scripts/ensure-deps.cjs:381-452,454-518`
- Modify: `scripts/prepare-source-protocol.cjs`
- Modify: `run.sh`

- [ ] **Step 1: Write source-launch branding tests**

Create `test/main/util/source-branding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Mate Agent source-run branding', () => {
  it('migrates Electron.app and legacy Orkas.app to Mate Agent.app', () => {
    const source = read('scripts/ensure-deps.cjs');
    expect(source).toContain("const legacyApp = path.join(distDir, 'Orkas.app');");
    expect(source).toContain("const brandedApp = path.join(distDir, `${APP_NAME}.app`);");
    expect(source).toContain("`${APP_NAME}.app/Contents/MacOS/Electron`");
    expect(source).toContain("['CFBundleIdentifier', APP_ID]");
  });

  it('declares the new identity and both connector schemes in Info.plist', () => {
    const source = read('scripts/prepare-source-protocol.cjs');
    expect(source).toContain("const brand = require('../src/resources/brand.json');");
    expect(source).toContain('CFBundleURLSchemes: [brand.protocolScheme, brand.legacyConnectorScheme]');
    expect(source).toContain("CFBundleURLName: 'com.mateagent.connectors'");
  });

  it('launches the renamed macOS bundle', () => {
    const source = read('run.sh');
    expect(source).toContain('Mate Agent.app');
    expect(source).not.toContain('APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Orkas.app"');
  });
});
```

- [ ] **Step 2: Run the source-branding test and verify failure**

```bash
npm run test:js -- test/main/util/source-branding.test.ts
```

Expected: FAIL on the old `Orkas.app` implementation.

- [ ] **Step 3: Make `ensure-deps.cjs` brand-driven and migration-safe**

At the top of `scripts/ensure-deps.cjs` add:

```js
const BRAND = require('../src/resources/brand.json');
const APP_NAME = BRAND.appName;
const APP_ID = BRAND.appId;
const LOG_PREFIX = `[${APP_NAME}]`;
```

Refactor `patchElectronAppName()` around these paths:

```js
const electronApp = path.join(distDir, 'Electron.app');
const legacyApp = path.join(distDir, 'Orkas.app');
const brandedApp = path.join(distDir, `${APP_NAME}.app`);
const sourceApp = fs.existsSync(electronApp) ? electronApp : legacyApp;
```

Required behavior:

1. If only `Mate Agent.app` exists and `path.txt` already points to it, return.
2. If `Electron.app` exists, remove stale `Mate Agent.app` and rename Electron.app.
3. Else if `Orkas.app` exists, remove stale `Mate Agent.app` and rename Orkas.app.
4. Set `CFBundleIdentifier=APP_ID`, `CFBundleName=APP_NAME`, and `CFBundleDisplayName=APP_NAME`.
5. Write `Mate Agent.app/Contents/MacOS/Electron` to `path.txt`.
6. Re-sign and re-register `Mate Agent.app`; unregister both old paths.
7. Replace user-visible `[Orkas]` console prefixes in this script with `LOG_PREFIX` without renaming internal `ORKAS_*` variables or stamp filenames.

- [ ] **Step 4: Update protocol preparation and launcher**

In `scripts/prepare-source-protocol.cjs`:

```js
const brand = require('../src/resources/brand.json');
const appBundle = path.join(root, 'node_modules', 'electron', 'dist', `${brand.appName}.app`);
const desired = {
  bundleId: brand.appId,
  name: brand.appName,
  schemes: [brand.protocolScheme, brand.legacyConnectorScheme],
};
```

Write URL types as:

```js
const urlTypes = JSON.stringify([{
  CFBundleURLName: 'com.mateagent.connectors',
  CFBundleURLSchemes: desired.schemes,
}]);
```

In `run.sh`, replace user-visible Orkas text with Mate Agent, document `mateagent://` as primary and `orkas://` as OAuth compatibility, and launch:

```bash
APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Mate Agent.app"
```

Do not rename `ORKAS_*` environment variables.

- [ ] **Step 5: Run source-launch and existing dependency tests**

```bash
npm run test:js -- test/main/util/source-branding.test.ts test/main/util/ensure-deps.test.ts
```

Expected: PASS.

- [ ] **Step 6: Execute the macOS source patch once and inspect identity**

```bash
node scripts/ensure-deps.cjs
node scripts/prepare-source-protocol.cjs
plutil -p "node_modules/electron/dist/Mate Agent.app/Contents/Info.plist" | rg "CFBundleIdentifier|CFBundleName|CFBundleDisplayName|mateagent|orkas"
cat node_modules/electron/path.txt
```

Expected:

```text
CFBundleIdentifier => com.mateagent.desktop
CFBundleName => Mate Agent
CFBundleDisplayName => Mate Agent
CFBundleURLSchemes contains mateagent and orkas
Mate Agent.app/Contents/MacOS/Electron
```

- [ ] **Step 7: Commit source-run migration**

```bash
git add scripts/ensure-deps.cjs scripts/prepare-source-protocol.cjs run.sh test/main/util/source-branding.test.ts
git commit -m "feat: brand macOS source runs as Mate Agent"
```

---

### Task 5: Generate and validate the double-node companion icon

**Files:**
- Create: `scripts/generate-brand-icons.py`
- Create: `src/resources/icons/mate-agent-master.svg`
- Create: `test/main/brand-assets.test.ts`
- Replace: `src/resources/icons/icon.png`
- Replace: `src/resources/icons/icon.icns`
- Replace: `src/resources/icons/icon.ico`
- Replace: `src/resources/icons/logo.png`

- [ ] **Step 1: Write failing asset validation tests**

Create `test/main/brand-assets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Jimp } from 'jimp';

const root = path.join(__dirname, '../..');
const asset = (name: string) => path.join(root, 'src/resources/icons', name);

describe('Mate Agent brand assets', () => {
  it('ships a maintainable SVG master with the approved palette', () => {
    const svg = fs.readFileSync(asset('mate-agent-master.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('#7C3AED');
    expect(svg).toContain('#3B82F6');
    expect(svg).toContain('#22D3EE');
    expect(svg).toContain('#11152B');
    expect(svg).not.toMatch(/orca|whale/i);
  });

  it('ships the expected raster dimensions', async () => {
    const icon = await Jimp.read(asset('icon.png'));
    const logo = await Jimp.read(asset('logo.png'));
    expect([icon.bitmap.width, icon.bitmap.height]).toEqual([512, 512]);
    expect([logo.bitmap.width, logo.bitmap.height]).toEqual([1024, 1024]);
  });

  it('ships valid ICNS and multi-image ICO containers', () => {
    const icns = fs.readFileSync(asset('icon.icns'));
    const ico = fs.readFileSync(asset('icon.ico'));
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(7);
  });
});
```

- [ ] **Step 2: Run the asset test and verify failure**

```bash
npm run test:js -- test/main/brand-assets.test.ts
```

Expected: FAIL because the SVG master does not exist and existing raster assets are the tiger-whale brand.

- [ ] **Step 3: Implement the deterministic icon generator**

Create `scripts/generate-brand-icons.py` with these concrete responsibilities:

```python
from pathlib import Path
from tempfile import TemporaryDirectory
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'src' / 'resources' / 'icons'
PURPLE = '#7C3AED'
BLUE = '#3B82F6'
CYAN = '#22D3EE'
BG = '#11152B'
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

def gradient(size: int, start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    image = Image.new('RGBA', (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x + (size - y)) / (2 * size)
            rgb = tuple(round(start[i] * (1 - t) + end[i] * t) for i in range(3))
            pixels[x, y] = (*rgb, 255)
    return image

def render(size: int) -> Image.Image:
    scale = size / 1024
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((48*scale, 48*scale, 976*scale, 976*scale), radius=220*scale, fill=BG)
    glow = Image.new('RGBA', image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.line([(330*scale, 650*scale), (700*scale, 360*scale)], fill=(34, 211, 238, 150), width=max(2, round(86*scale)))
    glow = glow.filter(ImageFilter.GaussianBlur(max(1, round(28*scale))))
    image.alpha_composite(glow)
    draw = ImageDraw.Draw(image)
    draw.line([(330*scale, 650*scale), (700*scale, 360*scale)], fill=CYAN, width=max(2, round(34*scale)))
    node_layer = gradient(size, (124, 58, 237), (59, 130, 246))
    mask = Image.new('L', image.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.ellipse((210*scale, 470*scale, 570*scale, 830*scale), fill=255)
    mask_draw.ellipse((610*scale, 260*scale, 800*scale, 450*scale), fill=255)
    image.alpha_composite(Image.composite(node_layer, Image.new('RGBA', image.size), mask))
    draw = ImageDraw.Draw(image)
    draw.ellipse((292*scale, 548*scale, 382*scale, 638*scale), fill=(255, 255, 255, 235))
    draw.ellipse((658*scale, 302*scale, 704*scale, 348*scale), fill=(255, 255, 255, 235))
    return image

def write_svg(path: Path) -> None:
    path.write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#7C3AED"/><stop offset="1" stop-color="#3B82F6"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="28"/></filter></defs>
<rect x="48" y="48" width="928" height="928" rx="220" fill="#11152B"/>
<path d="M330 650 L700 360" stroke="#22D3EE" stroke-width="86" stroke-linecap="round" opacity=".45" filter="url(#glow)"/>
<path d="M330 650 L700 360" stroke="#22D3EE" stroke-width="34" stroke-linecap="round"/>
<circle cx="390" cy="650" r="180" fill="url(#g)"/><circle cx="705" cy="355" r="95" fill="url(#g)"/>
<circle cx="337" cy="593" r="45" fill="#F8FCFF"/><circle cx="681" cy="325" r="23" fill="#F8FCFF"/>
</svg>\n''', encoding='utf-8')

def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        master = render(1024)
        master.save(tmpdir / 'logo.png', 'PNG')
        master.resize((512, 512), Image.Resampling.LANCZOS).save(tmpdir / 'icon.png', 'PNG')
        master.save(tmpdir / 'icon.icns', 'ICNS')
        master.save(tmpdir / 'icon.ico', 'ICO', sizes=SIZES)
        write_svg(tmpdir / 'mate-agent-master.svg')
        for name in ['logo.png', 'icon.png', 'icon.icns', 'icon.ico', 'mate-agent-master.svg']:
            (tmpdir / name).replace(OUT / name)

if __name__ == '__main__':
    main()
```

The temporary directory guarantees failed generation does not partially overwrite checked-in assets.

- [ ] **Step 4: Generate assets and visually inspect the 512px icon**

```bash
python3 scripts/generate-brand-icons.py
file src/resources/icons/icon.png src/resources/icons/icon.icns src/resources/icons/icon.ico src/resources/icons/logo.png
```

Then inspect `/Users/sudai/.config/codex/worktrees/Orkas/p3394-integration-mvp/src/resources/icons/icon.png` with the image viewer. Confirm: dark indigo rounded square, large purple-blue node, smaller companion node, cyan connection, no animal silhouette.

- [ ] **Step 5: Run asset tests**

```bash
npm run test:js -- test/main/brand-assets.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit icon assets and generator**

```bash
git add scripts/generate-brand-icons.py src/resources/icons test/main/brand-assets.test.ts
git commit -m "feat: add Mate Agent companion icon"
```

---

### Task 6: Replace user-visible brand copy without renaming internals

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `src/main/data/commander.json`
- Modify: `src/main/data/oss-projects.json`
- Modify: `src/renderer/modules/settings.js`
- Modify: `src/renderer/modules/saved-apps.js`
- Modify: `test/main/brand.test.ts`

- [ ] **Step 1: Add a user-visible residual audit test**

Append to `test/main/brand.test.ts`:

```ts
it('removes Orkas from user-visible product surfaces', () => {
  const publicFiles = [
    'src/renderer/index.html',
    'src/renderer/locales/zh.json',
    'src/renderer/locales/en.json',
    'src/renderer/locales/ja.json',
    'src/renderer/locales/pt.json',
    'src/main/data/commander.json',
    'src/main/data/oss-projects.json',
  ];
  for (const file of publicFiles) {
    expect(read(file), file).not.toContain('Orkas');
  }
  expect(read('src/renderer/modules/settings.js')).not.toContain("badge.textContent = 'Orkas'");
  expect(read('src/renderer/modules/saved-apps.js')).not.toContain("'Open in Orkas'");
});

it('keeps approved internal compatibility symbols', () => {
  expect(read('src/renderer/modules/ipc-shim.js')).toContain('window.orkas');
  expect(read('src/renderer/modules/artifact-security.js')).toContain('OrkasArtifactSecurity');
});
```

- [ ] **Step 2: Run the brand test and verify residual failure**

```bash
npm run test:js -- test/main/brand.test.ts
```

Expected: FAIL and list files still containing user-visible Orkas copy.

- [ ] **Step 3: Replace visible copy in HTML and locale files**

Use these exact product-name translations:

| Locale | Product display |
|---|---|
| zh | Mate 智伴 where a Chinese product heading is appropriate; Mate Agent in system/process names |
| en | Mate Agent |
| ja | Mate Agent |
| pt | Mate Agent |

Required examples:

```html
<title>Mate Agent</title>
<div class="logo-text">Mate Agent</div>
```

```json
{
  "account.gate_title": "Mate Agent",
  "settings.managed_by_orkas": "@Mate Agent"
}
```

Keep locale keys such as `settings.managed_by_orkas` unchanged because they are internal API keys. Replace only values.

Update Commander Chinese description to begin:

```text
Mate Agent 的协作调度者，负责把你的目标转成可执行、可交付的任务路径。
```

Update English and Japanese descriptions to use Mate Agent. Update OSS project descriptions and saved-app fallback text to “Open in Mate Agent”. Change the visible settings badge from `Orkas` to `Mate Agent`.

Do not rename:

- `window.OrkasArtifactSecurity`
- `_hasOrkasInvoke`
- `_hasOrkasStream`
- `_maybeShowOrkasCreditGuidance`
- locale keys containing `_orkas`

- [ ] **Step 4: Run renderer and brand-focused tests**

```bash
npm run test:js -- test/main/brand.test.ts test/renderer/synced-surface-regression.test.ts test/renderer/settings-task-notifications.test.ts test/renderer/lazy-features.test.ts
```

Expected: all selected test files pass with zero failures.

- [ ] **Step 5: Commit visible-copy replacement**

```bash
git add src/renderer/index.html src/renderer/locales src/main/data/commander.json src/main/data/oss-projects.json src/renderer/modules/settings.js src/renderer/modules/saved-apps.js test/main/brand.test.ts
git commit -m "feat: localize Mate Agent product branding"
```

---

### Task 7: Run static brand audit and complete regression tests

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Check whitespace and type safety**

```bash
git diff --check
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 2: Run all JavaScript/TypeScript and Python tests**

```bash
PYTHONDONTWRITEBYTECODE=1 npm test
```

Expected baseline or better:

```text
JavaScript/TypeScript: 0 failed
Python: 0 failed
```

The prior P3394 baseline was 352/352 JS test files, 4851 passed, 9 skipped, and 308/308 Python tests; new brand tests increase the passing totals.

- [ ] **Step 3: Scan only user-visible surfaces for legacy branding**

```bash
rg -n -S "Orkas" \
  src/renderer/index.html \
  src/renderer/locales \
  src/main/data/commander.json \
  src/main/data/oss-projects.json
```

Expected: no output.

Run an internal scan separately:

```bash
rg -n -S "window\.orkas|ORKAS_|\.orkas|OrkasArtifactSecurity" src/main src/renderer | head -80
```

Expected: compatibility references remain.

- [ ] **Step 4: Validate package identity and assets**

```bash
node - <<'NODE'
const p = require('./package.json');
console.log({
  productName: p.build.productName,
  appId: p.build.appId,
  artifactName: p.build.artifactName,
  schemes: p.build.protocols[0].schemes,
});
NODE
file src/resources/icons/icon.png src/resources/icons/icon.icns src/resources/icons/icon.ico src/resources/icons/logo.png
```

Expected:

```text
productName: Mate Agent
appId: com.mateagent.desktop
artifactName: Mate-Agent-${version}-${os}-${arch}.${ext}
schemes: [mateagent, orkas]
icon.png: PNG 512 x 512
logo.png: PNG 1024 x 1024
icon.icns: Mac OS X icon
icon.ico: MS Windows icon resource with at least 7 images
```

- [ ] **Step 5: Commit any regression fixes**

If tests required code changes:

```bash
git add <only-the-files-fixed-in-this-task>
git commit -m "fix: complete Mate Agent brand regression"
```

If no changes were needed, do not create an empty commit.

---

### Task 8: Perform real Electron QA and final verification

**Files:**
- No planned source changes; fix and recommit only if QA exposes a defect.

- [ ] **Step 1: Start an isolated QA instance**

```bash
QA_ROOT="$(mktemp -d)"
ORKAS_WORKSPACE_ROOT="$QA_ROOT/data" \
ORKAS_ALLOW_MULTI_INSTANCE=1 \
./run.sh
```

Expected:

- macOS Dock name: Mate Agent.
- Dock icon: double-node companion icon.
- Window title/application menu: Mate Agent.
- Existing main process reaches the renderer without startup errors.

- [ ] **Step 2: Check the Chinese interface at two sizes**

Verify at 1280×768 and 1024×720:

- Left brand area reads Mate Agent or Mate 智伴 according to the approved surface.
- New logo is not clipped or blurred.
- Conversation input, Agent picker and P3394 approval cards remain usable.
- No visible Orkas product name remains.

Capture screenshots for both sizes in the QA evidence directory outside the repository.

- [ ] **Step 3: Regress the P3394 interaction chain**

Run through:

1. Create a conversation.
2. Trigger an `@Agent` WakeRequest.
3. Reject once and confirm “已拒绝”.
4. Trigger again and approve; confirm “已启动”.
5. Confirm execution still enters the original Orkas `enqueue(...)` runtime path.
6. Confirm `agent_run_result` creates Evidence.
7. Confirm final Agent message creates KSTAR `needs_review`.
8. Test human acceptance pass and fail.
9. Test ExperienceCandidate approve and reject.
10. Refresh history and verify rejected/approved states restore correctly.

Expected: behavior matches the previously verified P3394 MVP baseline.

- [ ] **Step 4: Verify both deep-link schemes are safely routed**

With the app running:

```bash
open "mateagent://connectors/oauth/callback?status=cancelled"
open "orkas://connectors/oauth/callback?status=cancelled"
open "mateagent://account/login?token=must-not-run"
```

Expected:

- The first two focus Mate Agent and are accepted only as connector callbacks; with no pending OAuth flow they log a safe no-pending warning.
- The account-login URL is ignored and does not execute navigation or authentication behavior.

- [ ] **Step 5: Run final evidence commands**

```bash
git diff --check
npm run typecheck
PYTHONDONTWRITEBYTECODE=1 npm test
git status --short --branch
git log --oneline --decorate -10
```

Expected: all checks pass. `git status` may still show the pre-existing P3394 integration changes until they are committed, but no untracked generated junk or QA screenshots may remain in the repository.

- [ ] **Step 6: Record final result**

Report:

- Exact test totals.
- Electron QA result at both viewport sizes.
- App name, App ID and protocols observed.
- Icon files generated and visually inspected.
- P3394 workflow result.
- Any intentionally retained internal Orkas identifiers.

---

## Verification Summary

The migration is complete only when all of the following are true:

- `Mate Agent` is the Electron, package, Dock, taskbar and window identity.
- Chinese product copy uses `Mate 智伴` where appropriate.
- The icon is the approved purple-blue double-node companion design.
- App ID is `com.mateagent.desktop`.
- `mateagent://` is registered as the primary protocol.
- `orkas://` remains accepted only for the two connector OAuth callbacks.
- `.orkas`, `ORKAS_*`, `window.orkas` and existing storage/runtime structures remain compatible.
- No user-visible Orkas text or tiger-whale icon remains.
- Full automated tests and real Electron P3394 QA pass.

## Next Skill

Use `$superpower-subagents` for task-by-task delegated execution, or `$superpower-executing-plans` for inline execution in this session.
