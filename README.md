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
| `steerText`      | built-in | message that resumes the turn                |
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

- the harness **Settings UI** (the plugin installs a `loop-continue` section), or
- the profile's own `cordis.patch.yml`.

Prefer leaving `judgeProvider`/`judgeModel` unset. The guard then derives a
registered route from the active default model, which always resolves; a
hand-written route can name a provider the LLM service does not have registered,
and the judge call then fails.

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
