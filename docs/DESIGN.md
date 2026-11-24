# antidsh 架构与协议设计文档

> 本文档基于对本地参考仓库 `ref/deepseek-harness` 的源码核查编写，所有 `dsh` 服务与类型签名均对照真实源码确认。

---

## 1. 目标与核心原则

**目标**：建立一条从 **Antigravity（Neon）** 到本地运行中的 **`dsh web`（DeepSeek Harness + `deepseek-flash`）** 的低摩擦、可观测、可热干预协同通道。

**四条设计红线**：
1. **同进程人机双控**：插件作为 Cordis 插件直接运行在 `dsh web` 进程内，通过 `ctx.sessionController` 操作活体会话。Neon 通过 MCP 派活时，人类可在浏览器 `dsh web` 中实时围观、随时点“停止”、手动打字纠偏，再交还给 Neon。
2. **缓存优先，长会话复用**：`deepseek-flash`（DeepSeek-V4.1-Flash）拥有 1M 上下文，Cache Hit 费用约为 Cache Miss 的 1/50（\$0.003–\$0.006/M vs \$0.15–\$0.30/M）。设计上鼓励按项目/Feature 长期复用热会话，并用 `dsh` 原生 `fork` 在干净前缀上分叉，禁止“每个小任务开新会话”。
3. **Antigravity MCP 渐进式与懒加载友好**：
   - Antigravity 默认对 MCP 启用 Lazy Loading（将工具 schema 与 Server `instructions` 缓存至 `~/.gemini/antigravity/mcp/<serverName>/`），传输支持 Stdio 与 **Streamable HTTP**（不支持旧版 HTTP+SSE `2024-11-05`）。
   - 因此工具数量严格收敛为 **5 个高内聚原语**，并配极精炼的 `instructions` + 独立按需激活的 `SKILL.md`。
   - **返回载荷渐进披露**：默认只返回摘要（状态、游标、近期步数、缓存命中率、改动文件列表、是否有待审批项），绝不把整段 Trajectory 或全量 Diff 一次性倒给 Neon；需要时再按游标/文件路径下钻。
4. **防超时异步节奏 + 人类审批闭环**：
   - Antigravity MCP 工具调用受 `timeoutSeconds` 限制，不能靠单次同步调用傻等 10 分钟。
   - `dsh_send` 默认立即返回或短等（≤ 25s），长任务通过 `dsh_wait`（单次建议 30–60s）分段推进；遇到 `input-required`（终端权限审批或向用户提问）时立即提前返回并附带 `dsh web` 直达指引。

---

## 2. 总体架构

```text
┌─────────────────────────────┐
│    Antigravity (Neon)       │
│  • 规划 / 拆解 / 验收        │
│  • Lazy-loaded MCP Client   │
│  • skill/dsh-worker/SKILL   │
└──────────────┬──────────────┘
               │ Streamable HTTP (POST/DELETE /antidsh/mcp)
               │ Authorization: Bearer <token>
               ▼
┌──────────────────────────────────────────────────────────┐
│                  dsh web 进程 (Cordis)                    │
│                                                          │
│  ┌─────────────────────────┐   ┌──────────────────────┐  │
│  │  dsh-antidsh-mcp 插件    │   │   dsh Web UI (3080)  │  │
│  │  • ctx.webServer 挂路由  │   │   • 实时查看轨迹      │  │
│  │  • Streamable HTTP MCP  │   │   • 点停止 / 手动插话  │  │
│  │  • 5 个高内聚工具        │   │   • 点批准高危命令    │  │
│  └────────────┬────────────┘   └──────────┬───────────┘  │
│               │                           │              │
│               └──────────┬────────────────┘              │
│                          ▼                               │
│         ctx.sessionController (同一活体 Session)          │
│         • list / search / create / rename / fork         │
│         • prompt(queue|steer) / cancel / updateQueue     │
│         • state / wait / events / projections            │
│                          │                               │
│                          ▼                               │
│         JSONL 持久化日志 + DeepSeek API (deepseek-flash)  │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 已核实的 `dsh` 内部能力映射

以下均核实自 `ref/deepseek-harness`：

### 3.1 HTTP 路由挂载：`@deepseek-ai/dsh-host-webserver` (`ctx.webServer`)
- 文件参考：`ref/deepseek-harness/packages/host/webserver/src/index.ts`
- 注册方式：
  ```ts
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: config.path, // 默认 '/antidsh/mcp'
    auth: 'anonymous', // 由本插件执行 Bearer Token + Loopback Host/Origin 校验
    handler: async (req, res) => { /* Streamable HTTP MCP */ },
  }))
  ```
- Cordis 自动管理生命周期：卸载或 HMR 重载时自动注销路由。

### 3.2 会话与控制：`@deepseek-ai/dsh-api-session-controller` (`ctx.sessionController`)
- 文件参考：`ref/deepseek-harness/packages/api/session-controller/src/index.ts` 与 `types.ts`
- 直接可调用的 Host 方法：
  - `list({}, signal)` → `{ items: SessionSummary[] }`（含 `sessionId`, `updatedAt`, `running`, `blank`, `cwd`, `agentAvailable`, `projections`）
  - `search({ query }, signal)` → `{ items: SessionSearchItem[], hasMore }`
  - `create({ cwd?, workspaceId?, sessionId?, agentPreset? })` → `{ sessionId, agentPreset? }`
  - `rename({ sessionId, title })` → `{ title, seq }`
  - `fork({ sessionId, atSeq?, allowMigration? })` → `{ sessionId }`
  - `prompt({ requestId, sessionId, mode: 'queue' | 'steer', content, clientTimeZone? }, signal)` → `{ accepted: true }`
    - 自动唤醒/恢复冷会话；
    - `mode: 'queue'` 排队等待下一轮（空闲时立即启动）；
    - `mode: 'steer'` 运行中在下一步插入纠偏；
    - `content: []` 可续跑符合条件的失败空闲会话。
  - `updateQueue({ sessionId, itemId, action })` → 编辑/移除/提升为 steer。
  - `cancel({ sessionId })` → `{ accepted: true }`，优雅取消当前活跃 Turn 并保留 pending inbox。
  - `state({ sessionId }, signal)` → `SessionState`（`cursor`, `active`, `running`, `queue`, `pendingInput: ('approval' | 'question' | 'other')[]`）。
  - `wait({ sessionId, timeoutMs?, afterSeq?, maxMessages? }, signal)` → `SessionWaitValue`：
    - `reason: 'idle' | 'input-required' | 'timeout'`
    - `state: SessionState`
    - `output: { records, truncated }`
  - `events({ address: { kind: 'session', sessionId }, throughSeq?, beforeSeq?, maxMessages?, turnWindow? }, signal)` → `SessionEventsPage`（`records`, `hasMore`, `cursor`）。
  - `projections({ sessionId }, signal)` → `SessionProjectionsValue`。

### 3.3 Token 与缓存指标：`@deepseek-ai/dsh-llm` (`TokenUsage`)
- 文件参考：`ref/deepseek-harness/packages/llm/llm/src/types.ts`
- `TokenUsage` 明确拆分：
  - `inputTokens`（仅未命中缓存的输入）
  - `cacheReadTokens`（缓存命中输入）
  - `cacheWriteTokens`
  - `outputTokens`
  - `reasoningTokens`
- 因此缓存命中率可直接由持久化事件中的 `usage` 聚合计算：
  `cacheHitRate = cacheReadTokens / (inputTokens + cacheReadTokens)`。

### 3.4 审批与提问挂起处理（Phase 1 vs Phase 2）
- 文件参考：`ref/deepseek-harness/packages/interaction/user-approval/src/index.ts`、`packages/api/gateway/src/types.ts`
- **Phase 1（MVP，最安全且零侵入）**：
  - 不抢占 `dsh web` 的审批 waterfall 应答器。
  - 当 `ctx.sessionController.wait()` 返回 `reason: 'input-required'` 或 `state.pendingInput` 非空时，MCP 立即返回状态、`pendingInput` 类型（`approval` / `question`）以及提示人类在 `dsh web` 对应会话中确认的指引（如可用，结合近期事件摘要说明正在请求什么操作）。
- **Phase 2（可选演进）**：
  - 如确有需求让 Neon 代批白名单内的只读/测试命令，再评估挂载可配置的低优先级审批观察器或透传审批上下文。

---

## 4. 安全与传输规范

### 4.1 MCP 传输：Streamable HTTP（Spec `2025-03-26`）
- 端点：`POST /antidsh/mcp`（处理 JSON-RPC 2.0：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`），`DELETE /antidsh/mcp`（清理可选会话），`GET /antidsh/mcp`（返回 `405 Method Not Allowed`，MVP 走无状态 JSON 响应即可，无需长连 SSE，彻底避开连接泄漏与断连重放问题）。
- **实现策略**：建议先用**零外部 MCP 运行时依赖**的精简 JSON-RPC 2.0 + Streamable HTTP 实现（参考 `ref/dsh-cordis-mcp` 的轻量化思路，只依赖 Node 内置模块与 `@deepseek-ai/schemastery`），避免与 `dsh` profile 的 `pnpm` 依赖树产生版本冲突。

### 4.2 安全边界（Fail-Closed）
1. **强制 Bearer Token 鉴权**：
   - Token 来源优先级：`config.token` > 环境变量 `ANTIDSH_MCP_TOKEN`。
   - 使用 `crypto.timingSafeEqual` 校验 `Authorization: Bearer <token>`。
   - 若未配置任何 Token，插件**默认拒绝所有请求（返回 503/401）并打印明确配置提示**，除非显式设置 `allowUnauthenticatedLoopback: true`（仅限本地调试）。
2. **防 DNS Rebinding / 跨站请求**：
   - 若请求带 `Origin` 头，只允许 `null` 或 loopback 来源（`http://127.0.0.1:*`、`http://localhost:*`、`http://[::1]:*`），否则直接返回 `403`。
   - 校验 `Host` 头为 loopback 或与 `dsh web` 监听地址一致。
3. **不越权修改状态**：
   - `dsh_inspect(view="diff")` 仅执行只读 `git status --short` / `git diff`，通过 `execFile('git', [...])` 传参数组（禁止 shell 拼接防注入），并对输出做字节上限截断。

---

## 5. 五个高内聚 MCP 工具设计

MCP `initialize` 响应中的 `instructions` 字段控制在 ~120 字以内，简明指出：**先 `dsh_session(list)` 复用已有热会话；通过 `dsh_send` 派活/纠偏、`dsh_wait` 等待阶段结果、`dsh_inspect` 渐进查看摘要与 diff、`dsh_control` 中断或续跑。**

### Tool 1: `dsh_session`（会话发现、创建、重命名与分叉）
- **Input Schema**：
  - `action`: `'list' | 'search' | 'create' | 'rename' | 'fork'`（必填）
  - `query?`: string（`search` 时必填）
  - `cwd?`: string（`create` 时可选，绝对路径）
  - `workspace_id?`: string（`create` 时可选，与 `cwd` 二选一）
  - `title?`: string（`create` / `rename` 时可选/必填）
  - `session_id?`: string（`rename` / `fork` 时必填）
  - `at_seq?`: number（`fork` 时可选，指定分叉前缀 seq）
  - `limit?`: number（`list` / `search` 默认 20，上限 50）
- **输出设计**：
  - `list` 返回精简数组：`[{ session_id, title, cwd, running, agent_available, updated_at, last_seq }]`（绝不吐原始大对象）。
  - `create` 若同时传了 `title`，创建后顺带调用 `rename`。

### Tool 2: `dsh_send`（派活 / 追问 / 中途纠偏）
- **Input Schema**：
  - `session_id`: string（必填）
  - `prompt`: string（必填，非空白文本）
  - `mode?`: `'queue' | 'steer'`（默认 `'queue'`；会话运行中需要立刻纠偏时用 `'steer'`）
  - `wait_ms?`: number（默认 `0` 立即返回；可选 `1000..25000` 短等待）
- **行为**：
  1. 先读一次 `state` 记录 `cursor_before`（方便后续只看本轮新增输出）。
  2. 调用 `ctx.sessionController.prompt({ requestId, sessionId, mode, content: [{ type: 'text', text: prompt }] }, signal)`。
  3. 若 `wait_ms > 0`，继续调用 `wait({ sessionId, afterSeq: cursor_before, timeoutMs: wait_ms })` 并附带压缩摘要。
- **输出**：`{ accepted: true, session_id, mode, cursor_before, web_hint, wait?: CompactWaitResult }`。

### Tool 3: `dsh_wait`（分段等待，避免轮询与超时）
- **Input Schema**：
  - `session_id`: string（必填）
  - `after_seq?`: number（可选，只汇总该 seq 之后的助手输出）
  - `timeout_ms?`: number（默认 `45000`，范围 `1000..120000`，确保安全小于 Antigravity MCP 超时）
  - `max_chars?`: number（默认 `4000`，对返回的文本摘要做长度上限保护）
- **行为**：
  - 直接调用 `ctx.sessionController.wait({ sessionId, timeoutMs, afterSeq, maxMessages: 10 }, signal)`。
  - 将 `output.records` 压缩为高信息密度结构：**最新助手回复文本（截断保护）+ 期间调用的工具摘要 + `reason` + `cursor` + `pending_input` + `usage_delta`（含缓存命中率）**。
- **核心价值**：
  - `reason === 'idle'`：本轮结束，Neon 可直接调 `dsh_inspect(view="diff")` 验收。
  - `reason === 'input-required'`：立刻交还控制权并提示用户去 `dsh web` 点审批/回答问题。
  - `reason === 'timeout'`：返回当前阶段进度与最新 `cursor`，Neon 可决定继续 `dsh_wait`、下钻 `dsh_inspect` 或 `dsh_send(mode="steer")` 纠偏。

### Tool 4: `dsh_inspect`（渐进式观测：摘要 / 轨迹分页 / Git Diff）
- **Input Schema**：
  - `session_id`: string（必填）
  - `view?`: `'summary' | 'events' | 'diff'`（默认 `'summary'`）
  - `before_seq?`: number（`events` 分页用）
  - `through_seq?`: number（`events` 固定截断用）
  - `limit?`: number（`events` 默认 12，上限 50）
  - `path?`: string（`diff` 时可选，限定单文件详细 diff；省略时只返回 `git status --short` + `git diff --stat`）
  - `max_chars?`: number（默认 `6000`）
- **行为**：
  - `summary`：整合 `state()`、`projections()` 及最近一页 `events()`，输出：状态（running/idle/pendingInput）、`cursor`、模型信息、最近 N 步精简动作列表、累计/近期 `TokenUsage` 与 `cache_hit_rate`、待执行队列长度。
  - `events`：基于 `ctx.sessionController.events(...)` 返回精简事件流（过滤巨型原始输出并截断单条 tool result，保留 `seq`、`type`、`time`、核心摘要及 `next_before_seq` 游标）。
  - `diff`：基于会话 `cwd` 执行只读 `git` 命令；未传 `path` 时只返回变更文件清单与统计，传 `path` 时再返回该文件具体 diff（完美体现渐进披露）。

### Tool 5: `dsh_control`（优雅中断、失败续跑与队列管理）
- **Input Schema**：
  - `session_id`: string（必填）
  - `action`: `'cancel' | 'continue' | 'queue_edit' | 'queue_remove' | 'queue_steer'`（必填）
  - `item_id?`: string（`queue_*` 动作时必填）
  - `text?`: string（`queue_edit` 时必填）
- **行为**：
  - `cancel` → `ctx.sessionController.cancel({ sessionId })`（立即停掉当前 Turn，保留上下文与收件箱）。
  - `continue` → `ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [] }, signal)`（续跑失败的空闲会话）。
  - `queue_*` → `ctx.sessionController.updateQueue(...)`。

---

## 6. 打包、安装与 Antigravity 配置

### 6.1 `dsh` 插件打包形态
- `package.json` 声明：
  ```json
  {
    "name": "dsh-antidsh-mcp",
    "type": "module",
    "main": "./dist/index.js",
    "dsh": {
      "bundle": {
        "patch": "./cordis.patch.yml"
      }
    }
  }
  ```
- `cordis.patch.yml`：将本插件插入 `web` profile 的插件树，并在注释中说明配置项（`path`、`token`、`allowUnauthenticatedLoopback`、`defaultWaitMs`）。
- 本地安装到 `dsh web` profile：
  ```powershell
  npx @deepseek-ai/dsh plugin --profile web add github:YellowSubm/antidsh
  ```
  配置检查（不启动服务器）：
  ```powershell
  npx @deepseek-ai/dsh --profile web --dump-config
  ```

### 6.2 Antigravity `mcp_config.json` 配置
放在 `~/.gemini/config/mcp_config.json`（或单独封装成 Antigravity Plugin）：
```json
{
  "mcpServers": {
    "antidsh": {
      "url": "http://127.0.0.1:3080/antidsh/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_ANTIDSH_MCP_TOKEN>"
      },
      "timeoutSeconds": 180
    }
  }
}
```
> 保持 Antigravity 默认 **Lazy Loading**，不需要标记 `eager: true`；平时不派活时对 Neon 零负担，需要时由 `skill/dsh-worker/SKILL.md` 激活整套协作纪律。

---

## 7. 验收清单

1. **单元测试**：覆盖 Streamable HTTP 协议（`initialize`/`tools/list`/`tools/call`/`ping`/非法 JSON/方法校验）、Bearer Token + Origin 鉴权、5 个工具对 mock `sessionController` 的完整调用路径、响应截断与 `TokenUsage` 缓存命中率聚合。
2. **真机集成测试**：
   - `npx @deepseek-ai/dsh web` 启动后，`POST http://127.0.0.1:3080/antidsh/mcp` 正常完成 `initialize` 与 `tools/list`。
   - Antigravity 成功发现 5 个工具并走懒加载。
   - **人机双控闭环验证**：Neon 用 `dsh_send` 派发任务 → 浏览器打开 `dsh web` 实时看到该会话在跑 → 人工在网页端点击“停止”或发一句纠偏 → Neon 调用 `dsh_inspect(summary)` 立即感知到最新状态并继续推进 → 查看 `cache_hit_rate` 显著为正。
