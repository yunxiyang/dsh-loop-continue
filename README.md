# dsh-loop-continue

Continue a DeepSeek Harness agent turn when the model only *narrated* its next
action and forgot the tool call.

The agent loop closes a turn as `completed` the moment a step emits text and no
tool call. A model that writes "now I will re-apply the change" and stops looks
finished to the loop, even though the work is half done.

This plugin listens on `agent/turn-stopping`, replays the current turn's own
session log, and only asks a judge model one strict `true`/`false` question
when the shape matches that failure mode. `true` steers the same turn to run one
more step; `false` (or an unparseable answer) lets the turn close.

## Config

| field            | default | meaning                                        |
|------------------|---------|------------------------------------------------|
| `maxContinuations` | 10    | hard cap on steering per turn (no infinite loop) |
| `maxSteps`       | 10      | newest steps shown to the judge                |
| `maxTailChars`   | 2000    | cap on the trailing assistant text             |
| `judgeProvider`  | null    | override provider; null = follow session route |
| `judgeModel`     | null    | override model; null = follow session route    |
| `judgeMaxTokens` | 64      | judge output cap                               |
| `judgeTemperature` | 0     | judge sampling temperature                     |
| `steerText`      | built-in | message that resumes the turn                |
| `debug`          | false   | log every evaluation                          |

## Deterministic gates

No model call runs unless the turn *both*:

1. ended on a text-only step (no tool call), and
2. called at least one tool earlier (so a plain one-shot answer is untouched).

This keeps the extra judge call off ordinary finished turns and only spends it
where the model plausibly dropped a pending action.
