# Lucide 本地图标

保存 Lucide 官方 SVG，原始几何与文件内容保持不变，无 npm 依赖。

- 来源：[lucide-icons/lucide](https://github.com/lucide-icons/lucide/tree/94e4cb9d9db5907053ebf3636a97c45529cf776b/icons)，固定提交 `94e4cb9d9db5907053ebf3636a97c45529cf776b`。
- [许可证](LICENSE)保留 Lucide 与 Feather 的版权及许可声明。
- [manifest.json](manifest.json)记录现有 Icon 名称到官方图标的映射、来源链接与 SHA-256。
- `../../tools/build.cjs` 校验本地 SVG 并生成 `../../components/foundation/lucide-icons.js`，再打包到预览 bundle；构建和页面运行均不下载图标。

统一采用官方 24 × 24 画板、默认 2px 描边与圆角端点/连接，显示尺寸继续由 Icon 的 size 控制。新增图标时保存同一固定版本的官方 SVG，更新清单和 Icon.d.ts，重新构建；不要直接编辑生成的注册表。
