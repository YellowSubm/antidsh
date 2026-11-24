# 给 `dsh`（DeepSeek）的实现提示词

> 使用方式：在 `dsh` 中以 `antidsh` 仓库根目录为工作区打开会话，直接将下方分割线内的提示词粘贴发送。建议按提示词中的 3 个里程碑逐步验收（每步都在同一个 `dsh` 会话里继续，顺便吃满缓存）。

---

```markdown
你正在 `antidsh` 仓库根目录中实现 `dsh-antidsh-mcp` —— 一个挂载在 `dsh web` / `dsh Desktop` 同进程内的 Cordis 插件，通过 Streamable HTTP MCP（Spec 2025-03-26）将 `dsh` 的活体会话控制面暴露给外部 MCP 客户端（如 Antigravity）。

## 必读上下文（动手前先读）
1. 先完整阅读设计文档：`docs/DESIGN.md`（一切接口、安全红线和 5 个工具的设计以此为准）。
2. 参考源码（**只读，严禁修改 `ref/` 内任何文件**）：
   - `ref/deepseek-harness/packages/host/webserver/src/index.ts`（核实 `ctx.webServer.register` 的精确签名与鉴权行为）
   - `ref/deepseek-harness/packages/api/session-controller/src/index.ts` 与 `types.ts`（核实 `ctx.sessionController` 的精确方法与入参/出参类型）
   - `ref/deepseek-harness/packages/llm/llm/src/types.ts` 与 `ref/deepseek-harness/docs/persistence-catalog.zh.md`（核实持久化事件中 `assistant/message`、`tool`、`TokenUsage` / `cacheReadTokens` 的确切字段结构，不要猜字段名）
   - `ref/deepseek-harness/apps/cli/README.zh.md`（核实外部插件 `package.json` 的 `dsh.bundle.patch` 与 `cordis.patch.yml` 规范）
   - `ref/dsh-cordis-mcp`（可参考其零外部 MCP 依赖的轻量化 Cordis 插件结构与 `node --test` 单测组织方式）

## 范围与约束
- **允许改动**：仅在仓库根目录及新建的 `src/`、`test/`、`package.json`、`cordis.patch.yml`、`tsconfig.json`（如使用 TS）中创建和修改文件。
- **禁止改动**：不要修改 `ref/` 目录下的任何文件，也不要改写 `docs/DESIGN.md` 和 `skill/dsh-worker/SKILL.md`（若发现设计文档与 `ref/deepseek-harness` 真实源码存在出入，先停下向我汇报差异，不要私自改规格）。
- **技术选型**：
  - 优先采用纯 ESM（Node >= 20），零外部 MCP 运行时依赖（直接实现精简的 JSON-RPC 2.0 Streamable HTTP 处理器，避免与 `dsh` profile 的 `pnpm` 依赖冲突）；仅按 `dsh` 插件惯例使用 `@deepseek-ai/schemastery` 声明插件配置 Schema。
  - 若使用 TypeScript，请确保有干净的 build 脚本输出到 `dist/`，或直接使用带 JSDoc 类型标注的 ESM `.js`（保证无需复杂编译即可被 `dsh plugin --profile web add <repo-path>` 直接加载，二选一并在 Milestone 1 说明理由）。
  - 严禁拼接 shell 字符串执行 git 命令，必须用 `child_process.execFile('git', [...])`。

## 安全要求（必须全部满足）
1. 强制 Bearer Token 鉴权（`config.token` 优先，其次 `process.env.ANTIDSH_MCP_TOKEN`），使用 `crypto.timingSafeEqual` 比较；未配置 Token 时默认 Fail-Closed（返回 `503` 并打印明确提示），仅在显式配置 `allowUnauthenticatedLoopback: true` 时放行本机请求。
2. 校验 `Origin`（若存在则仅允许 loopback 来源）与 `Host`（防 DNS Rebinding）。
3. 限制 HTTP 请求体大小（如 1MB 上限），超时与异常返回规范的 JSON-RPC 错误结构，不泄露堆栈敏感信息。

## 分阶段交付（每完成一个 Milestone 请停下汇报并等待我验收）

### Milestone 1：核实源码细节 + 项目骨架 + Streamable HTTP MCP 与鉴权层
1. 先对照 `ref/deepseek-harness` 确认 `session/event` 中 `assistant/message`、`tool` 与 `TokenUsage` 的真实结构，列出 5 行以内的核对结论。
2. 搭建 `package.json`、`cordis.patch.yml`、Cordis 插件入口（`inject = ['webServer', 'sessionController']`）、Streamable HTTP 传输层（支持 `initialize` 含精炼 `instructions`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`；`DELETE` 返回 200/204；`GET` 返回 405）与安全鉴权中间件。
3. 编写 `node --test` 单元测试覆盖鉴权、Origin/Host 防护、Streamable HTTP 协议路由与错误处理，运行测试全部通过后汇报。

### Milestone 2：实现 5 个高内聚工具与渐进披露格式化器
严格按 `docs/DESIGN.md` 第 5 节实现：
1. `dsh_session`（`list` / `search` / `create` / `rename` / `fork`）
2. `dsh_send`（`queue` / `steer` + 可选短等待 `wait_ms`）
3. `dsh_wait`（封装 `ctx.sessionController.wait`，支持 `idle` / `input-required` / `timeout`，输出严格做字符上限截断）
4. `dsh_inspect`（`summary` 含近期步数与 `TokenUsage` 缓存命中率、`events` 游标分页、`diff` 只读 `git status --short` / `git diff --stat` / 单文件 diff）
5. `dsh_control`（`cancel` / `continue` / `queue_edit` / `queue_remove` / `queue_steer`）
- 编写完整的单元测试（Mock `ctx.sessionController`、模拟事件流与 `TokenUsage`、模拟临时 git 仓库测试 `diff`），确保全部 `node --test` 通过后汇报。

### Milestone 3：本地挂载验证与使用说明
1. 验证 `cordis.patch.yml` 语法与本地安装命令（给出在 Windows PowerShell 下安装到 `dsh web` profile 和 `--dump-config` 检查的精确步骤；不要擅自修改我全局 `~/.dsh` 配置，除非我确认允许）。
2. 在 `README.md` 补充最终的安装命令、配置项说明与 Antigravity `mcp_config.json` 配置示例。
3. 汇报全部测试结果、改动文件清单与已知限制。
```
