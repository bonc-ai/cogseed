# 模型图：松鼠趴在对话框上（cogseed-squirrel-perch）

设计预演，用于确认「桌面松鼠趴在聊天输入框上」的效果。

> **2026-08-17 已定稿并接入真实应用**（`src/renderer/index.html` +
> `src/renderer/style.css` 的 `.chat-input-squirrel`）：
> 首页新建会话与会话对话框的输入框右上角均采用本效果，
> 尺寸定为参考值 148px 的 **2/3（99px）**。

## 参考来源

官网登录页的效果：登录卡片外层包一个
`position: relative` 的场景容器，松鼠 `<img>` 绝对定位：

```css
.auth-squirrel {
  position: absolute;
  right: -14px;              /* 右缘探出卡片 14px */
  bottom: calc(100% - 24px); /* 底边压住卡片上沿 24px */
  z-index: 2;
  width: 148px;
  pointer-events: none;      /* 不挡点击 */
  user-select: none;
}
```

桌面图标 `cogseed-squirrel-perch.png` 与官网 `/assets/cogseed-squirrel-perch.png`
为同一文件（MD5 一致：`36eabf162ed6cffb38e194aca51a6c7f`）。

## 文件

- `index.html` — 交互模型图：还原应用聊天窗口（侧边栏 + 会话 + 输入框），
  上方控制条可切换松鼠位置（A 输入框右上角 / B 输入框左上角镜像）与大小（小/中/大）。
- `preview-pos-a.png` — 位置 A（右上角，参考站同款），中等大小
- `preview-pos-b.png` — 位置 B（左上角，镜像）
- `preview-pos-a-s.png` / `preview-pos-a-l.png` — 位置 A 的小/大两档
- `cogseed-squirrel-perch.png` — 松鼠素材副本
- `shot-visible.cjs` — 渲染脚本（用项目自带 Electron 截图，可见窗口模式；
  离屏渲染在此环境会漏画图片）

## 重新渲染效果图

```bash
cd docs/mockup-squirrel-perch
../../node_modules/.bin/electron --no-sandbox --disable-gpu \
  --user-data-dir=/tmp/el-shot shot-visible.cjs a:m b:m a:s a:l
```

参数格式 `位置:大小`，位置 `a|b`，大小 `s|m|l`；每次调用建议独立进程。
