---
name: dsh-worker
description: >-
  Delegate bounded coding, debugging, and test-iteration tasks from Antigravity
  (Neon) to a live DeepSeek Harness (dsh web) session via the antidsh MCP server
  while preserving human-in-the-loop control, resumability, and DeepSeek prompt
  cache hits. Activate when the user asks to let DeepSeek / dsh implement,
  refactor, fix, or iterate on a plan.
---

# DSH Worker Delegation Playbook (`antidsh`)

Use this playbook whenever Antigravity (Neon) acts as **Architect / Reviewer** and delegates hands-on implementation work to **DeepSeek (`deepseek-flash`)** running inside the user's live `dsh web` process via the `antidsh` MCP server.

## 1. Core Operating Principles

1. **Reuse Warm Sessions First (Maximize Cache Hits)**
   - Before starting work, ALWAYS call `dsh_session(action="list")` (or `search`) to find an existing warm session for the same repository / feature.
   - DeepSeek (`deepseek-flash`) has a 1M context window and ~97%–98% cache-hit discount. Keep one long-lived session per feature/topic instead of spawning disposable sessions per subtask.
   - Only create a fresh session (`create`) when starting an unrelated project/feature, or use `fork(at_seq=...)` to branch from a clean verified checkpoint before noisy exploration.
2. **Keep Prompts Bounded & Verifiable**
   - Every task sent via `dsh_send` must state:
     - **Goal**: What to build or fix in this step.
     - **Scope (`owned_paths`)**: Which files/directories `dsh` is expected to modify (and what NOT to touch).
     - **Verification**: Exact test/build/lint commands `dsh` must run and report.
     - **Stop Condition**: If requirements are ambiguous or require risky external actions, stop and ask instead of guessing.
3. **Progressive Disclosure (Protect Neon's Context)**
   - Never ask for full raw logs up front.
   - Inspect in layers: `dsh_wait` summary → `dsh_inspect(view="summary")` → `dsh_inspect(view="diff")` (file list + stat first) → `dsh_inspect(view="diff", path="...")` for specific files → `dsh_inspect(view="events", before_seq=...)` only when debugging a failure.
4. **Respect Human-in-the-Loop Control**
   - Because `antidsh` shares the live `dsh web` process, the user can watch, stop, or message the same session directly in their browser at any time.
   - If `dsh_wait` returns `reason: "input-required"` (`pending_input` includes `approval` or `question`), STOP waiting immediately and tell the user clearly what is waiting in `dsh web` so they can approve or answer there.

## 2. Standard Execution Loop

1. **Locate or Prepare Session**
   - Call `dsh_session(action="list")`. Each row carries `workspace_id` and `workspace_title` when the host exposes Workspaces.
   - Pick the matching warm session for the target `cwd`; if none exists, call `dsh_session(action="create", cwd="...", title="...")`. The host binds `cwd` to its Workspace automatically; the reply's `workspace_id`, `workspace_title`, and `workspace_created` show the result, and `dsh_session(action="workspaces")` lists registered Workspaces with their `session_count`.
2. **Dispatch Bounded Task**
   - Call `dsh_send(session_id, prompt, mode="queue", wait_ms=15000)`.
   - Save `cursor_before` so subsequent waits only summarize new output.
3. **Track Progress Without Polling Spam**
   - If still running, call `dsh_wait(session_id, after_seq=cursor_before, timeout_ms=60000)`.
   - Branch on `reason`:
     - **`idle`**: Proceed to Step 4 (Independent Verification).
     - **`input-required`**: Pause and inform the user to review the approval/question in `dsh web`. Resume waiting only after the user confirms.
     - **`timeout`**: Inspect the returned summary. If progressing well, call `dsh_wait` again; if drifting off-course, use `dsh_send(session_id, prompt="...", mode="steer")` or `dsh_control(action="cancel")` followed by a clarifying `dsh_send`.
4. **Independent Review & Iteration**
   - Call `dsh_inspect(session_id, view="diff")` to review changed files and diff stats.
   - Spot-check modified files with `dsh_inspect(session_id, view="diff", path="...")` or read them directly if in workspace.
   - If issues remain, send crisp, line-referenced review feedback back to the **same session** via `dsh_send` (preserving full cache and context).
   - Monitor `cache_hit_rate` and context growth from `dsh_inspect(view="summary")`. When a feature completes cleanly or a session becomes polluted by failed dead-ends, summarize the clean state and start or fork a fresh session for the next milestone.
