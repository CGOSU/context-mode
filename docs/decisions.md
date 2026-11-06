# 设计决策

## 已确认决策

### 2026-11-06：以 v2 为基础保留 Pi 定制

- 决定：在独立 `codex/pi-v2-migration` worktree 中以官方 v2.1.4 为基线，移植必要 Pi 定制，不将 v2 核心逐块拼入 v1。
- 原因：v2 已提供原生进程内 Pi 入口；保持平台适配边界便于后续跟进上游。详细契约见迁移 worktree 的 `docs/architecture/adr/0025-pi-customization.md`。
- 约束：发行版本单独标识为 `2.1.4-pi.1`；保留原 v1 安装与数据，使用单一本地构建包，禁止该 fork 的 ctx_upgrade 自动搬移旧数据；恢复仅依据当前 Pi 分支的持久记录。

