# Changelog

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
