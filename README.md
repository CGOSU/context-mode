# Context Mode（CGOSU 维护版）

本仓库是 [CGOSU/context-mode](https://github.com/CGOSU/context-mode)，基于上游项目 [mksglu/context-mode](https://github.com/mksglu/context-mode) 修改。Context Mode 是本地运行的 MCP 服务，通过沙箱执行与全文检索，减少工具输出占用的上下文。

## 本 fork 的改动

- 维护 Pi Coding Agent 集成，支持按会话分支检索历史记录。
- 同步上游的安全性、稳定性与 Pi 历史召回修复。
- Pi 历史注入由 `PI_CONTEXT_MODE_AUTO_MEMORY` 控制：`compact`（默认，仅压缩后注入）、`off`（关闭）、`always`（普通轮次也注入）。

## 构建与测试

需要 Node.js 22.5 或更高版本。

```bash
npm ci
npm run build      # 构建完整项目
npm run build:pi   # 构建 Pi 扩展
npm test           # 运行测试
```

> `pi install npm:context-mode` 安装的是上游 npm 包，不是本 fork。使用本 fork 时，请将 Pi 配置为使用 CGOSU 仓库版本，避免同时加载两份 `context-mode`。

## 上游与许可

本项目基于 [mksglu/context-mode](https://github.com/mksglu/context-mode)；许可信息见 [`LICENSE`](LICENSE)。