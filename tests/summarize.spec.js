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

  it('truncates a long tail from the front', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      ...step(1, 1, [call('exec_command')]),
      ...step(1, 2, [text('x'.repeat(100) + 'TAIL')]),
    ]
    const rendered = renderSummary(summarizeTurn(events, 1, 10), 10)
    expect(rendered).toContain('x'.repeat(6) + 'TAIL')
    expect(rendered).not.toContain('x'.repeat(50))
  })
})

/**
 * Drive `apply()` over a real cordis context with a stub LLM.
 *
 * The hook fires once per completed step, and a steer keeps the turn open so
 * the next step fires it again. `events` grows the way the agent loop logs it.
 */
function harness({ maxContinuations, verdict = 'true' }) {
  let judgeCalls = 0
  const steers = []
  const llm = {
    stream() {
      judgeCalls += 1
      return (async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: verdict } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const session = {
    events: [],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const agent = { session, steer: message => steers.push(message) }
  const ctx = new Context().extend({ logger: { info() {}, warn() {} }, agent })
  ctx.provide('llm', llm)
  apply(ctx, { maxContinuations, judgeProvider: null, judgeModel: null, debug: false })

  /** Append one step the way the loop logs it, then fire the stopping hook. */
  const stopping = async (index, blocks) => {
    session.events.push(...step(1, index, blocks))
    await ctx.serial({}, 'agent/turn-stopping', {
      agent,
      turn: 1,
      signal: new AbortController().signal,
    })
  }
  return { steers, ctx, session, stopping, judgeCalls: () => judgeCalls }
}

describe('maxContinuations budget', () => {
  it('stops steering once the per-turn cap is reached', async () => {
    const h = harness({ maxContinuations: 2 })
    await h.stopping(1, [call('exec_command')])
    for (let i = 2; i <= 8; i += 1) await h.stopping(i, [text('Now I will continue.')])
    expect(h.steers).toHaveLength(2)
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
