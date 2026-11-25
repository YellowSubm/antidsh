# AntiDSH Antigravity Plugin

Bundles the zero-config `antidsh` MCP stdio bridge (`bridge/antidsh-bridge.mjs`) and the `dsh-worker` delegation skill (`skills/dsh-worker/SKILL.md`).

- Automatically discovers your running `dsh Desktop` or `dsh web` instance via `<DSH_HOME>/antidsh-runtime.json` (no port pinning or manual token copying required).
- Survives `dsh Desktop` restarts and random port changes automatically.
- Requires `dsh-antidsh-mcp` v0.2.0+ installed in your `dsh Desktop` / `dsh web` profile.
