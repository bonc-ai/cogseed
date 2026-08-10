CogSeed 源码包
=================

打包时间: 2026-08-07 09:42
本地 HEAD: 81ee973

内容
----
- 完整源码: src/ (主进程 + 渲染层 + core-agent)
- 资源: resources/ (builtin 技能/Agent、app-ui、mac-locales)
- 测试: test/
- 文档: docs/、AGENTS.md、CLAUDE.md、README.md

已排除(体积大且可重建,不属于源码)
---------------------------------
- node_modules/ (1.0G, npm install 重建)
- .git/ (37M, 历史可在仓库查)
- resources/runtime/ (427M, Python 运行时, 需 npm run runtime:ensure 下载)
- resources/embedding-model/ (91M, 嵌入模型, postinstall 自动下载)
- resources/officecli/ (32M, office 预览工具链)

启动方式
--------
npm install   # 装依赖 + 下载嵌入模型
./run.sh      # macOS/Linux 启动
