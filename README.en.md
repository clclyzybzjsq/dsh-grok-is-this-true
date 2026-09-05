# dsh-grok-is-this-true

A DeepSeek Harness (dsh) global-command plugin: `/verify` + `/verify-result` summon an **independent reviewing agent** that checks the main agent's most recent delivery report in the background ("is this true?").

## Compatibility

> **This plugin is only guaranteed to work on the v0.1.1 baseline of the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) repository** (tag `dsh-v0.1.1`; the local development and validation baseline is `dsh-v0.1.1-rc.2`). It is not guaranteed to work on later official versions (v0.1.2 and beyond) — verify on your own machine before upgrading the harness.

The plugin depends only on the host-injected `ctx.commands`, `ctx.llm`, and `ctx.jobs` services; every `@deepseek-ai/*` import is type-only and erased at build time, so there is zero runtime dependency. The review jobs reuse the background-job service provided by `tool-jobs` in the session composition (in the web composition the controller is mounted by the preset), so the feature's effectiveness depends on the baseline composition mounting that service.

## Usage

```text
/verify
```

- Returns a task id immediately (`verify-1`); the review runs in the background and **does not block further messages**.
- A "background task" counter button appears in the session header (ui-jobs panel); open it anytime to watch the `verify-N` status and elapsed time.
- After the review finishes:

```text
/verify-result          # result of the most recent review task
/verify-result verify-1 # a specific task
```

The main agent can also read review tasks through the standard background jobs — `job_output` / `job_list`.

## How the reviewer is implemented

- **Single-call channel**: the review task does not run an agent loop and does not open a subagent session; instead the plugin calls `ctx.llm.stream(GenerateOptions)` once directly (the same one-shot channel as `/btw`). The system prompt is an independent, minimal review prompt — no main-agent persona, no tools.
- **No durable history**: the review writes no user message, no assistant message, and no surface session event; the verdict lives only in the **in-memory job record** of `ctx.jobs` (`jobs-local` does not persist) and vanishes when the session closes or the process exits. The only log writes are the command's own `command/run` / `command/done` — **log-only, non-surface** records that never reach a model request (`recordInput: false` keeps even the arguments out of the log).
- **Cache-neutral**: the session log and its derived model context are completely untouched, so the prefix of later requests stays byte-identical and provider-side context-cache hits behave as before; the review request is an independent, brand-new conversation that neither reads nor writes the session's cache entries.
- **Background, detached**: `ctx.jobs.start({ kind: 'verify', owner })` registers a standard owned background job; the handler returns an ack synchronously and the agent loop never waits on the model call.
- **Completion notice suppressed**: the plugin holds a standing `wait()` on each job and claims the `reported` bit before the settlement's completion listeners run, so `tool-jobs` skips the "background job verify-N finished" notice — not even a one-line notice enters the conversation or changes the next request's prefix.
- **Cancellable**: the task supports the standard `job_kill`; cancels/failures settle as `killed`/`failed` and are visible through `/verify-result`.
- **Routing**: reuses the current session's latest `requestHeader` provider/model; falls back to the agent `options`; errors out clearly when neither exists.

## Limits (currently fixed constants)

- `MAX_REPORT_CHARS = 20000`: cap on the reviewed report text in characters (longer reports are truncated with a marker).
- `OUTPUT_LIMIT_BYTES = 30000`: byte cap on the verdict the model reads through `job_output`.

These can be promoted to a plugin `Config` when they need to be configurable.

## Model Experience

- Each `/verify`: 1 LLM request (the review itself), ~0 extra session-context tokens; zero session-history growth.
- Each `/verify-result`: 0 LLM requests, purely local read.
- The verdict never enters any later request's context and never consumes session tokens.

## Install

Prerequisites: a dsh installation (the `dsh` CLI) and a target profile (the default GUI profile is named `web`).

### From GitHub

```sh
dsh plugin --profile web add github:<owner>/dsh-grok-is-this-true
```

A git install fetches sources, not built artifacts, so pnpm runs the package's `prepare` script to build `lib/`. pnpm ≥ 10 refuses to run a git dependency's `prepare` until explicitly allowed — the first `add` fails and dsh prints the exact package key; copy it into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-grok-is-this-true: true
```

then re-run the `add`. That allowance is permission to execute the package's code at install time; only allow packages whose source you trust, and pin a commit: `github:<owner>/dsh-grok-is-this-true#<sha>`. Then (re)start your `dsh web` once so the new row composes.

> Migrating from the old package: if you previously installed `@deepseek-ai/dsh-grok-is-this-true` in the harness workspace, run `dsh plugin --profile web remove @deepseek-ai/dsh-grok-is-this-true` before installing this one, so old and new bundles do not both insert the same `/verify` / `/verify-result` commands into the composition.

### From a tarball (no build allowance needed)

```sh
pnpm pack                          # produces dsh-grok-is-this-true-0.1.0.tgz
dsh plugin --profile web add ./dsh-grok-is-this-true-0.1.0.tgz
```

### From a local directory

```sh
dsh plugin --profile web add /path/to/dsh-grok-is-this-true
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-grok-is-this-true
```

## Build

```sh
pnpm install    # installs tsdown and runs prepare, emitting lib/
```

The `prepare` script is self-contained (builds from `src/` with a dedicated tsdown config): no monorepo context, no project references, no type checking. Output: `lib/index.js` (ESM node half).

## Distribution

This is a standard dsh bundle: `package.json` declares `dsh.bundle` (patch `cordis.patch.yml` inserts the `ds-h-@grok-is-this-true` row into the profile composition). Create a repository under your GitHub account, push this directory, and users install with `github:<owner>/dsh-grok-is-this-true`; or distribute tarballs with `pnpm pack`.

## Known limitations

- Reviews only the "most recent delivery" (the last non-empty assistant message on the session surface); finer-grained targets can be added later as `/verify <target>`.
- The verdict lives only in process memory — it does not survive sessions or processes; to keep a report, have the main agent write the `/verify-result` text to a workspace file (that is a deliberate user action).
- `lib/index.js` has zero runtime dependencies (all type imports, erased at build) — the same as `dsh-command-btw` — and can be loaded standalone outside the harness.

## License

MIT © 2026 [iseri_tomori](./LICENSE)
