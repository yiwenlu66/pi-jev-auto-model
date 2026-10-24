import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Isolate the extension's HOME-relative config, state and settings writes.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-resume-test-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
const agentDir = path.join(home, ".pi/agent");
fs.mkdirSync(agentDir, { recursive: true });
const placeholder = { provider: "jev-auto", id: "auto-jev-subagent", reasoning: true };
const selected = { provider: "dexgem-responses", id: "gpt-6.1-sol", reasoning: true };
const switched = { provider: "dexgem-completions", id: "deepseek-flash", reasoning: true };
const defaultSettings = { defaultProvider: placeholder.provider, defaultModel: placeholder.id, defaultThinkingLevel: "high" };
const profilePath = path.join(home, "profile.json");
fs.writeFileSync(profilePath, JSON.stringify({
  instructions: "fixture", models: { [`${selected.provider}/${selected.id}`]: { when: "fixture", levels: { medium: "fixture" } } },
}));
fs.writeFileSync(path.join(agentDir, "jev-auto-model.json"), JSON.stringify({
  endpoint: "https://fixture.invalid/jev", apiKey: "fixture", spawnInterception: false,
  profiles: { [`${placeholder.provider}/${placeholder.id}`]: { path: profilePath } },
}));
// The extension currently uses JS syntax in a .ts entrypoint; loading a data URL
// exercises that exact source on Node 20 too, without a TS loader dependency.
const source = fs.readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const { default: extension } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const previousFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const user = { type: "message", message: { role: "user", content: "original task" } };
const modelChange = (model) => ({ type: "model_change", provider: model.provider, modelId: model.id });
const thinking = (level) => ({ type: "thinking_level_change", thinkingLevel: level });
const assistant = (model, stopReason = "stop") => ({ type: "message", message: { role: "assistant", provider: model.provider, model: model.id, stopReason } });
const original = () => [modelChange(placeholder), thinking("high"), modelChange(selected), thinking("medium"), user];

async function fixture({ branch = original(), all = branch, current = placeholder, level = "high", models = [selected, switched], auth = true } = {}) {
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(defaultSettings));
  const hooks = new Map();
  const calls = { fetch: 0, models: [], levels: [], markers: [], notices: [] };
  let active = current;
  let activeLevel = level;
  globalThis.fetch = async () => {
    calls.fetch++;
    return { ok: true, json: async () => ({ answers: { model: { choice: `${selected.provider}/${selected.id}`, probabilities: { [`${selected.provider}/${selected.id}`]: 1 } } } }) };
  };
  const writeDefaults = (patch) => {
    const p = path.join(agentDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf8")), ...patch }));
  };
  extension({
    on: (name, handler) => hooks.set(name, handler),
    setModel: async (model) => {
      calls.models.push(model);
      if (!auth) return false;
      active = model;
      writeDefaults({ defaultProvider: model.provider, defaultModel: model.id });
      return true;
    },
    setThinkingLevel: (value) => { calls.levels.push(value); activeLevel = active.reasoning ? value : "off"; writeDefaults({ defaultThinkingLevel: activeLevel }); },
    getThinkingLevel: () => activeLevel,
    appendEntry: (type, data) => calls.markers.push({ type, data }),
  });
  const ctx = {
    get model() { return active; },
    mode: "json", hasUI: true,
    sessionManager: { getEntries: () => all, getBranch: () => branch },
    modelRegistry: { find: (provider, id) => models.find((model) => model.provider === provider && model.id === id) },
    ui: { notify: (...notice) => calls.notices.push(notice) },
  };
  await hooks.get("session_start")({ reason: "startup" }, ctx);
  const result = await hooks.get("input")({ text: "continue" }, ctx);
  return { calls, result, active, level: activeLevel, defaults: JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) };
}
function retained(result, model = selected, level = "medium") {
  assert.deepEqual(result.result, { action: "continue" });
  assert.equal(result.active, model);
  assert.equal(result.level, level);
  assert.equal(result.calls.fetch, 0, "resume must not call Jev or fetch profiles");
  assert.equal(result.calls.markers.length, 0, "reuse is not a new routing decision");
  assert.deepEqual(result.defaults, defaultSettings, "setModel/setThinking must not drift global defaults");
}

test("resumed placeholder reuses persisted concrete model and thinking without routing", async () => {
  retained(await fixture());
});
test("failed placeholder assistant cannot erase concrete selection", async () => {
  retained(await fixture({ branch: [...original(), assistant(placeholder, "error")] }));
});
test("newer entries from another branch are excluded", async () => {
  const branch = original();
  retained(await fixture({ branch, all: [...branch, modelChange(switched), thinking("low"), assistant(switched)] }));
});
test("latest manual concrete model and thinking changes win over original route", async () => {
  retained(await fixture({ branch: [...original(), modelChange(switched), thinking("low"), assistant(placeholder, "error")] }), switched, "low");
});
test("retained off thinking level does not fall back to launch high", async () => {
  retained(await fixture({ branch: [...original(), thinking("off")] }), selected, "off");
});
test("successful assistant model records update latest concrete selection like Pi", async () => {
  retained(await fixture({ branch: [...original(), assistant(switched), thinking("low")] }), switched, "low");
});
test("errored concrete assistant is not a successful model switch", async () => {
  retained(await fixture({ branch: [...original(), assistant(switched, "error")] }));
});
test("already concrete resumed model and explicit thinking override remain untouched", async () => {
  const result = await fixture({ current: switched, level: "low" });
  retained(result, switched, "low");
  assert.deepEqual(result.calls.models, []);
  assert.deepEqual(result.calls.levels, []);
});
test("fresh placeholder still performs original first-message routing", async () => {
  const result = await fixture({ branch: [modelChange(placeholder), thinking("high")] });
  assert.equal(result.active, selected);
  assert.equal(result.level, "medium");
  assert.equal(result.calls.fetch, 1);
  assert.equal(result.calls.markers.length, 1);
});
test("resumed history without concrete selection stops explicitly without routing", async () => {
  const result = await fixture({ branch: [modelChange(placeholder), thinking("high"), user, assistant(placeholder, "error")] });
  assert.deepEqual(result.result, { action: "handled" });
  assert.equal(result.calls.fetch, 0);
  assert.deepEqual(result.calls.models, []);
  assert.match(result.calls.notices.at(-1)[0], /no concrete model\/thinking selection/);
});
test("missing persisted thinking does not adopt inherited launch level", async () => {
  const result = await fixture({ branch: [modelChange(selected), user] });
  assert.deepEqual(result.result, { action: "handled" });
  assert.equal(result.calls.fetch, 0);
  assert.deepEqual(result.calls.models, []);
});
test("missing retained registry model stops instead of rerouting or submitting placeholder", async () => {
  const result = await fixture({ models: [] });
  assert.deepEqual(result.result, { action: "handled" });
  assert.equal(result.calls.fetch, 0);
  assert.match(result.calls.notices.at(-1)[0], /not in registry/);
});
test("failed retained-model authentication stops and preserves global defaults", async () => {
  const result = await fixture({ auth: false });
  assert.deepEqual(result.result, { action: "handled" });
  assert.equal(result.calls.fetch, 0);
  assert.deepEqual(result.defaults, defaultSettings);
  assert.match(result.calls.notices.at(-1)[0], /no auth/);
});
