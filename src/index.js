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
export const DEFAULT_MAX_CONTINUATIONS = 10

/** How many most-recent steps of the current turn the summary shows. */
export const DEFAULT_MAX_STEPS = 10

/** Total characters of trailing text handed to the judge, split across the first and last halves. */
export const DEFAULT_MAX_TAIL_CHARS = 2000

/** Judge output ceiling; the answer is one word. */
export const DEFAULT_JUDGE_MAX_TOKENS = 64

/** Judge sampling temperature; a verdict should not vary run to run. */
export const DEFAULT_JUDGE_TEMPERATURE = 0

/**
 * Built-in judge instruction. The judge sees a deterministic turn summary and
 * answers one word, so this text is the entire decision policy: it ships as the
 * `judgePrompt` default and any deployment can replace it.
 */
export const DEFAULT_JUDGE_PROMPT = [
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

/** Built-in message injected when the guard steers an unfinished turn. */
export const DEFAULT_STEER_TEXT = (
  'You described an action but did not call any tool. Continue the task now: '
  + 'call the tool for the action you just described. Do not narrate — emit the tool call.'
)

export const Config = z.object({
  maxContinuations: z.number().step(1).min(0).default(DEFAULT_MAX_CONTINUATIONS),
  maxSteps: z.number().step(1).min(1).default(DEFAULT_MAX_STEPS),
  maxTailChars: z.number().step(1).min(1).default(DEFAULT_MAX_TAIL_CHARS),
  judgeProvider: z.union([z.string(), z.const(null)]),
  judgeModel: z.union([z.string(), z.const(null)]),
  judgeMaxTokens: z.number().step(1).min(1).default(DEFAULT_JUDGE_MAX_TOKENS),
  judgeTemperature: z.number().default(DEFAULT_JUDGE_TEMPERATURE),
  /** Instruction telling the judge what counts as an unfinished turn. */
  judgePrompt: z.string().default(DEFAULT_JUDGE_PROMPT),
  /** Steer text sent back to the model; the model then runs one more step. */
  steerText: z.string().default(DEFAULT_STEER_TEXT),
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
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: renderSummary(summary, config.maxTailChars) }],
  }]

  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: config.judgePrompt,
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
  // The live config source. A Settings-UI change swaps this closure instead of
  // rebuilding the plugin, so every evaluation below reads the current values.
  let current = () => config
  registerSettings(ctx, config, {
    setSource: source => { current = source },
    // installSection calls this unconditionally, so it must always be present.
    onChange: () => {},
  })

  const initial = resolveConfig(current())
  ctx.logger?.info?.(`[${name}] loaded: maxContinuations=${initial.maxContinuations} `
    + `maxSteps=${initial.maxSteps} judge=${initial.judgeProvider ?? '<session-route>'}`
    + `/${initial.judgeModel ?? '<session-route>'} debug=${String(initial.debug)}`)

  /**
   * Continuations already spent per turn. The turn number is stable while
   * steering keeps the same turn open, so this is a hard per-turn budget; a
   * new human message opens a new turn number and a fresh budget.
   */
  const spent = new Map()

  /**
   * Turns waiting to see whether their last steer changed anything. A steer
   * that the model ignores costs a full judge round-trip and produces another
   * narration, so one ignored steer ends the turn instead of burning the whole
   * budget. Cleared as soon as the probe is read, or when the turn closes.
   */
  const pendingProbe = new Map()

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const resolved = resolveConfig(current())
    const used = spent.get(turn) ?? 0
    if (used >= resolved.maxContinuations) {
      // Keep the exhausted entry: the hook fires again after every extra step
      // this turn buys, so deleting it here would hand the turn a fresh budget
      // and make maxContinuations unbounded. turn/end clears it instead.
      return
    }

    const events = readEvents(agent.session)
    const summary = summarizeTurn(events, turn, resolved.maxSteps)
    if (!looksUnfinished(summary)) return

    // Did the previous steer actually make the model call a tool? A turn that
    // narrates again after being told to emit the call will keep doing so, so
    // stop here rather than spend the remaining budget on the same refusal.
    const probe = pendingProbe.get(turn)
    if (probe !== undefined) {
      pendingProbe.delete(turn)
      const calledTool = events.slice(probe.eventsAtSteer).some(event => {
        if (event.type !== 'assistant/message' || event.data?.turn !== turn) return false
        return (event.data.message?.content ?? []).some(b => b.type === 'tool-call')
      })
      if (!calledTool) {
        spent.set(turn, resolved.maxContinuations)
        if (resolved.debug) {
          ctx.logger?.info?.(`[${name}] turn ${turn}: previous steer produced no tool call; `
            + 'stopping instead of steering again')
        }
        return
      }
    }

    const route = resolved.judgeProvider != null && resolved.judgeModel != null
      ? { provider: resolved.judgeProvider, model: resolved.judgeModel }
      : routeOf(agent)

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
    pendingProbe.set(turn, { eventsAtSteer: events.length })
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: resolved.steerText }],
      source: PLUGIN_SOURCE,
    }))
  })

  /** Drop bookkeeping once a turn truly closes. */
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') {
      spent.delete(event.data.turn)
      pendingProbe.delete(event.data.turn)
    }
  })
}

/**
 * Resolve one config snapshot.
 *
 * Called per evaluation rather than once at mount so a Settings-UI or patch
 * change takes effect on the next turn-stopping hook without a restart.
 *
 * @param config - raw plugin config from the loader or the Settings section.
 * @returns the config with every default applied.
 */
function resolveConfig(config) {
  return {
    ...config,
    maxContinuations: config.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS,
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    maxTailChars: config.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS,
    judgeMaxTokens: config.judgeMaxTokens ?? DEFAULT_JUDGE_MAX_TOKENS,
    judgeTemperature: config.judgeTemperature ?? DEFAULT_JUDGE_TEMPERATURE,
    judgePrompt: config.judgePrompt ?? DEFAULT_JUDGE_PROMPT,
    steerText: config.steerText ?? DEFAULT_STEER_TEXT,
    debug: config.debug ?? false,
  }
}

/** Settings namespace so the harness Settings UI can drive this plugin live. */
export const SETTINGS_NAMESPACE = 'loop-continue'

/**
 * Mount the plugin's Settings section.
 *
 * Registration is cosmetic: the guard works from the loader config even when
 * no settings service is present. On a new core the section is installed
 * through this plugin's own injector scope, so it lives for exactly this
 * plugin's lifetime and disappears with it; on an older core the top-level
 * helper is imported lazily, because the symbol only exists there.
 *
 * @param ctx - plugin context.
 * @param config - base config used until a settings source replaces it.
 * @param hooks - `setSource` receives the live settings-backed getter.
 */
function registerSettings(ctx, config, hooks) {
  // The settings service calls every hook unconditionally, so normalize here
  // rather than trusting each call site to supply them all.
  const safeHooks = { setSource: () => {}, onChange: () => {}, ...hooks }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      const provider = settingsCtx?.settings
      if (provider !== undefined && typeof provider.installSection === 'function') {
        try {
          provider.installSection(ctx, SETTINGS_NAMESPACE, Config, config, safeHooks)
        } catch (error) {
          // This callback runs inside the plugin fiber, so a throw here would
          // fail the whole plugin. Settings are cosmetic; the guard still works
          // from the loader config.
          ctx.logger?.warn?.(`[${name}] settings section not installed: ${String(error)}`)
        }
      }
    })
    return
  }
  import('@deepseek-ai/dsh-settings').then(mod => {
    if (typeof mod.installSettingsSection === 'function') {
      mod.installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, safeHooks)
    }
  }).catch(() => {
    // Settings registration is cosmetic: the guard still works from the
    // loader config when the section could not be mounted.
  })
}

/**
 * Resolve the provider/model the judge should call.
 *
 * The judge follows the model the current conversation is actually running:
 * the turn is stopping right now, so that route is by definition working. No
 * fallback and no derivation — a route that cannot be read is a real fault and
 * must surface instead of being papered over with a different model.
 *
 * @param agent - the turn's agent subject.
 * @returns the conversation's own provider/model route.
 */
function routeOf(agent) {
  const config = agent.session.requestHeader()?.config
  if (config?.provider !== undefined && config?.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  throw new Error(`[${name}] the session has no request header yet; `
    + 'set judgeProvider/judgeModel explicitly')
}
