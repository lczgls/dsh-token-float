
import fs from "node:fs";
const SRC = fs.readFileSync("/home/lou/workspace/tf-work/client.js", "utf8");

const PEAK = Date.parse("2026-11-10T10:00:00+08:00");   // Tuesday 10:00 Asia/Shanghai
const OFF  = Date.parse("2026-11-10T13:00:00+08:00");   // Tuesday 13:00 (lunch gap, off-peak)
let NOW = PEAK;
Date.now = () => NOW;

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const fetchStub = async () => ({ ok: false, status: 404, json: async () => ({}) });
const documentStub = {
  getElementById: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
};
const ReactStub = { createElement: () => ({}), useSyncExternalStore: () => ({}), useCallback: (f) => f, useEffect() {} };

function makeWorld(sharedStore, opts = {}) {
  const ls = sharedStore
    ? {
        getItem: (k) => (sharedStore.has(k) ? sharedStore.get(k) : null),
        setItem: (k, v) => sharedStore.set(k, String(v)),
        removeItem: (k) => sharedStore.delete(k),
      }
    : localStorage;
  let mod = null;
  // Every world but the migration case starts as an already-upgraded install.
  if (!opts.migrate && !ls.getItem("dsh.token-float.migrated.v3")) {
    ls.setItem("dsh.token-float.migrated.v3", JSON.stringify({ at: 0 }));
  }
  const windowStub = { __ModuleLoader__: { load: (m) => { mod = m; } }, localStorage: ls };
  new Function("window", "document", "fetch", "require", SRC)(windowStub, documentStub, fetchStub, (id) => ReactStub);
  if (!mod || mod.id !== "dsh-token-float") throw new Error("module not loaded");

  const world = { ls, sessionId: "s1", running: false, tokenUsage: undefined, timeline: undefined, selections: undefined, status: new Map(), meter: null, disposers: [] };
  const projection = (key) => {
    if (key === "tokenUsage" && world.tokenUsage) return { getSnapshot: () => world.tokenUsage, subscribe: () => () => {} };
    if (key === "contextTimeline" && world.timeline) return { getSnapshot: () => world.timeline, subscribe: () => () => {} };
    if (key === "modelSelection" && world.selections) return { getSnapshot: () => world.selections, subscribe: () => () => {} };
    return undefined;
  };
  const binding = { keyedHooks: { projection }, props: { get sessionId() { return world.sessionId; } } };
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === "function") world.disposers.push(d); },
    locale: { register: () => () => {}, subscribe: () => () => {}, getLocale: () => ({ active: "zh-CN" }) },
    slots: {
      inject: (_name, fn) => fn(),
      register: (config) => { if (config && typeof config.inject === "function") world.meter = config.inject().meter; return () => {}; },
    },
    uiSession: {
      current: { getSnapshot: () => binding, subscribe: () => () => {} },
      sessionStatus: { getSnapshot: () => world.status, subscribe: () => () => {} },
    },
    remote: { account: { getBalance: async () => ({ ok: false }) } },
  };
  const exportsObj = mod.factory((id) => ReactStub);
  exportsObj.apply(ctx);
  if (!world.meter) throw new Error("meter was not registered");
  return world;
}

const snap = (world) => { world.meter.refresh(); return world.meter.getSnapshot(); };
const brief = (s) => ({ total: s.total, cost: Number(s.cost.toFixed(4)), today: Number(s.today.toFixed(4)), model: s.model.name, running: s.running, lastTurn: s.lastTurn });

const results = {};

// A: no contextTimeline -> local estimate, 1M uncached at Tuesday peak
{
  NOW = PEAK;
  const w = makeWorld(new Map());
  w.tokenUsage = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  results.A_local_fallback = brief(snap(w));
  w.disposers.forEach((d) => d());
}

// B: Host attribution wins, mixed peak/off, pro model (shared localStorage for D/F)
const shared = new Map();
let worldB;
{
  NOW = PEAK;
  const w = makeWorld(shared);
  worldB = w;
  w.tokenUsage = { uncachedInputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6, cacheWriteTokens: 0 };
  w.timeline = { cost: { deepseek: { "deepseek-v4-pro": { peak: { uncached: 1e6 }, off: { cacheRead: 1e6, output: 1e6 } } } } };
  results.B_host_attribution = brief(snap(w));
}

// C: Host fold lags the live totals -> fall back even though a timeline exists
{
  NOW = PEAK;
  const w = makeWorld(new Map());
  w.tokenUsage = { uncachedInputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6, cacheWriteTokens: 0 };
  w.timeline = { cost: { deepseek: { "deepseek-flash": { peak: { uncached: 1e6 } } } } };
  results.C_host_lagging = brief(snap(w));
  w.disposers.forEach((d) => d());
}

// D: same Host figure at an off-peak wall clock must not re-price
{
  NOW = OFF;
  results.D_same_figure_offpeak_clock = brief(snap(worldB));
}

// E: a Host delta while running books today and settles lastTurn
{
  NOW = OFF;
  worldB.running = true;
  worldB.status.set("s1", { running: true });
  snap(worldB); // a turn starts: the mark is taken at the pre-turn figure
  worldB.timeline = { cost: { deepseek: { "deepseek-v4-pro": { peak: { uncached: 1e6 }, off: { cacheRead: 1e6, output: 1e6, output_extra: 0 } } } } };
  // grow by exactly 1.0 CNY worth of pro off-peak output: 1.0 / 13.5 * 1e6 tokens
  const extra = Math.round((1 / 13.5) * 1e6);
  worldB.timeline = { cost: { deepseek: { "deepseek-v4-pro": { peak: { uncached: 1e6 }, off: { cacheRead: 1e6, output: 1e6 + extra } } } } };
  worldB.tokenUsage = { uncachedInputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 + extra, cacheWriteTokens: 0 };
  results.E_running_delta = brief(snap(worldB));
  worldB.running = false;
  worldB.status.set("s1", { running: false });
  results.E_turn_settled = brief(snap(worldB));
}

// F: reload the page with the same storage -> no double seeding
{
  NOW = OFF;
  worldB.disposers.forEach((d) => d());
  const w2 = makeWorld(shared);
  w2.tokenUsage = { uncachedInputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 + Math.round((1 / 13.5) * 1e6), cacheWriteTokens: 0 };
  w2.timeline = worldB.timeline;
  results.F_reload_no_double_seed = brief(snap(w2));
  results.storage_day = JSON.parse(shared.get("dsh.token-float.day.v1"));
  w2.disposers.forEach((d) => d());
}

// G: two models in one session -> dominant name plus count; and an empty cost map
{
  NOW = PEAK;
  const w = makeWorld(new Map());
  w.tokenUsage = { uncachedInputTokens: 1e6, cacheReadTokens: 0, outputTokens: 2e6, cacheWriteTokens: 0 };
  w.timeline = { cost: { deepseek: { "deepseek-flash": { peak: { uncached: 1e6 } }, "deepseek-v4-pro": { off: { output: 2e6 } } } } };
  results.G_two_models = brief(snap(w));
  w.timeline = { cost: {} };
  results.G_empty_cost_map = brief(snap(w));
  w.disposers.forEach((d) => d());
}

// H: a session that predates today books only its growth (token path)
{
  NOW = PEAK;
  const store = new Map();
  const w1 = makeWorld(store);
  w1.tokenUsage = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  results.H_day1 = brief(snap(w1));
  w1.disposers.forEach((d) => d());

  NOW = Date.parse("2026-11-11T10:00:00+08:00");
  const w2 = makeWorld(store);
  w2.tokenUsage = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  results.H_next_day_unchanged = brief(snap(w2));
  w2.tokenUsage = { uncachedInputTokens: 2e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  results.H_next_day_growth = brief(snap(w2));
  w2.disposers.forEach((d) => d());
}

// I: same rule on the Host path
{
  NOW = PEAK;
  const store = new Map();
  const w1 = makeWorld(store);
  w1.tokenUsage = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  w1.timeline = { cost: { deepseek: { "deepseek-v4-pro": { peak: { uncached: 1e6 } } } } };
  results.I_day1 = brief(snap(w1));
  w1.disposers.forEach((d) => d());

  NOW = Date.parse("2026-11-11T10:00:00+08:00");
  const w2 = makeWorld(store);
  w2.tokenUsage = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  w2.timeline = { cost: { deepseek: { "deepseek-v4-pro": { peak: { uncached: 1e6 } } } } };
  results.I_next_day_unchanged = brief(snap(w2));
  w2.tokenUsage = { uncachedInputTokens: 2e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  w2.timeline = { cost: { deepseek: { "deepseek-v4-pro": { peak: { uncached: 2e6 } } } } };
  results.I_next_day_growth = brief(snap(w2));
  w2.disposers.forEach((d) => d());
}

// J: the 1.3.0 migration drops an inflated day without booking the history again
{
  NOW = PEAK;
  const store = new Map();
  store.set("dsh.token-float.day.v1", JSON.stringify({ date: "2026-11-10", cost: 94, seeded: { s1: 94 } }));
  const w = makeWorld(store, { migrate: true });
  w.tokenUsage = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  w.timeline = { cost: { deepseek: { "deepseek-flash": { peak: { uncached: 1e6 } } } } };
  results.J_migration = brief(snap(w));
  results.J_storage = JSON.parse(store.get("dsh.token-float.day.v1"));
  w.disposers.forEach((d) => d());
}

// K: crossing between Host and token paths must not double-book
{
  NOW = PEAK;
  const store = new Map();
  const w = makeWorld(store);
  w.tokenUsage = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  w.timeline = { cost: { deepseek: { "deepseek-flash": { peak: { uncached: 1e6 } } } } };
  results.K_host = brief(snap(w));
  w.timeline = undefined;
  snap(w);
  w.tokenUsage = { uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 };
  results.K_local_growth = brief(snap(w));
  w.timeline = { cost: { deepseek: { "deepseek-flash": { peak: { uncached: 1e6, output: 1e6 } } } } };
  results.K_host_back = brief(snap(w));
  w.disposers.forEach((d) => d());
}

console.log(JSON.stringify(results, null, 2));
process.exit(0);
