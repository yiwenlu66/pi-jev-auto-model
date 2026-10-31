# pi-jev-auto-model

Automatic model + thinking-level selection for [Pi](https://github.com/badlogic/pi-mono)
sessions, routed by [TypeSafe Jev](https://docs.typesafe.ai/) — a System One decision model
that answers typed questions (`choice`/`noul`/`score`) with probabilities instead of
generating prose.

## What it does

You add **placeholder models** (e.g. `jev-auto/auto-jev-main`) to your pi model catalog and
start sessions on them. The extension does the rest:

1. You send the **first prompt** of a session.
2. The extension sends the prompt to jev as `state`, with a `choice` question whose criteria
   come from a **profile**: one entry per candidate model describing *when to use it*.
3. jev picks a model; the extension asks jev a **second** choice question — which thinking
   level, with dedicated effort instructions and per-level criteria from the profile
   (**hierarchical selection**). Model-routing context is used only in the first question.
4. The session is switched to the selected `model:level` and stays there. Later prompts are
   not re-routed; manual `/model` changes are respected.
5. On your next new session, the model is reset to the auto placeholder (pi's `setModel`
   persists global defaults; the extension repairs that drift and restores your defaults file).

Subagent routing works from the parent session: a `subagent_spawn` tool call whose `model`
is a placeholder (or absent) is resolved against the subagent profile and rewritten to a
concrete `provider/model:level` before dispatch. An explicit concrete `model=` passed by the
main agent always wins.

Routing adds ~1–2 s (two jev calls) to the **first** prompt only. Each decision costs
fractions of a cent (jev input ≈ $0.04/Mtok, output free).

## Install

Add the package to `~/.pi/agent/settings.json`:

```json
"packages": ["git:github.com/yiwenlu66/pi-jev-auto-model"]
```

Then `/reload` (or restart pi). Alternatively, clone anywhere and symlink the extension:

```sh
git clone https://github.com/yiwenlu66/pi-jev-auto-model ~/.pi/agent/git/github.com/yiwenlu66/pi-jev-auto-model
mkdir -p ~/.pi/agent/extensions/jev-auto-model
ln -s ~/.pi/agent/git/github.com/yiwenlu66/pi-jev-auto-model/extensions/index.ts \
      ~/.pi/agent/extensions/jev-auto-model/index.ts
```

## Configure

### 1. Placeholder models in `~/.pi/agent/models.json`

```json
"providers": {
  "jev-auto": {
    "baseUrl": "https://api.typesafe.ai/v1",
    "apiKey": "!cat ~/.pi/agent/.memory/local/typesafe-api-key",
    "api": "openai-responses",
    "models": [
      { "id": "auto-jev-main", "reasoning": true, "contextWindow": 920000, "maxTokens": 128000,
        "input": ["text", "image"], "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
      { "id": "auto-jev-subagent", "reasoning": true, "contextWindow": 920000, "maxTokens": 128000,
        "input": ["text", "image"], "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
    ]
  }
}
```

Placeholders are never actually called — the extension routes before the first request.
(`baseUrl` just needs to be syntactically valid.)

### 2. `~/.pi/agent/jev-auto-model.json`

```json
{
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "apiKey": "!cat ~/.pi/agent/.memory/local/typesafe-api-key",
  "jevModel": "jev-latest",
  "timeoutMs": 15000,
  "stateMaxChars": 6000,
  "profiles": {
    "jev-auto/auto-jev-main":     { "source": "file", "path": "~/.pi/agent/jev-profiles/main.json" },
    "jev-auto/auto-jev-subagent": { "source": "file", "path": "~/.pi/agent/jev-profiles/subagent.json" }
  }
}
```

`apiKey` accepts a literal, `"$ENV_VAR"`, or `"!shell command"`. A profile source can also be
a URL (`{ "source": "url", "url": "https://…", "auth": "!…" }`) — e.g. a relay-hosted profile
that injects live prices, quota and error statistics into the criteria hourly. By default the
auth value is sent as `Authorization: Bearer <auth>`; set `"authHeader": "x-my-token-header"` to
send it under a custom header name instead.

### 3. Profiles

A profile is the whole routing policy, as data. See `examples/profile.example.json`:

```json
{
  "version": 1, "kind": "jev-model-profile", "name": "my-main",
  "instructions": "You are selecting the LLM for the main agent session. …",
  "effort_instructions": "Choose effort based on the task's reasoning needs and the per-level criteria.",
  "models": {
    "anthropic/claude-sonnet-4-5": {
      "when": "Default for substantive coding work. …",
      "levels": { "high": "Default.", "max": "Hardest reasoning." },
      "default_level": "high"
    }
  },
  "fallback": { "model": "anthropic/claude-sonnet-4-5", "level": "high" }
}
```

- `instructions` — the model-selection jev question only. State what matters (task difficulty,
  session length, cost posture).
- `models.<provider>/<model>.when` — the model-selection criterion jev scores. This is where
  model personalities, prices, quotas, and error statistics belong. Keep each entry 2–4 sentences.
  Neither `instructions` nor `when` is included in the effort question.
- `effort_instructions` — optional top-level string appended to the second question as dedicated
  effort-selection policy, after the selected model is fixed. Keep model-routing context out of
  this field and `levels`. Missing, non-string, empty, or whitespace-only values use the neutral
  built-in instruction: "Base the effort level on the task's reasoning needs and the per-level
  criteria for the selected model." Older profiles work unchanged; `when` is never a fallback.
- `levels` — per-model thinking-level criteria (second jev question). One level = no second call.
- `fallback` — used when jev or the network fails; the session still works.
- `sampling` — optional, default `false`. When `true`, the **model** is sampled from jev's
  probability distribution instead of argmax: a fan-out of similar subagent tasks spreads
  across suitable models instead of all landing on the same pick. The **thinking level is
  never sampled** — it is always jev's argmax. Spreading model choices populates the
  per-(role, model) rating cells the feedback loop scores; ratings are not keyed by effort,
  so a sampled level would add no measurable evidence while it silently changed how much
  the model reasons (a 0.10 mass on `off` can drop a thinking task to no reasoning at all).

Model ids must exist in your `models.json` as `provider/model-id`.

## Behavior notes

- **First prompt only.** Detection: no prior user messages in the session and no routing
  marker. Resumed/forked sessions with history are never re-routed.
- **Resume continuity.** If a runner reopens a conversation on its original placeholder,
  the extension restores the latest concrete model and thinking level from the active
  session branch before the next request, without calling jev. Native model-change and
  successful assistant records are used; failed placeholder responses and other branches
  cannot overwrite the selection. A concrete active model (including an explicit override)
  is left alone. If the saved selection is missing or unavailable, input stops with an
  explicit error asking you to select a concrete model.
- **Failure policy.** jev/network errors fall back to the profile's `fallback` model — the
  prompt is never lost. If the profile cannot be loaded, the built-in fallback is used.
  Failed profile loads are evicted after their retries; the next routing attempt retries without
  restarting Pi. Fallback handling does not refetch the failed profile. Concurrent callers share
  an in-flight load, and successful profiles remain cached for the process lifetime.
  Subagent routing failure leaves the spawn untouched (role default).
- **Transparency.** Each routing posts a UI notification with the top-3 probabilities and
  appends a session entry (`jev-auto-model:routed:v1`) with full probabilities.
- **Defaults repair.** pi's `setModel` writes global defaults; after routing, the extension
  restores `settings.json`'s `defaultProvider/defaultModel` and resets fresh interactive
  sessions back to the placeholder.

## Tests

Run `npm test` for isolated resume-continuity, first-prompt routing, model/effort
policy-separation, and profile-cache recovery regressions.
The tests use temporary configuration and stub network calls; they require no credentials.

## License

MIT
