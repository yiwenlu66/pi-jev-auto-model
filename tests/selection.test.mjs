import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Load the installed entrypoint, with the same isolated HOME/data-URL approach
// as resume.test.mjs. Exercise registered hooks rather than an extracted selector.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-selection-test-"));
const previousHome = process.env.HOME;
const previousFetch = globalThis.fetch;
const previousRandom = Math.random;
process.env.HOME = home;
const agentDir = path.join(home, ".pi/agent");
fs.mkdirSync(agentDir, { recursive: true });
const placeholder = { provider: "jev-auto", id: "auto-jev-subagent" };
const selected = { provider: "fixture", id: "reasoner" };
const alternative = { provider: "fixture", id: "alternative" };
const modelId = `${selected.provider}/${selected.id}`;
const alternativeId = `${alternative.provider}/${alternative.id}`;
const profileUrl = "https://fixture.invalid/profile";
const endpoint = "https://fixture.invalid/jev";
fs.writeFileSync(path.join(agentDir, "jev-auto-model.json"), JSON.stringify({
  endpoint, apiKey: "fixture",
  profiles: { [`${placeholder.provider}/${placeholder.id}`]: { source: "url", url: profileUrl } },
}));
const source = fs.readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const { default: extension } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
after(() => {
  globalThis.fetch = previousFetch;
  Math.random = previousRandom;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const defaultEffort = "Base the effort level on the task's reasoning needs and the per-level criteria for the selected model.";
const effortPrefix = `You already selected the model "${modelId}" for this task. ` +
  "Now pick the thinking/reasoning effort level for the task on that model. ";
const state = "Investigate an ambiguous multi-step reasoning problem.";
function profileFixture() {
  return {
    instructions: "MODEL POLICY: select by price, quota and recent errors.",
    models: {
      [modelId]: {
        when: "MODEL CONTEXT: avoid short sessions; price 99; quota 3%; error 503.",
        levels: { medium: "Straightforward reasoning.", high: "Complex reasoning." },
        default_level: "high",
      },
      [alternativeId]: {
        when: "ALTERNATIVE CONTEXT: cheap short-session route; recent errors 429.",
        levels: { high: "Default." },
      },
    },
    fallback: { model: alternativeId, level: "low" },
  };
}

async function route(profile, { levelChoice = "medium", failEffort = false, spawn = false } = {}) {
  const requests = [];
  const markers = [];
  let profileFetches = 0;
  globalThis.fetch = async (url, options) => {
    if (url === profileUrl) {
      profileFetches++;
      return { ok: true, json: async () => profile };
    }
    assert.equal(url, endpoint);
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.questions.model) {
      return { ok: true, json: async () => ({ answers: { model: {
        choice: modelId, probabilities: { [modelId]: 1 },
      } } }) };
    }
    if (failEffort) throw new Error("fixture effort network failure");
    return { ok: true, json: async () => ({ answers: { level: {
      choice: levelChoice, probabilities: { medium: 1, high: 0 },
    } } }) };
  };
  const hooks = new Map();
  let active = placeholder;
  let level = "off";
  extension({
    on: (name, handler) => hooks.set(name, handler),
    setModel: async (model) => { active = model; return true; },
    setThinkingLevel: (value) => { level = value; },
    getThinkingLevel: () => level,
    appendEntry: (type, data) => markers.push({ type, data }),
  });
  const ctx = {
    get model() { return active; },
    hasUI: false,
    sessionManager: { getEntries: () => [], getBranch: () => [] },
    modelRegistry: { find: (provider, id) => [selected, alternative].find((m) => m.provider === provider && m.id === id) },
  };
  const input = { model: `${placeholder.provider}/${placeholder.id}`, task: state };
  const result = spawn
    ? await hooks.get("tool_call")({ toolName: "subagent_spawn", input }, ctx)
    : await hooks.get("input")({ text: state }, ctx);
  return { requests, markers, profileFetches, active, level, result, input };
}

function assertQuestions({ requests, profileFetches }, profile, effort) {
  assert.equal(profileFetches, 1);
  assert.equal(requests.length, 2);
  // Exact first-question payload: instructions and every model's when stay unchanged.
  assert.deepEqual(requests[0], {
    model: "jev-latest", state,
    questions: { model: { type: "choice", instructions: profile.instructions,
      criteria: Object.fromEntries(Object.entries(profile.models).map(([id, entry]) => [id, entry.when])) } },
  });
  assert.deepEqual(requests[1], {
    model: "jev-latest", state,
    questions: { level: { type: "choice", instructions: effortPrefix + effort,
      criteria: profile.models[modelId].levels } },
  });
  const second = JSON.stringify(requests[1]);
  for (const entry of Object.values(profile.models)) assert.ok(!second.includes(entry.when));
  assert.ok(!second.includes(profile.instructions));
  assert.ok(!second.includes("Model context:"));
}

test("installed first-prompt routing separates model context from dedicated effort policy", async () => {
  const profile = { ...profileFixture(), effort_instructions: "EFFORT POLICY: choose by reasoning difficulty only." };
  const result = await route(profile);
  assertQuestions(result, profile, profile.effort_instructions);
  assert.deepEqual(result.result, { action: "continue" });
  assert.equal(result.active, selected);
  assert.equal(result.level, "medium");
  assert.equal(result.markers.length, 1);
  assert.deepEqual(result.markers[0].data.levelProbs, { medium: 1, high: 0 });
});

test("installed subagent interception uses the same dedicated effort policy", async () => {
  const profile = { ...profileFixture(), effort_instructions: "Use the per-level reasoning criteria." };
  const result = await route(profile, { spawn: true });
  assertQuestions(result, profile, profile.effort_instructions);
  assert.equal(result.input.model, `${modelId}:medium`);
});

for (const [name, value] of Object.entries({ missing: undefined, null: null, empty: "", whitespace: " \n\t ", number: 7, boolean: false, object: {}, array: [] })) {
  test(`legacy/unusable ${name} effort policy uses the neutral default, never when`, async () => {
    const profile = profileFixture();
    if (value !== undefined) profile.effort_instructions = value;
    const result = await route(profile);
    assertQuestions(result, profile, defaultEffort);
    assert.equal(result.active, selected);
    assert.equal(result.level, "medium");
  });
}

test("invalid returned level still uses default_level", async () => {
  const result = await route(profileFixture(), { levelChoice: "invalid" });
  assert.equal(result.level, "high");
});

test("invalid returned level without default_level still uses first level", async () => {
  const profile = profileFixture();
  delete profile.models[modelId].default_level;
  const result = await route(profile, { levelChoice: "invalid" });
  assert.equal(result.level, "medium");
});

test("sampling still selects effort from probabilities instead of the returned choice", async () => {
  const profile = { ...profileFixture(), sampling: true };
  Math.random = () => 0.5;
  try {
    const result = await route(profile, { levelChoice: "high" });
    assertQuestions(result, profile, defaultEffort);
    assert.equal(result.level, "medium");
  } finally {
    Math.random = previousRandom;
  }
});

test("single-level and no-level profiles still skip the effort call", async () => {
  for (const [levels, defaultLevel, expected] of [[{ medium: "Only level." }, "high", "medium"], [{}, "low", "low"], [{}, undefined, "high"]]) {
    const profile = profileFixture();
    profile.models[modelId].levels = levels;
    profile.models[modelId].default_level = defaultLevel;
    const result = await route(profile);
    assert.equal(result.requests.length, 1);
    assert.equal(result.level, expected);
  }
});

test("effort network failure still applies the profile fallback", async () => {
  const result = await route(profileFixture(), { failEffort: true });
  assert.equal(result.active, alternative);
  assert.equal(result.level, "low");
  assert.equal(result.markers[0].data.fallback, true);
});
