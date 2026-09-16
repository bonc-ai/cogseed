# CogSeed 开源版 · 本地资源

全界面使用系统默认非衬线字体，只指定 CSS 通用类别 `system-ui, sans-serif`。不指定任何字体名称，不包含字体文件，不访问字体服务。

`asset-manifest.json` 记录 `../vendor/` 中 React 预览运行文件及许可证的来源、字节数和 SHA-256。页面只引用本地运行文件；来源链接不参与运行时加载。

来源：[React 18.3.1](https://github.com/facebook/react/tree/v18.3.1)。许可证见 `vendor/LICENSE-React.txt`。

[Lucide 图标](lucide/README.md)保存官方 SVG、固定版本、名称映射与许可证；构建时内联到共享组件，无新增依赖或运行时网络请求。

`brand/` 保存从 cogseed-source/src/resources/icons 复制的现有 Logo 和松鼠，来源、大小与哈希已登记。图形仅用于开源品牌呈现，不代表新增产品能力。
