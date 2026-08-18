CogSeed 源码包
=================

项目名称: CogSeed
仓库地址: https://github.com/YOUR-ORG/cogseed.git

内容
----
- 完整源码: src/ (Electron 主进程、renderer、Core Agent)
- 资源: resources/ (平台 Agent/Skill、品牌资源、运行时清单)
- 测试: test/
- 文档: docs/、AGENTS.md、README.md

可重建或按平台准备的本地内容
----------------------------
- node_modules/ (npm install)
- resources/runtime/ (npm run runtime:ensure / 开发依赖准备)
- resources/embedding-model/ (postinstall 自动准备)
- resources/officecli/、FFmpeg、Whisper 等平台资源

启动方式
--------
npm install
./run.sh      # macOS / Linux shell
run.cmd       # Windows

验证方式
--------
npm run typecheck
npm test
