# dsh-grok-is-this-true

DeepSeek Harness（dsh）全局命令插件：`/verify` + `/verify-result` 召唤一个**独立审核 agent**，在后台核实主 agent 最近一次交付报告（"is this true?"）。

## 兼容性

> **本插件只保证适用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方仓库的 v0.1.1 基线版本**（tag `dsh-v0.1.1`；本地开发与验证基线为 `dsh-v0.1.1-rc.2`）。不保证在官方仓库更高版本（v0.1.2 及以后）上正常工作，升级 harness 前请先在本机验证。

插件只依赖宿主注入的 `ctx.commands`、`ctx.llm` 与 `ctx.jobs` 服务；对 `@deepseek-ai/*` 包全部为类型导入，构建时擦除、零运行时依赖。审核任务复用会话组合里 `tool-jobs` 提供的后台任务服务（web 组成中 controller 由 preset 挂载），因此功能有效性取决于基线组合是否挂载该服务。

## 用法

```text
/verify
```

- 触发后立即返回任务 id（`verify-1`），审核在后台进行，**不影响继续发消息**。
- 会话头部会出现"后台任务"计数按钮（ui-jobs 面板），可随时点开查看 `verify-N` 的运行状态与耗时。
- 审核完成后运行：

```text
/verify-result          # 最近一次审核任务的结论
/verify-result verify-1 # 指定任务
```

主 agent 也可以通过 `job_output` / `job_list` 读取审核任务（走标准后台任务工具）。

## 审核 agent 的实现要点

- **单次调用通道**：审核任务不走 agent 循环、不开子代理会话，而是直接在插件里 `ctx.llm.stream(GenerateOptions)` 一次性调用模型（与 `/btw` 同一通道）。系统提示词是独立的最小审核提示，不带主 agent 的 persona、不带工具。
- **不落盘历史**：审核期间不写任何 user/assistant 消息、不写任何 surface 会话事件；审核结论只存在 `ctx.jobs` 的**进程内存记录**里（`jobs-local` 不落盘），会话关闭/进程退出即消失。唯一的日志写入是命令自身的 `command/run` / `command/done`——它们是 **log-only、非 surface** 记录，永不进入模型请求（`recordInput: false` 使日志里也不留参数）。
- **不影响缓存命中**：会话日志与其派生的模型上下文完全未被触碰，后续请求的前缀与审核前逐字节一致，provider 端上下文缓存命中行为不变；审核请求本身携带的是独立的全新对话，既不读也不写会话的缓存条目。
- **后台独立运行**：`ctx.jobs.start({ kind: 'verify', owner })` 注册一个标准有主后台任务，handler 同步返回 ack，agent loop 全程不等模型调用。
- **完成通知被静默**：插件为每个任务挂一个常驻 `wait()`，在 settle 前认领 `reported` 位，`tool-jobs` 因之跳过"background job verify-N finished"通知——连一行结束通知都不会进入会话或改变下一请求的前缀。
- **可取消**：任务支持标准 `job_kill`；取消/失败会以 `killed`/`failed` 终态落记录，`/verify-result` 可见。
- **路由**：复用当前会话最近的 `requestHeader` provider/model；没有时回退 agent `options`；都没有则给出明确报错。

## 上限（当前为固定常量）

- `MAX_REPORT_CHARS = 20000`：送入审核的报告文本截断上限（超长加截断标记）。
- `OUTPUT_LIMIT_BYTES = 30000`：模型经 `job_output` 读取结论的字节上限。

需要由配置控制时再提升为插件 `Config`。

## 对模型的影响（Model Experience）

- 每次 `/verify`：1 次 LLM 请求（审核本身），额外 ~0 token 会话上下文；零会话历史增长。
- 每次 `/verify-result`：0 次 LLM 请求，纯本地读取。
- 审核结论不进入任何后续请求的上下文，不占用会话 token。

## 安装

前置：已安装 dsh（`dsh` CLI）并存在目标 profile（默认 GUI profile 名为 `web`）。

### 从 GitHub

```sh
dsh plugin --profile web add github:<owner>/dsh-grok-is-this-true
```

Git 安装取的是源码而非构建产物，因此 pnpm 会运行包的 `prepare` 脚本以生成 `lib/`。pnpm ≥ 10 默认拒绝运行 git 依赖的 `prepare`，首次 `add` 会失败并打印确切的包 key；把该 key 复制进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-grok-is-this-true: true
```

然后重新执行 `add`。该放行意味着允许在安装时执行此包代码——只放行你信任的包，并建议固定 commit（`github:<owner>/dsh-grok-is-this-true#<sha>`）。完成后再（重）启动一次 `dsh web`，组合生效。

> 从旧版迁移：若此前在 harness 工作区安装的是 `@deepseek-ai/dsh-grok-is-this-true`，请先 `dsh plugin --profile web remove @deepseek-ai/dsh-grok-is-this-true` 再安装本包，避免新旧两个 bundle 同时向组合插入同一组 `/verify` / `/verify-result` 命令。

### 从 tarball（无需构建放行）

```sh
pnpm pack                          # 生成 dsh-grok-is-this-true-0.1.0.tgz
dsh plugin --profile web add ./dsh-grok-is-this-true-0.1.0.tgz
```

### 本地目录

```sh
dsh plugin --profile web add /path/to/dsh-grok-is-this-true
```

### 卸载

```sh
dsh plugin --profile web remove dsh-grok-is-this-true
```

## 构建

```sh
pnpm install    # 安装 tsdown 并运行 prepare，生成 lib/
```

`prepare` 脚本是自包含构建（`src/` + 专属 tsdown 配置）：无 monorepo 上下文、无 project references、无类型检查，产物为 `lib/index.js`（ESM node half）。

## 分发

这是标准的 dsh bundle：`package.json` 声明 `dsh.bundle`（patch `cordis.patch.yml` 向 profile 组合插入 `ds-h-@grok-is-this-true` 行）。在你的 GitHub 账号下新建同名仓库并把本目录推上去后，用户即可用上面的 `github:<owner>/dsh-grok-is-this-true` 方式安装；也可 `pnpm pack` 分发 tarball。

## 已知限制

- 仅审核"最近一次交付"（会话表面上最后一条非空 assistant 消息）；有更细粒度需求可后续扩展 `/verify <目标>`。
- 审核结论仅存进程内存，不跨会话、不跨进程；如需留存报告可让主 agent 把 `/verify-result` 的文本转存到工作区文件（那属于用户主动行为）。
- `lib/index.js` 零运行时依赖（全部类型导入 + esbuild 擦除），与 `dsh-command-btw` 相同，可脱离 harness 独立加载。

## License

MIT © 2026 [iseri_tomori](./LICENSE)
