# Changelog

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
