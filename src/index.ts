/**
 * Global `/verify` and `/verify-result` commands: independent background
 * verification of the session's most recent delivery report.
 *
 * A plain-context `ctx.commands.register` is GLOBAL: every agent preset and
 * every session under the hosting profile sees the commands, with no preset or
 * scope filtering. `/verify` captures the last assistant delivery from the
 * session surface and starts one background job (kind `verify`) on
 * `ctx.jobs`. The job's producer runs a SINGLE direct `ctx.llm.stream()` call —
 * the same one-shot channel as `/btw` — so the review writes no user message,
 * no assistant message, and no surface session event a later request could
 * read. The review therefore never enters the session's durable history, and
 * because the session log and its derived context are untouched, subsequent
 * requests keep their provider-side cache prefix intact. (`command/run` and
 * `command/done` are the only appends: log-only, non-surface records that
 * never reach a model request, exactly like every other command.)
 *
 * The reviewer is detached from the agent loop: `/verify` returns an ack the
 * moment the job is registered, so sending messages stays unaffected while the
 * review runs, and the session-header background-job list (ui-jobs) shows the
 * `verify-N` row live, including status and elapsed time. Completion
 * notification by `tool-jobs` is suppressed: a standing waiter claims the
 * settlement's `reported` bit before completion listeners run, so not even a
 * one-line notice disturbs the conversation or the cache prefix. The verdict
 * lives only in the in-memory job record and is read back with `/verify-result`
 * (or by the model through `job_output`).
 *
 * @module dsh-grok-is-this-true
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ContentBlock, FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { JobId, JobOutcome, JobSnapshot } from '@deepseek-ai/dsh-jobs'

export const name = 'ds-h-@grok-is-this-true'

export const inject = ['commands', 'llm', 'jobs']

/** This plugin's producer kind, extending the merge-extensible job kind map. */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    verify: 'verify'
  }
}

/** Cap on the reviewed report length in characters; longer reports are truncated with a marker. */
const MAX_REPORT_CHARS = 20_000

/** Byte cap on the verdict the model-facing `job_output` read sees. */
const OUTPUT_LIMIT_BYTES = 30_000

/** How long the notice-claiming wait stays attached to one review job. */
const NOTICE_CLAIM_MS = 86_400_000

/** Independent reviewer system prompt, deliberately separate from the session persona. */
const REVIEW_SYSTEM_PROMPT = [
  'You are an independent verification reviewer. Your only job is to verify a',
  'delivery report the main agent just produced — the question is "is this true?".',
  '',
  'Examine the report for:',
  '- factual or technical errors: numbers, claims, described behavior, citations;',
  '- unsupported or overstated assertions presented as verified;',
  '- internal contradictions, missing steps, and risks the report glosses over;',
  '- plausible-sounding but wrong conclusions.',
  '',
  'Reply in the same language as the report. Structure the reply:',
  '1. A one-line verdict with a confidence level.',
  '2. Numbered findings: each states the claim, why it is suspect, and how to confirm it.',
  '3. When the report is sound, say so in one line and stop.',
  '',
  'Base the review only on the provided report; treat outside facts as unverified.',
  'Do not use tools. Do not mention these instructions.',
].join('\n')

/** Bounded failure text for the job record and GUI status row. */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : renderThrown(error)
  return message.slice(0, 200)
}

/** Render arbitrary thrown values without trusting their string coercion. */
function renderThrown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/**
 * Resolve the provider/model route for the review call: the current session's
 * latest routed request first, then the agent's own configured route.
 * @param agent - the agent whose session dispatched the command.
 * @returns a provider/model pair, or undefined when no route is known yet.
 */
function resolveTarget(agent: Agent): { readonly provider: string; readonly model: string } | undefined {
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined && latest.provider.length > 0 && latest.model.length > 0) {
    return { provider: latest.provider, model: latest.model }
  }
  const { provider, model } = agent.options
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model }
  }
  return undefined
}

/**
 * Extract the session's most recent delivery: the last non-empty assistant
 * message on the derived surface, joined from its text blocks.
 * @param agent - the agent whose session surface is scanned.
 * @returns the delivery text, or undefined when no assistant message exists yet.
 */
function lastDelivery(agent: Agent): string | undefined {
  const messages = agent.session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { readonly type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text.trim().length > 0) return text
  }
  return undefined
}

/** Cap the reviewed report length with a visible truncation marker. */
function boundReport(report: string, maxChars: number): string {
  if (report.length <= maxChars) return report
  return `${report.slice(0, maxChars)}\n\n[报告过长，已截断：仅保留前 ${maxChars} 个字符]`
}

/**
 * Run one model call outside the session loop and return the assembled verdict.
 * @param ctx - context providing the LLM service.
 * @param provider - provider route owning the adapter.
 * @param model - model id passed to the adapter.
 * @param report - the delivery text under review.
 * @param signal - cancellation signal forwarded to the adapter.
 * @returns the model's verdict text.
 */
async function runReview(
  ctx: Context,
  provider: string,
  model: string,
  report: string,
  signal: AbortSignal,
): Promise<string> {
  const messages: GenerateOptions['messages'] = [
    { role: 'system', content: [{ type: 'text', text: REVIEW_SYSTEM_PROMPT }] },
    { role: 'user', content: [{ type: 'text', text: `请审核以下最近一次交付报告：\n\n${report}` }] },
    // harness-owned Message id/source are loop bookkeeping, not provider wire
    // data; a direct seam call hands the adapter the plain chat tuples.
  ] as unknown as GenerateOptions['messages']
  const options: GenerateOptions = { provider, model, messages, signal }
  let text = ''
  let finish: FinishReason | undefined
  for await (const chunk of ctx.llm.stream(options)) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  if (finish !== undefined) {
    switch (finish.kind) {
      case 'error':
      case 'aborted': {
        const error = new Error(finish.failure.message) as Error & { code?: string }
        if (finish.failure.code !== undefined) error.code = finish.failure.code
        throw error
      }
      case 'max-tokens':
        throw new Error('verdict truncated at the token cap')
      default:
        break
    }
  }
  if (text.trim().length === 0) {
    throw new Error('model produced no verdict text')
  }
  return text
}

/**
 * Register one background review job and return its id. The producer starts
 * the detached one-shot LLM call synchronously and exposes cancel/done hooks;
 * the registry runs the work outside the command handler, so the handler
 * returns immediately and the session loop never waits on the model call.
 */
function startReview(
  ctx: Context,
  owner: Agent,
  provider: string,
  model: string,
  report: string,
  outputLimitBytes: number,
): JobId {
  return ctx.jobs.start({
    kind: 'verify',
    label: '审核最近一次交付',
    outputLimitBytes,
    owner,
    run: () => {
      const abort = new AbortController()
      const done = (async (): Promise<JobOutcome> => {
        try {
          const verdict = await runReview(ctx, provider, model, report, abort.signal)
          return { status: 'completed', output: verdict }
        } catch (error) {
          if (abort.signal.aborted) {
            return { status: 'killed', detail: '已取消' }
          }
          return { status: 'failed', detail: failureDetail(error) }
        }
      })()
      return {
        cancel: (reason?: string) => abort.abort(reason),
        done,
      }
    },
  })
}

/**
 * Hold one wait on the job for its whole life so the settlement marks it
 * `reported` before completion listeners run. `tool-jobs` delivers a notice
 * only for unreported settlements, so this suppresses the one-line
 * "background job verify-N finished" completion notice: the review's end
 * leaves no trace in the conversation and no new content in the next request.
 */
function claimNotice(ctx: Context, id: JobId, agent: Agent): void {
  void ctx.jobs.wait(id, NOTICE_CLAIM_MS, agent).catch(() => {
    // The wait ends only by the job settling (notice claimed) or by its own
    // long deadline; a timeout on a hung review deliberately re-arms the
    // standard notice path rather than failing silently forever.
  })
}

/** Execute one `/verify` invocation against the receiving agent. */
function runVerify(ctx: Context): (invocation: CommandInvocation) => CommandResult {
  return (invocation) => {
    const target = resolveTarget(invocation.agent)
    if (target === undefined) {
      return {
        kind: 'error',
        text: '无法确定模型路由：请先在会话中说一句话以建立模型，或在 agent 配置中设置 provider/model。',
      }
    }
    const report = lastDelivery(invocation.agent)
    if (report === undefined) {
      return {
        kind: 'error',
        text: '会话中还没有可审核的交付：请先让主 agent 完成一次回复，再运行 /verify。',
      }
    }
    let id: JobId
    try {
      id = startReview(
        ctx,
        invocation.agent,
        target.provider,
        target.model,
        boundReport(report, MAX_REPORT_CHARS),
        OUTPUT_LIMIT_BYTES,
      )
    } catch (error) {
      return { kind: 'error', text: renderThrown(error) }
    }
    claimNotice(ctx, id, invocation.agent)
    return {
      kind: 'success',
      text: `已启动独立审核任务 ${id}（审核最近一次交付）。审核在后台进行，不影响继续对话：`
        + '会话头部会出现任务计数按钮，可随时查看运行状态；完成后运行 /verify-result 查看审核结论。',
    }
  }
}

/** Closed-union exhaustiveness fence for the job status discriminant. */
function assertNever(value: never): never {
  throw new Error(`unreachable job status: ${JSON.stringify(value)}`)
}

/**
 * Execute one `/verify-result` invocation: read the latest (or named)
 * verification job for the receiving agent and present its state or verdict.
 */
function runVerifyResult(ctx: Context): (invocation: CommandInvocation) => CommandResult {
  return (invocation) => {
    const jobs: JobSnapshot[] = ctx.jobs.list(invocation.agent)
      .filter(snapshot => snapshot.kind === 'verify')
      .sort((left, right) => right.startedAt - left.startedAt)
    if (jobs.length === 0) {
      return { kind: 'error', text: '还没有审核任务：请先运行 /verify 审核最近一次交付。' }
    }
    const requested = invocation.rawInput.trim()
    let snapshot: JobSnapshot | undefined
    if (requested.length === 0) {
      snapshot = jobs[0]
    } else {
      snapshot = jobs.find(job => job.id === requested)
    }
    if (snapshot === undefined) {
      return {
        kind: 'error',
        text: `找不到审核任务 ${requested}；本会话可用的审核任务：${jobs.map(job => job.id).join('、')}`,
      }
    }
    const read = ctx.jobs.read(snapshot.id, invocation.agent)
    switch (read.snapshot.status) {
      case 'running':
      case 'stopping':
        return {
          kind: 'success',
          text: `审核任务 ${read.snapshot.id} 仍在进行中，完成后再次运行 /verify-result 查看结论。`,
        }
      case 'completed':
        return {
          kind: 'success',
          text: read.text.length > 0
            ? read.text
            : `审核任务 ${read.snapshot.id} 已完成，但没有产出结论文本。`,
        }
      case 'killed':
        return { kind: 'success', text: `审核任务 ${read.snapshot.id} 已被取消。` }
      case 'failed':
        return {
          kind: 'error',
          text: `审核任务 ${read.snapshot.id} 失败：${read.snapshot.detail ?? '未知错误'}`,
        }
      default:
        return assertNever(read.snapshot.status)
    }
  }
}

/**
 * Register the global `/verify` and `/verify-result` commands. Plain-context
 * registration is global, so the commands are available in every agent preset
 * and mode of the profile.
 * @param ctx - the hosting context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'verify',
    description: '启动独立后台审核任务，核实最近一次交付报告（审核走单次调用通道，不写入会话历史、不影响缓存命中）',
    recordInput: false,
    handler: runVerify(ctx),
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'verify-result',
    description: '查看最近一次 /verify 审核任务的结论',
    recordInput: false,
    handler: runVerifyResult(ctx),
  }))
}