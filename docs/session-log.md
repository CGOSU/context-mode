# 会话记录

## 会话

### 2026-11-06：完成 v2 Pi 定制迁移与本地切换

- 实现：独立 worktree `/Users/cgosu/code/JavaScript/context-mode/.worktrees/v2-pi`，分支 `codex/pi-v2-migration`；基于官方固定 tag v2.1.4，输出包 `2.1.4-pi.1`。保持 v2 进程内架构，移植当前分支记忆、压缩后一次恢复、结构化与图证据、字符预算、工具发现；修复非零退出、停止执行输出留存、失败元数据与唯一检索来源。
- 验证：完整单元测试 2,766 通过、39 跳过、0 失败、0 取消；类型检查通过。全部端到端组已执行；更新旧预期后 GP1/GP4/GP5 复测 83 通过、5 跳过、0 失败，其余组此前通过。真实 Pi 1.5.0 SDK 验证加载单扩展、9 工具、预算/检索/失败信息、分支切换、压缩重启恢复一次及按需发现，网络请求 0。构建、提示词与仓库检查、最终包 SHA256SUMS 校验通过。
- 测试兼容：修复 npm 12 打包 JSON 格式、可选 Python tomllib 缺失检测，以及一处上游 doctor 测试将报告头部误当诊断表格的断言。执行错误标记和检索来源的旧快照已按新语义更新，并增加真实检索断言。
- 备份：`/Users/cgosu/.pi/agent/context-mode-backups/v1-before-v2-20261106-150705`。保存原 settings、v1 已跟踪源码快照与未提交补丁；旧数据约 222 MiB，34 个数据库采用 Node SQLite 在线备份且逐库 quick_check 通过。原目录保持不动。
- 应用：只替换全局 settings 中原 `git:github.com/CGOSU/context-mode` 为上述 worktree 的 `release-out`，校验其他设置未变。最终目录由真实 Pi 资源加载器直接读取：1 扩展，0 错误。
- 回退：完整退出 Pi，运行 `python3 /Users/cgosu/.pi/agent/context-mode-backups/v1-before-v2-20261106-150705/restore-package.py`，再重启。脚本仅替换本次包来源并保留其他设置，已在临时配置验证。旧安装与数据库仍在原路径。
- 边界：未推送或发布；未执行上游 ctx_upgrade/setup；旧索引未自动导入 v2。没有关闭用户现有 Pi 进程，须完整退出重启才能使用新包。39 项单元跳过主要为平台/缺少可选宿主及已有上游排除；不声称全部宿主或真实模型调用已验证。

