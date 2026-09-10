import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  apply, looksUnfinished, parseVerdict, renderSummary, summarizeTurn,
} from '../src/index.js'

/** Build one step's events the way the agent loop really logs them. */
function step(turn, index, blocks) {
  return [
    { type: 'step/start', data: { turn, step: index } },
    {
      type: 'assistant/message',
      data: {
        turn,
        step: index,
        message: { role: 'assistant', content: blocks },
      },
    },
  ]
}

const text = value => ({ type: 'text', text: value })
const call = value => ({ type: 'tool-call', name: value, id: `${value}-1`, arguments: '{}' })

/** The turn 4 shape observed in a real session: two tool steps then a narration. */
const NARRATION_TURN = [
  { type: 'turn/start', data: { turn: 4 } },
  ...step(4, 1, [call('exec_command')]),
  ...step(4, 2, [text('Backed everything up.'), call('exec_command')]),
  ...step(4, 3, [text('Pull succeeded. Now I will put the change back.')]),
  { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
]

describe('summarizeTurn', () => {
  it('reports per-step tool calls and the trailing text', () => {
    const summary = summarizeTurn(NARRATION_TURN, 4, 10)
    expect(summary.steps.map(s => s.tools)).toEqual([
      ['exec_command'],
      ['exec_command'],
      [],
    ])
    expect(summary.text).toBe('Pull succeeded. Now I will put the change back.')
  })

  it('ignores other turns', () => {
    const summary = summarizeTurn(NARRATION_TURN, 5, 10)
    expect(summary.steps).toEqual([])
    expect(looksUnfinished(summary)).toBe(false)
  })

  it('keeps only the newest steps', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      ...step(1, 1, [call('a')]),
      ...step(1, 2, [call('b')]),
      ...step(1, 3, [text('tail')]),
    ]
    const summary = summarizeTurn(events, 1, 2)
    expect(summary.steps.map(s => s.step)).toEqual([2, 3])
    expect(summary.truncated).toBe(true)
  })

  it('captures the human request that opened the turn', () => {
    const events = [
      {
        type: 'user/message',
        data: {
          turn: 4,
          source: { kind: 'user' },
          role: 'user',
          content: [text('keep the full width, tell me if it conflicts')],
        },
      },
      ...NARRATION_TURN,
    ]
    const summary = summarizeTurn(events, 4, 10)
    expect(summary.userRequest).toBe('keep the full width, tell me if it conflicts')
  })

  it('skips bare acknowledgements and reaches the substantive request', () => {
    const events = [
      {
        type: 'user/message',
        data: {
          turn: 4,
          source: { kind: 'user' },
          content: [text('check why the first output is a full sentence')],
        },
      },
      {
        type: 'user/message',
        data: { turn: 5, source: { kind: 'user' }, content: [text('继续')] },
      },
      {
        type: 'user/message',
        data: { turn: 6, source: { kind: 'user' }, content: [text('继续')] },
      },
      ...step(6, 1, [call('exec_command')]),
      ...step(6, 2, [text('now I will confirm the structure and then change it.')]),
    ]
    const summary = summarizeTurn(events, 6, 10)
    expect(summary.userRequest).toBe('check why the first output is a full sentence')
  })

  it('falls back to the nearest message when every one is an acknowledgement', () => {
    const events = [
      {
        type: 'user/message',
        data: { turn: 4, source: { kind: 'user' }, content: [text('继续')] },
      },
      ...step(4, 1, [call('exec_command')]),
      ...step(4, 2, [text('next I will run the test.')]),
    ]
    const summary = summarizeTurn(events, 4, 10)
    expect(summary.userRequest).toBe('继续')
  })
})

describe('looksUnfinished', () => {
  it('accepts the narration shape', () => {
    expect(looksUnfinished(summarizeTurn(NARRATION_TURN, 4, 10))).toBe(true)
  })

  it('rejects a turn whose last step called a tool', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      ...step(1, 1, [call('exec_command')]),
      ...step(1, 2, [text('done'), call('exec_command')]),
    ]
    expect(looksUnfinished(summarizeTurn(events, 1, 10))).toBe(false)
  })

  it('rejects a one-step answer that never used a tool', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      ...step(1, 1, [text('The answer is 42.')]),
    ]
    expect(looksUnfinished(summarizeTurn(events, 1, 10))).toBe(false)
  })

  it('rejects an empty trailing message', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      ...step(1, 1, [call('exec_command')]),
      ...step(1, 2, [text('   ')]),
    ]
    expect(looksUnfinished(summarizeTurn(events, 1, 10))).toBe(false)
  })
})

describe('parseVerdict', () => {
  it('reads a bare verdict', () => {
    expect(parseVerdict('true')).toBe(true)
    expect(parseVerdict('false')).toBe(false)
    expect(parseVerdict(' TRUE \n')).toBe(true)
  })

  it('treats anything unclear as no continuation', () => {
    expect(parseVerdict('')).toBe(false)
    expect(parseVerdict('maybe')).toBe(false)
    expect(parseVerdict('untrue')).toBe(false)
  })
})

describe('renderSummary', () => {
  it('lists the steps and the trailing text', () => {
    const rendered = renderSummary(summarizeTurn(NARRATION_TURN, 4, 10), 2000)
    expect(rendered).toContain('step 1: exec_command')
    expect(rendered).toContain('step 3: no tool call')
    expect(rendered).toContain('Now I will put the change back.')
  })

  it('keeps both ends and marks the truncated middle', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      ...step(1, 1, [call('exec_command')]),
      ...step(1, 2, [text('x'.repeat(100) + 'TAIL')]),
    ]
    const rendered = renderSummary(summarizeTurn(events, 1, 10), 10)
    expect(rendered).toContain('x'.repeat(5))            // head kept
    expect(rendered).toContain('[truncated middle]')
    expect(rendered).toContain('xTAIL')                   // tail kept
    expect(rendered).not.toContain('x'.repeat(50))
  })
})

/**
 * Drive `apply()` over a real cordis context with a stub LLM.
 *
 * The hook fires once per completed step, and a steer keeps the turn open so
 * the next step fires it again. `events` grows the way the agent loop logs it.
 */
function harness({ maxContinuations, verdict = 'true', finishKind = 'stop', warns = [], settings }) {
  let judgeCalls = 0
  const steers = []
  const llmOptions = []
  const infos = []
  const llm = {
    stream(options) {
      judgeCalls += 1
      llmOptions.push(options)
      return (async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: verdict } }
        yield { type: 'finish', reason: { kind: finishKind, failure: finishKind === 'error' ? { message: 'no adapter' } : undefined } }
      })()
    },
  }
  const session = {
    events: [],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const agent = { session, steer: message => steers.push(message) }
  const ctx = new Context().extend({
    logger: { info: msg => infos.push(String(msg)), warn: msg => warns.push(String(msg)) },
    agent,
  })
  ctx.provide('llm', llm)
  if (settings !== undefined) ctx.provide('settings', settings)
  apply(ctx, { maxContinuations, judgeProvider: null, judgeModel: null, debug: true })

  /** Append one step the way the loop logs it, then fire the stopping hook. */
  const stopping = async (index, blocks) => {
    session.events.push(...step(1, index, blocks))
    await ctx.serial({}, 'agent/turn-stopping', {
      agent,
      turn: 1,
      signal: new AbortController().signal,
    })
  }
  return {
    steers, ctx, session, stopping, judgeCalls: () => judgeCalls, llmOptions, warns, infos,
  }
}

describe('maxContinuations budget', () => {
  it('stops steering once the per-turn cap is reached', async () => {
    const h = harness({ maxContinuations: 2 })
    await h.stopping(1, [call('exec_command')])
    // Each narration is followed by a step that really calls a tool, so every
    // steer counts as effective and the per-turn cap is what stops the loop.
    for (let round = 0; round < 4; round += 1) {
      await h.stopping(2 + round * 2, [text('Now I will continue.')])
      await h.stopping(3 + round * 2, [call('exec_command')])
    }
    expect(h.steers).toHaveLength(2)
  })

  it('stops after one ignored steer instead of burning the budget', async () => {
    const h = harness({ maxContinuations: 10 })
    await h.stopping(1, [call('exec_command')])
    await h.stopping(2, [text('Now I will continue.')])
    // The model narrates again instead of calling the tool the steer asked for.
    for (let i = 3; i <= 6; i += 1) await h.stopping(i, [text('Still narrating.')])
    expect(h.steers).toHaveLength(1)
    expect(h.infos.some(line => line.includes('no tool call'))).toBe(true)
  })

  it('spends nothing when the judge answers false', async () => {
    const h = harness({ maxContinuations: 2, verdict: 'false' })
    await h.stopping(1, [call('exec_command')])
    await h.stopping(2, [text('Now I will continue.')])
    expect(h.steers).toHaveLength(0)
  })

  it('releases a closed turn so its budget does not linger', async () => {
    const h = harness({ maxContinuations: 1 })
    await h.stopping(1, [call('exec_command')])
    await h.stopping(2, [text('Now I will continue.')])
    expect(h.steers).toHaveLength(1)

    // Closing turn 1 releases its entry. Re-firing the same turn number then
    // sees a fresh budget; without the turn/end handler it stays exhausted.
    h.ctx.emit('session/event', h.session, { type: 'turn/end', data: { turn: 1 } })
    await h.stopping(3, [text('Now I will continue.')])
    expect(h.steers).toHaveLength(2)
  })
})

describe('judge route resolution', () => {
  it('applies a settings change without remounting the plugin', async () => {
    let hooks
    const settings = {
      installSection(_ctx, _ns, _schema, _config, sectionHooks) {
        hooks = sectionHooks
      },
    }
    const h = harness({ maxContinuations: 10, settings })

    await h.stopping(1, [call('exec_command')])
    await h.stopping(2, [text('Now I will continue.')])
    expect(h.steers).toHaveLength(1)

    // The Settings UI swaps the live source; the next evaluation must read the
    // new value instead of the snapshot taken when the plugin mounted.
    hooks.setSource(() => ({ maxContinuations: 0 }))
    await h.stopping(3, [call('exec_command')])
    await h.stopping(4, [text('Now I will continue.')])
    expect(h.steers).toHaveLength(1)
  })

  it('resolves a registered route instead of passing a literal null provider', async () => {
    const h = harness({ maxContinuations: 1 })
    await h.stopping(1, [call('exec_command')])
    await h.stopping(2, [text('Now I will continue.')])
    // judgeProvider/judgeModel are null in the harness, so the judge must fall
    // through to the session header rather than call with provider=null.
    expect(h.llmOptions.length).toBe(1)
    expect(h.llmOptions[0].provider).toBe('p')
    expect(h.llmOptions[0].model).toBe('m')
  })

  it('prefers the active default model over the session header', async () => {
    const h = harness({ maxContinuations: 1 })
    h.ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default-p', model: 'default-m' }),
    })
    await h.stopping(1, [call('exec_command')])
    await h.stopping(2, [text('Now I will continue.')])
    expect(h.llmOptions[0].provider).toBe('default-p')
    expect(h.llmOptions[0].model).toBe('default-m')
  })

  it('warns and does not steer when the judge call yields an error finish', async () => {
    const h = harness({ maxContinuations: 1, finishKind: 'error' })
    await h.stopping(1, [call('exec_command')])
    await h.stopping(2, [text('Now I will continue.')])
    expect(h.steers).toHaveLength(0)
    expect(h.warns.some(w => w.includes('judge call failed'))).toBe(true)
  })
})
