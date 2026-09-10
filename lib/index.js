/**
 * Continue an agent turn when the model only narrated its next action instead
 * of calling a tool.
 *
 * The agent loop ends a turn as `completed` whenever a step produces text but
 * no tool call (packages/core/agent-loop/src/agent.ts). A model that announces
 * "now I will re-apply the change" and forgets the actual call therefore looks
 * finished, and the turn closes mid-task.
 *
 * This plugin listens on `agent/turn-stopping`, reads this turn's own session
 * log, and only when the shape matches that failure mode asks a model one
 * yes/no question. A `true` answer steers, which keeps the SAME turn open and
 * runs one more step.
 *
 * @module dsh-loop-continue
 */

import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'loop-continue'

/** The hook, LLM service, and session projections this plugin reads. */
export const inject = ['llm']

/** Where a steering message claims to come from. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

/** How many extra steps one turn may buy, across all of its stopping boundaries. */
const DEFAULT_MAX_CONTINUATIONS = 10

/** How many most-recent steps of the current turn the summary shows. */
const DEFAULT_MAX_STEPS = 10

/** Total characters of trailing text handed to the judge, split across the first and last halves. */
const DEFAULT_MAX_TAIL_CHARS = 2000

export const Config = z.object({
  maxContinuations: z.number().step(1).min(0).default(DEFAULT_MAX_CONTINUATIONS),
  maxSteps: z.number().step(1).min(1).default(DEFAULT_MAX_STEPS),
  maxTailChars: z.number().step(1).min(1).default(DEFAULT_MAX_TAIL_CHARS),
  judgeProvider: z.union([z.string(), z.const(null)]),
  judgeModel: z.union([z.string(), z.const(null)]),
  judgeMaxTokens: z.number().step(1).min(1).default(64),
  judgeTemperature: z.number().default(0),
  /** Steer text sent back to the model; the model then runs one more step. */
  steerText: z.string().default(
    'You described an action but did not call any tool. Continue the task now: '
    + 'call the tool for the action you just described. Do not narrate — emit the tool call.',
  ),
  /** Emit a diagnostic line for every hook evaluation. */
  debug: z.boolean().default(false),
})

/**
 * Read a session's immutable event log across host core versions.
 *
 * 0.1.1-rc.2 (DSH Desktop 2.0.3) exposes events as a `session.events` getter;
 * 0.1.5-alpha.2 renamed it to `session.snapshotEvents()`. Calling the wrong
 * one yields the "is not a function" failure, so probe both and use whichever
 * the running host actually provides.
 *
 * @param session - the agent's live session.
 * @returns a frozen event array, or an empty array when neither API exists.
 */
function readEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    return session.snapshotEvents()
  }
  if (session && Array.isArray(session.events)) {
    return session.events
  }
  return []
}

/**
 * Reconstruct what actually happened in one turn from its own log entries.
 *
 * Every agent/session event carries `turn`, so the summary is filtered by the
 * turn number the hook was handed. Nothing here is inferred from prose: a step
 * shows a tool call only if an `assistant/message` in that step really carried
 * a `tool-call` block.
 *
 * @param events - full session event log snapshot.
 * @param turn - turn whose steps should be summarized.
 * @param maxSteps - how many trailing steps to include.
 * @returns per-step facts plus the trailing assistant text.
 */
export function summarizeTurn(events, turn, maxSteps) {
  const steps = []
  let current = null
  let lastText = ''
  let userRequest = ''

  for (const event of events) {
    const data = event.data
    if (data?.turn !== turn) continue

    switch (event.type) {
      case 'step/start': {
        current = { step: data.step, tools: [], text: '' }
        steps.push(current)
        break
      }
      case 'assistant/message': {
        const blocks = data.message?.content ?? []
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
        const tools = blocks.filter(b => b.type === 'tool-call').map(b => b.name)
        if (current !== null) {
          current.tools.push(...tools)
          if (text) current.text = text
        }
        if (text) lastText = text
        break
      }
      default:
        break
    }
  }

  // The judge needs the task this turn is answering. Walk the preceding
  // human turns in reverse, skipping bare acknowledgements ("continue",
  // "ok", ...) that carry no task information, and keep the most recent few
  // substantive requests in chronological order.
  const acknowledgements = new Set([
    '继续', '继续吧', '接着', '继续搞', '好的', '好', '嗯', '知道了',
    'ok', 'okay', 'go on', 'continue', 'go', 'next',
  ])
  const isAcknowledgement = text => acknowledgements.has(text.trim().toLowerCase())
  const requests = []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'user/message' || event.data?.turn > turn) continue
    if (event.data.source?.kind !== 'user') continue
    const text = (event.data.content ?? [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    if (!text) continue
    if (isAcknowledgement(text)) continue
    requests.unshift(text)
    if (requests.length >= 3) break
  }
  // Fall back to the nearest human message when every preceding one is a bare
  // acknowledgement (or there are none); a weak anchor beats a blank one.
  if (requests.length === 0) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'user/message' || event.data?.turn > turn) continue
      if (event.data.source?.kind !== 'user') continue
      userRequest = (event.data.content ?? [])
        .filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (userRequest) break
    }
  } else {
    userRequest = requests.join('\n')
  }

  const window = steps.slice(-maxSteps)
  return { steps: window, text: lastText, userRequest, truncated: steps.length > window.length }
}

/**
 * Decide whether one turn's log looks like an unfinished, silently-abandoned
 * narration.
 *
 * Deterministic gates run before any model call:
 *  - the turn must have ended on a text-only step (no tool call),
 *  - the turn must have called at least one tool earlier, which excludes a
 *    plain question answered directly in one step,
 *  - the trailing text must exist and be non-trivial.
 *
 * @param summary - facts produced by {@link summarizeTurn}.
 * @returns whether the LLM judge is worth invoking.
 */
export function looksUnfinished(summary) {
  const { steps, text } = summary
  if (steps.length === 0) return false
  const last = steps[steps.length - 1]
  if (last.tools.length > 0) return false
  const earlierTools = steps.slice(0, -1).some(s => s.tools.length > 0)
  if (!earlierTools) return false
  return text.trim().length > 0
}

/** Render the deterministic step summary as compact plain text. */
export function renderSummary(summary, maxTailChars) {
  const lines = summary.steps.map(s => {
    const tools = s.tools.length > 0 ? s.tools.join(', ') : 'no tool call'
    return `  step ${s.step}: ${tools}`
  })
  // The model states its *next* action near the front ("now I will..."),
  // then often rambles; the very end usually re-commits. Keep both ends so
  // the judge sees the promise without eating the whole budget.
  const tail = summary.text.length > maxTailChars
    ? `${summary.text.slice(0, Math.floor(maxTailChars / 2))}\n`
      + '...\n[truncated middle]\n...\n'
      + `${summary.text.slice(-Math.ceil(maxTailChars / 2))}`
    : summary.text
  const priorNote = summary.truncated
    ? `  (showing only the last ${summary.steps.length} steps)\n`
    : ''
  return [
    'Steps actually executed in this turn:',
    ...lines,
    priorNote.trimEnd(),
    '',
    'Trailing assistant message (text only, no tool call):',
    tail,
    '',
    'The human request this turn is answering:',
    summary.userRequest || '(unknown)',
  ].filter(line => line !== '').join('\n')
}

/**
 * Parse a strict boolean verdict. Anything that is not clearly true counts as
 * false, so an unparseable answer can never extend a turn.
 */
export function parseVerdict(text) {
  const normalized = text.trim().toLowerCase()
  const first = normalized.match(/\b(true|false)\b/)?.[1]
  return first === 'true'
}

/**
 * Ask the judge model whether the trailing text promises work that no tool
 * call performed.
 *
 * @param ctx - plugin context exposing `ctx.llm`.
 * @param route - provider/model to call.
 * @param summary - deterministic turn facts.
 * @param config - resolved plugin policy.
 * @param signal - the turn's abort signal.
 * @returns whether the turn should continue.
 */
async function judge(ctx, route, summary, config, signal) {
  const system = [
    'You inspect one coding-agent turn that just ended.',
    'A turn ends when the agent writes text and calls no tool.',
    'Decide whether that trailing text states an action the agent still',
    'intends to perform, or merely reports completed work.',
    'A promise of future action means the task is unfinished when no tool',
    'call in the step list performed it. This includes explicit "now I will...",',
    '"next I will..." as well as softer commitments like "let me check/confirm',
    '/verify ... then ...", "I need to look at ...", "let me first ...", or',
    'phrases that name a pending read, edit, run, or lookup the agent has not',
    'yet performed.',
    'A finished report, a question to the human, or a final answer means the',
    'task is finished.',
    'Reply with exactly one word: true or false.',
  ].join(' ')

  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: renderSummary(summary, config.maxTailChars) }],
  }]

  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages,
    maxTokens: config.judgeMaxTokens,
    temperature: config.judgeTemperature,
    signal,
  })) {
    assembler.push(chunk)
  }

  const text = assembler.blocks()
    .filter(b => b.type === 'text').map(b => b.text).join('')
  // A missing or unknown provider is swallowed into an error finish chunk by
  // the LLM service; surface it so a misconfigured judge route is visible in
  // the log instead of reading as an endless stream of `verdict=false`.
  const finish = assembler.finish
  if (finish?.kind === 'error') {
    const detail = finish.failure?.message ?? JSON.stringify(finish.failure ?? {})
    throw new Error(`judge call failed: ${detail}`)
  }
  return parseVerdict(text)
}

/**
 * Register the turn-stopping guard.
 * @param ctx - plugin context.
 * @param config - plugin policy.
 */
export function apply(ctx, config) {
  const maxContinuations = config.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
  const maxTailChars = config.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS
  const resolved = {
    ...config,
    maxContinuations,
    maxSteps,
    maxTailChars,
    judgeMaxTokens: config.judgeMaxTokens ?? 64,
    judgeTemperature: config.judgeTemperature ?? 0,
    steerText: config.steerText ?? (
      'You described an action but did not call any tool. Continue the task now: '
      + 'call the tool for the action you just described. Do not narrate — emit the tool call.'
    ),
    debug: config.debug ?? false,
  }

  ctx.logger?.info?.(`[${name}] loaded: maxContinuations=${resolved.maxContinuations} `
    + `maxSteps=${resolved.maxSteps} judge=${resolved.judgeProvider ?? '<session-route>'}`
    + `/${resolved.judgeModel ?? '<session-route>'} debug=${String(resolved.debug)}`)

  /**
   * Continuations already spent per turn. The turn number is stable while
   * steering keeps the same turn open, so this is a hard per-turn budget; a
   * new human message opens a new turn number and a fresh budget.
   */
  const spent = new Map()

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const used = spent.get(turn) ?? 0
    if (used >= resolved.maxContinuations) {
      // Keep the exhausted entry: the hook fires again after every extra step
      // this turn buys, so deleting it here would hand the turn a fresh budget
      // and make maxContinuations unbounded. turn/end clears it instead.
      return
    }

    const summary = summarizeTurn(readEvents(agent.session), turn, resolved.maxSteps)
    if (!looksUnfinished(summary)) return

    const route = resolved.judgeProvider != null && resolved.judgeModel != null
      ? { provider: resolved.judgeProvider, model: resolved.judgeModel }
      : routeOf(ctx, agent)

    let verdict = false
    try {
      verdict = await judge(ctx, route, summary, resolved, signal)
    } catch (error) {
      // The judge is advisory: a failure must never wedge the turn.
      if (resolved.debug) {
        ctx.logger?.warn?.(`[${name}] judge failed: ${String(error)}`)
      }
      return
    }

    if (resolved.debug) {
      ctx.logger?.info?.(`[${name}] turn ${turn} verdict=${String(verdict)} spent=${used}`)
    }
    if (!verdict) {
      return
    }

    spent.set(turn, used + 1)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: resolved.steerText }],
      source: PLUGIN_SOURCE,
    }))
  })

  /** Drop bookkeeping once a turn truly closes. */
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') spent.delete(event.data.turn)
  })
}

/**
 * Resolve the provider/model the judge should call.
 *
 * The session request header can carry a provider id that differs from any
 * registered route (e.g. a pi-ai shorthand), which makes the judge silently
 * fail. Prefer the active default-model selection instead — it always names a
 * registered route — and only fall back to the session header, then give up.
 *
 * @param ctx - plugin context exposing `agentDefaultModel`.
 * @param agent - the turn's agent subject.
 * @returns a registered provider/model route.
 */
function routeOf(ctx, agent) {
  const selection = (() => {
    try {
      return ctx.get('agentDefaultModel')?.currentSelection?.()
    } catch {
      return undefined
    }
  })()
  if (typeof selection?.provider === 'string' && selection.provider.length > 0
    && typeof selection?.model === 'string' && selection.model.length > 0) {
    return { provider: selection.provider, model: selection.model }
  }
  const config = agent.session.requestHeader()?.config
  if (config?.provider !== undefined && config?.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  throw new Error(`[${name}] cannot resolve a judge route; set judgeProvider/judgeModel explicitly`)
}
