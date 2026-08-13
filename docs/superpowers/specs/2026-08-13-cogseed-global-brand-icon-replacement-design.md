# CogSeed 全局品牌图标替换设计

日期：2026-08-13
状态：用户已批准，进入实施

## 目标

将用户提供的品牌图标作为 CogSeed 的统一品牌视觉资源，覆盖应用内品牌标、启动/欢迎界面以及桌面应用图标，同时保持现有 CogSeed 产品名、App ID、协议和内部兼容标识不变。

## 资源策略

输入资源：`/Users/sudai/Desktop/微信图片_20260813194423_1297_537.png`。

生成两套资源：

- 页面透明版：移除纯白背景，保留绿色环、橙色角色和种子主体，输出 `logo.png` 与 `cogseed-master.svg` 配套使用。
- 桌面应用图标版：使用浅色底和适当安全留白，生成 512px 主 PNG、ICO 多尺寸容器和 ICNS 多尺寸容器。

页面和桌面图标都使用同一视觉主体；不再继续使用旧的双节点紫蓝渐变图形。

## 替换范围

- `src/resources/icons/logo.png`
- `src/resources/icons/icon.png`
- `src/resources/icons/icon.ico`
- `src/resources/icons/icon.icns`
- `src/resources/icons/cogseed-master.svg`
- 所有代码、启动页和 renderer 品牌资源引用
- 图标生成脚本及其测试契约

现有 `brand.json` 的产品身份字段不变。旧的 `orkas`、`mateagent` 等协议兼容项也不变，因为它们属于内部兼容和深链接迁移，不是用户品牌图标。

## 实施方式

1. 使用 Pillow 对用户提供的 PNG 做本地裁切、背景处理、缩放和抗锯齿。
2. 生成透明页面版及浅色底应用版。
3. 使用仓库现有的图标生成脚本或等价本地工具生成 ICO / ICNS。
4. 更新 SVG、资源引用和测试中的旧品牌视觉断言。
5. 使用图片尺寸、格式头、alpha 通道和旧图形关键词扫描进行验证。

## 验收标准

- 页面品牌资源为新图标，且透明背景版无大块白色方底。
- 应用图标在 16–1024px 资源层级可读取，ICO / ICNS 容器有效。
- 用户可见界面不再出现旧紫蓝双节点品牌图形。
- `npm run typecheck` 通过。
- 品牌资源和 renderer 相关测试通过。
- 不修改业务逻辑、数据格式、协议、用户数据或未相关的未跟踪文件。
