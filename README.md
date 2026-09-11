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

## Install

Install into a profile with the dsh CLI. Its `plugin` subcommand forwards to
pnpm inside the profile directory, so `add`/`remove` behave as usual:

```sh
dsh plugin --profile <profile> add dsh-loop-continue
```

Then restart the profile. The profile's `package.json` gains the dependency and
`dsh.profile.bundles` entry, and the bundled `cordis.patch.yml` inserts the
guard into the layer stack — no manual patch editing is required.

To remove it:

```sh
dsh plugin --profile <profile> remove dsh-loop-continue
```

Working from a local checkout instead? Point the profile at the directory:

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-loop-continue
```

Source edits under `lib/` are picked up only on restart.

## Config

| field            | default | meaning                                        |
|------------------|---------|------------------------------------------------|
| `maxContinuations` | 10    | hard cap on steering per turn (no infinite loop) |
| `maxSteps`       | 10      | newest steps shown to the judge                |
| `maxTailChars`   | 2000    | trailing-text budget split across the first and last halves |
| `judgeProvider`  | null    | override provider; null/unset = derive from the active default model |
| `judgeModel`     | null    | override model; null/unset = derive from the active default model    |
| `judgeMaxTokens` | 64      | judge output cap                               |
| `judgeTemperature` | 0     | judge sampling temperature                     |
| `judgePrompt`    | built-in | instruction telling the judge what counts as unfinished |
| `steerText`      | built-in | message injected when the guard steers        |
| `debug`          | false   | log every evaluation                          |

## Deterministic gates

No model call runs unless the turn *both*:

1. ended on a text-only step (no tool call), and
2. called at least one tool earlier (so a plain one-shot answer is untouched).

This keeps the extra judge call off ordinary finished turns and only spends it
where the model plausibly dropped a pending action.

## Stopping early

Steering is not free: each continuation costs a judge round-trip plus one more
agent step. So the guard also watches whether a steer *worked*.

When it steers, it records how far the session log had grown. The next time the
same turn stops, it checks whether any assistant step in between actually called
a tool. If the model only narrated again, the steer was ignored and the turn is
closed instead of spending the remaining budget on the same refusal. A model
that answers the steer with a real tool call keeps its normal budget.

## Configuring the guard

The guard resolves its config on every evaluation rather than freezing it at
mount, so a change reaches the very next turn-stopping check. Two ways to set
values:

- the user settings file, `~/.dsh/settings.yaml`, under a `loop-continue:` key, or
- the profile's own `cordis.patch.yml`.

Prefer leaving `judgeProvider`/`judgeModel` unset. The guard then judges with
the model the current conversation is already running, which is by definition a
working route; set them only to judge with a different model on purpose.

## Editing the prompts

Both prompt texts ship as defaults and are plain config fields, so you can
retune the guard without touching code. The editing surface is
`~/.dsh/settings.yaml`:

```yaml
loop-continue:
  judgePrompt: >-
    You inspect one coding-agent turn that just ended. Reply with exactly one
    word: true if the trailing text promises work that no tool call performed,
    false otherwise.
  steerText: >-
    You described an action but did not call any tool. Emit the tool call now.
```

Because the settings section is live, a save there applies to the next
turn-stopping check with **no restart**. The plugin's settings section also
appears on the host side of the Plugins page, but DSH renders a plugin
configuration card only when the plugin ships a browser half; this one is
host-only, so the YAML above is the editing surface.

What each field controls:

- **`judgePrompt`** — the judge's whole decision policy. The judge sees a
  deterministic summary (tool calls per step, trailing text, the human request)
  and must answer one word. Tighten it if the guard steers turns that were
  actually finished; loosen it if it misses dropped actions.
- **`steerText`** — what the model is told when a turn is steered. This is the
  message the model acts on, so phrase it as an instruction to emit the call.

To revert, delete the fields; the built-ins come back.

## Hot mount

`cordis.patch.yml` ships a **plain insert** — only `id` + `name`, no `config`
and no `!!js` expressions — so a market hot-mount can add or remove this plugin
as a minimal row. No user-specific endpoint, provider, or key is baked into the
patch: policy is resolved at runtime as described above.

A patch-layer change is replayed in full on every reload
(`applyEntryPatches` clones the entry list before applying), so a row adds and
removes cleanly and never accumulates.

Whether a patch edit takes effect *without a restart* depends on the host:

- Under the CLI (`dsh profile`), `runProfile` installs an HMR service and
  registers the profile and user patch files with it, so patch edits are applied
  live.
- Under **DSH Desktop 2.0.3** that path is not taken — the desktop shell
  composes the profile itself (`dsh-app-boot` helpers) and never loads
  `cordis-plugin-hmr`, so a `cordis.patch.yml` edit needs a profile restart.

Edits to `lib/*.js` always need a restart: the dsh HMR service is created with
`root: []`, so no source directory is watched for module replacement.
