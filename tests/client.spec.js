/**
 * Tests for the browser half of the settings card.
 *
 * The bundle is a `window.__ModuleLoader__.load` closure factory, so the test
 * supplies a minimal React that keeps hook state across renders and expands
 * function components. That is enough to drive every control and assert the
 * settings-scope traffic, which is where the card's real contract lives: text
 * commits on blur, numbers commit on the keystroke, and a reset is not undone
 * by the blur that clicking the button triggers.
 */

import { describe, expect, it } from 'vitest'

/** Minimal React whose hook state persists per component across renders. */
function createReact() {
  const store = new Map()
  let key = null
  let cursor = 0
  let rerender = () => {}
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => {
      const k = `${key}#${cursor++}`
      if (!store.has(k)) store.set(k, typeof init === 'function' ? init() : init)
      return [store.get(k), (next) => {
        store.set(k, typeof next === 'function' ? next(store.get(k)) : next)
        rerender()
      }]
    },
    useEffect: () => { cursor++ },
    useRef: (init) => {
      const k = `${key}#${cursor++}`
      if (!store.has(k)) store.set(k, { current: init })
      return store.get(k)
    },
    __begin: (name) => { key = name; cursor = 0 },
    __onRerender: (fn) => { rerender = fn },
  }
}

/**
 * Load the bundle once. The module registers itself through a global loader, so
 * a second import would return the cached module without re-running it.
 * @returns the loaded bundle descriptor.
 */
let bundlePromise = null
function loadBundle() {
  if (bundlePromise === null) {
    bundlePromise = (async () => {
      const loaded = []
      globalThis.window = { __ModuleLoader__: { load: (m) => loaded.push(m) } }
      try {
        await import('../src/client.js')
      } finally {
        delete globalThis.window
      }
      return loaded[0]
    })()
  }
  return bundlePromise
}

/** Build a fake settings scope that records its writes. */
function createScope(initial) {
  const calls = []
  const stored = { ...initial }
  return {
    calls,
    stored,
    scope: {
      getSnapshot: () => ({ status: 'ready', writable: true, value: { ...stored } }),
      subscribe: () => () => {},
      set: (field, value) => { calls.push(['set', field, value]); stored[field] = value },
      unset: (field) => { calls.push(['unset', field]); delete stored[field] },
    },
  }
}

const STORED = {
  judgePrompt: 'STORED-PROMPT',
  steerText: 'STORED-STEER',
  maxContinuations: 10,
  maxSteps: 10,
  maxTailChars: 2000,
  debug: false,
}

/**
 * Mount the card against a fake scope.
 * @returns the controls, a re-read accessor, and the recorded scope traffic.
 */
async function mount(initial = STORED) {
  const bundle = await loadBundle()
  const react = createReact()
  const mod = bundle.factory((name) => (name === 'react' ? react : null))
  const { calls, stored, scope } = createScope(initial)

  let card = null
  mod.apply({
    effect: () => {},
    inject: (_deps, fn) => fn({
      settingsScope: { bind: () => scope },
      slots: { inject: (_name, inner) => inner(), register: (_opts, factory) => { card = factory } },
    }),
  })
  expect(card, 'the card must register into settings.plugin.item').not.toBeNull()

  const read = () => {
    const out = []
    let i = 0
    const visit = (node) => {
      if (node === null || node === undefined) return
      if (typeof node === 'string' || typeof node === 'number') return
      if (Array.isArray(node)) { for (const c of node) visit(c); return }
      if (typeof node.type === 'function') {
        react.__begin(`${node.type.name}:${i++}`)
        visit(node.type(node.props))
        return
      }
      out.push(node)
      for (const c of (node.children ?? [])) visit(c)
    }
    react.__begin('card:0')
    const desc = card()
    visit(desc.type(desc.props))
    return out
  }

  let current = read()
  react.__onRerender(() => { current = read() })

  const ui = {
    calls,
    stored,
    els: () => current,
    textarea: (index = 0) => current.filter((e) => e.type === 'textarea')[index],
    numeric: (label) => current.find((e) => e.type === 'input' && e.props['aria-label'] === label),
    toggle: () => current.find((e) => e.type === 'input' && e.props.type === 'checkbox'),
    button: (label) => current.filter((e) => e.type === 'button').find((b) => b.children.join('') === label),
    header: () => current.find((e) => e.type === 'button' && e.props.className === 'dshLoopHeader'),
    /** Open the card; the controls only exist once it is expanded. */
    expand() {
      const header = ui.header()
      if (header.props['aria-expanded'] !== true) header.props.onClick()
    },
  }
  ui.expand()
  return ui
}

describe('settings card', () => {
  it('starts collapsed and expands on the header', async () => {
    const bundle = await loadBundle()
    const react = createReact()
    const mod = bundle.factory((name) => (name === 'react' ? react : null))
    const { scope } = createScope(STORED)
    let card = null
    mod.apply({
      effect: () => {},
      inject: (_deps, fn) => fn({
        settingsScope: { bind: () => scope },
        slots: { inject: (_n, inner) => inner(), register: (_o, factory) => { card = factory } },
      }),
    })

    const read = () => {
      const out = []
      let i = 0
      const visit = (node) => {
        if (node === null || node === undefined) return
        if (typeof node === 'string' || typeof node === 'number') return
        if (Array.isArray(node)) { for (const c of node) visit(c); return }
        if (typeof node.type === 'function') {
          react.__begin(`${node.type.name}:${i++}`)
          visit(node.type(node.props))
          return
        }
        out.push(node)
        for (const c of (node.children ?? [])) visit(c)
      }
      react.__begin('card:0')
      const desc = card()
      visit(desc.type(desc.props))
      return out
    }

    let current = read()
    react.__onRerender(() => { current = read() })

    const header = () => current.find((e) => e.type === 'button' && e.props.className === 'dshLoopHeader')

    expect(header().props['aria-expanded'], 'collapsed by default').toBe(false)
    expect(current.filter((e) => e.type === 'textarea'), 'no controls while collapsed').toHaveLength(0)

    header().props.onClick()
    expect(header().props['aria-expanded']).toBe(true)
    expect(current.filter((e) => e.type === 'textarea'), 'controls appear when open').toHaveLength(2)
    expect(current.find((e) => e.type === 'li').props.className).toContain('dshLoopCardOpen')

    header().props.onClick()
    expect(header().props['aria-expanded']).toBe(false)
    expect(current.filter((e) => e.type === 'textarea')).toHaveLength(0)
  })

  it('shows the unsaved marker on the header while collapsed', async () => {
    const ui = await mount()
    ui.textarea(0).props.onChange({ target: { value: 'DRAFT' } })
    ui.header().props.onClick()
    const pending = ui.els().find((e) => e.props?.className === 'dshLoopPending')
    expect(pending, 'a collapsed card must still announce the pending edit').toBeDefined()
    expect(pending.children.join('')).toBe('未保存')
  })

  it('exposes both prompts and the numeric fields', async () => {
    const ui = await mount()
    expect(ui.els().filter((e) => e.type === 'textarea')).toHaveLength(2)
    expect(ui.textarea(0).props.value).toBe('STORED-PROMPT')
    expect(ui.textarea(1).props.value).toBe('STORED-STEER')
    expect(ui.numeric('每轮最多续期次数').props.value).toBe('10')
    expect(ui.numeric('摘要包含的步骤数').props.value).toBe('10')
    expect(ui.numeric('正文长度上限(字符)').props.value).toBe('2000')
    expect(ui.toggle().props.checked).toBe(false)
  })

  it('commits a prompt on blur, not on every keystroke', async () => {
    const ui = await mount()
    ui.textarea(0).props.onChange({ target: { value: 'EDITED' } })
    expect(ui.calls, 'typing must not write').toHaveLength(0)
    expect(ui.textarea(0).props.value, 'the draft must be visible').toBe('EDITED')

    ui.textarea(0).props.onBlur()
    expect(ui.calls).toEqual([['set', 'judgePrompt', 'EDITED']])
  })

  it('marks an unsaved prompt and offers to discard it', async () => {
    const ui = await mount()
    ui.textarea(0).props.onChange({ target: { value: 'DRAFT' } })
    const badges = ui.els().filter((e) => e.props?.className === 'dshLoopBadge')
    expect(badges[0].children.join('')).toContain('未保存')
    expect(ui.button('放弃修改')).toBeDefined()
  })

  it('commits a number immediately and rejects an out-of-range value', async () => {
    const ui = await mount()
    ui.numeric('每轮最多续期次数').props.onChange({ target: { value: '3' } })
    expect(ui.calls).toEqual([['set', 'maxContinuations', 3]])

    ui.numeric('每轮最多续期次数').props.onChange({ target: { value: '999' } })
    expect(ui.calls, 'out of range must not reach the scope').toHaveLength(1)
  })

  it('writes the debug toggle', async () => {
    const ui = await mount()
    ui.toggle().props.onChange({ target: { checked: true } })
    expect(ui.calls).toEqual([['set', 'debug', true]])
  })

  it('unsets a prompt on reset', async () => {
    const ui = await mount()
    ui.button('恢复内置默认').props.onClick()
    expect(ui.calls).toEqual([['unset', 'judgePrompt']])
  })

  it('does not let the blur after a reset write the draft back', async () => {
    const ui = await mount()
    ui.textarea(0).props.onChange({ target: { value: 'DRAFT' } })
    ui.button('恢复内置默认').props.onClick()
    // Clicking the button blurs the textarea, so this is the real browser order.
    ui.textarea(0).props.onBlur()
    expect(ui.calls).toEqual([['unset', 'judgePrompt']])
  })

  it('does not let the blur after a discard write the draft', async () => {
    const ui = await mount()
    ui.textarea(0).props.onChange({ target: { value: 'DRAFT' } })
    ui.button('放弃修改').props.onClick()
    ui.textarea(0).props.onBlur()
    expect(ui.calls).toHaveLength(0)
  })
})
