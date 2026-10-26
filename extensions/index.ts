/**
 * pi-jev-auto-model — route pi sessions to a real model:level via TypeSafe Jev.
 *
 * Design:
 * - Placeholder models (e.g. jev-auto/auto-jev-main, jev-auto/auto-jev-subagent) sit in
 *   models.json. A session that starts on a placeholder gets routed on its first user
 *   message: jev picks the model (choice question over the profile), then picks the
 *   thinking level for that model (second choice question). The selection pins the
 *   session; later manual changes are respected.
 * - Subagent routing happens in the parent: tool_call on subagent_spawn with a
 *   placeholder (or absent) model is resolved against the subagent profile and the
 *   args are mutated to a concrete provider/model:level before dispatch.
 * - pi.setModel persists global defaults; to keep "new sessions start with auto",
 *   the extension remembers what it routed and, on a fresh session, switches back to
 *   the placeholder when the current model matches that drift.
 *
 * Config: ~/.pi/agent/jev-auto-model.json
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MARKER = "jev-auto-model:routed:v1";
const DEFAULT_EFFORT_INSTRUCTIONS = "Base the effort level on the task's reasoning needs and the per-level criteria for the selected model.";
const STATE_FILE = path.join(os.homedir(), ".pi/agent/.jev-auto-state.json");
const CONFIG_PATH = path.join(os.homedir(), ".pi/agent/jev-auto-model.json");

function expandHome(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function resolveSecret(v) {
  if (typeof v !== "string") return v;
  if (v.startsWith("!")) return execSync(v.slice(1), { encoding: "utf8" }).trim();
  if (v.startsWith("$")) return process.env[v.slice(1)] ?? "";
  return v;
}

function loadConfig() {
  const raw = fs.readFileSync(expandHome(CONFIG_PATH), "utf8");
  const cfg = JSON.parse(raw);
  cfg.apiKey = resolveSecret(cfg.apiKey);
  for (const prof of Object.values(cfg.profiles ?? {})) {
    if (prof.auth) prof.auth = resolveSecret(prof.auth);
    if (prof.path) prof.path = expandHome(prof.path);
  }
  return cfg;
}

async function fetchProfile(cfg, profCfg) {
  if (profCfg.source === "url" || profCfg.url) {
    const headers = { "User-Agent": "pi-jev-auto-model/0.1" };
    if (profCfg.auth) {
      if (profCfg.authHeader) headers[profCfg.authHeader] = profCfg.auth;
      else headers["Authorization"] = `Bearer ${profCfg.auth}`;
    }
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(profCfg.url, { headers, signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000) });
        if (!r.ok) throw new Error(`profile fetch ${profCfg.url}: HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
  return JSON.parse(fs.readFileSync(profCfg.path, "utf8"));
}

async function jevAsk(cfg, state, questions) {
  const r = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "pi-jev-auto-model/0.1",
    },
    body: JSON.stringify({ model: cfg.jevModel ?? "jev-latest", state, questions }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000),
  });
  if (!r.ok) throw new Error(`jev HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

/** Weighted sample from a jev probability map; returns null if empty/degenerate. */
function sampleFrom(probs) {
  const entries = Object.entries(probs ?? {}).filter(([, v]) => typeof v === "number" && v > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let r = Math.random() * total;
  for (const [k, v] of entries) { r -= v; if (r <= 0) return k; }
  return entries[entries.length - 1][0];
}

function splitModelId(full) {
  const i = full.indexOf("/");
  if (i < 0) throw new Error(`profile model id must be provider/model, got ${full}`);
  return { provider: full.slice(0, i), modelId: full.slice(i + 1) };
}

/**
 * Hierarchical selection: model first, then thinking level for that model.
 * Returns { provider, modelId, level, modelProbs, levelProbs }.
 */
async function jevSelect(cfg, profile, state) {
  const maxChars = cfg.stateMaxChars ?? 6000;
  const truncated = state.length > maxChars ? state.slice(0, maxChars) + "\n[…truncated]" : state;

  const modelCriteria = {};
  for (const [id, m] of Object.entries(profile.models)) modelCriteria[id] = m.when;
  const a1 = await jevAsk(cfg, truncated, {
    model: { type: "choice", instructions: profile.instructions, criteria: modelCriteria },
  });
  const modelProbs = a1.answers.model.probabilities;
  const chosenId = (profile.sampling === true && sampleFrom(modelProbs)) || a1.answers.model.choice;
  const entry = profile.models[chosenId];
  if (!entry) throw new Error(`jev returned model not in profile: ${chosenId}`);

  const levelIds = Object.keys(entry.levels ?? {});
  let level, levelProbs = null;
  if (levelIds.length === 0) {
    level = entry.default_level ?? "high";
  } else if (levelIds.length === 1) {
    level = levelIds[0];
  } else {
    const effortInstructions = typeof profile.effort_instructions === "string" && profile.effort_instructions.trim()
      ? profile.effort_instructions.trim() : DEFAULT_EFFORT_INSTRUCTIONS;
    const instr = `You already selected the model "${chosenId}" for this task. ` +
      `Now pick the thinking/reasoning effort level for the task on that model. ` +
      effortInstructions;
    const a2 = await jevAsk(cfg, truncated, {
      level: { type: "choice", instructions: instr, criteria: entry.levels },
    });
    levelProbs = a2.answers.level.probabilities;
    level = (profile.sampling === true && sampleFrom(levelProbs)) || a2.answers.level.choice;
    if (!entry.levels[level]) level = entry.default_level ?? levelIds[0];
  }
  return { ...splitModelId(chosenId), level, modelProbs, levelProbs };
}

function topProbs(probs, n = 3) {
  if (!probs) return "";
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(" ");
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function writeState(patch) {
  const s = { ...readState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function hasUserHistory(ctx) {
  return ctx.sessionManager.getEntries().some(
    (e) => e.type === "message" && e.message.role === "user",
  );
}
function alreadyRouted(ctx) {
  return ctx.sessionManager.getEntries().some(
    (e) => e.type === "custom" && e.customType === MARKER,
  );
}

export default function (pi) {
  let cfg = null;
  const profileCache = new Map();
  let pending = null;
  let defaultsAtStart = null; // { provider, model, thinking } captured at session_start
  // pi-subagents marks child sessions; never drift-repair inside a child.
  const isChild = !!process.env.PI_SUBAGENT_EXTENSION_BINDINGS;

  const log = (msg) => process.stderr.write(`[jev-auto] ${msg}\n`);
  const getCfg = () => (cfg ??= loadConfig());
  const getProfile = async (placeholderId) => {
    if (!profileCache.has(placeholderId)) {
      profileCache.set(placeholderId, fetchProfile(getCfg(), getCfg().profiles[placeholderId]));
    }
    return profileCache.get(placeholderId);
  };
  const isPlaceholder = (model) =>
    model && getCfg().profiles?.[`${model.provider}/${model.id}`] !== undefined;

  /** Apply a resolved selection to the current session. */
  const applySelection = async (ctx, placeholderId, sel) => {
    const model = ctx.modelRegistry.find(sel.provider, sel.modelId);
    if (!model) throw new Error(`model ${sel.provider}/${sel.modelId} not in registry`);
    if (!(await pi.setModel(model))) throw new Error(`no auth for ${sel.provider}/${sel.modelId}`);
    pi.setThinkingLevel(sel.level);
    const effective = pi.getThinkingLevel();
    pi.appendEntry(MARKER, {
      placeholder: placeholderId,
      provider: sel.provider, modelId: sel.modelId, level: effective,
      modelProbs: sel.modelProbs, levelProbs: sel.levelProbs, at: new Date().toISOString(),
    });
    writeState({ lastRouting: { placeholder: placeholderId, provider: sel.provider, modelId: sel.modelId } });
    restoreDefaultFile();
    if (ctx.hasUI) {
      ctx.ui.notify(
        `jev routed ${placeholderId} → ${sel.provider}/${sel.modelId}:${effective}  (${topProbs(sel.modelProbs)})`,
        "info",
      );
    }
    log(`routed ${placeholderId} -> ${sel.provider}/${sel.modelId}:${effective} | ${topProbs(sel.modelProbs)}`);
  };

  const applyFallback = async (ctx, placeholderId, profile, err) => {    const fb = profile?.fallback ?? { model: "dexgem-responses/gpt-6.1-sol", level: "high" };
    const { provider, modelId } = splitModelId(fb.model);
    const model = ctx.modelRegistry.find(provider, modelId);
    if (model && (await pi.setModel(model))) {
      pi.setThinkingLevel(fb.level ?? "high");
      pi.appendEntry(MARKER, { placeholder: placeholderId, fallback: true, error: String(err) });
      restoreDefaultFile();
    }
    if (ctx.hasUI) ctx.ui.notify(`jev routing failed (${err}); fell back to ${fb.model}:${fb.level ?? "high"}`, "warning");
    log(`routing failed: ${err}; fallback ${fb.model}`);
  };

  /** setModel/setThinkingLevel persist global defaults; restore pre-routing defaults in the file. */
  const restoreDefaultFile = () => {
    try {
      if (!defaultsAtStart) return;
      const p = path.join(os.homedir(), ".pi/agent/settings.json");
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
    if (s.defaultProvider === defaultsAtStart.provider && s.defaultModel === defaultsAtStart.model &&
        (!defaultsAtStart.thinking || s.defaultThinkingLevel === defaultsAtStart.thinking)) return;
      s.defaultProvider = defaultsAtStart.provider;
      s.defaultModel = defaultsAtStart.model;
      if (defaultsAtStart.thinking) s.defaultThinkingLevel = defaultsAtStart.thinking;
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
    } catch (e) { log(`restoreDefaultFile failed: ${e}`); }
  };

  // --- New sessions start on the auto placeholder (repair default drift caused by setModel) ---
  pi.on("session_start", async (event, ctx) => {
    try {
      cfg = loadConfig();
      try {
        const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/settings.json"), "utf8"));
        defaultsAtStart = { provider: s.defaultProvider, model: s.defaultModel, thinking: s.defaultThinkingLevel };
      } catch {}
      if (isChild) return;
      // Only interactive sessions: in print/json mode an explicit --model must win.
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
      if ((event.reason !== "new" && event.reason !== "startup") || hasUserHistory(ctx)) return;
      const st = readState();
      const last = st.lastRouting;
      if (!last || !ctx.model) return;
      if (ctx.model.provider === last.provider && ctx.model.id === last.modelId) {
        const ph = splitModelId(last.placeholder);
        const placeholder = ctx.modelRegistry.find(ph.provider, ph.modelId);
        if (placeholder) {
          await pi.setModel(placeholder);
          if (ctx.hasUI) ctx.ui.notify(`new session: model reset to ${last.placeholder} (jev will route on first prompt)`, "info");
        }
      }
    } catch (e) { log(`session_start drift-repair failed: ${e}`); }
  });

  // --- Main-session routing on first user message ---
  pi.on("input", async (event, ctx) => {
    try {
      if (!ctx.model || !isPlaceholder(ctx.model)) return { action: "continue" };
      const placeholderId = `${ctx.model.provider}/${ctx.model.id}`;
      const branch = ctx.sessionManager.getBranch();
      if (branch.some((e) => e.type === "message" && e.message.role === "user")) {
        // Async runners may pass the launch placeholder/level again on resume,
        // overriding Pi's native session restore. Reuse active-branch state;
        // a failed placeholder response must not replace a concrete selection.
        try {
          let retainedModel = null;
          let retainedLevel = null;
          for (const entry of branch) {
            if (entry.type === "thinking_level_change") retainedLevel = entry.thinkingLevel;
            const candidate = entry.type === "model_change"
              ? { provider: entry.provider, id: entry.modelId }
              : entry.type === "message" && entry.message.role === "assistant" &&
                  ["stop", "length", "toolUse"].includes(entry.message.stopReason)
                ? { provider: entry.message.provider, id: entry.message.model }
                : null;
            if (candidate && candidate.provider && candidate.id && !isPlaceholder(candidate)) {
              retainedModel = candidate;
            }
          }
          if (!retainedModel || retainedLevel === null) {
            throw new Error("no concrete model/thinking selection in the active session branch");
          }
          const model = ctx.modelRegistry.find(retainedModel.provider, retainedModel.id);
          if (!model) throw new Error(`retained model ${retainedModel.provider}/${retainedModel.id} not in registry`);
          try {
            if (!(await pi.setModel(model))) throw new Error(`no auth for ${model.provider}/${model.id}`);
            pi.setThinkingLevel(retainedLevel);
          } finally {
            restoreDefaultFile();
          }
          log(`retained ${model.provider}/${model.id}:${pi.getThinkingLevel()} on resume (no routing)`);
          return { action: "continue" };
        } catch (err) {
          const message = `cannot resume ${placeholderId}: ${err?.message ?? err}; select a concrete model explicitly`;
          log(message);
          if (ctx.hasUI) ctx.ui.notify(message, "error");
          return { action: "handled" };
        }
      }
      if (hasUserHistory(ctx) || alreadyRouted(ctx)) return { action: "continue" };

      pending ??= (async () => {
        const profile = await getProfile(placeholderId);
        const sel = await jevSelect(getCfg(), profile, event.text);
        await applySelection(ctx, placeholderId, sel);
      })();
      try {
        await pending;
      } catch (err) {
        const profile = await getProfile(placeholderId).catch(() => null);
        await applyFallback(ctx, placeholderId, profile, err?.message ?? err);
      } finally {
        pending = null;
      }
      return { action: "continue" };
    } catch (err) {
      log(`input hook error: ${err}`);
      return { action: "continue" };
    }
  });

  // --- Subagent routing: resolve placeholder/absent model on subagent_spawn ---
  // (parent-side interception; disable with "spawnInterception": false to rely on
  // child-side first-prompt routing in async/runner-host children)
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent_spawn") return;
    try {
      if (getCfg().spawnInterception === false) return;
      const args = event.input ?? {};
      const subId = Object.keys(getCfg().profiles ?? {}).find((k) => k.includes("subagent"));
      if (!subId) return;
      const raw = typeof args.model === "string" ? args.model : "";
      const baseModel = raw.split(":")[0];
      const hasConcrete = raw && !getCfg().profiles[baseModel];
      if (hasConcrete) return; // main agent override: leave explicit concrete models alone
      if (!raw && getCfg().interceptAbsentModel === false) return;

      const state = typeof args.task === "string" ? args.task : JSON.stringify(args).slice(0, 4000);
      const profile = await getProfile(subId);
      const sel = await jevSelect(getCfg(), profile, state);
      args.model = `${sel.provider}/${sel.modelId}:${sel.level}`;
      const note = `jev routed subagent (${args.agent ?? "blank"}) → ${args.model}  (${topProbs(sel.modelProbs)})`;
      if (ctx.hasUI) ctx.ui.notify(note, "info");
      log(note);
    } catch (err) {
      // Failure must not block dispatch: leave args.model untouched (role default applies).
      log(`subagent routing failed: ${err?.message ?? err}`);
      if (ctx.hasUI) ctx.ui.notify(`jev subagent routing failed: ${err?.message ?? err}`, "warning");
    }
  });
}
