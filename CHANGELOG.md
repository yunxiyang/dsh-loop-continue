# Changelog

## 0.2.3

### Fixed

- **The steering message carries a producer-owned source kind again.** Session
  format v4 refuses `{ kind: 'plugin', plugin: name }` on persist — the host's
  own admission rule, enforced over every declared message slot — so each
  steering message was rejected and, because the record is appended from a
  step hook, the refusal failed the whole turn with
  `format v4 message requires a producer-owned source kind`. The message now
  claims the source kind `plugin:loop-continue`, which is the kind the v3 to v4
  migration derives for this plugin, so records written before the upgrade
  still answer to the same name.

## 0.2.2

### Added

- The judge call's self-contained shape is now stated, tested, and documented.
  It always was self-contained — `system` is `judgePrompt`, `messages` is one
  `renderSummary(...)` user message, no `tools`, no replayed history — but
  nothing said so, and reusing the session context is an attractive-looking
  change now that prefix caching is visible. It is not one: the host's
  incremental `Session.deriveMessages` does make such a prefix hit, yet the
  saving is the miss on roughly 1–2k tokens while the verdict is the plugin's
  whole output, and the call would lose determinism, focus, and a cost that
  tracks the turn rather than the session. A comment on `judge()`, the test
  `sends the judge a self-contained request`, and a README section now hold
  that line; both mutations that would cross it (adding `tools`, replaying
  history) fail the test.

- `npm run build` copies `src/` to `lib/`, and `npm run check` fails when the
  two differ. The tests exercise `src/` while npm publishes `lib/`, and nothing
  derived one from the other at install time, so a forgotten copy would have
  shipped stale code behind a green test run. `prepublishOnly` runs the check
  and the tests.

- A CI workflow runs the sync check, the tests, and a pack assertion on every
  push and pull request.

### Fixed

- **The settings card works on dsh 0.1.7 and its edits are saved.** 0.1.7
  removed the `settingsScope` service and the `settings.plugin.item` slot it
  hung off; a configuration is now addressed by Loader ENTRY ID through the
  `configForms` service, and a third-party bundle seats its card in
  `plugins.row.config` under `<package name>#<row id>`. Both are now checked
  for at runtime rather than declared, so the plugin mounts on either line.

  The write path was the subtler half. The host does not pass the
  `configForms` controller into `plugins.row.config` — it passes its own
  adapter, which carries the controller's snapshot as `state` plus a `mutate`
  and has no `getSnapshot`, `subscribe` or `set`. Wrapping that adapter is
  what lets a card read and write at all, and `settingsScopeOf` now wraps it
  when only an adapter is offered, while handing a real controller straight
  through. The adapter has no `unset`, so the wrap supplies one as
  `mutate([{ op: 'unset', path: [field] }])` — the shape the controller's own
  `unset` uses.

- **The settings card's edits are accepted on dsh 0.2.0-rc.1.** Its `Config`
  schema carried no `meta.volatile`, so the host refused every write with
  `Plugin entry "loop-continue" has no volatile fields` (or
  `Config field "<field>" is not volatile`) and the card could only report that
  the value had not been accepted. The schema is now marked volatile at the
  root with `.extra('volatile', true)`, which is what the host actually reads —
  `Schema.prototype.volatile()` is that same call behind a double-wrap guard,
  and the profile's pinned schemastery predates neither behavior, so the
  explicit form keeps the intent visible. One root flag covers every field,
  including the `maxContinuations`/`maxSteps` a profile patch injects.

- The host-provided peers now admit the 0.2 line. `^0.1.1-rc.2` excluded
  `0.2.0-rc.1` for the same node-semver reason the pinned dev dependencies
  record: a prerelease is admitted only inside its own `major.minor.patch`
  tuple, so the range that shipped with 0.2.0 rejected the host it was written
  for and pnpm reported unmet peers at install time. All three are now
  `^0.1.1-rc.2 || ^0.2.0-rc.1`, which accepts the 0.2.0-rc.1 host and still
  refuses `0.3.0-rc.1`, so one published version serves both lines.

- The dev dependencies are pinned exactly. The host-provided peers were only
  reachable as ranges no registry resolution can satisfy: node-semver admits a
  prerelease only inside its own `major.minor.patch` tuple, so `^0.1.1-rc.2`
  excludes `0.1.5-rc.2`.

### Changed

- A rejected write is now visible. The controller's `mutate` returns `false`
  when the host refuses an edit instead of throwing, so with every call site
  written as `void scope.set(...)` a refusal looked exactly like a stale
  render: the card kept showing the old value and nothing was reported. Each
  write now reports its outcome and the card prints a line when one is not
  accepted.

- `maxSteps` defaults to `6` (was 10) and `maxTailChars` to `1500` (was 2000).
  The verdict turns on the last text-only step and on whether an earlier step
  already performed the action that step names, so a few steps is the useful
  window; the rest lengthen the prompt without informing the answer, and a
  promise usually sits in the opening clause and is restated at the end, which
  is what the two-ended truncation reads.

  Two tests pin the defaults on the two paths that consume them — the schema's
  `.default()` and `resolveConfig`'s `??` fallback. Neither covers the other,
  and changing the constants back fails both.

## 0.2.0

### Added

- **A settings card under Settings > Plugins > plugin config.** The package now
  ships a browser half (`lib/client.js`, discovered through
  `dsh.client.platform: "web"` plus the `./client` export), so the judge policy
  and the steering message are editable in the GUI instead of only in
  `~/.dsh/settings.yaml`. Both surfaces write the same namespace.

- The hand-written bundle is a plain `window.__ModuleLoader__.load` closure
  factory, so the package still ships no build step and no client dependencies
  of its own — `react` arrives through the injected `require` table.

- The card starts collapsed and opens from its header, restating the built-in
  plugin cards' tokens, radii, and paddings so it reads as one of them. The
  chevron is inlined rather than imported: the primitives package that ships it
  belongs to the web app's own bundle and is not a module a third-party client
  bundle may require.

### Changed

- Prompt textareas commit on blur. The Host validates and persists the whole
  settings document per write, so committing a 740-character policy on every
  keystroke would issue one write per character. Numbers and the toggle still
  commit immediately.

- Every default is exported (`DEFAULT_MAX_CONTINUATIONS`, `DEFAULT_MAX_STEPS`,
  `DEFAULT_MAX_TAIL_CHARS`, `DEFAULT_JUDGE_MAX_TOKENS`,
  `DEFAULT_JUDGE_TEMPERATURE`) and used as the single source for both the schema
  and the fallback paths.

## 0.1.3

### Fixed

- **The plugin failed to load on any host with a settings service.** The
  settings section was registered with only a `setSource` hook, but
  `installSection` calls `hooks.onChange()` unconditionally and `scope.watch()`
  calls it again. The resulting `TypeError: hooks.onChange is not a function`
  was thrown from inside the plugin fiber, so `apply` aborted and the guard
  never registered at all — no steering, no log line beyond the stack trace.
  0.1.1 and 0.1.2 are affected; upgrade.

- **A settings-section failure no longer fails the plugin.** The install call is
  wrapped, so a cosmetic registration problem cannot take down the guard.

## 0.1.2

### Added

- **`judgePrompt` config field.** The judge's instruction was hardcoded; it now
  ships as a default and can be replaced per deployment, so the decision policy
  is tunable without a code change. `DEFAULT_JUDGE_PROMPT` and
  `DEFAULT_STEER_TEXT` are exported for reference.
- **Prompt editing documented.** Both prompt texts live in
  `~/.dsh/settings.yaml` under `loop-continue:` and, because the guard resolves
  config per evaluation, a save applies to the next turn-stopping check with no
  restart.

### Fixed

- README described `judgeProvider`/`judgeModel` as deriving from the global
  default-model setting. The guard follows the current conversation's own
  provider/model instead.

## 0.1.1

### Fixed

- **Judge route leaked a literal `null` provider.** With `judgeProvider` absent
  the guard tested `!== undefined`, so a `null` in the profile config was passed
  straight to the LLM service as `{ provider: null, model: null }`. The service
  reports an unknown provider through an error *finish chunk* rather than a
  throw, so the call failed silently, the judge read an empty answer, and every
  turn logged `verdict=false`. The guard now treats `null` and unset alike and
  follows the conversation's own provider/model.
- **A judge failure was invisible.** An error finish chunk is now surfaced as
  `judge failed: ...` instead of being parsed as a `false` verdict.
- **Steering could burn the whole per-turn budget on the same refusal.** The
  guard now records the session-log position at each steer and checks whether
  any step in between actually called a tool. A steer the model ignored ends the
  turn instead of spending the remaining budget.

### Changed

- **Configuration is resolved per evaluation** rather than frozen at mount, so
  a change reaches the next turn-stopping check without a restart.
- **A Settings section is installed** (namespace `loop-continue`) for live
  reconfiguration from the harness Settings UI.
- `judgeProvider`/`judgeModel` at `null` or unset both mean "follow the
  conversation's route"; the judge no longer derives a route from the global
  default-model setting.

## 0.1.0

Initial release: continue a turn whose trailing text promised an action that no
tool call performed.
