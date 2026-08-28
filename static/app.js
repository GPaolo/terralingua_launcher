/* TerraLingua launcher UI. Plain JS, no build step (same approach as viz/). */

"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  settings: null,
  schema: null,
  values: {}, // param name -> value (only user-touched entries)
  personas: [],
  artifacts: [],
  prompts: null, // originals from the target repo
  design: null, // last designer result
  designHistory: [], // snapshots taken before each refinement, for undo
  refineLog: [], // the feedback strings, shown as chips
  procs: [],
  logProcId: null,
  logOffset: 0,
  configPaths: {}, // name -> path for saved-config loading
};

/* ---------------- helpers ---------------- */

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}
const GET = (url) => api("GET", url);
const POST = (url, body) => api("POST", url, body);

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), isErr ? 6000 : 3000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

/* ---------------- params ---------------- */

function allParams() {
  return (state.schema?.groups || []).flatMap((g) => g.params);
}
function paramByName(name) {
  return allParams().find((p) => p.name === name);
}

function currentValue(p) {
  return p.name in state.values ? state.values[p.name] : p.default;
}

function isChanged(p) {
  if (!(p.name in state.values)) return false;
  const v = state.values[p.name];
  if (v === null || v === "" || v === undefined) return false;
  if (Array.isArray(p.default) || Array.isArray(v)) {
    return JSON.stringify(v) !== JSON.stringify(p.default);
  }
  return v !== p.default;
}

function setValue(name, value) {
  const p = paramByName(name);
  if (value === "" || value === null || value === undefined ||
      (p && !Array.isArray(value) && value === p.default)) {
    delete state.values[name];
  } else {
    state.values[name] = value;
  }
  onValuesChanged();
}

const persistValues = debounce(() => {
  POST("/api/state", { last_values: state.values }).catch(() => {});
}, 800);

const refreshPreview = debounce(async () => {
  try {
    const r = await POST("/api/preview", {
      values: state.values,
      resume: $("#opt-resume").checked,
    });
    $("#cmd-preview").textContent = r.cmd;
  } catch (e) { /* schema not ready */ }
}, 350);

function onValuesChanged() {
  persistValues();
  refreshPreview();
  // cheap re-style without a full rebuild
  for (const row of $$(".param")) {
    const p = paramByName(row.dataset.name);
    if (p) row.classList.toggle("changed", isChanged(p));
  }
  for (const g of state.schema?.groups || []) {
    const badge = $(`#gbadge-${g.key}`);
    if (badge) {
      const n = g.params.filter(isChanged).length;
      badge.textContent = n ? `${n} changed` : "";
    }
  }
}

const WIDE_PARAMS = new Set([
  "exp_name", "exp_description", "personas", "init_artifacts",
  "prompt_templates", "save_root", "model", "agents_name_prefix",
]);

function makeControl(p) {
  const val = currentValue(p);
  if (p.type === "bool") {
    const input = el("input", {
      type: "checkbox",
      onchange: (e) => setValue(p.name, e.target.checked),
    });
    input.checked = !!val;
    return el("span", { class: "switch" }, input, el("span", { class: "track" }));
  }
  if (p.choices && p.choices.length) {
    const sel = el("select", { onchange: (e) => setValue(p.name, e.target.value) });
    for (const c of p.choices) sel.append(el("option", { value: c }, String(c)));
    sel.value = String(val ?? p.choices[0]);
    return sel;
  }
  if ((p.type === "int" || p.type === "float") && !p.nargs && !p.autocoerce) {
    const input = el("input", {
      type: "number",
      step: p.type === "int" ? "1" : "any",
      onchange: (e) => {
        const raw = e.target.value;
        if (raw === "") return setValue(p.name, "");
        const n = p.type === "int" ? parseInt(raw, 10) : parseFloat(raw);
        setValue(p.name, Number.isNaN(n) ? "" : n);
      },
    });
    input.value = val === null || val === undefined ? "" : val;
    input.placeholder = p.default === null ? "" : String(p.default);
    return input;
  }
  // strings, nargs lists and autocoerced values: free text
  const input = el("input", {
    type: "text",
    class: WIDE_PARAMS.has(p.name) ? "wide" : "",
    onchange: (e) => setValue(p.name, e.target.value),
    spellcheck: "false",
  });
  if (p.name === "model" && state.schema.extras?.model_suggestions) {
    input.setAttribute("list", "model-suggestions");
  }
  const display = Array.isArray(val) ? val.join(" ") : val;
  input.value = display === null || display === undefined ? "" : display;
  input.placeholder = Array.isArray(p.default)
    ? p.default.join(" ")
    : p.default === null ? "—" : String(p.default);
  return input;
}

function renderParams() {
  const root = $("#param-groups");
  root.textContent = "";
  const schema = state.schema;
  if (!schema || schema.errors?.length && !schema.groups?.length) {
    root.append(el("div", { class: "empty" },
      "Could not read the parameter schema: " + (schema?.errors || []).join("; ")));
    return;
  }
  if (schema.extras?.model_suggestions && !$("#model-suggestions")) {
    const dl = el("datalist", { id: "model-suggestions" });
    for (const m of schema.extras.model_suggestions) dl.append(el("option", { value: m }));
    document.body.append(dl);
  }
  for (const g of schema.groups) {
    const card = el("div", { class: "group", "data-group": g.key },
      el("h2", {}, g.title, el("span", { class: "badge", id: `gbadge-${g.key}` })));
    for (const p of g.params) {
      const row = el("div", { class: "param" + (isChanged(p) ? " changed" : ""), "data-name": p.name },
        el("span", { class: "dot" }),
        el("label", { for: `param-${p.name}` }, p.name),
        el("button", {
          class: "info", "aria-label": `About ${p.name}`, tabindex: "0",
          onmouseenter: (e) => showTip(e.currentTarget, p),
          onmouseleave: hideTip,
          onfocus: (e) => showTip(e.currentTarget, p),
          onblur: hideTip,
          onclick: (e) => e.preventDefault(),
        }, "i"),
        makeControl(p),
        el("button", {
          class: "reset", title: "Reset to default",
          onclick: () => { delete state.values[p.name]; renderParams(); onValuesChanged(); },
        }, "↺"));
      card.append(row);
    }
    root.append(card);
  }
  applyParamFilter();
  onValuesChanged();
}

function applyParamFilter() {
  const q = $("#param-search").value.trim().toLowerCase();
  const changedOnly = $("#changed-only").checked;
  for (const row of $$(".param")) {
    const p = paramByName(row.dataset.name);
    const hit = !q || p.name.includes(q) || (p.help || "").toLowerCase().includes(q);
    row.style.display = hit && (!changedOnly || isChanged(p)) ? "" : "none";
  }
  for (const card of $$(".group")) {
    const any = Array.from(card.querySelectorAll(".param")).some((r) => r.style.display !== "none");
    card.style.display = any ? "" : "none";
  }
}

function showTip(target, p) {
  const tip = $("#tooltip");
  tip.textContent = "";
  tip.append(el("span", { class: "t-name" }, p.name));
  tip.append(document.createTextNode(p.help || "(no description)"));
  const def = Array.isArray(p.default) ? p.default.join(" ") : JSON.stringify(p.default);
  tip.append(el("span", { class: "t-default" },
    `default: ${def}` + (p.choices ? ` · choices: ${p.choices.join(", ")}` : "")));
  tip.classList.remove("hidden");
  const r = target.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = Math.min(r.left, window.innerWidth - tw - 12);
  let y = r.bottom + 8;
  if (y + th > window.innerHeight - 8) y = r.top - th - 8;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { $("#tooltip").classList.add("hidden"); }

/* ---------------- saved configs ---------------- */

async function refreshConfigs() {
  try {
    const r = await GET("/api/configs");
    const sel = $("#config-select");
    sel.textContent = "";
    sel.append(el("option", { value: "" }, "Load saved config…"));
    state.configPaths = {};
    for (const c of r.configs) {
      state.configPaths[c.path] = c;
      sel.append(el("option", { value: c.path }, `${c.name}  (${c.saved_at || ""})`));
    }
  } catch (e) { /* repo may be unset */ }
}

async function loadConfig(path) {
  try {
    const r = await GET(`/api/file?path=${encodeURIComponent(path)}`);
    const data = JSON.parse(r.content);
    state.values = data.values || {};
    $("#opt-viz").checked = !!data.launch_viz;
    $("#opt-resume").checked = !!data.resume;
    $("#config-name").value = data.name || "";
    renderParams();
    await restoreEditorsFromValues();
    toast(`Loaded config "${data.name || path}"`);
  } catch (e) {
    toast(`Could not load config: ${e.message}`, true);
  }
}

/* ---------------- personas editor ---------------- */

function normalizePersona(entry) {
  if (typeof entry === "string") return { persona: entry, name: "", role: "", count: 1 };
  return {
    persona: String(entry.persona ?? ""),
    name: String(entry.name ?? ""),
    role: String(entry.role ?? ""),
    count: entry.count || 1,
  };
}

function exportPersonas() {
  return state.personas
    .filter((p) => p.persona.trim())
    .map((p) => {
      const out = { persona: p.persona.trim() };
      if (p.name.trim()) out.name = p.name.trim();
      if (p.role.trim()) out.role = p.role.trim();
      if (+p.count > 1) out.count = +p.count;
      return out;
    });
}

function renderPersonas() {
  const root = $("#personas-list");
  root.textContent = "";
  if (!state.personas.length) {
    root.append(el("div", { class: "empty" }, "No personas — beings start with none. Add one, load a file, or let the Scenario AI write them."));
  }
  state.personas.forEach((p, i) => {
    const card = el("div", { class: "card" },
      el("div", { class: "card-head" }, `persona ${i + 1}`,
        el("span", { class: "spacer" }),
        el("button", { class: "icon-btn", title: "Duplicate", onclick: () => { state.personas.splice(i + 1, 0, { ...p }); renderPersonas(); } }, "⧉"),
        el("button", { class: "icon-btn del", title: "Remove", onclick: () => { state.personas.splice(i, 1); renderPersonas(); } }, "✕")),
      el("textarea", {
        rows: "3", placeholder: "You are a cautious healer. You …",
        oninput: (e) => { p.persona = e.target.value; },
      }, p.persona),
      el("div", { class: "row" },
        el("label", {}, "name (optional)", el("input", { type: "text", value: p.name, placeholder: "drawn at random", oninput: (e) => { p.name = e.target.value; } })),
        el("label", {}, "role (optional)", el("input", { type: "text", value: p.role, placeholder: "e.g. healer", oninput: (e) => { p.role = e.target.value; } })),
        el("label", {}, "count", el("input", { type: "number", min: "1", value: p.count, oninput: (e) => { p.count = e.target.value; updatePersonaTotals(); } }))));
    root.append(card);
  });
  updatePersonaTotals();
}

function updatePersonaTotals() {
  const total = state.personas.reduce((n, p) => n + (parseInt(p.count, 10) || 1), 0);
  $("#personas-count").textContent = total || "";
  const initAgents = currentValue(paramByName("init_agents") || { default: null, name: "init_agents" });
  $("#personas-total").textContent = total
    ? `${total} being${total === 1 ? "" : "s"} covered · init_agents = ${initAgents ?? "?"}`
    : "";
}

/* ---------------- artifacts editor ---------------- */

function normalizeArtifact(a) {
  return {
    name: String(a.name ?? ""),
    type: a.type || "text",
    payload: String(a.payload ?? ""),
    placement: a.pose ? "pose" : a.agent ? "agent" : a.role ? "role" : "random",
    pose: Array.isArray(a.pose) ? a.pose.slice(0, 2) : [0, 0],
    agent: String(a.agent ?? ""),
    role: String(a.role ?? ""),
    lifespan: a.lifespan ?? -1,
    step: a.step ?? 0,
    heal_probability: a.heal_probability ?? 0.2,
    hazard_multiplier: a.hazard_multiplier ?? 1.0,
    radius: a.radius ?? 1,
  };
}

// a cleared number input holds ""; fall back to the engine default
function num(v, dflt) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

function exportArtifacts() {
  return state.artifacts
    .filter((a) => a.name.trim())
    .map((a) => {
      const out = { name: a.name.trim(), type: a.type };
      if (a.payload.trim()) out.payload = a.payload.trim();
      if (a.placement === "pose") out.pose = [Math.trunc(num(a.pose[0], 0)), Math.trunc(num(a.pose[1], 0))];
      if (a.placement === "agent" && a.agent.trim()) {
        out.agent = a.agent.trim();
        // the engine supports both: seeded only if the named being holds the role
        if (a.role.trim()) out.role = a.role.trim();
      }
      if (a.placement === "role" && a.role.trim()) out.role = a.role.trim();
      const lifespan = Math.trunc(num(a.lifespan, -1));
      if (lifespan !== -1) out.lifespan = lifespan;
      const step = Math.trunc(num(a.step, 0));
      if (step !== 0) out.step = step;
      if (a.type === "health_center") {
        out.heal_probability = num(a.heal_probability, 0.2);
        out.hazard_multiplier = num(a.hazard_multiplier, 1.0);
        out.radius = Math.max(0, Math.trunc(num(a.radius, 1)));
      }
      return out;
    });
}

function renderArtifacts() {
  const root = $("#artifacts-list");
  root.textContent = "";
  if (!state.artifacts.length) {
    root.append(el("div", { class: "empty" }, "No seeded artifacts. Add one, load a file, or let the Scenario AI write them."));
  }
  state.artifacts.forEach((a, i) => {
    const placementInputs = () => {
      if (a.placement === "pose") {
        return el("div", { class: "row" },
          el("label", {}, "x", el("input", { type: "number", value: a.pose[0], oninput: (e) => { a.pose[0] = e.target.value; } })),
          el("label", {}, "y", el("input", { type: "number", value: a.pose[1], oninput: (e) => { a.pose[1] = e.target.value; } })));
      }
      if (a.placement === "agent") {
        return el("div", { class: "row" },
          el("label", {}, "into the inventory of being (tag or name)",
            el("input", { type: "text", value: a.agent, placeholder: "being0 or Miriam", oninput: (e) => { a.agent = e.target.value; } })),
          el("label", {}, "required role (optional)",
            el("input", { type: "text", value: a.role, placeholder: "only if they hold it", oninput: (e) => { a.role = e.target.value; } })));
      }
      if (a.placement === "role") {
        return el("div", { class: "row" },
          el("label", {}, "into every being with persona role",
            el("input", { type: "text", value: a.role, placeholder: "healer", oninput: (e) => { a.role = e.target.value; } })));
      }
      return null;
    };
    const card = el("div", { class: "card" },
      el("div", { class: "card-head" }, `artifact ${i + 1}`,
        el("span", { class: "spacer" }),
        el("button", { class: "icon-btn", title: "Duplicate", onclick: () => { state.artifacts.splice(i + 1, 0, JSON.parse(JSON.stringify(a))); renderArtifacts(); } }, "⧉"),
        el("button", { class: "icon-btn del", title: "Remove", onclick: () => { state.artifacts.splice(i, 1); renderArtifacts(); } }, "✕")),
      el("div", { class: "row" },
        el("label", {}, "name", el("input", { type: "text", value: a.name, placeholder: "welcome_stone", oninput: (e) => { a.name = e.target.value; } })),
        el("label", {}, "type", (() => {
          const sel = el("select", { onchange: (e) => { a.type = e.target.value; if (a.type === "health_center") a.placement = a.placement === "pose" ? "pose" : "random"; renderArtifacts(); } });
          for (const t of ["text", "ppe", "health_center"]) sel.append(el("option", { value: t }, t));
          sel.value = a.type;
          return sel;
        })())),
      a.type === "text"
        ? el("textarea", { rows: "2", placeholder: "Inscription other beings can read…", oninput: (e) => { a.payload = e.target.value; } }, a.payload)
        : null,
      el("div", { class: "row" },
        el("label", {}, "placement", (() => {
          const sel = el("select", { onchange: (e) => { a.placement = e.target.value; renderArtifacts(); } });
          const opts = a.type === "health_center"
            ? [["random", "random free cell"], ["pose", "map position"]]
            : [["random", "random free cell"], ["pose", "map position"], ["agent", "being inventory"], ["role", "role inventories"]];
          for (const [v, t] of opts) sel.append(el("option", { value: v }, t));
          sel.value = a.placement;
          return sel;
        })()),
        el("label", {}, "lifespan (−1 ∞)", el("input", { type: "number", value: a.lifespan, oninput: (e) => { a.lifespan = e.target.value; } })),
        el("label", {}, "appears at step", el("input", { type: "number", min: "0", value: a.step, oninput: (e) => { a.step = e.target.value; } }))),
      placementInputs(),
      a.type === "health_center"
        ? el("div", { class: "row" },
            el("label", {}, "heal probability", el("input", { type: "number", step: "0.05", min: "0", max: "1", value: a.heal_probability, oninput: (e) => { a.heal_probability = e.target.value; } })),
            el("label", {}, "hazard ×", el("input", { type: "number", step: "0.1", min: "0", value: a.hazard_multiplier, oninput: (e) => { a.hazard_multiplier = e.target.value; } })),
            el("label", {}, "radius", el("input", { type: "number", min: "0", value: a.radius, oninput: (e) => { a.radius = e.target.value; } })))
        : null);
    root.append(card);
  });
  $("#artifacts-count").textContent = state.artifacts.length || "";
}

/* ---------------- files (load/save editors) ---------------- */

async function fillFileSelect(kind, selectId) {
  try {
    const r = await GET(`/api/files?kind=${kind}`);
    const sel = $(selectId);
    const keep = sel.options[0];
    sel.textContent = "";
    sel.append(keep);
    for (const f of r.files) sel.append(el("option", { value: f }, f));
  } catch (e) { /* ignore */ }
}

async function loadJsonFile(path) {
  const r = await GET(`/api/file?path=${encodeURIComponent(path)}`);
  return JSON.parse(r.content);
}

async function saveEditorFile(kind) {
  const isPersonas = kind === "personas";
  const pathInput = $(isPersonas ? "#personas-path" : "#artifacts-path");
  const path = pathInput.value.trim() ||
    (isPersonas ? "launcher_configs/personas.json" : "launcher_configs/init_artifacts.json");
  pathInput.value = path;
  const data = isPersonas ? exportPersonas() : exportArtifacts();
  try {
    const r = await POST("/api/file", { path, content: JSON.stringify(data, null, 2) });
    setValue(isPersonas ? "personas" : "init_artifacts", r.path);
    renderParams();
    toast(`Saved ${r.path} and set --${isPersonas ? "personas" : "init_artifacts"}`);
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  }
}

async function restoreEditorsFromValues() {
  const pPath = state.values.personas;
  if (pPath) {
    try {
      state.personas = (await loadJsonFile(pPath)).map(normalizePersona);
      $("#personas-path").value = pPath;
    } catch (e) { /* stale path */ }
  }
  const aPath = state.values.init_artifacts;
  if (aPath) {
    try {
      state.artifacts = (await loadJsonFile(aPath)).map(normalizeArtifact);
      $("#artifacts-path").value = aPath;
    } catch (e) { /* stale path */ }
  }
  renderPersonas();
  renderArtifacts();
}

/* ---------------- scenario designer ---------------- */

let designerLoaded = false;
async function initScenarioTab() {
  if (designerLoaded) return;
  designerLoaded = true;
  // usable immediately; the slow litellm catalogue only feeds the datalist
  $("#designer-model").value = state.settings?.last_model || "claude-opus-5";
  try {
    state.prompts = await GET("/api/prompts");
    $("#sys-original").textContent = state.prompts.sys_prompt || "(not found in target repo)";
    $("#step-original").textContent = state.prompts.agent_prompt || "(not found in target repo)";
  } catch (e) { /* shown on design */ }
  try {
    const r = await GET("/api/designer/models");
    const dl = $("#designer-models");
    dl.textContent = "";
    for (const m of r.models) dl.append(el("option", { value: m }));
    // never clobber what the user typed while the catalogue loaded
    if (!$("#designer-model").value) $("#designer-model").value = r.default || "claude-opus-5";
    const found = Object.entries(r.keys).filter(([, v]) => v).map(([k]) => k);
    $("#designer-hint").textContent = found.length
      ? `Detected in environment: ${found.join(", ")} — the list shows only models those keys can reach (any other model can still be typed, with its key pasted). Keys are used per call, never stored.`
      : "No API key detected in the environment or the repo's .env — paste one for the model's provider. Used for this call only, never stored.";
  } catch (e) { /* ignore */ }
}

function designRequestBody() {
  return {
    description: $("#scenario-desc").value.trim(),
    model: $("#designer-model").value.trim(),
    api_key: $("#designer-key").value,
    personas: exportPersonas(),
    artifacts: exportArtifacts(),
    values: state.values,
  };
}

// the design as it stands on screen — manual textarea edits included
function currentDesign() {
  return {
    sys_prompt: $("#sys-adapted").value,
    agent_prompt: $("#step-adapted").value,
    personas: state.design?.personas || [],
    init_artifacts: state.design?.init_artifacts || [],
    suggested_params: state.design?.suggested_params || [],
    design_notes: state.design?.design_notes || "",
  };
}

async function runDesign() {
  const desc = $("#scenario-desc").value.trim();
  if (!desc) return toast("Describe the scenario first", true);
  const btn = $("#design-btn");
  btn.disabled = true;
  $("#design-status").classList.remove("hidden");
  $("#design-status").textContent = `Asking ${$("#designer-model").value} to design the scenario — this can take a minute…`;
  try {
    const r = await POST("/api/design", designRequestBody());
    state.design = r.result;
    state.designHistory = [];
    state.refineLog = [];
    renderRefineLog();
    showDesign(r.result, r.issues);
    toast("Scenario designed — review, edit, refine, then save the bundle");
  } catch (e) {
    toast(`Design failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    $("#design-status").classList.add("hidden");
  }
}

async function runRefine() {
  const feedback = $("#refine-input").value.trim();
  if (!feedback) return toast("Say what to change first", true);
  if (!state.design) return;
  const btn = $("#refine-btn");
  btn.disabled = true;
  $("#design-status").classList.remove("hidden");
  $("#design-status").textContent = `Refining with ${$("#designer-model").value}…`;
  const before = currentDesign();
  try {
    const r = await POST("/api/design", {
      ...designRequestBody(),
      feedback,
      current: before,
    });
    state.designHistory.push(before);
    state.refineLog.push(feedback);
    state.design = r.result;
    showDesign(r.result, r.issues);
    $("#refine-input").value = "";
    renderRefineLog();
    toast("Design refined");
  } catch (e) {
    toast(`Refine failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    $("#design-status").classList.add("hidden");
  }
}

function refineUndo() {
  if (!state.designHistory.length) return;
  state.design = state.designHistory.pop();
  state.refineLog.pop();
  showDesign(state.design, []);
  renderRefineLog();
  toast("Restored the previous version");
}

function renderRefineLog() {
  const log = $("#refine-log");
  log.textContent = "";
  state.refineLog.forEach((f, i) => {
    log.append(el("span", { class: "chip", title: f }, `v${i + 2}: ${f}`));
  });
  $("#refine-undo").classList.toggle("hidden", !state.designHistory.length);
}

function showDesign(d, issues) {
  $("#design-result").classList.remove("hidden");
  $("#design-notes").textContent = d.design_notes || "";
  const issuesEl = $("#design-issues");
  issuesEl.classList.toggle("hidden", !issues.length);
  issuesEl.textContent = "";
  if (issues.length) {
    const ul = el("ul");
    for (const i of issues) ul.append(el("li", {}, i));
    issuesEl.append(ul);
  }
  $("#sys-adapted").value = d.sys_prompt || "";
  $("#step-adapted").value = d.agent_prompt || "";
  $("#design-personas").textContent = JSON.stringify(d.personas, null, 2);
  $("#design-artifacts").textContent = JSON.stringify(d.init_artifacts, null, 2);
  const chips = $("#design-params");
  chips.textContent = "";
  if (!d.suggested_params.length) chips.append(el("span", { class: "hint" }, "none suggested"));
  for (const s of d.suggested_params) {
    const chip = el("span", { class: "pchip" },
      el("code", {}, `${s.name} = ${JSON.stringify(s.value)}`),
      el("span", { class: "why" }, s.why || ""),
      el("button", {
        onclick: (e) => {
          setValue(s.name, s.value);
          renderParams();
          chip.classList.add("applied");
          e.target.textContent = "✓ applied";
        },
      }, "apply"));
    chips.append(chip);
  }
  if (!$("#bundle-name").value) {
    $("#bundle-name").value = $("#scenario-desc").value.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").split("_").slice(0, 4).join("_");
  }
  $("#design-result").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveBundle() {
  if (!state.design) return;
  try {
    const r = await POST("/api/bundle", {
      name: $("#bundle-name").value,
      sys_prompt: $("#sys-adapted").value,
      agent_prompt: $("#step-adapted").value,
      personas: state.design.personas,
      init_artifacts: state.design.init_artifacts,
    });
    if (r.paths.personas) setValue("personas", r.paths.personas);
    if (r.paths.init_artifacts) setValue("init_artifacts", r.paths.init_artifacts);
    if (r.paths.prompt_templates) {
      if (state.prompts?.supports_override) {
        setValue("prompt_templates", r.paths.prompt_templates);
      } else {
        toast("Saved, but this TerraLingua version has no --prompt_templates parameter; prompts saved for manual use", true);
      }
    }
    renderParams();
    await restoreEditorsFromValues();
    toast(`Scenario bundle saved to ${r.dir} and wired into the launch form`);
  } catch (e) {
    toast(`Bundle save failed: ${e.message}`, true);
  }
}

function downloadBundle() {
  if (!state.design) return;
  const files = {
    "prompt_templates.json": JSON.stringify(
      { sys_prompt: $("#sys-adapted").value, agent_prompt: $("#step-adapted").value }, null, 2),
    "personas.json": JSON.stringify(state.design.personas, null, 2),
    "init_artifacts.json": JSON.stringify(state.design.init_artifacts, null, 2),
  };
  for (const [name, content] of Object.entries(files)) {
    const a = el("a", {
      href: URL.createObjectURL(new Blob([content], { type: "application/json" })),
      download: name,
    });
    document.body.append(a);
    a.click();
    a.remove();
  }
}

/* ---------------- console / processes ---------------- */

function fmtUptime(startedAt) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
  return s < 60 ? `${s}s` : s < 3600 ? `${(s / 60) | 0}m ${s % 60}s` : `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m`;
}

function renderProcs() {
  const root = $("#proc-list");
  root.textContent = "";
  if (!state.procs.length) {
    root.append(el("div", { class: "empty" }, "Nothing launched yet."));
  }
  for (const p of state.procs) {
    const statusClass = p.status === "running" ? "running" : p.status.startsWith("exited") ? "exited" : "stopped";
    const glyph = statusClass === "running" ? "●" : statusClass === "exited" ? "⚠" : "▪";
    root.append(el("div", { class: "card" },
      el("div", { class: "card-head" },
        el("b", {}, p.kind === "viz" ? "📊 " + p.label : "🌍 " + p.label),
        el("span", { class: `proc-status ${statusClass}` }, `${glyph} ${p.status}`),
        el("span", { class: "spacer" }),
        p.status === "running" ? el("span", { class: "hint" }, fmtUptime(p.started_at)) : null),
      el("code", { class: "hint", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", title: p.cmd }, p.cmd),
      el("div", { class: "row" },
        el("button", { onclick: () => { state.logProcId = p.id; state.logOffset = 0; $("#log-view").textContent = ""; syncLogSelect(); } }, "view log"),
        p.status === "running" ? el("button", { class: "danger-ghost", onclick: () => stopProc(p.id, false) }, "stop") : null,
        p.status === "running" ? el("button", { class: "danger-ghost", onclick: () => stopProc(p.id, true) }, "force kill") : null)));
  }
  syncLogSelect();
}

function syncLogSelect() {
  const sel = $("#log-select");
  sel.textContent = "";
  for (const p of state.procs) {
    sel.append(el("option", { value: p.id }, `#${p.id} ${p.kind} — ${p.label}`));
  }
  if (state.logProcId === null && state.procs.length) state.logProcId = state.procs[0].id;
  if (state.logProcId !== null) sel.value = String(state.logProcId);
}

async function stopProc(id, force) {
  try {
    await POST(`/api/procs/${id}/stop?force=${force}`, {});
    toast(force ? "Killed" : "Stop signal sent");
  } catch (e) {
    toast(e.message, true);
  }
}

async function pollProcs() {
  try {
    const r = await GET("/api/procs");
    state.procs = r.procs;
    const running = r.procs.filter((p) => p.status === "running");
    const sims = running.filter((p) => p.kind === "sim");
    const chip = $("#run-chip");
    if (sims.length) {
      chip.classList.remove("hidden", "dead");
      chip.textContent = `${sims.map((p) => p.label).join(", ")} running`;
    } else {
      chip.classList.add("hidden");
    }
    $("#console-badge").textContent = running.length || "";
    $("#console-badge").classList.toggle("live", running.length > 0);
    const vizLink = $("#viz-link");
    vizLink.classList.toggle("hidden", !r.viz_up);
    vizLink.href = `http://127.0.0.1:${state.settings?.viz_port || 8000}`;
    if ($("#tab-console").classList.contains("active")) renderProcs();
  } catch (e) { /* server restarting */ }
}

let logBusy = false;
async function pollLog() {
  if (logBusy) return; // a response slower than the tick must not double-append
  if (!$("#tab-console").classList.contains("active") || state.logProcId === null) return;
  logBusy = true;
  const procId = state.logProcId;
  try {
    const r = await GET(`/api/procs/${procId}/log?offset=${state.logOffset}`);
    if (state.logProcId !== procId) return; // user switched logs mid-flight
    if (r.text) {
      state.logOffset = r.offset;
      const view = $("#log-view");
      view.textContent += r.text;
      if (view.textContent.length > 400000) view.textContent = view.textContent.slice(-300000);
      if ($("#log-follow").checked) view.scrollTop = view.scrollHeight;
    }
    $("#log-status").textContent = r.status;
  } catch (e) { /* ignore */ } finally {
    logBusy = false;
  }
}

/* ---------------- launch ---------------- */

async function launch() {
  const btn = $("#launch-btn");
  btn.disabled = true;
  // open synchronously inside the click so popup blockers allow it; the
  // real URL is filled in once the server answers
  const vizWin = $("#opt-viz").checked ? window.open("", "_blank") : null;
  try {
    const r = await POST("/api/launch", {
      values: state.values,
      resume: $("#opt-resume").checked,
      launch_viz: $("#opt-viz").checked,
    });
    toast(`Launched ${r.proc.label} (pid log #${r.proc.id})`);
    state.logProcId = r.proc.id;
    state.logOffset = 0;
    $("#log-view").textContent = "";
    switchTab("console");
    await pollProcs();
    if (r.viz && vizWin) {
      const delay = r.viz.started ? 1500 : 0;
      setTimeout(() => { vizWin.location = r.viz.url; }, delay);
    } else if (vizWin) {
      vizWin.close();
    }
  } catch (e) {
    if (vizWin) vizWin.close();
    toast(`Launch failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function saveConfig() {
  const name = $("#config-name").value.trim();
  if (!name) return toast("Give the config a name first", true);
  try {
    const r = await POST("/api/configs", {
      name,
      values: state.values,
      launch_viz: $("#opt-viz").checked,
      resume: $("#opt-resume").checked,
    });
    toast(`Saved ${r.path}`);
    refreshConfigs();
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  }
}

/* ---------------- header / settings / tabs ---------------- */

function renderHeader() {
  const s = state.settings;
  const repoName = s.repo.split("/").filter(Boolean).pop();
  const chip = $("#target-chip");
  chip.textContent = `${s.repo_ok ? "" : "⚠ "}${repoName} · ${s.python.split("/").slice(-3).join("/")}`;
  chip.style.color = s.repo_ok && s.python_ok ? "" : "var(--status-critical)";
  const keys = $("#key-chips");
  const chipName = (k) => k === "AWS_BEARER_TOKEN_BEDROCK"
    ? "bedrock" : k.replace("_API_KEY", "").toLowerCase();
  keys.textContent = "";
  for (const [k, on] of Object.entries(s.keys || {})) {
    keys.append(el("span", { class: `chip ${on ? "on" : ""}`, title: on ? `${k} detected` : `${k} not set` },
      `${on ? "✓" : "·"} ${chipName(k)}`));
  }
}

function switchTab(name) {
  for (const t of $$(".tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of $$(".tabpane")) p.classList.toggle("active", p.id === `tab-${name}`);
  if (name === "scenario") initScenarioTab();
  if (name === "console") renderProcs();
}

function hookPathCompletion(inputSel, listId, dirsOnly) {
  const input = $(inputSel);
  const dl = el("datalist", { id: listId });
  document.body.append(dl);
  input.setAttribute("list", listId);
  input.addEventListener("input", debounce(async () => {
    try {
      const r = await GET(`/api/fs?prefix=${encodeURIComponent(input.value)}&dirs_only=${dirsOnly}`);
      dl.textContent = "";
      for (const p of r.paths) dl.append(el("option", { value: p }));
    } catch (e) { /* completion is best-effort */ }
  }, 150));
}

function openSettings() {
  const s = state.settings;
  $("#set-repo").value = s.repo;
  $("#set-python").value = s.python;
  $("#set-vizport").value = s.viz_port;
  $("#settings-error").classList.add("hidden");
  $("#settings-modal").showModal();
}

async function saveSettings() {
  try {
    state.settings = await POST("/api/settings", {
      repo: $("#set-repo").value.trim(),
      python: $("#set-python").value.trim(),
      viz_port: parseInt($("#set-vizport").value, 10) || 8000,
    });
    $("#settings-modal").close();
    renderHeader();
    await loadSchema(true);
    // everything else derived from the repo is stale now too
    refreshConfigs();
    fillFileSelect("personas", "#personas-files");
    fillFileSelect("artifacts", "#artifacts-files");
    designerLoaded = false;
    state.prompts = null;
    if ($("#tab-scenario").classList.contains("active")) initScenarioTab();
  } catch (e) {
    const err = $("#settings-error");
    err.textContent = e.message;
    err.classList.remove("hidden");
  }
}

async function loadSchema(refresh = false) {
  try {
    state.schema = await GET(`/api/schema${refresh ? "?refresh=1" : ""}`);
  } catch (e) {
    state.schema = { groups: [], errors: [e.message] };
  }
  renderParams();
}

/* ---------------- boot ---------------- */

async function boot() {
  const theme = localStorage.getItem("tl-launcher-theme");
  if (theme) document.documentElement.dataset.theme = theme;

  state.settings = await GET("/api/settings").catch(() => null);
  if (state.settings) {
    state.values = state.settings.last_values || {};
    renderHeader();
  }

  $("#theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme === "light" ? "" : "light";
    if (cur) document.documentElement.dataset.theme = cur;
    else delete document.documentElement.dataset.theme;
    localStorage.setItem("tl-launcher-theme", cur);
  });
  $("#target-chip").addEventListener("click", openSettings);
  $("#settings-cancel").addEventListener("click", () => $("#settings-modal").close());
  $("#settings-save").addEventListener("click", saveSettings);
  hookPathCompletion("#set-repo", "fs-repo-list", true);
  hookPathCompletion("#set-python", "fs-python-list", false);

  for (const t of $$(".tab")) t.addEventListener("click", () => switchTab(t.dataset.tab));

  $("#param-search").addEventListener("input", applyParamFilter);
  $("#changed-only").addEventListener("change", applyParamFilter);
  $("#reset-all").addEventListener("click", () => {
    if (!confirm("Reset every parameter to its default?")) return;
    state.values = {};
    renderParams();
  });
  $("#opt-resume").addEventListener("change", refreshPreview);
  $("#cmd-copy").addEventListener("click", () => {
    navigator.clipboard.writeText($("#cmd-preview").textContent);
    toast("Command copied");
  });
  $("#launch-btn").addEventListener("click", launch);
  $("#save-config").addEventListener("click", saveConfig);
  $("#config-select").addEventListener("change", (e) => {
    if (e.target.value) loadConfig(e.target.value);
    e.target.value = "";
  });
  $("#config-reload").addEventListener("click", refreshConfigs);

  $("#personas-add").addEventListener("click", () => {
    state.personas.push({ persona: "", name: "", role: "", count: 1 });
    renderPersonas();
  });
  $("#personas-save").addEventListener("click", () => saveEditorFile("personas"));
  $("#personas-rescan").addEventListener("click", () => fillFileSelect("personas", "#personas-files"));
  $("#personas-files").addEventListener("change", async (e) => {
    if (!e.target.value) return;
    try {
      state.personas = (await loadJsonFile(e.target.value)).map(normalizePersona);
      $("#personas-path").value = e.target.value;
      renderPersonas();
    } catch (err) {
      toast(`Could not load: ${err.message}`, true);
    }
    e.target.value = "";
  });

  $("#artifacts-add").addEventListener("click", () => {
    state.artifacts.push(normalizeArtifact({ name: "" }));
    renderArtifacts();
  });
  $("#artifacts-save").addEventListener("click", () => saveEditorFile("artifacts"));
  $("#artifacts-rescan").addEventListener("click", () => fillFileSelect("artifacts", "#artifacts-files"));
  $("#artifacts-files").addEventListener("change", async (e) => {
    if (!e.target.value) return;
    try {
      state.artifacts = (await loadJsonFile(e.target.value)).map(normalizeArtifact);
      $("#artifacts-path").value = e.target.value;
      renderArtifacts();
    } catch (err) {
      toast(`Could not load: ${err.message}`, true);
    }
    e.target.value = "";
  });

  $("#design-btn").addEventListener("click", runDesign);
  $("#refine-btn").addEventListener("click", runRefine);
  $("#refine-undo").addEventListener("click", refineUndo);
  $("#refine-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runRefine();
  });
  $("#designer-model").addEventListener("change", (e) => {
    POST("/api/state", { last_model: e.target.value }).catch(() => {});
  });
  $("#apply-personas").addEventListener("click", () => {
    if (!state.design) return;
    state.personas = state.design.personas.map(normalizePersona);
    renderPersonas();
    switchTab("personas");
    toast("Personas moved to the editor — save there to use them");
  });
  $("#apply-artifacts").addEventListener("click", () => {
    if (!state.design) return;
    state.artifacts = state.design.init_artifacts.map(normalizeArtifact);
    renderArtifacts();
    switchTab("artifacts");
    toast("Artifacts moved to the editor — save there to use them");
  });
  $("#bundle-save").addEventListener("click", saveBundle);
  $("#bundle-download").addEventListener("click", downloadBundle);

  $("#log-select").addEventListener("change", (e) => {
    state.logProcId = parseInt(e.target.value, 10);
    state.logOffset = 0;
    $("#log-view").textContent = "";
  });

  await loadSchema();
  await refreshConfigs();
  await restoreEditorsFromValues();
  fillFileSelect("personas", "#personas-files");
  fillFileSelect("artifacts", "#artifacts-files");
  refreshPreview();

  pollProcs();
  setInterval(pollProcs, 2000);
  setInterval(pollLog, 1000);
}

boot();
