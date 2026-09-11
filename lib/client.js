/**
 * Browser half of dsh-loop-continue.
 *
 * The Host half registers the `loop-continue` settings namespace; this half
 * claims a card for that namespace under Settings > Plugins > plugin config, so
 * the judge policy and the steering text are editable without touching
 * `settings.yaml` by hand.
 *
 * The artifact is a closure-factory bundle (`window.__ModuleLoader__.load`),
 * the only shape the client module system accepts. `react` and the settings
 * scope service arrive through the injected `require` table; nothing here is
 * bundled, so the package ships no build step.
 *
 * Writes use different timing per control. A number or a toggle commits on the
 * spot, matching every other settings card. A prompt textarea commits on blur
 * instead: the Host validates and persists the whole document per write, and a
 * 740-character policy paragraph would otherwise push one write per keystroke.
 */
window.__ModuleLoader__.load({
  id: 'dsh-loop-continue',
  factory: (require) => {
    const react = require('react')
    const { createElement, useState, useEffect, useRef } = react

    const PLUGIN_ID = 'dsh-loop-continue'
    const NAMESPACE = 'loop-continue'
    const CARD_TAG_ID = `${PLUGIN_ID}/card.css`

    /** Field names, matching the Host schema keys. */
    const F_JUDGE_PROMPT = 'judgePrompt'
    const F_STEER_TEXT = 'steerText'
    const F_MAX_CONTINUATIONS = 'maxContinuations'
    const F_MAX_STEPS = 'maxSteps'
    const F_MAX_TAIL_CHARS = 'maxTailChars'
    const F_DEBUG = 'debug'

    /** Numeric bounds, mirrored from the Host schema; the schema stays the authority. */
    const NUM_FIELDS = [
      {
        field: F_MAX_CONTINUATIONS,
        label: '每轮最多续期次数',
        min: 0,
        max: 100,
        default: 10,
        hint: '同一轮内累计;用完即让该轮正常结束。开新一轮时配额重置。',
      },
      {
        field: F_MAX_STEPS,
        label: '摘要包含的步骤数',
        min: 1,
        max: 100,
        default: 10,
        hint: '判定时向 judge 列出最近多少步。调大更准但更慢更贵。',
      },
      {
        field: F_MAX_TAIL_CHARS,
        label: '正文长度上限(字符)',
        min: 100,
        max: 20000,
        default: 2000,
        hint: '取结尾正文的前半 + 后半,中间截断。',
      },
    ]

    /** Prompt textareas, committed on blur rather than per keystroke. */
    const TEXT_FIELDS = [
      {
        field: F_JUDGE_PROMPT,
        label: 'judgePrompt — 判定策略',
        rows: 10,
        hint: 'judge 收到确定性的轮次摘要后,按这段指令只回一个词:true 或 false。',
      },
      {
        field: F_STEER_TEXT,
        label: 'steerText — 续期消息',
        rows: 4,
        hint: '判定为未完成时发给模型的消息,模型据此再跑一步。',
      },
    ]

    /**
     * Card chrome. A contributed card inherits no styling from the settings
     * section, so it carries its own and reads as part of the surrounding list.
     */
    const CARD_CSS = `
.dshLoopCard {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0;
  padding: 16px 20px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  list-style: none;
}

.dshLoopHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.dshLoopTitle {
  color: var(--dsw-alias-text-l1);
  font-size: 15px;
  font-weight: 600;
}

.dshLoopState {
  color: var(--dsw-alias-text-l3);
  font-size: 12px;
}

.dshLoopIntro {
  margin: 0;
  color: var(--dsw-alias-text-l3);
  font-size: 12px;
  line-height: 1.6;
}

.dshLoopRow {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshLoopLabelRow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.dshLoopLabel {
  color: var(--dsw-alias-text-l1);
  font-size: 13px;
  font-weight: 600;
}

.dshLoopBadge {
  color: var(--dsw-alias-text-l3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.dshLoopHint {
  margin: 0;
  color: var(--dsw-alias-text-l3);
  font-size: 12px;
  line-height: 1.5;
}

.dshLoopError {
  margin: 0;
  color: var(--dsw-alias-text-error, var(--dsw-alias-text-l2));
  font-size: 12px;
  line-height: 1.5;
}

.dshLoopInput {
  width: 120px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-text-l1);
  font: inherit;
  font-variant-numeric: tabular-nums;
}

.dshLoopTextarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-text-l1);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}

.dshLoopInput:focus-visible,
.dshLoopTextarea:focus-visible {
  border-color: var(--dsw-alias-border-l3);
  outline: none;
}

.dshLoopInput:disabled,
.dshLoopTextarea:disabled {
  opacity: 0.5;
}

.dshLoopInvalid {
  border-color: var(--dsw-alias-text-error, var(--dsw-alias-border-l3));
}

.dshLoopControls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.dshLoopButton {
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-text-l1);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.dshLoopButton:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3);
}

.dshLoopButton:disabled {
  opacity: 0.5;
  cursor: default;
}

.dshLoopToggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--dsw-alias-text-l1);
  font-size: 13px;
}
`

    /**
     * Install the card stylesheet once. The loader re-executes this factory on
     * every HMR rebuild, so a second tag would stack a duplicate sheet.
     * @returns the disposer removing the tag.
     */
    function installStyles() {
      if (document.querySelector(`style[data-plugin-css="${CARD_TAG_ID}"]`) !== null) {
        return () => {}
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = CARD_TAG_ID
      tag.textContent = CARD_CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /**
     * One numeric row. Owns its own draft state so the text can hold an
     * in-between value the Host would reject, without snapping back.
     * @param props - the field spec, the stored value, and the commit callback.
     * @returns the row.
     */
    function NumberRow(props) {
      const spec = props.spec
      const stored = typeof props.stored === 'number' && Number.isFinite(props.stored)
        ? props.stored
        : spec.default
      const [text, setText] = useState(String(stored))
      // Follow the Host document when it changes for any reason other than this
      // control's own write: a reset, another window, or a settings file edit.
      useEffect(() => { setText(String(stored)) }, [stored])

      const parsed = Number(text.trim())
      const valid = text.trim() !== ''
        && Number.isFinite(parsed)
        && parsed >= spec.min
        && parsed <= spec.max

      return createElement('div', { className: 'dshLoopRow' },
        createElement('div', { className: 'dshLoopLabelRow' },
          createElement('span', { className: 'dshLoopLabel' }, spec.label),
          createElement('span', { className: 'dshLoopBadge' }, `当前 ${stored}`),
        ),
        createElement('input', {
          className: valid ? 'dshLoopInput' : 'dshLoopInput dshLoopInvalid',
          type: 'text',
          inputMode: 'numeric',
          value: text,
          disabled: !props.writable,
          'aria-label': spec.label,
          ...(valid ? {} : { 'aria-invalid': true }),
          onChange: (event) => {
            const next = event.target.value
            setText(next)
            const parsedNext = Number(next.trim())
            if (next.trim() === '' || !Number.isFinite(parsedNext)) return
            if (parsedNext < spec.min || parsedNext > spec.max) return
            props.onCommit(parsedNext)
          },
        }),
        createElement('p', { className: valid ? 'dshLoopHint' : 'dshLoopError' },
          valid
            ? `${spec.hint} 可填 ${spec.min} 到 ${spec.max}。`
            : `请输入 ${spec.min} 到 ${spec.max} 之间的数字。`),
      )
    }

    /**
     * The card. Reads the bound namespace scope and writes back through it.
     * @param props - the settings scope bound to this namespace.
     * @returns the card's rows.
     */
    function LoopContinueCard(props) {
      const scope = props.scope
      const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
      useEffect(() => scope.subscribe(() => { setSnapshot(scope.getSnapshot()) }), [scope])

      const value = snapshot.value ?? {}
      const writable = snapshot.writable === true
      const ready = snapshot.status === 'ready'

      // A textarea holds local text between focus and blur, so the Host document
      // is not rewritten per keystroke. `null` means "showing the stored value".
      const [drafts, setDrafts] = useState({})
      const scratch = useRef({})

      const commitText = (field) => {
        const next = scratch.current[field]
        setDrafts(prev => { const rest = { ...prev }; delete rest[field]; return rest })
        if (next === undefined || next === value[field]) return
        void scope.set(field, next)
      }

      // Clearing the scratch value is what makes the blur a button click
      // triggers a no-op: either the button runs first (blur finds nothing to
      // commit) or the blur runs first (the button's unset lands on top).
      const revertText = (field) => {
        delete scratch.current[field]
        setDrafts(prev => { const rest = { ...prev }; delete rest[field]; return rest })
      }

      const rows = []

      for (const spec of TEXT_FIELDS) {
        const stored = typeof value[spec.field] === 'string' ? value[spec.field] : ''
        const text = drafts[spec.field] ?? stored
        const dirty = drafts[spec.field] !== undefined && text !== stored
        rows.push(createElement('div', { className: 'dshLoopRow', key: spec.field },
          createElement('div', { className: 'dshLoopLabelRow' },
            createElement('span', { className: 'dshLoopLabel' }, spec.label),
            createElement('span', { className: 'dshLoopBadge' }, `${text.length} 字符${dirty ? ' · 未保存' : ''}`),
          ),
          createElement('textarea', {
            className: 'dshLoopTextarea',
            rows: spec.rows,
            value: text,
            disabled: !writable,
            spellCheck: false,
            'aria-label': spec.label,
            onChange: (event) => {
              const next = event.target.value
              scratch.current[spec.field] = next
              setDrafts(prev => ({ ...prev, [spec.field]: next }))
            },
            onBlur: () => { commitText(spec.field) },
          }),
          createElement('p', { className: 'dshLoopHint' }, spec.hint),
          createElement('div', { className: 'dshLoopControls' },
            createElement('button', {
              className: 'dshLoopButton',
              type: 'button',
              disabled: !writable,
              onClick: () => { void scope.unset(spec.field); revertText(spec.field) },
            }, '恢复内置默认'),
            dirty
              ? createElement('button', {
                className: 'dshLoopButton',
                type: 'button',
                onClick: () => { revertText(spec.field) },
              }, '放弃修改')
              : null,
          ),
        ))
      }

      for (const spec of NUM_FIELDS) {
        rows.push(createElement(NumberRow, {
          key: spec.field,
          spec,
          stored: value[spec.field],
          writable,
          onCommit: (next) => { void scope.set(spec.field, next) },
        }))
      }

      const debugOn = value[F_DEBUG] === true
      rows.push(createElement('div', { className: 'dshLoopRow', key: F_DEBUG },
        createElement('label', { className: 'dshLoopToggle' },
          createElement('input', {
            type: 'checkbox',
            checked: debugOn,
            disabled: !writable,
            onChange: (event) => { void scope.set(F_DEBUG, event.target.checked) },
          }),
          createElement('span', null, 'debug — 把每次判定写进日志'),
        ),
        createElement('p', { className: 'dshLoopHint' },
          '开启后日志出现每次判定的 verdict 与续期计数。这一项需要重启 DSH 才生效;上面的 prompt 与数字改动立即生效。'),
      ))

      return createElement('li', { className: 'dshLoopCard' },
        createElement('div', { className: 'dshLoopHead' },
          createElement('span', { className: 'dshLoopTitle' }, 'Loop Continue — 续跑未完成的轮次'),
          createElement('span', { className: 'dshLoopState' }, ready ? (writable ? '已生效' : '只读') : '加载中'),
        ),
        createElement('p', { className: 'dshLoopIntro' },
          '当模型只叙述了下一步动作却没有调用工具时,这一轮会被判定为未完成并自动续跑。'
          + '下面两项 prompt 是判定策略本体,改完下一次判定即生效,无需重启。'),
        ...rows,
      )
    }

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), `${PLUGIN_ID}: card styles`)

      // The configurable tab dispatches a card only while the Host serves its
      // namespace, so the binding and the slot registration ride one scope.
      ctx.inject(['slots', 'settingsScope'], (scoped) => {
        const scope = scoped.settingsScope.bind({ namespace: NAMESPACE })
        scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
          name: 'settings.plugin.item',
          key: NAMESPACE,
        }, () => createElement(LoopContinueCard, { scope })))
      })
    }

    return { apply, name: PLUGIN_ID, inject: ['slots', 'settingsScope'] }
  },
})
