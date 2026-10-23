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
   level, with per-level criteria from the profile (**hierarchical selection**).
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

```sh
# clone into pi's global git packages (or anywhere) and link the extension
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
that injects live prices, quota and error statistics into the criteria hourly.

### 3. Profiles

A profile is the whole routing policy, as data. See `examples/profile.example.json`:

```json
{
  "version": 1, "kind": "jev-model-profile", "name": "my-main",
  "instructions": "You are selecting the LLM for the main agent session. …",
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

- `instructions` — the top-level jev question. State what matters (task difficulty, session
  length, cost posture).
- `models.<provider>/<model>.when` — the criterion jev scores. This is where model
  personalities, prices, and quotas belong. Keep each entry 2–4 sentences.
- `levels` — per-model thinking-level criteria (second jev question). One level = no second call.
- `fallback` — used when jev or the network fails; the session still works.

Model ids must exist in your `models.json` as `provider/model-id`.

## Behavior notes

- **First prompt only.** Detection: no prior user messages in the session and no routing
  marker. Resumed/forked sessions with history are never re-routed.
- **Failure policy.** jev/network errors fall back to the profile's `fallback` model — the
  prompt is never lost. Subagent routing failure leaves the spawn untouched (role default).
- **Transparency.** Each routing posts a UI notification with the top-3 probabilities and
  appends a session entry (`jev-auto-model:routed:v1`) with full probabilities.
- **Defaults repair.** pi's `setModel` writes global defaults; after routing, the extension
  restores `settings.json`'s `defaultProvider/defaultModel` and resets fresh interactive
  sessions back to the placeholder.

## License

MIT
