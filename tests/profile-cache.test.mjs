import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Exercise one installed extension instance across sessions and concurrent spawns.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-profile-cache-test-"));
const previousHome = process.env.HOME;
const previousFetch = globalThis.fetch;
process.env.HOME = home;
const agentDir = path.join(home, ".pi/agent");
fs.mkdirSync(agentDir, { recursive: true });
const placeholder = { provider: "jev-auto", id: "auto-jev-subagent" };
const placeholderId = `${placeholder.provider}/${placeholder.id}`;
const selected = { provider: "fixture", id: "reasoner" };
const selectedId = `${selected.provider}/${selected.id}`;
const fallback = { provider: "dexgem-responses", id: "gpt-6.1-sol" };
const profileUrl = "https://fixture.invalid/profile";
const endpoint = "https://fixture.invalid/jev";
const profile = {
  instructions: "Select the model.",
  models: { [selectedId]: { when: "Use for this task.", levels: { medium: "Routine.", high: "Hard." } } },
};
const response = () => ({ ok: true, json: async () => profile });
fs.writeFileSync(path.join(agentDir, "jev-auto-model.json"), JSON.stringify({
  endpoint, apiKey: "fixture", profiles: { [placeholderId]: { source: "url", url: profileUrl } },
}));
const source = fs.readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const { default: extension } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
after(() => {
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function fastRetries(t) {
  const pauses = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    pauses.push(delay);
    queueMicrotask(callback);
    return 0;
  });
  return pauses;
}
const flush = () => new Promise(setImmediate);

function router(fetchProfile, onNotice) {
  const hooks = new Map();
  const markers = [];
  let active = placeholder;
  let level = "high";
  let profileFetches = 0;
  let jevCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url === profileUrl) return fetchProfile(++profileFetches);
    assert.equal(url, endpoint);
    jevCalls++;
    const body = JSON.parse(options.body);
    const key = body.questions.model ? "model" : "level";
    const choice = key === "model" ? selectedId : "medium";
    return { ok: true, json: async () => ({ answers: { [key]: { choice, probabilities: { [choice]: 1 } } } }) };
  };
  extension({
    on: (name, handler) => hooks.set(name, handler),
    setModel: async (model) => { active = model; return true; },
    setThinkingLevel: (value) => { level = value; },
    getThinkingLevel: () => level,
    appendEntry: (type, data) => markers.push({ type, data }),
  });
  const ctx = {
    get model() { return active; },
    mode: "json", hasUI: !!onNotice,
    sessionManager: { getEntries: () => [], getBranch: () => [] },
    modelRegistry: { find: (provider, id) => [selected, fallback].find((m) => m.provider === provider && m.id === id) },
    ui: { notify: (...args) => onNotice?.(...args) },
  };
  return {
    get profileFetches() { return profileFetches; },
    get jevCalls() { return jevCalls; },
    markers,
    async session() {
      active = placeholder;
      level = "high";
      await hooks.get("session_start")({ reason: "new" }, ctx);
      const result = await hooks.get("input")({ text: "Implement the task." }, ctx);
      return { active, level, result };
    },
    async spawn() {
      const input = { model: placeholderId, task: "Implement the task." };
      await hooks.get("tool_call")({ toolName: "subagent_spawn", input }, ctx);
      return input;
    },
  };
}

test("three failed profile attempts fall back once; later sessions recover without reload and cache success", async (t) => {
  const pauses = fastRetries(t);
  const instance = router(async (attempt) => {
    if (attempt <= 3) throw new TypeError("fetch failed");
    return response();
  });
  const failed = await instance.session();
  assert.equal(failed.active, fallback);
  assert.equal(failed.level, "high");
  assert.equal(instance.markers[0].data.fallback, true);
  assert.equal(instance.markers[0].data.error, "fetch failed");
  assert.equal(instance.profileFetches, 3, "fallback must not start another profile load");
  assert.equal(instance.jevCalls, 0);
  assert.deepEqual(pauses, [1500, 3000], "existing bounded retries stay unchanged");

  const recovered = await instance.session();
  assert.equal(recovered.active, selected);
  assert.equal(recovered.level, "medium");
  assert.deepEqual(recovered.result, { action: "continue" });
  assert.equal(instance.profileFetches, 4);
  assert.equal(instance.jevCalls, 2);
  assert.equal(instance.markers[1].data.provider, selected.provider);
  assert.equal(instance.markers[1].data.fallback, undefined);

  assert.equal((await instance.session()).active, selected);
  assert.equal(instance.profileFetches, 4, "successful profile stays cached across sessions");
  assert.equal(instance.jevCalls, 4);
});

test("concurrent failed callers share retries; recovery survives older failure handlers and shares a new load", async (t) => {
  const pauses = fastRetries(t);
  let rejectFirst;
  const first = new Promise((resolve, reject) => { rejectFirst = reject; });
  let resolveRecovery;
  const recovery = new Promise((resolve) => { resolveRecovery = resolve; });
  let recovering;
  const instance = router((attempt) => {
    if (attempt === 1) return first;
    if (attempt <= 3) throw new TypeError("fetch failed");
    return recovery;
  }, (message, severity) => {
    // Start the replacement while another caller of the rejected promise is
    // still unwinding. Its failure must not discard this newer cached load.
    if (severity === "warning" && !recovering) recovering = instance.spawn();
  });

  const older = [instance.spawn(), instance.spawn()];
  assert.equal(instance.profileFetches, 1, "in-flight initial load is deduplicated");
  rejectFirst(new TypeError("fetch failed"));
  const failed = await Promise.all(older);
  assert.ok(failed.every((input) => input.model === placeholderId));
  assert.deepEqual(pauses, [1500, 3000]);
  assert.equal(instance.profileFetches, 4, "one replacement starts after the shared three-attempt failure");
  assert.equal(instance.jevCalls, 0);

  const concurrent = instance.spawn();
  await flush();
  assert.equal(instance.profileFetches, 4, "older failure handlers cannot evict the newer in-flight load");
  resolveRecovery(response());
  for (const input of await Promise.all([recovering, concurrent])) {
    assert.equal(input.model, `${selectedId}:medium`);
  }
  assert.equal(instance.jevCalls, 4);
  assert.equal((await instance.spawn()).model, `${selectedId}:medium`);
  assert.equal(instance.profileFetches, 4, "new successful load stays cached");
});
