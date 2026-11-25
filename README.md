# antidsh (`dsh-antidsh-mcp` + Antigravity Plugin)

让 **Antigravity（Neon）负责架构规划、任务拆解与验收**，驱动同进程运行在 **DeepSeek Harness（`dsh Desktop` / `dsh web`）** 里的 **DeepSeek（`deepseek-flash`）** 实际写代码与跑测试。

## 为什么做这个项目？

相比传统“用完即焚”的 Subagent，`antidsh` 解决四个核心痛点：

1. **人机同屏热干预**：`dsh` 插件直接运行在 `dsh Desktop` / `dsh web` 同一个进程内（复用 `ctx.webServer` 与 `ctx.sessionController`），Neon 派活的同时，你可以直接在 `dsh` 界面实时观看思考与终端执行、随时点停止或亲手打字插话。
2. **零配置自动发现（v0.2）**：
   - `dsh` 插件首次启动**自动生成并持久化 32 字节随机 Bearer Token**（`~/.dsh/antidsh-token`），并将当前监听地址与 Token 原子写入 `~/.dsh/antidsh-runtime.json`；
   - Antigravity 侧插件内置零依赖本地桥接 `antidsh-bridge.mjs`，自动读取发现文件并转发——**无需固定 `dsh Desktop` 端口、无需手动生成或复制 Token、`dsh Desktop` 重启换端口自动无感重连**。
3. **吃满 `deepseek-flash` 缓存红利**：`deepseek-flash`（DeepSeek-V4.1-Flash）拥有 1M 上下文与高达 ~97%–98% 的 Cache Hit 折扣。通过长期复用项目/特性级热会话及原生 `fork`，最大化前缀缓存命中率。
4. **贴合 Antigravity 渐进式与懒加载理念**：仅暴露 5 个高内聚 MCP 原语工具（`dsh_session`、`dsh_send`、`dsh_wait`、`dsh_inspect`、`dsh_control`），捆绑按需激活的 [dsh-worker SKILL.md](./antigravity-plugin/skills/dsh-worker/SKILL.md)，平时零上下文负担，排障/验收时再按游标渐进下钻日志与 diff。

---

## 目录结构

```text
antidsh/
├── src/                                  # dsh 侧 Cordis 插件（纯 ESM .js，无编译步骤）
│   ├── index.js                          # 插件入口：Config / inject / apply / 路由与发现文件
│   ├── runtime.js                        # 自动生成持久化 Token 与 antidsh-runtime.json 管理
│   ├── http.js                           # Streamable HTTP 传输、鉴权、body 限制、断连取消
│   ├── protocol.js                       # JSON-RPC 2.0 与 MCP 方法分发、版本协商
│   ├── security.js                       # Bearer、Host、Origin、loopback peer 校验
│   ├── format.js                         # 渐进披露格式化与 TokenUsage 聚合
│   ├── git.js                            # 只读 git status/diff（execFile 参数数组，无 shell）
│   └── tools/                            # 五个高内聚 MCP 工具及参数校验
├── cordis.patch.yml                      # dsh.bundle.patch：向 profile 插入插件行
├── antigravity-plugin/                   # Antigravity 侧插件包（MCP 桥接 + dsh-worker Skill）
│   ├── plugin.json
│   ├── mcp_config.json
│   ├── bridge/antidsh-bridge.mjs         # 零依赖自动发现桥接（Node >= 20）
│   └── skills/dsh-worker/SKILL.md
├── scripts/manage-antigravity-plugin.ps1 # Antigravity 插件安装/卸载脚本
├── install-antigravity.bat               # Windows 一键安装 Antigravity 插件
├── uninstall-antigravity.bat             # Windows 一键卸载 Antigravity 插件
├── test/                                 # node --test 单测
└── docs/                                 # 设计文档与实现提示词记录
```

---

## 30 秒零配置安装（推荐：`dsh Desktop` + Antigravity）

### 第 1 步：在 `dsh Desktop` 中安装 / 升级 `dsh-antidsh-mcp`（v0.2.0+）

- **方式 A（应用内图形界面，推荐）**：打开 `dsh Desktop` → 进入 **「插件」** 页面 → 安装或更新 `dsh-antidsh-mcp`（支持填本地目录路径或仓库地址），完成后重启一次 `dsh Desktop`。
- **方式 B（使用 Desktop 自带命令行）**：先在 Desktop 菜单 **「应用 → 管理 dsh 命令…」** 注册自带的 `dsh` 命令，**完全退出** `dsh Desktop` 后运行：
  ```powershell
  dsh plugin --profile desktop add <你的本地 antidsh 路径或 GitHub 地址>
  ```
  再重新打开 `dsh Desktop`。

> 重启 `dsh Desktop` 后，插件会自动在 `~/.dsh/antidsh-token` 生成持久化密钥，并写入 `~/.dsh/antidsh-runtime.json`（退出时自动清理），**完全不需要手动改 `webserver` 端口或配置环境变量**。

### 第 2 步：安装 Antigravity 插件

双击仓库根目录的 `install-antigravity.bat`，或在 PowerShell 运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage-antigravity-plugin.ps1 -Action install
```

它会将插件安装到 `%USERPROFILE%\.gemini\config\plugins\antidsh` 并自动写入桥接脚本的绝对路径。

### 第 3 步：在 Antigravity 启用插件

在 Antigravity 的 **Plugins / Customizations** 面板中启用 **AntiDSH**（`antidsh`）。启用后，5 个 MCP 工具与 `dsh-worker` Skill 会自动生效，无需重启 Antigravity。

---

## 进阶：直连 Streamable HTTP（不使用桥接时）

如果你不想使用桥接脚本、希望直接用 `url` 连 `dsh web`（默认端口 `3080`）或已固定端口的 `dsh Desktop`：

1. 可选在 profile 的 `cordis.patch.yml` 固定 `webserver` 端口（Desktop 默认随机端口，注意 patch 不深合并需保留 `host`）：
   ```yaml
   - id: webserver
     config:
       host: 127.0.0.1
       port: 3081
   ```
2. Token 会自动保存在 `~/.dsh/antidsh-token`（也可用 `ANTIDSH_MCP_TOKEN` 环境变量或 `config.token` 显式覆盖）。
3. 在 `~/.gemini/config/mcp_config.json` 中配置：
   ```json
   {
     "mcpServers": {
       "antidsh": {
         "url": "http://127.0.0.1:3081/antidsh/mcp",
         "headers": {
           "Authorization": "Bearer <你的 token>"
         },
         "timeoutSeconds": 180
       }
     }
   }
   ```

---

## 插件配置项（均可选，开箱即用）

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `path` | `/antidsh/mcp` | MCP 端点路径，必须是绝对路径、无尾部斜杠。 |
| `token` | `""` | 显式 Bearer Token；为空时依次回落到 `ANTIDSH_MCP_TOKEN` → `autoToken` 自动持久化密钥。 |
| `autoToken` | `true` | 未配置显式 Token 时，自动在 `<DSH_HOME>/antidsh-token` 生成并持久化 32 字节随机 Token。设为 `false` 恢复 503 fail-closed。 |
| `publishRuntimeFile` | `true` | 启动时原子写入 `<DSH_HOME>/antidsh-runtime.json`，供本地桥接自动发现当前随机端口与 Token；退出时自动清理。 |
| `allowUnauthenticatedLoopback` | `false` | 仅开发调试用；为 `true` 且无显式 token 时放行本机 loopback 请求。 |
| `defaultWaitMs` | `0` | `dsh_send` 省略 `wait_ms` 时的短等待默认值（`0` 或 `1000..25000`）；不影响 `dsh_wait` 默认 45000ms。 |

---

## 卸载 / 回滚

- **Antigravity 侧**：双击 `uninstall-antigravity.bat`（或运行 `.\scripts\manage-antigravity-plugin.ps1 -Action uninstall`）。
- **dsh Desktop 侧**：在 Desktop「插件」页直接移除，或完全退出 Desktop 后运行 `dsh plugin --profile desktop remove dsh-antidsh-mcp`。
- **dsh web 侧**：运行 `npx --yes @deepseek-ai/dsh plugin --profile web remove dsh-antidsh-mcp` 并重启。

---

## 安全模型与测试

- **鉴权与防重放**：Bearer Token 经 SHA-256 + `crypto.timingSafeEqual` 比较；本地桥接仅允许转发到 loopback `http(s)` URL，绝不把 Token 发往外部主机。
- **防跨站与 DNS Rebinding**：仅信任 loopback 与实际绑定 `Host`；存在 `Origin` 时仅放行 loopback 来源（拒绝 `Origin: null` 与 `Sec-Fetch-Site: cross-site`）。
- **断连取消**：Antigravity 发送 `notifications/cancelled` 或断开连接时，桥接与服务端均会中止在途 `AbortSignal`，防止 `dsh_wait` 泄漏。
- **只读 Git 隔离**：`dsh_inspect(view="diff")` 仅使用 `execFile('git', [...])` 传参数组（禁用 shell、外部 diff driver、textconv 与可选锁），同时覆盖 staged 与 unstaged 改动。

运行单元测试（Node >= 20）：

```powershell
npm test
# 受限沙箱（禁止 spawn）中：
node --test --test-isolation=none test/*.test.js
```
