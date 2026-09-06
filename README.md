# dsh-grok-is-this-true

dsh（DeepSeek Harness）全局命令插件：`/verify` + `/verify-result` 召唤一个**独立审核 agent**，在后台核实主 agent 最近一次交付报告（"is this true?"）。

A global-command plugin for DeepSeek Harness (dsh): `/verify` + `/verify-result` summon an **independent reviewing agent** that checks the main agent's most recent delivery report in the background ("is this true?").

## 兼容性 / Compatibility

> **本插件只保证适用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方仓库的 v0.1.1 基线版本**（tag `dsh-v0.1.1`；本地开发与验证基线为 `dsh-v0.1.1-rc.2`）。不保证在官方仓库更高版本（v0.1.2 及以后）上正常工作，升级 harness 前请先在本机验证。
>
> **This plugin is only guaranteed to work on the v0.1.1 baseline of the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) repository** (tag `dsh-v0.1.1`; the local development and validation baseline is `dsh-v0.1.1-rc.2`). It is not guaranteed to work on later official versions (v0.1.2 and beyond) — verify on your own machine before upgrading the harness.

插件只依赖宿主注入的 `ctx.commands`、`ctx.llm` 与 `ctx.jobs` 服务；对 `@deepseek-ai/*` 包全部为类型导入，构建时擦除、零运行时依赖。审核任务复用会话组合里 `tool-jobs` 提供的后台任务服务（web 组成中 controller 由 preset 挂载），因此功能有效性取决于基线组合是否挂载该服务。

The plugin depends only on the host-injected `ctx.commands`, `ctx.llm`, and `ctx.jobs` services; every `@deepseek-ai/*` import is type-only and erased at build time, so there is zero runtime dependency. The review jobs reuse the background-job service provided by `tool-jobs` in the session composition (in the web composition the controller is mounted by the preset), so the feature's effectiveness depends on the baseline composition mounting that service.

## 用法 / Usage

```text
/verify
```

- 触发后立即返回任务 id（`verify-1`），审核在后台进行，**不影响继续发消息**。
  Returns a task id immediately (`verify-1`); the review runs in the background and **does not block further messages**.
- 会话头部会出现"后台任务"计数按钮（ui-jobs 面板），可随时点开查看 `verify-N` 的运行状态与耗时。
  A "background task" counter button appears in the session header (ui-jobs panel); open it anytime to watch the `verify-N` status and elapsed time.
- 审核完成后运行：
  After the review finishes:

```text
/verify-result          # 最近一次审核任务的结论 / result of the most recent review task
/verify-result verify-1 # 指定任务 / a specific task
```

主 agent 也可以通过 `job_output` / `job_list` 读取审核任务（走标准后台任务工具）。

The main agent can also read review tasks through the standard background jobs — `job_output` / `job_list`.

## 审核 agent 的实现要点 / How the reviewer is implemented

- **单次调用通道**：审核任务不走 agent 循环、不开子代理会话，而是直接在插件里 `ctx.llm.stream(GenerateOptions)` 一次性调用模型（与 `/btw` 同一通道）。系统提示词是独立的最小审核提示，不带主 agent 的 persona、不带工具。
  **Single-call channel**: the review task does not run an agent loop and does not open a subagent session; instead the plugin calls `ctx.llm.stream(GenerateOptions)` once directly (the same one-shot channel as `/btw`). The system prompt is an independent, minimal review prompt — no main-agent persona, no tools.
- **不落盘历史**：审核期间不写任何 user/assistant 消息、不写任何 surface 会话事件；审核结论只存在 `ctx.jobs` 的**进程内存记录**里（`jobs-local` 不落盘），会话关闭/进程退出即消失。唯一的日志写入是命令自身的 `command/run` / `command/done`——它们是 **log-only、非 surface** 记录，永不进入模型请求（`recordInput: false` 使日志里也不留参数）。
  **No durable history**: the review writes no user message, no assistant message, and no surface session event; the verdict lives only in the **in-memory job record** of `ctx.jobs` (`jobs-local` does not persist) and vanishes when the session closes or the process exits. The only log writes are the command's own `command/run` / `command/done` — **log-only, non-surface** records that never reach a model request (`recordInput: false` keeps even the arguments out of the log).
- **不影响缓存命中**：会话日志与其派生的模型上下文完全未被触碰，后续请求的前缀与审核前逐字节一致，provider 端上下文缓存命中行为不变；审核请求本身携带的是独立的全新对话，既不读也不写会话的缓存条目。
  **Cache-neutral**: the session log and its derived model context are completely untouched, so the prefix of later requests stays byte-identical and provider-side context-cache hits behave as before; the review request is an independent, brand-new conversation that neither reads nor writes the session's cache entries.
- **后台独立运行**：`ctx.jobs.start({ kind: 'verify', owner })` 注册一个标准有主后台任务，handler 同步返回 ack，agent loop 全程不等模型调用。
  **Background, detached**: `ctx.jobs.start({ kind: 'verify', owner })` registers a standard owned background job; the handler returns an ack synchronously and the agent loop never waits on the model call.
- **完成通知被静默**：插件为每个任务挂一个常驻 `wait()`，在 settle 前认领 `reported` 位，`tool-jobs` 因之跳过"background job verify-N finished"通知——连一行结束通知都不会进入会话或改变下一请求的前缀。
  **Completion notice suppressed**: the plugin holds a standing `wait()` on each job and claims the `reported` bit before the settlement's completion listeners run, so `tool-jobs` skips the "background job verify-N finished" notice — not even a one-line notice enters the conversation or changes the next request's prefix.
- **可取消**：任务支持标准 `job_kill`；取消/失败会以 `killed`/`failed` 终态落记录，`/verify-result` 可见。
  **Cancellable**: the task supports the standard `job_kill`; cancels/failures settle as `killed`/`failed` and are visible through `/verify-result`.
- **路由**：复用当前会话最近的 `requestHeader` provider/model；没有时回退 agent `options`；都没有则给出明确报错。
  **Routing**: reuses the current session's latest `requestHeader` provider/model; falls back to the agent `options`; errors out clearly when neither exists.

## 上限（当前为固定常量）/ Limits (currently fixed constants)

- `MAX_REPORT_CHARS = 20000`：送入审核的报告文本截断上限（超长加截断标记）。
  `MAX_REPORT_CHARS = 20000`: cap on the reviewed report text in characters (longer reports are truncated with a marker).
- `OUTPUT_LIMIT_BYTES = 30000`：模型经 `job_output` 读取结论的字节上限。
  `OUTPUT_LIMIT_BYTES = 30000`: byte cap on the verdict the model reads through `job_output`.

需要由配置控制时再提升为插件 `Config`。

These can be promoted to a plugin `Config` when they need to be configurable.

## 对模型的影响（Model Experience）/ Model Experience

- 每次 `/verify`：1 次 LLM 请求（审核本身），额外 ~0 token 会话上下文；零会话历史增长。
  Each `/verify`: 1 LLM request (the review itself), ~0 extra session-context tokens; zero session-history growth.
- 每次 `/verify-result`：0 次 LLM 请求，纯本地读取。
  Each `/verify-result`: 0 LLM requests, purely local read.
- 审核结论不进入任何后续请求的上下文，不占用会话 token。
  The verdict never enters any later request's context and never consumes session tokens.

## 安装 / Install

前置：已安装 dsh（`dsh` CLI）并存在目标 profile（默认 GUI profile 名为 `web`）。

Prerequisites: a dsh installation (the `dsh` CLI) and a target profile (the default GUI profile is named `web`).

### 从 GitHub / From GitHub

```sh
dsh plugin --profile web add github:clclyzybzjsq/dsh-grok-is-this-true
```

Git 安装取的是源码而非构建产物，因此 pnpm 会运行包的 `prepare` 脚本以生成 `lib/`。pnpm ≥ 10 默认拒绝运行 git 依赖的 `prepare`，首次 `add` 会失败并打印确切的包 key；把该 key 复制进 profile 的 `pnpm-workspace.yaml`：

A git install fetches sources, not built artifacts, so pnpm runs the package's `prepare` script to build `lib/`. pnpm ≥ 10 refuses to run a git dependency's `prepare` until explicitly allowed — the first `add` fails and dsh prints the exact package key; copy it into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-grok-is-this-true: true
```

然后重新执行 `add`。该放行意味着允许在安装时执行此包代码——只放行你信任的包，并建议固定 commit（`github:clclyzybzjsq/dsh-grok-is-this-true#<sha>`）。完成后再（重）启动一次 `dsh web`，组合生效。

Then re-run the `add`. That allowance is permission to execute the package's code at install time — only allow packages whose source you trust, and pin a commit (`github:clclyzybzjsq/dsh-grok-is-this-true#<sha>`). (Re)start your `dsh web` once so the composition picks up the new row.

> **从旧版迁移 / Migrating from the old package**：若此前在 harness 工作区安装的是 `@deepseek-ai/dsh-grok-is-this-true`，请先 `dsh plugin --profile web remove @deepseek-ai/dsh-grok-is-this-true` 再安装本包，避免新旧两个 bundle 同时向组合插入同一组 `/verify` / `/verify-result` 命令。 If you previously installed `@deepseek-ai/dsh-grok-is-this-true` in the harness workspace, run `dsh plugin --profile web remove @deepseek-ai/dsh-grok-is-this-true` before installing this one, so old and new bundles do not both insert the same `/verify` / `/verify-result` commands into the composition.

### 从 tarball（无需构建放行）/ From a tarball (no build allowance needed)

```sh
pnpm pack                          # 生成 dsh-grok-is-this-true-0.1.0.tgz / produces dsh-grok-is-this-true-0.1.0.tgz
dsh plugin --profile web add ./dsh-grok-is-this-true-0.1.0.tgz
```

### 本地目录 / From a local directory

```sh
dsh plugin --profile web add /path/to/dsh-grok-is-this-true
```

### 卸载 / Uninstall

```sh
dsh plugin --profile web remove dsh-grok-is-this-true
```

## 构建 / Build

```sh
pnpm install    # 安装 tsdown 并运行 prepare，生成 lib/ / installs tsdown and runs prepare, emitting lib/
```

`prepare` 脚本是自包含构建（`src/` + 专属 tsdown 配置）：无 monorepo 上下文、无 project references、无类型检查，产物为 `lib/index.js`（ESM node half）。

The `prepare` script is self-contained (builds from `src/` with a dedicated tsdown config): no monorepo context, no project references, no type checking. Output: `lib/index.js` (ESM node half).

## 分发 / Distribution

这是标准的 dsh bundle：`package.json` 声明 `dsh.bundle`（patch `cordis.patch.yml` 向 profile 组合插入 `ds-h-@grok-is-this-true` 行）。本仓库地址 `github:clclyzybzjsq/dsh-grok-is-this-true`，用户按上面的 GitHub 命令安装；也可以 `pnpm pack` 分发 tarball。

This is a standard dsh bundle: `package.json` declares `dsh.bundle` (patch `cordis.patch.yml` inserts the `ds-h-@grok-is-this-true` row into the profile composition). Repository: `github:clclyzybzjsq/dsh-grok-is-this-true` — users install with the GitHub command above, or you distribute tarballs with `pnpm pack`.

## 已知限制 / Known limitations

- 仅审核"最近一次交付"（会话表面上最后一条非空 assistant 消息）；有更细粒度需求可后续扩展 `/verify <目标>`。
  Reviews only the "most recent delivery" (the last non-empty assistant message on the session surface); finer-grained targets can be added later as `/verify <target>`.
- 审核结论仅存进程内存，不跨会话、不跨进程；如需留存报告可让主 agent 把 `/verify-result` 的文本转存到工作区文件（那属于用户主动行为）。
  The verdict lives only in process memory — it does not survive sessions or processes; to keep a report, have the main agent write the `/verify-result` text to a workspace file (that is a deliberate user action).
- `lib/index.js` 零运行时依赖（全部类型导入 + esbuild 擦除），与 `dsh-btw` 相同，可脱离 harness 独立加载。
  `lib/index.js` has zero runtime dependencies (all type imports, erased at build) — the same as `dsh-btw` — and can be loaded standalone outside the harness.

## License

MIT © 2026 [iseri_tomori](./LICENSE)