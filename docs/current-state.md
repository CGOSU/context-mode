# 当前状态

## 当前目标

官方 v2.1.4 基础上的 Pi 定制迁移已完成。默认主线分支为 `main`；后续开发应进入 `/Users/cgosu/code/JavaScript/context-mode/.worktrees/v2-pi`。

## 已知状态

- Pi 全局唯一 context-mode 包来源已切换为 `/Users/cgosu/code/JavaScript/context-mode/.worktrees/v2-pi/release-out`，运行包版本为 `2.1.4-pi.1`；源码基线版本保持 `2.1.4`。
- 最终目录已由真实 Pi 1.5.0 资源加载器验证：一个扩展、零加载错误。现有 Pi 进程尚需完整退出并重启；不要仅 `/reload`。
- v2 保持进程内架构，保留当前分支记忆、压缩恢复、结构化/图证据、输出预算和按需发现；非零退出与超时证据处理已修复。
- 原工作区位于 `codex/v1-legacy` 归档分支，`~/.pi/agent/git/github.com/CGOSU/context-mode` 保留为 v1 安装对照；旧数据未删除、未改名、未自动导入 v2。不要同时启用两份扩展。
- 本地包直接引用 worktree 的 `release-out`，必须保留此目录。更新使用 `npm run build:pi`，不使用普通 `npm run build` 代替定制打包。

## 验证命令

- `npm run typecheck`
- `node --test --test-concurrency=4 tests/`（干净临时 HOME，保留 PATH、USER、TMPDIR；不要为整套测试覆盖 CONTEXT_MODE_DATA_DIR）
- `npm run build:pi`
- `node scripts/test-pi-installed.mjs`（真实 Pi SDK，临时环境、模拟模型，不调用模型 API）

## 最近一次更新

- 2026-11-06：CI 不再随普通推送自动运行；发布流程仍会调用 CI 检查。原先失败的检查未修复，其历史记录仍保留。
- 2026-11-06：接受主线提升方案：保留 `main` 名称，将 v2 提升为主线；v1 归档为 `codex/v1-legacy`，工作目录和旧修改保留。
- 2026-11-06：完成 v2 适配、验证、旧库备份及配置切换；详细记录见 `docs/session-log.md`，决策见 ADR-0025。
