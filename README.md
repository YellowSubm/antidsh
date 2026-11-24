# antidsh (`dsh-antidsh-mcp`)

让 **Antigravity（Neon）负责架构规划、任务拆解与验收**，通过 **Streamable HTTP MCP** 驱动同进程运行在 **DeepSeek Harness（`dsh Desktop` / `dsh web`）** 里的 **DeepSeek（`deepseek-flash`）** 实际写代码与跑测试。

## 为什么做这个项目？

相比传统“用完即焚”的 Subagent，`antidsh` 解决四个核心痛点：

1. **人机同屏热干预**：插件直接挂载在 `dsh Desktop` / `dsh web` 同一个进程内（复用 `ctx.webServer` 与 `ctx.sessionController`），Neon 派活的同时，你可以直接在 `dsh` 界面实时观看思考与终端执行、随时点停止或亲手打字插话。
2. **可中断、可纠偏、可续跑**：原生复用 `dsh` 的 `cancel`（保留收件箱不丢上下文）、`steer`（中途纠偏）与 JSONL 持久化会话，中断后随时无缝接续。
3. **吃满 `deepseek-flash` 缓存红利**：`deepseek-flash`（DeepSeek-V4.1-Flash）拥有 1M 上下文与高达 ~97%–98% 的 Cache Hit 折扣。通过长期复用项目/特性级热会话及原生 `fork`，最大化前缀缓存命中率。
4. **贴合 Antigravity 渐进式与懒加载理念**：仅暴露 5 个高内聚 MCP 原语工具（`dsh_session`、`dsh_send`、`dsh_wait`、`dsh_inspect`、`dsh_control`），配合精炼 Server `instructions` 与按需激活的 [skill/dsh-worker/SKILL.md](./skill/dsh-worker/SKILL.md)，平时零上下文负担，排障/验收时再按游标渐进下钻日志与 diff。

---

## 目录结构

```text
antidsh/
├── README.md                   # 安装、配置与冒烟验证指南
├── cordis.patch.yml            # dsh.bundle.patch：向 profile 插入插件行
├── package.json                # 纯 ESM .js，无编译步骤，直接加载 src/index.js
├── src/
│   ├── index.js                # Cordis 插件入口：Config / inject / apply / 路由注册
│   ├── http.js                 # Streamable HTTP 传输、鉴权、body 限制、断连取消
│   ├── protocol.js             # JSON-RPC 2.0 与 MCP 方法分发、版本协商
│   ├── security.js             # Bearer、Host、Origin、loopback peer 校验
│   ├── format.js               # 渐进披露格式化与 TokenUsage 聚合
│   ├── git.js                  # 只读 git status/diff（execFile 参数数组，无 shell）
│   └── tools/                  # 五个高内聚 MCP 工具及参数校验
├── test/                       # node --test 单测
├── skill/
│   └── dsh-worker/
│       └── SKILL.md            # Antigravity 配套 Skill（渐进披露 + 缓存优先规范）
└── docs/
    ├── DESIGN.md               # 基于 dsh 源码核对的架构与协议设计
    └── PROMPT_FOR_DSH.md       # 分阶段实现提示词记录
```

---

## 快速安装：dsh Desktop（推荐）

`dsh Desktop` 本质是完整 `dsh web` 外套一层 Electron 壳，插件 **0 改动原生兼容**。Desktop 独占 `~/.dsh/profiles/desktop` 且默认监听系统随机端口，只需 4 步即可完成配置：

### 1. 安装插件到 `desktop` profile（任选其一）

- **方式 A（应用内图形界面，最省心）**：打开 `dsh Desktop` → 进入 **「插件」** 页面 → 添加 `github:YellowSubm/antidsh`（Desktop 内置 pnpm，无需本机额外安装 pnpm），安装完成后重启 Desktop。
- **方式 B（使用 Desktop 自带命令行）**：
  1. 先在 Desktop 菜单 **「应用 → 管理 dsh 命令…」** 注册自带的 `dsh` 命令；
  2. **完全退出** `dsh Desktop`（包括系统托盘图标）；
  3. 在终端运行：
     ```powershell
     dsh plugin --profile desktop add github:YellowSubm/antidsh
     ```
     > 注意：`npx @deepseek-ai/dsh` 无法修改 `desktop` profile，命令行安装必须使用 Desktop 自带的 `dsh` 命令。

### 2. 固定 Desktop 端口（关键）

Desktop 默认每次启动随机分配端口，需在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中固定 `webserver` 端口（例如 `3081`，避开 `dsh web` 默认的 `3080`）：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3081
```

> **注意**：`cordis.patch.yml` 会替换整块 `config`（不做深合并），务必保留 `host: 127.0.0.1`。

### 3. 生成并配置 Bearer Token

在 PowerShell 生成一个 32 字节随机密钥：

```powershell
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes)
$token
```

将 Token 配置给 Desktop（二选一）：

- **推荐（Windows 用户级环境变量）**：
  ```powershell
  setx ANTIDSH_MCP_TOKEN "<替换为上面生成的 token>"
  ```
  然后**完全退出并重新打开 `dsh Desktop`**（Windows 图形界面启动的 Desktop 会从注册表读取用户级环境变量）。
- **或写入 `~/.dsh/profiles/desktop/cordis.patch.yml`**：
  ```yaml
  - id: dsh-antidsh-mcp
    config:
      path: /antidsh/mcp
      token: '<替换为上面生成的 token>'
      allowUnauthenticatedLoopback: false
      defaultWaitMs: 0
  ```

### 4. 配置 Antigravity MCP 与 Skill

在 `%USERPROFILE%\.gemini\config\mcp_config.json`（或 Antigravity 界面 `… → MCP Servers`）中加入：

```json
{
  "mcpServers": {
    "antidsh": {
      "url": "http://127.0.0.1:3081/antidsh/mcp",
      "headers": {
        "Authorization": "Bearer <替换为上面生成的 token>"
      },
      "timeoutSeconds": 180
    }
  }
}
```

- 保持 Antigravity 默认的 **Lazy Loading**，无需配置 `eager: true`。
- 将仓库中的 [skill/dsh-worker/SKILL.md](./skill/dsh-worker/SKILL.md) 复制到 `~/.gemini/config/skills/dsh-worker/SKILL.md`（或项目的 `.agents/skills/dsh-worker/SKILL.md`），即可让 Neon 按“缓存优先复用热会话 + 有界任务单 + 渐进下钻验收”的规范协同。

---

## 备选安装：dsh web（CLI / 浏览器方式）

如果你平时在终端使用 `dsh web`（默认端口 `3080`）：

1. **安装插件**（需要 `pnpm` 在 `PATH` 上）：
   ```powershell
   npx --yes @deepseek-ai/dsh plugin --profile web add github:YellowSubm/antidsh
   ```
   本地源码调试也可以直接传本地目录路径：`npx --yes @deepseek-ai/dsh plugin --profile web add <你的本地仓库路径>`。
2. **检查配置是否加载**：
   ```powershell
   npx --yes @deepseek-ai/dsh --profile web --dump-config | Select-String -Context 0,8 "dsh-antidsh-mcp"
   ```
   > `--dump-config` 会按层输出明文配置（含 `config.token`），请勿直接公开粘贴。
3. **带 Token 启动 `dsh web`**：
   ```powershell
   $env:ANTIDSH_MCP_TOKEN = "<你的随机 token>"
   npx --yes @deepseek-ai/dsh web --port 3080
   ```
   启动日志应出现：
   ```text
   [antidsh-mcp] MCP endpoint: http://127.0.0.1:3080/antidsh/mcp
   [antidsh-mcp] Bearer authentication is required.
   ```
4. 将上面 Antigravity `mcp_config.json` 中的端口改为 `3080`。

### 卸载 / 回滚

- **Desktop**：在 Desktop「插件」页直接移除，或完全退出 Desktop 后运行 `dsh plugin --profile desktop remove dsh-antidsh-mcp`。
- **Web**：运行 `npx --yes @deepseek-ai/dsh plugin --profile web remove dsh-antidsh-mcp` 并重启 `dsh web`。
- 若曾在 profile 的 `cordis.patch.yml` 里手写过 `dsh-antidsh-mcp` 配置块，建议一并删除。

---

## 插件配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `path` | `/antidsh/mcp` | MCP 端点路径，必须是绝对路径、无尾部斜杠。 |
| `token` | `""` | 客户端必须提交的 Bearer Token；为空时回落到环境变量 `ANTIDSH_MCP_TOKEN`；两者都为空时默认 503 fail-closed。 |
| `allowUnauthenticatedLoopback` | `false` | 仅本地调试用；为 `true` 且无 token 时放行本机 loopback 请求，切勿在对外暴露的实例上开启。 |
| `defaultWaitMs` | `0` | `dsh_send` 省略 `wait_ms` 时的短等待默认值（`0` 或 `1000..25000`）；不影响 `dsh_wait` 默认的 45000ms。 |

> **提示**：profile 级 patch 替换整块 `config` 对象（不做深合并），覆盖任意字段时请把其余字段一并写全；`config.token` 优先于环境变量 `ANTIDSH_MCP_TOKEN`。

---

## 冒烟验证：Neon 派活 + `dsh` 人机同屏

### 1. 最小接口自检（PowerShell）

```powershell
$headers = @{
  Authorization = "Bearer <你的 token>"
  "Content-Type" = "application/json"
}
$body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3081/antidsh/mcp" -Headers $headers -Body $body
```

预期返回 `protocolVersion: "2025-03-26"`、`serverInfo.name: "dsh-antidsh-mcp"` 与精炼的 `instructions`（若用 `dsh web` 请将端口改为 `3080`）。

### 2. Antigravity 端到端闭环验证

1. 在 Antigravity 重载 MCP 连接，确认发现 5 个工具：`dsh_session`、`dsh_send`、`dsh_wait`、`dsh_inspect`、`dsh_control`。
2. 让 Neon 调用 `dsh_session({ "action": "list" })` 查找热会话，或调用 `dsh_session({ "action": "create", "cwd": "<你的项目绝对路径>", "title": "smoke" })`。
3. 让 Neon 调用 `dsh_send({ "session_id": "<id>", "prompt": "...", "mode": "queue", "wait_ms": 0 })`，立刻在 `dsh Desktop` / `dsh web` 中点开同一会话，实时观察执行过程。
4. 验证人机同屏：在 `dsh` 界面点停止、打字插话或批准高危命令；再让 Neon 通过 `dsh_wait`、`dsh_inspect(view="summary" | "events" | "diff")`、`dsh_control(action="cancel")` 观察与协作。

---

## 安全模型与测试

- **鉴权与防重放**：Bearer Token 经 SHA-256 + `crypto.timingSafeEqual` 比较；未配置 Token 默认 503 fail-closed。
- **防跨站与 DNS Rebinding**：仅信任 loopback 与实际绑定 `Host`；存在 `Origin` 时仅放行 loopback 来源（拒绝 `Origin: null` 与 `Sec-Fetch-Site: cross-site`）。
- **请求体与断连控制**：请求体 1MB 上限、10 秒读取超时（不影响长 `dsh_wait` 响应）；客户端中途断开自动通过 `AbortSignal` 取消 `dsh` 侧等待。
- **只读 Git 隔离**：`dsh_inspect(view="diff")` 仅使用 `execFile('git', [...])` 传参数组（禁用 shell、外部 diff driver、textconv 与可选锁），同时覆盖 staged 与 unstaged 改动（优先 `git diff HEAD`，无 commit 仓库回退 `git diff`）。

运行单元测试（Node >= 20）：

```powershell
npm test
# 若处于禁止 child_process.spawn 的受限沙箱中：
node --test --test-isolation=none test/*.test.js
```

## 参考文档

- [docs/DESIGN.md](./docs/DESIGN.md)：架构、接口与安全红线设计说明
- [skill/dsh-worker/SKILL.md](./skill/dsh-worker/SKILL.md)：Antigravity 配套 Skill
