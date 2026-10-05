/* TerraLingua launcher front-end. Plain JavaScript, no build step. */

"use strict";

const SCENARIO_PREFIX = "run.scenario_options.";
const SCENARIO_GROUP = "Scenario options";
const EVALUATE_DELAY = 400;
const PERSIST_DELAY = 500;
const LONG_TEXT = 80;
const LOG_LIMIT = 400000;
const LOG_KEEP = 300000;

const DERIVED_LABELS = {
  artifact_creation_enabled: "Artifact creation",
  internal_memory_enabled: "Internal memory",
  energy_death: "Death at zero energy",
  reproduction_enabled: "Reproduction",
  newborn_base_energy: "Newborn base energy",
  failed_birth_cost: "Failed birth cost",
  hop_radius: "Hop radius",
};

/* Content files a run reads. `setting` is the core setting that names one; a scenario option
   with the same name counts too. The server reports which setting applies and where its file
   is (`state.sources`). New files go under <workdir>/launcher_content/<kind>/. */
const CONTENT_KINDS = {
  artifacts: { setting: "env.init_artifacts_path", tab: "Artifacts", one: "artifact set", many: "artifact sets", entry: "Artifact" },
  personas: { setting: "agent.personas_path", tab: "Personas", one: "persona list", many: "persona lists", entry: "Persona" },
};
const INSTRUCTIONS_SETTING = "agent.scenario_specific_instructions";

let entrySeq = 0;

/* `path` is the editor's file, relative to the working directory; `saved` says it exists there;
   `seen` is the configuration's file the editor last followed. */
function newContentState() {
  return {
    items: [], counts: {}, name: null, path: null, saved: false, writable: true, files: null,
    entries: [], savedText: "[]", busy: false, seen: null, followed: null, loadSeq: 0, nodes: null,
  };
}

/* The instructions editor on the Scenario AI tab. `savedText` is the text as on disk, "" for a new
   text, null while no text is shown; `writable` is false for a file outside the working directory. */
function newInstructionsState() {
  return { path: null, name: null, savedText: null, saved: false, writable: false, busy: false, followed: null, loadSeq: 0 };
}

const state = {
  settings: null,
  presets: [],
  preset: null,
  overrides: {},
  resume: false,
  schema: null,
  schemaCache: {},
  fields: {},
  base: {},
  evaluation: null,
  diagnostics: [],
  loadSeq: 0,
  evalSeq: 0,
  evalPending: false,
  evalValid: false,
  previewSeq: 0,
  showInactive: false,
  search: "",
  pinned: null,
  jsonErrors: {},
  rows: {},
  sections: [],
  procs: [],
  procNodes: new Map(),
  selectedProc: null,
  logSeq: 0,
  logOffset: 0,
  logBusy: false,
  logDone: false,
  logError: null,
  pollError: null,
  follow: true,
  tab: "launch",
  toastTimer: null,
  content: { artifacts: newContentState(), personas: newContentState() },
  instructions: newInstructionsState(),
  sources: {},
  extra: { paths: [], info: {}, path: null, text: "", savedText: null, busy: false, loadSeq: 0 },
  artifactTypes: { key: null, list: null, loading: false, cache: {}, seq: 0 },
  design: null,
  designBusy: false,
  designNameTouched: false,
  designFolderTouched: false,
  loaded: false,
};

/* ---------------- small helpers ---------------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) node.removeAttribute(name);
  else node.setAttribute(name, value === true ? "" : String(value));
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatValue(value) {
  return value === undefined ? "none" : JSON.stringify(value);
}

function formatJson(value) {
  const text = JSON.stringify(value);
  return text.length > 60 ? JSON.stringify(value, null, 2) : text;
}

function humanize(key) {
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatTime(seconds) {
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
}

function walk(object, keys) {
  let cursor = object;
  for (const key of keys) {
    if (!isPlainObject(cursor) || !(key in cursor)) return { ok: false, value: undefined };
    cursor = cursor[key];
  }
  return { ok: true, value: cursor };
}

function setNested(object, keys, value) {
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function deleteNested(object, keys) {
  const found = walk(object, keys.slice(0, -1));
  if (found.ok && isPlainObject(found.value)) delete found.value[keys[keys.length - 1]];
}

/* ---------------- server calls, errors, toasts ---------------- */

async function api(method, url, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const failure = new Error(`The server did not answer (${error.message}).`);
    failure.status = 0;
    throw failure;
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data.detail) detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch (error) {
      /* no JSON body: keep the status text */
    }
    const failure = new Error(detail);
    failure.status = response.status;
    throw failure;
  }
  return response.json();
}

const GET = (url) => api("GET", url);
const POST = (url, body) => api("POST", url, body ?? {});

function showError(message) {
  $("#errorText").textContent = message;
  $("#errorBar").hidden = false;
}

function hideError() {
  $("#errorBar").hidden = true;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { node.hidden = true; }, Math.max(2500, message.length * 45));
}

/* ---------------- header and settings ---------------- */

function keyLabel(name) {
  return name === "AWS_BEARER_TOKEN_BEDROCK" ? "bedrock" : name.replace("_API_KEY", "").toLowerCase();
}

function renderHeader() {
  const settings = state.settings;
  if (!settings) return;
  const workdir = $("#hdrWorkdir");
  workdir.textContent = settings.workdir;
  workdir.title = settings.workdir_ok ? settings.workdir : `${settings.workdir} is not a folder`;
  workdir.classList.toggle("bad", !settings.workdir_ok);
  const python = $("#hdrPython");
  python.textContent = settings.python;
  python.title = settings.python_ok ? settings.python : `${settings.python} was not found`;
  python.classList.toggle("bad", !settings.python_ok);
  const version = $("#hdrTlVersion");
  version.textContent = settings.terralingua_version || "not installed";
  version.classList.toggle("bad", !settings.terralingua_version);
  $("#hdrLauncherVersion").textContent = settings.launcher_version || "";
  const chips = $("#keyChips");
  chips.textContent = "";
  for (const [name, isSet] of Object.entries(settings.keys || {})) {
    chips.append(el("span", {
      class: `chip${isSet ? " on" : ""}`,
      role: "listitem",
      title: `${name} is ${isSet ? "set" : "not set"}`,
    }, `${keyLabel(name)} ${isSet ? "set" : "not set"}`));
  }
}

function openSettings() {
  const settings = state.settings || {};
  $("#settingsWorkdir").value = settings.workdir || "";
  $("#settingsPython").value = settings.python || "";
  $("#settingsToolPorts").value = (settings.tool_ports || []).join(", ");
  $("#settingsError").hidden = true;
  $("#settingsDialog").showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const errorNode = $("#settingsError");
  const saveButton = $("#settingsSave");
  saveButton.disabled = true;
  const previousWorkdir = state.settings?.workdir;
  try {
    state.settings = await POST("/api/settings", {
      workdir: $("#settingsWorkdir").value.trim(),
      python: $("#settingsPython").value.trim(),
      tool_ports: $("#settingsToolPorts").value.trim(),
    });
    $("#settingsDialog").close();
    renderHeader();
    state.schemaCache = {};
    resetArtifactTypes();
    if (state.settings.workdir !== previousWorkdir) {
      state.sources = {};
      for (const kind of Object.keys(CONTENT_KINDS)) {
        state.content[kind] = { ...newContentState(), nodes: state.content[kind].nodes };
        renderEntries(kind);
        loadContentList(kind);
      }
    }
    await loadPresets();
    const preset = state.presets.some((p) => p.name === state.preset) ? state.preset : null;
    await selectPreset(preset, true);
    persistState();
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    saveButton.disabled = false;
  }
}

function bindPathCompletion(input, list, dirsOnly) {
  input.addEventListener("input", debounce(async () => {
    try {
      const result = await GET(`/api/fs?prefix=${encodeURIComponent(input.value)}&dirs_only=${dirsOnly}`);
      list.textContent = "";
      for (const path of result.paths) list.append(el("option", { value: path }));
    } catch (error) {
      showError(error.message);
    }
  }, 150));
}

/* ---------------- presets ---------------- */

async function loadPresets() {
  let ok = true;
  try {
    state.presets = (await GET("/api/presets")).presets;
  } catch (error) {
    state.presets = [];
    ok = false;
    showError(error.message);
  }
  renderPresetOptions();
  return ok;
}

function renderPresetOptions() {
  const select = $("#presetSelect");
  select.textContent = "";
  select.append(el("option", { value: "" }, "No preset (defaults only)"));
  for (const preset of state.presets) {
    const description = preset.description || "";
    const short = description.length > 70 ? `${description.slice(0, 67)}…` : description;
    select.append(el("option", { value: preset.name, title: `${description} (${preset.location})` },
      short ? `${preset.name} — ${short}` : preset.name));
  }
  select.value = state.preset || "";
  renderPresetInfo();
}

function renderPresetInfo() {
  const info = $("#presetInfo");
  const preset = state.presets.find((p) => p.name === state.preset);
  if (preset) {
    info.textContent = `${preset.description || "No description."} Location: ${preset.location}.`;
  } else if (state.preset) {
    info.textContent = `The preset "${state.preset}" was not found.`;
  } else {
    info.textContent = "Model defaults only. Pick a preset to start from a saved configuration.";
  }
}

async function onPresetChange(event) {
  const name = event.target.value || null;
  if (name === state.preset) return;
  const count = Object.keys(state.overrides).length;
  if (count && !window.confirm(`Changing the preset clears ${plural(count, "changed setting", "changed settings")}. Continue?`)) {
    event.target.value = state.preset || "";
    return;
  }
  const kept = state.overrides;
  state.overrides = {};
  state.jsonErrors = {};
  const ok = await selectPreset(name);
  if (!ok) {
    state.overrides = kept;
    afterChange();
    return;
  }
  persistState();
}

async function fetchSchema(name, refresh) {
  const key = name || "";
  if (!refresh && state.schemaCache[key]) return state.schemaCache[key];
  const query = new URLSearchParams();
  if (name) query.set("preset", name);
  if (refresh) query.set("refresh", "true");
  const schema = await GET(`/api/schema?${query}`);
  state.schemaCache[key] = schema;
  return schema;
}

function setFormBusy(busy) {
  const form = $("#form");
  form.classList.toggle("busy", busy);
  form.setAttribute("aria-busy", String(busy));
}

function showFormMessage(text) {
  const form = $("#form");
  form.textContent = "";
  form.append(el("p", { class: "empty" }, text));
}

/* Loads a preset's schema and base values. Returns false when the load failed
   and the previous preset was kept; true otherwise. */
async function selectPreset(name, refresh = false) {
  const previous = state.preset;
  state.preset = name;
  if (name !== previous) state.sources = {};
  $("#presetSelect").value = name || "";
  renderPresetInfo();
  setFormBusy(true);
  const load = ++state.loadSeq;
  const seq = beginEvaluation();
  try {
    const [schema, baseResult] = await Promise.all([
      fetchSchema(name, refresh),
      POST("/api/evaluate", { preset: name, overrides: {} }),
    ]);
    if (load !== state.loadSeq) return true;
    const fields = prepareFields(schema);
    const base = baseResult.valid ? collectValues(baseResult, fields) : {};
    state.schema = schema;
    state.fields = fields;
    state.base = base;
    state.evaluation = null;
    state.pinned = null;
    state.loaded = true;
    buildForm();
    if (state.tab === "artifacts") refreshArtifactTypes();
    refreshContentPanes();
    if (Object.keys(state.overrides).length) runEvaluation();
    else applyEvaluationResult(baseResult, seq);
    return true;
  } catch (error) {
    if (load !== state.loadSeq) return true;
    showError(error.message);
    if (state.schema) {
      state.preset = previous;
      $("#presetSelect").value = previous || "";
      renderPresetInfo();
      applyEvaluationResult(null, seq);
    } else {
      showFormMessage("The settings could not be loaded. Check the error above, then check Settings.");
    }
    return false;
  } finally {
    if (load === state.loadSeq) {
      setFormBusy(false);
      renderToolButtons();
    }
  }
}

/* ---------------- field catalogue ---------------- */

function schemaTypes(schema) {
  const types = new Set();
  const add = (part) => {
    if (!part) return;
    if (part.type) types.add(part.type);
    if (part.$ref) types.add("object");
  };
  add(schema);
  for (const alt of [...(schema?.anyOf || []), ...(schema?.oneOf || [])]) add(alt);
  return types;
}

function enumChoices(field) {
  const schema = field.schema || {};
  const choices = [...(schema.enum || [])];
  for (const alt of [...(schema.anyOf || []), ...(schema.oneOf || [])]) {
    if (alt.enum) choices.push(...alt.enum);
  }
  return choices;
}

function isOptional(field) {
  return schemaTypes(field.schema).has("null") || /\bNone\b/.test(field.type || "");
}

function isInteger(field) {
  const types = schemaTypes(field.schema);
  if (types.has("integer") && !types.has("number")) return true;
  return /^int\b/.test(field.type || "") && !/float/.test(field.type || "");
}

function controlKind(field) {
  const types = schemaTypes(field.schema);
  const typeText = field.type || "";
  if (field.children.length) return "nested";
  if (types.has("array") || types.has("object") || /\b(list|tuple|dict|set)\b/.test(typeText)) return "json";
  if (enumChoices(field).length) return "enum";
  if (types.has("boolean") || /^bool\b/.test(typeText)) return isOptional(field) ? "tribool" : "bool";
  if (types.has("integer") || types.has("number") || /\b(int|float)\b/.test(typeText)) return "number";
  return "text";
}

function parentPath(path, fields) {
  if (!fields[path].scenario) return null;
  const parts = path.split(".");
  for (let n = parts.length - 1; n > 0; n--) {
    const candidate = parts.slice(0, n).join(".");
    if (candidate in fields && fields[candidate].scenario) return candidate;
  }
  return null;
}

function prepareFields(schema) {
  const fields = {};
  for (const [path, field] of Object.entries(schema.fields || {})) {
    fields[path] = { ...field, path, scenario: false };
  }
  for (const [path, field] of Object.entries(schema.scenario?.fields || {})) {
    fields[path] = { ...field, path, scenario: true, aliases: [], group: SCENARIO_GROUP };
  }
  const paths = Object.keys(fields);
  const aliasOwners = new Map();
  for (const path of paths) {
    fields[path].parent = parentPath(path, fields);
    for (const alias of fields[path].aliases || []) aliasOwners.set(alias, (aliasOwners.get(alias) || 0) + 1);
  }
  for (const path of paths) {
    const field = fields[path];
    field.children = paths.filter((p) => fields[p].parent === path);
    field.title = field.schema?.title || path.split(".").pop();
    field.optional = isOptional(field);
    field.kind = controlKind(field);
    const alias = (field.aliases || []).find((name) => aliasOwners.get(name) === 1);
    field.flag = field.scenario ? path : `--${alias || path}`;
    field.searchText = [path, ...(field.aliases || []), field.title, field.description || ""].join(" ").toLowerCase();
  }
  return fields;
}

function hasScenarioFields() {
  return Object.values(state.fields).some((field) => field.scenario);
}

/* ---------------- overrides ---------------- */

function overrideHolder(path) {
  let ancestor = state.fields[path]?.parent || null;
  while (ancestor) {
    if (ancestor in state.overrides && isPlainObject(state.overrides[ancestor])) return ancestor;
    ancestor = state.fields[ancestor].parent;
  }
  return null;
}

function relativeKeys(ancestor, path) {
  return path.slice(ancestor.length + 1).split(".");
}

function overrideFor(path) {
  if (path in state.overrides) return { present: true, value: state.overrides[path] };
  const holder = overrideHolder(path);
  if (holder) {
    const found = walk(state.overrides[holder], relativeKeys(holder, path));
    if (found.ok) return { present: true, value: found.value };
  }
  return { present: false, value: undefined };
}

function putOverride(path, value) {
  const holder = overrideHolder(path);
  if (holder) {
    setNested(state.overrides[holder], relativeKeys(holder, path), value);
  } else if (path in state.base && sameValue(value, state.base[path])) {
    delete state.overrides[path];
  } else {
    state.overrides[path] = value;
  }
}

function setOverride(path, value) {
  putOverride(path, value);
  afterChange();
}

function clearOverride(path) {
  delete state.overrides[path];
  const holder = overrideHolder(path);
  if (holder) deleteNested(state.overrides[holder], relativeKeys(holder, path));
  afterChange();
}

function deleteDescendantOverrides(path) {
  for (const key of Object.keys(state.overrides)) {
    if (key.startsWith(`${path}.`)) delete state.overrides[key];
  }
}

function toggleParent(path, enabled) {
  if (!enabled) {
    deleteDescendantOverrides(path);
    setOverride(path, null);
    return;
  }
  delete state.overrides[path];
  const base = state.base[path];
  if (base === null || base === undefined) state.overrides[path] = {};
  afterChange();
}

function resetField(path) {
  delete state.jsonErrors[path];
  clearOverride(path);
}

function resetAll() {
  const count = Object.keys(state.overrides).length;
  if (!count) {
    toast("There are no changes to reset.");
    return;
  }
  if (!window.confirm(`Reset ${plural(count, "changed setting", "changed settings")} to the preset values?`)) return;
  state.overrides = {};
  state.jsonErrors = {};
  afterChange();
}

function afterChange() {
  state.evalPending = true;
  refreshRows();
  updateActionButtons();
  scheduleEvaluate();
  persistState();
}

/* ---------------- values and states ---------------- */

function collectValues(result, fields = state.fields) {
  const values = { ...(result.inactive_values || {}), ...(result.active_values || {}) };
  const options = result.resolved?.run?.scenario_options;
  for (const [path, field] of Object.entries(fields)) {
    if (!field.scenario) continue;
    const found = walk(options, path.slice(SCENARIO_PREFIX.length).split("."));
    if (found.ok) values[path] = found.value;
  }
  return values;
}

function evaluatedValue(path) {
  const values = state.evaluation?.values;
  if (state.evalValid && values && path in values) return values[path];
  if (path in state.base) return state.base[path];
  return state.fields[path]?.default;
}

function displayValue(path) {
  const override = overrideFor(path);
  return override.present ? override.value : evaluatedValue(path);
}

function fieldState(path) {
  return state.evaluation?.states?.[path] || { active: true, reason: "" };
}

function ancestorNull(path) {
  let ancestor = state.fields[path]?.parent || null;
  while (ancestor) {
    const value = displayValue(ancestor);
    if (value === null || value === undefined) return true;
    ancestor = state.fields[ancestor].parent;
  }
  return false;
}

function startingValue(field) {
  if (field.default !== null && field.default !== undefined) return field.default;
  const base = state.base[field.path];
  if (base !== null && base !== undefined) return base;
  switch (field.kind) {
    case "number": return numberBounds(field).min ?? 0;
    case "enum": return enumChoices(field)[0];
    case "json": return schemaTypes(field.schema).has("object") ? {} : [];
    default: return "";
  }
}

function diagnosticPath(field) {
  if (!field) return null;
  if (field in state.fields) return field;
  if (SCENARIO_PREFIX + field in state.fields) return SCENARIO_PREFIX + field;
  return null;
}

function errorMap() {
  const errors = new Map();
  for (const diagnostic of state.diagnostics) {
    if (diagnostic.severity !== "error") continue;
    const path = diagnosticPath(diagnostic.field);
    if (path && !errors.has(path)) errors.set(path, diagnostic);
  }
  return errors;
}

/* ---------------- controls ---------------- */

function numberBounds(field) {
  const schema = field.schema || {};
  const integer = isInteger(field);
  const bounds = {};
  for (const part of [schema, ...(schema.anyOf || [])]) {
    if (part.minimum !== undefined) bounds.min = part.minimum;
    if (part.maximum !== undefined) bounds.max = part.maximum;
    if (part.exclusiveMinimum !== undefined) bounds.min = integer ? part.exclusiveMinimum + 1 : part.exclusiveMinimum;
    if (part.exclusiveMaximum !== undefined) bounds.max = integer ? part.exclusiveMaximum - 1 : part.exclusiveMaximum;
  }
  return bounds;
}

function makeSwitch(id, onToggle, withText) {
  const input = el("input", { type: "checkbox", role: "switch", id, onchange: () => onToggle(input.checked) });
  const track = el("span", { class: "track", "aria-hidden": "true" });
  const wrap = el("span", { class: "switch" }, input, track);
  const text = withText ? el("span", { class: "hint" }) : null;
  const node = text ? el("span", { class: "switch-with-text" }, wrap, text) : wrap;
  return {
    el: node,
    input,
    setValue: (value) => {
      input.checked = value !== null && value !== undefined && value !== false;
      if (text) text.textContent = input.checked ? "enabled" : "disabled (null)";
    },
    setDisabled: (disabled) => { input.disabled = disabled; },
  };
}

function makeTribool(id, onChange) {
  const select = el("select", { id, onchange: () => onChange(select.value === "null" ? null : select.value === "true") },
    el("option", { value: "true" }, "true"),
    el("option", { value: "false" }, "false"),
    el("option", { value: "null" }, "null"));
  return {
    el: select,
    input: select,
    setValue: (value) => { select.value = value === null || value === undefined ? "null" : String(!!value); },
    setDisabled: (disabled) => { select.disabled = disabled; },
  };
}

function makeSelect(id, choices, onChange) {
  const select = el("select", { id, onchange: () => onChange(choices[Number(select.value)]) });
  choices.forEach((choice, index) => select.append(el("option", { value: String(index) }, String(choice))));
  return {
    el: select,
    input: select,
    setValue: (value) => {
      const index = choices.findIndex((choice) => sameValue(choice, value));
      select.selectedIndex = index;
    },
    setDisabled: (disabled) => { select.disabled = disabled; },
  };
}

function makeNumber(field, id, onChange) {
  const integer = isInteger(field);
  const bounds = numberBounds(field);
  const input = el("input", {
    type: "number",
    id,
    step: integer ? "1" : "any",
    inputmode: integer ? "numeric" : "decimal",
    min: bounds.min === undefined ? null : String(bounds.min),
    max: bounds.max === undefined ? null : String(bounds.max),
  });
  input.addEventListener("input", () => {
    if (input.validity.badInput) return;
    if (input.value === "") {
      clearOverride(field.path);
      return;
    }
    const number = Number(input.value);
    if (Number.isFinite(number)) onChange(number);
  });
  return {
    el: input,
    input,
    setValue: (value) => { input.value = value === null || value === undefined ? "" : String(value); },
    setDisabled: (disabled) => { input.disabled = disabled; },
  };
}

function isLongText(field) {
  return typeof field.default === "string" && field.default.length > LONG_TEXT;
}

function makeText(field, id, onChange) {
  const holder = el("span", { class: "text-holder" });
  const handle = { el: holder, input: null, setValue: null, setDisabled: null };
  const build = (long) => {
    const node = long
      ? el("textarea", { id, rows: "3", spellcheck: "false" })
      : el("input", { type: "text", id, spellcheck: "false" });
    node.addEventListener("input", () => onChange(node.value));
    if (handle.input) {
      node.disabled = handle.input.disabled;
      handle.input.replaceWith(node);
    } else {
      holder.append(node);
    }
    handle.input = node;
  };
  build(isLongText(field));
  handle.setValue = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    const long = isLongText(field) || text.length > LONG_TEXT;
    const focused = document.activeElement === handle.input;
    if (long !== (handle.input.tagName === "TEXTAREA") && !focused) build(long);
    handle.input.value = text;
  };
  handle.setDisabled = (disabled) => { handle.input.disabled = disabled; };
  return handle;
}

function makeJson(field, id) {
  const textarea = el("textarea", { id, rows: "2", spellcheck: "false", class: "json" });
  textarea.addEventListener("input", () => {
    const text = textarea.value.trim();
    if (!text) {
      delete state.jsonErrors[field.path];
      clearOverride(field.path);
      return;
    }
    try {
      const value = JSON.parse(text);
      delete state.jsonErrors[field.path];
      setOverride(field.path, value);
    } catch (error) {
      state.jsonErrors[field.path] = error.message;
      refreshRows();
      updateActionButtons();
    }
  });
  return {
    el: textarea,
    input: textarea,
    setValue: (value) => {
      const text = value === undefined ? "" : formatJson(value);
      textarea.value = text;
      textarea.rows = Math.min(10, Math.max(2, text.split("\n").length));
    },
    setDisabled: (disabled) => { textarea.disabled = disabled; },
  };
}

function withNullBox(field, control) {
  if (!field.optional) return control;
  const box = el("input", {
    type: "checkbox",
    "aria-label": `Set ${field.title} to null`,
    onchange: () => setOverride(field.path, box.checked ? null : startingValue(field)),
  });
  const node = el("span", { class: "ctl-with-null" }, control.el, el("label", { class: "null-label" }, box, "null"));
  return {
    el: node,
    get input() { return control.input; },
    setValue: (value) => {
      box.checked = value === null;
      control.setValue(value);
    },
    setDisabled: (disabled) => {
      box.disabled = disabled;
      control.setDisabled(disabled || box.checked);
    },
  };
}

function makeControl(field, id) {
  const path = field.path;
  switch (field.kind) {
    case "nested": return makeSwitch(id, (on) => toggleParent(path, on), true);
    case "bool": return makeSwitch(id, (on) => setOverride(path, on), false);
    case "tribool": return makeTribool(id, (value) => setOverride(path, value));
    case "enum": return withNullBox(field, makeSelect(id, enumChoices(field), (value) => setOverride(path, value)));
    case "number": return withNullBox(field, makeNumber(field, id, (value) => setOverride(path, value)));
    case "json": return withNullBox(field, makeJson(field, id));
    default: return withNullBox(field, makeText(field, id, (value) => setOverride(path, value)));
  }
}

/* ---------------- form ---------------- */

function constraintText(id) {
  return (state.schema?.constraints || []).find((c) => c.id === id)?.description || "";
}

function linkChip(path) {
  return el("button", { type: "button", class: "link-chip", onclick: () => jumpToField(path) }, path);
}

function buildDetails(field) {
  const list = el("dl", { class: "row-details" });
  const add = (term, ...content) => list.append(el("dt", {}, term), el("dd", {}, ...content));
  add("Description", field.description || "No description.");
  if (field.notes) add("Notes", field.notes);
  add("Path", el("code", {}, field.path));
  add("Flag", el("code", {}, field.flag));
  add("Default", el("code", {}, formatValue(field.default)));
  if (field.type) add("Type", el("code", {}, field.type));
  if (field.depends_on?.length) add("Depends on", ...field.depends_on.map(linkChip));
  if (field.affects?.length) add("Affects", ...field.affects.map(linkChip));
  if (field.inactive_reason) add("Condition", field.inactive_reason);
  const rules = (field.constraints || []).map(constraintText).filter(Boolean);
  if (rules.length) add("Rules", el("ul", { class: "rules" }, ...rules.map((rule) => el("li", {}, rule))));
  return list;
}

function toggleDetails(path) {
  const row = state.rows[path];
  const open = row.detailsNode.hidden;
  row.detailsNode.hidden = !open;
  row.detailsButton.setAttribute("aria-expanded", String(open));
}

function buildRow(path, section) {
  const field = state.fields[path];
  const id = `ctl-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const control = makeControl(field, id);
  const changedMark = el("span", { class: "changed-mark" }, "changed");
  const label = el("label", { class: "row-label", for: id },
    el("span", { class: "title", title: path }, field.title), changedMark);
  const reset = el("button", {
    type: "button", class: "ghost reset", "aria-label": `Reset ${field.title}`, onclick: () => resetField(path),
  }, "Reset");
  const detailsButton = el("button", {
    type: "button", class: "ghost", "aria-expanded": "false", "aria-controls": `${id}-details`,
    "aria-label": `Details of ${field.title}`, onclick: () => toggleDetails(path),
  }, "Details");
  const reasonNode = el("p", { class: "row-reason", id: `${id}-reason`, hidden: true });
  const errorText = el("span");
  const errorNode = el("p", { class: "row-error", id: `${id}-error`, hidden: true }, el("strong", {}, "Error:"), " ", errorText);
  const detailsNode = buildDetails(field);
  detailsNode.id = `${id}-details`;
  detailsNode.hidden = true;
  const contentKind = contentKindOf(path);
  const contentLink = contentKind
    ? el("p", { class: "row-link", hidden: true }, el("button", {
      type: "button", class: "link-chip", onclick: () => openContentSource(contentKind),
    }, contentKind in CONTENT_KINDS ? `Edit in ${CONTENT_KINDS[contentKind].tab}` : "Show in Scenario AI"))
    : null;
  const row = el("div", { class: "row", "data-path": path },
    label,
    el("div", { class: "row-control" }, control.el),
    el("div", { class: "row-actions" }, reset, detailsButton),
    contentLink, reasonNode, errorNode, detailsNode);
  state.rows[path] = {
    path, section, el: row, control, reset, detailsButton, changedMark, reasonNode, errorNode, errorText, detailsNode,
    contentKind, contentLink,
  };
  if (!field.children.length) return row;
  const children = el("div", { class: "children" });
  for (const child of field.children) children.append(buildRow(child, section));
  return el("div", { class: "nest" }, row, children);
}

function buildSection(group) {
  const badge = el("span", { class: "badge changed-count" });
  const note = el("p", { class: "group-note", hidden: true });
  const body = el("div", { class: "group-body" });
  const section = { name: group.name, badge, note, body, el: null };
  for (const path of group.paths) body.append(buildRow(path, section));
  section.el = el("details", { class: "group", open: true }, el("summary", {}, group.name, badge), body, note);
  state.sections.push(section);
  return section.el;
}

function buildForm() {
  const root = $("#form");
  root.textContent = "";
  state.rows = {};
  state.sections = [];
  state.jsonErrors = {};
  const scenario = hasScenarioFields();
  if (scenario) delete state.overrides["run.scenario_options"];
  const groups = (state.schema.groups || []).map((group) => ({
    name: group.name,
    paths: group.fields.filter((path) => state.fields[path] && !(scenario && path === "run.scenario_options")),
  }));
  const scenarioRoots = Object.values(state.fields).filter((field) => field.scenario && !field.parent).map((field) => field.path);
  if (scenarioRoots.length) groups.unshift({ name: SCENARIO_GROUP, paths: scenarioRoots });
  for (const group of groups) {
    if (group.paths.length) root.append(buildSection(group));
  }
  refreshRows();
}

function refreshRows() {
  const query = state.search.trim().toLowerCase();
  const errors = errorMap();
  const stats = new Map(state.sections.map((section) => [section, { visible: 0, inactiveHidden: 0, changed: 0 }]));
  let inactiveTotal = 0;
  for (const row of Object.values(state.rows)) {
    const path = row.path;
    const field = state.fields[path];
    const fstate = fieldState(path);
    const changed = overrideFor(path).present;
    const error = errors.get(path);
    const jsonError = state.jsonErrors[path];
    const parentNull = ancestorNull(path);
    const matches = !query || field.searchText.includes(query);
    const inactiveHidden = !fstate.active && !state.showInactive;
    const visible = !!error || state.pinned === path || (matches && !inactiveHidden && !parentNull);
    if (!fstate.active) inactiveTotal++;
    row.el.hidden = !visible;
    row.el.classList.toggle("inactive", !fstate.active);
    row.el.classList.toggle("changed", changed);
    row.el.classList.toggle("has-error", !!error);
    row.el.classList.toggle("has-json-error", !!jsonError);
    row.changedMark.hidden = !changed;
    row.reset.hidden = !changed;
    row.reasonNode.hidden = fstate.active;
    row.reasonNode.textContent = fstate.active ? "" : fstate.reason || "This setting does not apply with the current configuration.";
    const errorText = error ? error.message : jsonError ? `Invalid JSON. ${jsonError}` : "";
    row.errorNode.hidden = !errorText;
    row.errorText.textContent = errorText;
    const editing = document.activeElement === row.control.input || !!jsonError;
    if (!editing) row.control.setValue(displayValue(path));
    row.control.setDisabled(!fstate.active);
    if (row.contentLink) {
      const source = state.sources[row.contentKind];
      const openable = !!source && source.setting === path && source.exists && (source.inside || row.contentKind === "instructions");
      row.contentLink.hidden = !openable;
    }
    const describedBy = [fstate.active ? "" : row.reasonNode.id, errorText ? row.errorNode.id : ""].filter(Boolean);
    setAttr(row.control.input, "aria-describedby", describedBy.join(" ") || null);
    setAttr(row.control.input, "aria-invalid", errorText ? "true" : null);
    const count = stats.get(row.section);
    if (visible) count.visible++;
    else if (inactiveHidden && matches && !parentNull) count.inactiveHidden++;
    if (changed) count.changed++;
  }
  for (const section of state.sections) {
    const count = stats.get(section);
    const noteNeeded = count.visible === 0 && count.inactiveHidden > 0;
    section.el.hidden = count.visible === 0 && count.inactiveHidden === 0;
    section.note.hidden = !noteNeeded;
    section.note.textContent = `${count.inactiveHidden} ${count.inactiveHidden === 1 ? "setting does" : "settings do"} not apply with the current configuration.`;
    section.badge.textContent = count.changed ? `${count.changed} changed` : "";
  }
  $("#showInactiveText").textContent = `Show inactive settings (${inactiveTotal})`;
}

function jumpToField(path) {
  const row = state.rows[path];
  if (!row) return;
  state.pinned = path;
  refreshRows();
  const section = row.el.closest("details.group");
  if (section) section.open = true;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  row.el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  row.el.classList.add("flash");
  setTimeout(() => row.el.classList.remove("flash"), 1500);
}

/* ---------------- evaluation ---------------- */

function beginEvaluation() {
  state.evalPending = true;
  updateActionButtons();
  return ++state.evalSeq;
}

async function runEvaluation() {
  const seq = beginEvaluation();
  let result = null;
  try {
    result = await POST("/api/evaluate", { preset: state.preset, overrides: state.overrides });
  } catch (error) {
    if (seq === state.evalSeq) showError(error.message);
  }
  applyEvaluationResult(result, seq);
}

const scheduleEvaluate = debounce(runEvaluation, EVALUATE_DELAY);

function worthShowing(diagnostic) {
  // An inactive setting is already hidden or greyed out in the form.
  return diagnostic.code !== "inactive_setting";
}

function applyEvaluationResult(result, seq) {
  if (seq !== state.evalSeq) return;
  state.evalPending = false;
  state.evalValid = !!(result && result.valid);
  state.diagnostics = result ? (result.diagnostics || []).filter(worthShowing) : [];
  if (state.evalValid) {
    state.evaluation = {
      states: result.fields || {},
      values: collectValues(result),
      derived: result.derived || {},
    };
    renderDerived();
    if (isPlainObject(result.content)) state.sources = result.content;
    if (Array.isArray(result.extra_files)) applyExtraInfo(result.extra_files);
  }
  renderDiagnostics(result !== null);
  $("#statesNote").hidden = state.evalValid || !state.evaluation;
  refreshRows();
  updateActionButtons();
  refreshPreview();
  refreshContentPanes();
  followSources();
}

function renderDiagnostics(answered) {
  const list = $("#diagnostics");
  list.textContent = "";
  if (!state.diagnostics.length) {
    const text = !answered ? "The last check did not complete." : state.evalValid ? "No problems found." : "No details.";
    list.append(el("li", { class: "diag-empty" }, text));
    return;
  }
  for (const diagnostic of state.diagnostics) {
    const path = diagnosticPath(diagnostic.field);
    const where = path || diagnostic.field;
    const body = path
      ? el("button", { type: "button", onclick: () => jumpToField(path) }, diagnostic.message, el("code", {}, where))
      : el("span", { class: "text" }, diagnostic.message, where ? el("code", {}, where) : null);
    list.append(el("li", { class: `diag ${diagnostic.severity}` }, el("span", { class: "severity" }, diagnostic.severity), body));
  }
}

function formatDerived(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  if (value === null || value === undefined) return "not set";
  return String(value);
}

function renderDerived() {
  const list = $("#derived");
  list.textContent = "";
  const derived = state.evaluation?.derived || {};
  for (const [key, value] of Object.entries(derived)) {
    list.append(el("dt", {}, DERIVED_LABELS[key] || humanize(key)), el("dd", {}, formatDerived(value)));
  }
}

async function refreshPreview() {
  const seq = ++state.previewSeq;
  try {
    const result = await POST("/api/preview", { preset: state.preset, overrides: state.overrides, resume: state.resume });
    if (seq === state.previewSeq) $("#cmdPreview").textContent = result.cmd;
  } catch (error) {
    if (seq === state.previewSeq) showError(error.message);
  }
}

async function copyCommand() {
  const node = $("#cmdPreview");
  if (!node.textContent) return;
  try {
    await navigator.clipboard.writeText(node.textContent);
    toast("Command copied.");
  } catch (error) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast("Copy failed. The command is selected. Press Ctrl+C.");
  }
}

function updateActionButtons() {
  const errors = state.diagnostics.filter((d) => d.severity === "error").length;
  const jsonErrors = Object.keys(state.jsonErrors).length;
  let reason = "";
  if (!state.schema) reason = "Waiting for the settings to load.";
  else if (jsonErrors) reason = `${plural(jsonErrors, "field has", "fields have")} invalid JSON.`;
  else if (state.evalPending) reason = "Checking the configuration…";
  else if (errors) reason = `Fix ${plural(errors, "error", "errors")} before you launch.`;
  else if (!state.evalValid) reason = "The last check did not complete.";
  $("#launchBtn").disabled = !!reason;
  $("#savePresetBtn").disabled = !!reason;
  const preset = currentPreset();
  let updateReason = reason;
  if (!updateReason && !preset) updateReason = "Pick a preset to update.";
  else if (!updateReason && preset.location === "(built-in)") updateReason = `${preset.name} is built into TerraLingua. Save a new preset instead.`;
  const update = $("#updatePresetBtn");
  update.disabled = !!updateReason;
  update.title = updateReason || `Write the current configuration to ${preset.location}.`;
  $("#launchHint").textContent = reason;
}

function currentPreset() {
  return state.presets.find((p) => p.name === state.preset) || null;
}

/* ---------------- launch and save ---------------- */

/* What a launch would leave unsaved: changed settings, and edits in the content editors. */
function unsavedWork() {
  const items = [];
  const count = Object.keys(state.overrides).length;
  if (count) {
    items.push(`${plural(count, "changed setting is", "changed settings are")} not saved to a preset. The run still uses them: they go on the command line and into the run's params.json.`);
  }
  for (const kind of Object.keys(CONTENT_KINDS)) {
    if (!contentDirty(kind)) continue;
    const where = state.content[kind].path ? ` to ${state.content[kind].path}` : "";
    items.push(`The ${CONTENT_KINDS[kind].tab} editor has unsaved changes${where}. The run reads the files as they are on disk, without them.`);
  }
  if (instructionsDirty()) {
    const where = state.instructions.path ? ` to ${state.instructions.path}` : "";
    items.push(`The instructions text has unsaved changes${where}. The run reads the file as it is on disk, without them.`);
  }
  if (extraDirty()) {
    items.push(`The Files editor has unsaved changes to ${state.extra.path}. The run reads the file as it is on disk, without them.`);
  }
  return items;
}

/* Launches at once when everything is saved; otherwise says what is not and asks first. */
function launch() {
  const unsaved = unsavedWork();
  if (!unsaved.length) {
    startRun();
    return;
  }
  const list = $("#launchUnsaved");
  list.textContent = "";
  for (const item of unsaved) list.append(el("li", {}, item));
  $("#launchDialog").showModal();
}

function confirmLaunch(event) {
  event.preventDefault();
  $("#launchDialog").close();
  startRun();
}

async function startRun() {
  $("#launchBtn").disabled = true;
  try {
    const result = await POST("/api/launch", { preset: state.preset, overrides: state.overrides, resume: state.resume });
    toast(`Started ${result.proc.label}.`);
    showNewProc(result.proc);
  } catch (error) {
    showError(error.message);
  } finally {
    updateActionButtons();
  }
}

function showNewProc(proc) {
  state.procs = [proc, ...state.procs.filter((p) => p.id !== proc.id)];
  selectProc(proc.id);
  switchTab("console");
}

/* ---------------- scenario tools ---------------- */

/* One button per tool the preset's scenario ships (viewer, anthropologist).
   The interpreter must be usable; the configuration's validity does not matter. */
function renderToolButtons() {
  const tools = state.schema?.scenario?.tools || {};
  const names = Object.keys(tools).filter((name) => tools[name]);
  for (const holder of [$("#toolButtons"), $("#consoleToolButtons")]) {
    holder.textContent = "";
    holder.hidden = !names.length;
    for (const name of names) {
      holder.append(el("button", {
        type: "button",
        disabled: !state.settings?.python_ok,
        onclick: (event) => startTool(name, event.currentTarget),
      }, `Open ${name}`));
    }
  }
}

async function startTool(name, button) {
  button.disabled = true;
  try {
    const result = await POST(`/api/tools/${encodeURIComponent(name)}`, { preset: state.preset });
    const forwarded = state.settings?.tool_ports?.length ? "" : " If you work through forwarded ports, forward this one too.";
    toast(`Started ${result.proc.label} at ${result.url}.${forwarded}`);
    showNewProc(result.proc);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = !state.settings?.python_ok;
  }
}

function openSavePreset() {
  $("#savePresetName").value = "";
  $("#savePresetDescription").value = "";
  $("#savePresetError").hidden = true;
  $("#savePresetDialog").showModal();
}

async function savePreset(event) {
  event.preventDefault();
  const errorNode = $("#savePresetError");
  const confirmButton = $("#savePresetConfirm");
  const name = $("#savePresetName").value.trim();
  confirmButton.disabled = true;
  try {
    const result = await POST("/api/presets", {
      name,
      description: $("#savePresetDescription").value.trim(),
      preset: state.preset,
      overrides: state.overrides,
    });
    $("#savePresetDialog").close();
    toast(`Saved ${result.path}.`);
    await afterPresetWritten(name);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    confirmButton.disabled = false;
  }
}

/* After a preset file was written, the changes are part of it: the form restarts from the file. */
async function afterPresetWritten(name) {
  const kept = state.overrides;
  state.overrides = {};
  state.jsonErrors = {};
  state.schemaCache = {};
  resetArtifactTypes();
  beginEvaluation();
  setFormBusy(true);
  await loadPresets();
  const ok = await selectPreset(name, true);
  if (!ok) {
    state.overrides = kept;
    afterChange();
    return;
  }
  persistState();
}

function openUpdatePreset() {
  const preset = currentPreset();
  if (!preset) return;
  const count = Object.keys(state.overrides).length;
  $("#updatePresetTitle").textContent = `Update preset ${preset.name}`;
  $("#updatePresetText").textContent = count
    ? `${plural(count, "changed setting becomes", "changed settings become")} part of the preset. The file ${preset.location} is rewritten.`
    : `No setting changed; only the description can change. The file ${preset.location} is rewritten.`;
  $("#updatePresetDescription").value = preset.description || "";
  $("#updatePresetError").hidden = true;
  $("#updatePresetDialog").showModal();
}

async function updatePreset(event) {
  event.preventDefault();
  const errorNode = $("#updatePresetError");
  const confirmButton = $("#updatePresetConfirm");
  const name = state.preset;
  confirmButton.disabled = true;
  try {
    const result = await api("PUT", `/api/presets/${encodeURIComponent(name)}`, {
      description: $("#updatePresetDescription").value.trim(),
      overrides: state.overrides,
    });
    $("#updatePresetDialog").close();
    toast(`Updated ${result.path}.`);
    await afterPresetWritten(name);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    confirmButton.disabled = false;
  }
}

/* ---------------- content files: artifact sets and persona lists ---------------- */

function contentNodes(kind) {
  const ct = state.content[kind];
  if (ct.nodes) return ct.nodes;
  const pane = $(`#pane${CONTENT_KINDS[kind].tab}`);
  ct.nodes = {
    pane,
    editor: $(".content-editor", pane),
    title: $(".ct-title", pane),
    source: $(".ct-source", pane),
    items: $(".ct-items", pane),
    newButton: $(".ct-new", pane),
    openButton: $(".ct-open", pane),
    saveAsButton: $(".ct-save-as-btn", pane),
    titleName: $(".ct-title-name", pane),
    inUse: $(".ct-inuse", pane),
    unsaved: $(".ct-unsaved", pane),
    saveButton: $(".ct-save", pane),
    addButton: $(".ct-add", pane),
    useButton: $(".ct-use", pane),
    note: $(".ct-note", pane),
    info: $(".ct-info", pane),
    hint: $(".ct-hint", pane),
    entries: $(".ct-entries", pane),
  };
  return ct.nodes;
}

function coreSetting(kind) {
  return kind === "instructions" ? INSTRUCTIONS_SETTING : CONTENT_KINDS[kind].setting;
}

/* The content kind a setting names: a core setting, or a scenario option with the same name. */
function contentKindOf(path) {
  const leaf = path.split(".").pop();
  const option = path.startsWith(SCENARIO_PREFIX);
  const kinds = [...Object.keys(CONTENT_KINDS), "instructions"];
  return kinds.find((kind) => path === coreSetting(kind) || (option && leaf === coreSetting(kind).split(".").pop())) || null;
}

function contentNameError(name) {
  if (name.startsWith("-") || name.startsWith(".")) return "The name must not start with '-' or '.'.";
  if (/[\\/]/.test(name)) return "The name must not contain slashes.";
  return "";
}

function contentSettingKnown(kind) {
  return Object.keys(state.fields).some((path) => contentKindOf(path) === kind);
}

/* The setting that names this kind's file in the current configuration. */
function contentSetting(kind) {
  return state.sources[kind]?.setting || coreSetting(kind);
}

/* The value that setting takes for a file: relative to the working directory for a core setting;
   for a scenario option, relative to the scenario's folder when the file is inside it, else absolute. */
function settingValueFor(kind, path) {
  const base = state.sources[kind] ? state.sources[kind].base : "";
  if (base === "") return path;
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return `${state.settings?.workdir || ""}/${path}`;
}

function contentInUse(kind) {
  const ct = state.content[kind];
  const source = state.sources[kind];
  return !!ct.path && ct.saved && !!source && source.relative === ct.path;
}

function toInt(text) {
  const trimmed = String(text).trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

function parseLoose(text) {
  try {
    return JSON.parse(text.trim());
  } catch (error) {
    return text;
  }
}

function sortedObject(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

function paramText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function currentWorldType() {
  const value = displayValue("env.world_type");
  return typeof value === "string" ? value : "grid";
}

/* ---- artifact types ---- */

function artifactTypeList() {
  return state.artifactTypes.list || [];
}

function artifactTypeOf(name) {
  return artifactTypeList().find((type) => type.name === name) || null;
}

function defaultArtifactType() {
  const types = artifactTypeList();
  return (types.find((type) => type.creatable) || types[0] || { name: "text" }).name;
}

function artifactTypeHint(name) {
  if (state.artifactTypes.loading) return "Loading artifact types…";
  const type = artifactTypeOf(name);
  if (!type) return state.artifactTypes.list ? "This type is not in the current preset. The run skips the entry." : "The artifact types are not loaded.";
  return type.creatable ? type.description : `${type.description} Beings cannot create this type.`;
}

function resetArtifactTypes() {
  Object.assign(state.artifactTypes, { key: null, list: null, loading: false, cache: {} });
}

/* Loads the types for the current preset once, then re-renders the entries
   so the type selects and parameter inputs match. */
async function refreshArtifactTypes() {
  const types = state.artifactTypes;
  const key = state.preset || "";
  const seq = ++types.seq;
  if (!types.cache[key]) {
    types.loading = true;
    refreshContentPane("artifacts");
    try {
      const query = key ? `?preset=${encodeURIComponent(key)}` : "";
      types.cache[key] = (await GET(`/api/artifact_types${query}`)).types;
    } catch (error) {
      if (seq === types.seq) showError(`The artifact types could not be loaded: ${error.message}`);
    }
    if (seq !== types.seq) return;
  }
  types.loading = false;
  const list = types.cache[key];
  if (!list || (types.key === key && types.list === list)) {
    refreshContentPane("artifacts");
    return;
  }
  types.key = key;
  types.list = list;
  for (const entry of state.content.artifacts.entries) splitArtifactParams(entry);
  renderEntries("artifacts");
}

/* ---- entry models: the editor's view of one file entry ---- */

function newArtifactEntry() {
  return {
    id: ++entrySeq, name: "", artType: defaultArtifactType(), payload: "",
    poseMode: currentWorldType() === "grid" ? "cell" : "node", row: "", col: "", node: "",
    lifespan: "-1", movable: true, params: {}, extra: {}, extraText: "", extraError: "", rest: {},
  };
}

/* Puts each parameter either in `params` (the type declares it) or in `extra` (free JSON). */
function splitArtifactParams(entry) {
  const known = artifactTypeOf(entry.artType)?.params || [];
  const all = { ...entry.extra, ...entry.params };
  entry.params = {};
  entry.extra = {};
  for (const [key, value] of Object.entries(all)) {
    if (known.includes(key)) entry.params[key] = value;
    else entry.extra[key] = value;
  }
  entry.extraText = Object.keys(entry.extra).length ? formatJson(entry.extra) : "";
  entry.extraError = "";
}

function artifactFromFile(raw) {
  const { name, art_type: artType, payload, pose, lifespan, movable, params, ...rest } = isPlainObject(raw) ? raw : {};
  const entry = newArtifactEntry();
  if (name !== undefined && name !== null) entry.name = String(name);
  if (typeof artType === "string" && artType) entry.artType = artType;
  if (payload !== undefined && payload !== null) entry.payload = typeof payload === "string" ? payload : formatJson(payload);
  if (Array.isArray(pose)) {
    entry.poseMode = "cell";
    entry.row = pose[0] === undefined || pose[0] === null ? "" : String(pose[0]);
    entry.col = pose[1] === undefined || pose[1] === null ? "" : String(pose[1]);
  } else if (pose !== undefined && pose !== null) {
    entry.poseMode = "node";
    entry.node = String(pose);
  }
  if (lifespan !== undefined && lifespan !== null) entry.lifespan = String(lifespan);
  entry.movable = movable !== false;
  entry.extra = isPlainObject(params) ? { ...params } : {};
  entry.rest = rest;
  splitArtifactParams(entry);
  return entry;
}

function artifactToFile(entry) {
  const out = {
    name: entry.name.trim(),
    art_type: entry.artType,
    payload: entry.artType === "text" ? entry.payload : parseLoose(entry.payload),
    pose: entry.poseMode === "cell" ? [toInt(entry.row), toInt(entry.col)] : entry.node.trim(),
    lifespan: toInt(entry.lifespan),
    movable: !!entry.movable,
  };
  const params = sortedObject({ ...entry.extra, ...entry.params });
  if (Object.keys(params).length) out.params = params;
  for (const [key, value] of Object.entries(entry.rest)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function newPersonaEntry() {
  return { id: ++entrySeq, persona: "", name: "", count: "1", rest: {} };
}

function personaFromFile(raw) {
  const source = typeof raw === "string" ? { persona: raw } : isPlainObject(raw) ? raw : {};
  const { persona, name, count, ...rest } = source;
  const entry = newPersonaEntry();
  if (persona !== undefined && persona !== null) entry.persona = String(persona);
  if (name !== undefined && name !== null) entry.name = String(name);
  if (count !== undefined && count !== null) entry.count = String(count);
  entry.rest = rest;
  return entry;
}

function personaToFile(entry) {
  const out = { persona: entry.persona.trim() };
  if (entry.name.trim()) out.name = entry.name.trim();
  out.count = toInt(entry.count);
  for (const [key, value] of Object.entries(entry.rest)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function validateArtifact(entry, problems) {
  if (!entry.name.trim()) problems.name = "Type a name.";
  if (!entry.payload.trim()) problems.payload = "Type a payload.";
  if (entry.poseMode === "cell") {
    if (toInt(entry.row) === null || toInt(entry.col) === null) problems.pose = "A cell needs two whole numbers: row and column.";
  } else if (!entry.node.trim()) {
    problems.pose = "Type a node id.";
  }
  const lifespan = toInt(entry.lifespan);
  if (lifespan === null || lifespan < -1) problems.lifespan = "Lifespan is a whole number. -1 means forever.";
  if (entry.extraError) problems.params = entry.extraError;
}

function validatePersona(entry, problems) {
  if (!entry.persona.trim()) problems.persona = "Type the persona text.";
  const count = toInt(entry.count);
  if (count === null || count < 1) problems.count = "Count is a whole number of 1 or more.";
}

const CONTENT_MODEL = {
  artifacts: { blank: newArtifactEntry, fromFile: artifactFromFile, toFile: artifactToFile, validate: validateArtifact, render: renderArtifactEntry },
  personas: { blank: newPersonaEntry, fromFile: personaFromFile, toFile: personaToFile, validate: validatePersona, render: renderPersonaEntry },
};

/* Problems per entry id: { field: message }. An entry without problems has an empty object. */
function validateContent(kind) {
  const ct = state.content[kind];
  const problems = new Map(ct.entries.map((entry) => [entry.id, {}]));
  for (const entry of ct.entries) CONTENT_MODEL[kind].validate(entry, problems.get(entry.id));
  if (kind === "artifacts") {
    const byName = new Map();
    for (const entry of ct.entries) {
      const name = entry.name.trim();
      if (!name) continue;
      if (byName.has(name)) {
        const message = `Two entries are named "${name}". Names must be unique.`;
        problems.get(entry.id).name = message;
        problems.get(byName.get(name).id).name = message;
      } else {
        byName.set(name, entry);
      }
    }
  }
  return problems;
}

function serializeContent(kind) {
  return state.content[kind].entries.map((entry) => CONTENT_MODEL[kind].toFile(entry));
}

function contentDirty(kind) {
  return JSON.stringify(serializeContent(kind)) !== state.content[kind].savedText;
}

/* ---- entry cards ---- */

function entryErrorNode(entry, field, id) {
  const node = el("p", { class: "entry-error", id: `${id}-error`, hidden: true });
  entry.errorNodes[field] = node;
  return node;
}

function fieldBlock(id, labelText, control, errorNode, wide) {
  return el("div", { class: wide ? "field wide" : "field" }, el("label", { for: id }, labelText), control, errorNode);
}

function entryCard(kind, entry, index, fields) {
  const label = `${CONTENT_KINDS[kind].entry} ${index + 1}`;
  const head = el("div", { class: "entry-head" },
    el("button", { type: "button", class: "mini", "aria-label": `Duplicate ${label}`, onclick: () => duplicateEntry(kind, entry) }, "Duplicate"),
    el("button", { type: "button", class: "danger-ghost mini", "aria-label": `Remove ${label}`, onclick: () => removeEntry(kind, entry) }, "Remove"));
  const card = el("fieldset", { class: "entry" }, el("legend", {}, label), head, el("div", { class: "entry-fields" }, ...fields));
  entry.card = card;
  return card;
}

function renderArtifactEntry(entry, index) {
  const kind = "artifacts";
  const id = (part) => `artifacts-e${entry.id}-${part}`;
  entry.inputs = {};
  entry.errorNodes = {};
  const edited = () => refreshContentPane(kind);

  const nameInput = el("input", { type: "text", id: id("name"), spellcheck: "false", autocomplete: "off", placeholder: "snake_case_name" });
  nameInput.value = entry.name;
  nameInput.addEventListener("input", () => { entry.name = nameInput.value; edited(); });
  entry.inputs.name = nameInput;

  const typeSelect = el("select", { id: id("type") });
  const typeHint = el("p", { class: "hint" });
  const types = artifactTypeList();
  for (const type of types) typeSelect.append(el("option", { value: type.name }, type.name));
  if (!types.some((type) => type.name === entry.artType)) {
    typeSelect.append(el("option", { value: entry.artType }, types.length ? `${entry.artType} (not in this preset)` : entry.artType));
  }
  typeSelect.value = entry.artType;
  typeHint.textContent = artifactTypeHint(entry.artType);

  const payloadArea = el("textarea", { id: id("payload"), rows: "3", spellcheck: "false" });
  payloadArea.value = entry.payload;
  payloadArea.addEventListener("input", () => { entry.payload = payloadArea.value; edited(); });
  entry.inputs.payload = payloadArea;

  const poseInputs = el("span", { class: "pose-inputs" });
  const renderPose = () => {
    poseInputs.textContent = "";
    if (entry.poseMode === "cell") {
      const row = el("input", { type: "number", step: "1", inputmode: "numeric", id: id("row"), placeholder: "row", "aria-label": "Row" });
      const col = el("input", { type: "number", step: "1", inputmode: "numeric", id: id("col"), placeholder: "col", "aria-label": "Column" });
      row.value = entry.row;
      col.value = entry.col;
      row.addEventListener("input", () => { entry.row = row.value; edited(); });
      col.addEventListener("input", () => { entry.col = col.value; edited(); });
      poseInputs.append(row, col);
      entry.inputs.pose = [row, col];
    } else {
      const node = el("input", { type: "text", id: id("node"), spellcheck: "false", autocomplete: "off", placeholder: "node id", "aria-label": "Node id" });
      node.value = entry.node;
      node.addEventListener("input", () => { entry.node = node.value; edited(); });
      poseInputs.append(node);
      entry.inputs.pose = [node];
    }
  };
  const modeGroup = el("span", { class: "pose-mode", role: "radiogroup", "aria-label": "Pose kind" });
  for (const [value, text] of [["cell", "cell [row, col]"], ["node", "node id"]]) {
    const radio = el("input", { type: "radio", name: id("pose-mode"), value, id: id(`pose-${value}`) });
    radio.checked = entry.poseMode === value;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      entry.poseMode = value;
      renderPose();
      edited();
    });
    modeGroup.append(el("label", { for: id(`pose-${value}`) }, radio, text));
  }
  renderPose();
  const poseBlock = el("div", { class: "field wide", role: "group", "aria-labelledby": id("pose-label") },
    el("span", { class: "field-label", id: id("pose-label") }, "Pose"),
    el("div", { class: "pose-row" }, modeGroup, poseInputs),
    entryErrorNode(entry, "pose", id("pose")));

  const lifespanInput = el("input", { type: "number", step: "1", min: "-1", inputmode: "numeric", id: id("lifespan") });
  lifespanInput.value = entry.lifespan;
  lifespanInput.addEventListener("input", () => { entry.lifespan = lifespanInput.value; edited(); });
  entry.inputs.lifespan = lifespanInput;

  const movable = makeSwitch(id("movable"), (on) => { entry.movable = on; edited(); }, false);
  movable.setValue(entry.movable);
  movable.input.setAttribute("aria-label", "Movable");
  const movableBlock = el("div", { class: "field" },
    el("span", { class: "field-label" }, "Movable"),
    el("label", { class: "switch-label", for: id("movable") }, movable.el, el("span", { class: "hint" }, "beings can carry it")));

  const paramsBlock = el("div", { class: "params" });
  const renderParams = () => {
    paramsBlock.textContent = "";
    const known = artifactTypeOf(entry.artType)?.params || [];
    for (const name of known) {
      const input = el("input", { type: "text", id: id(`param-${name}`), spellcheck: "false", autocomplete: "off" });
      input.value = name in entry.params ? paramText(entry.params[name]) : "";
      input.addEventListener("input", () => {
        const text = input.value.trim();
        if (text) entry.params[name] = parseLoose(text);
        else delete entry.params[name];
        edited();
      });
      paramsBlock.append(fieldBlock(id(`param-${name}`), name, input, null));
    }
    const extra = el("textarea", { id: id("extra"), rows: "2", spellcheck: "false", class: "json", placeholder: "{}" });
    extra.value = entry.extraText;
    extra.addEventListener("input", () => {
      entry.extraText = extra.value;
      entry.extraError = "";
      const text = extra.value.trim();
      if (!text) {
        entry.extra = {};
      } else {
        try {
          const value = JSON.parse(text);
          const clash = isPlainObject(value) ? Object.keys(value).find((key) => known.includes(key)) : null;
          if (!isPlainObject(value)) entry.extraError = "Other parameters must be a JSON object.";
          else if (clash) entry.extraError = `"${clash}" has its own field above.`;
          else entry.extra = value;
        } catch (error) {
          entry.extraError = `Invalid JSON. ${error.message}`;
        }
      }
      edited();
    });
    entry.inputs.params = extra;
    const label = known.length ? "Other parameters (JSON object)" : "Parameters (JSON object)";
    paramsBlock.append(fieldBlock(id("extra"), label, extra, entryErrorNode(entry, "params", id("extra")), true));
  };
  renderParams();
  typeSelect.addEventListener("change", () => {
    entry.artType = typeSelect.value;
    splitArtifactParams(entry);
    typeHint.textContent = artifactTypeHint(entry.artType);
    renderParams();
    edited();
  });

  const fields = [
    fieldBlock(id("name"), "Name", nameInput, entryErrorNode(entry, "name", id("name"))),
    el("div", { class: "field" }, el("label", { for: id("type") }, "Type"), typeSelect, typeHint),
    fieldBlock(id("payload"), "Payload", payloadArea, entryErrorNode(entry, "payload", id("payload")), true),
    poseBlock,
    el("div", { class: "field" }, el("label", { for: id("lifespan") }, "Lifespan"), lifespanInput,
      el("p", { class: "hint" }, "-1 means forever."), entryErrorNode(entry, "lifespan", id("lifespan"))),
    movableBlock,
    paramsBlock,
  ];
  return entryCard(kind, entry, index, fields);
}

function renderPersonaEntry(entry, index) {
  const kind = "personas";
  const id = (part) => `personas-e${entry.id}-${part}`;
  entry.inputs = {};
  entry.errorNodes = {};
  const edited = () => refreshContentPane(kind);

  const personaArea = el("textarea", { id: id("persona"), rows: "3", placeholder: "You are a healer. You ..." });
  personaArea.value = entry.persona;
  personaArea.addEventListener("input", () => { entry.persona = personaArea.value; edited(); });
  entry.inputs.persona = personaArea;

  const nameInput = el("input", { type: "text", id: id("name"), autocomplete: "off", placeholder: "optional" });
  nameInput.value = entry.name;
  nameInput.addEventListener("input", () => { entry.name = nameInput.value; edited(); });

  const countInput = el("input", { type: "number", step: "1", min: "1", inputmode: "numeric", id: id("count") });
  countInput.value = entry.count;
  countInput.addEventListener("input", () => { entry.count = countInput.value; edited(); });
  entry.inputs.count = countInput;

  const fields = [
    el("div", { class: "field wide" }, el("label", { for: id("persona") }, "Persona (second person, 1 to 4 sentences)"),
      personaArea, entryErrorNode(entry, "persona", id("persona"))),
    fieldBlock(id("name"), "Name", nameInput, null),
    el("div", { class: "field" }, el("label", { for: id("count") }, "Count"), countInput,
      el("p", { class: "hint" }, "How many beings get this persona."), entryErrorNode(entry, "count", id("count"))),
  ];
  return entryCard(kind, entry, index, fields);
}

function renderEntries(kind) {
  const ct = state.content[kind];
  const nodes = contentNodes(kind);
  nodes.entries.textContent = "";
  if (!ct.entries.length) nodes.entries.append(el("p", { class: "empty" }, 'No entries yet. Use "Add entry".'));
  ct.entries.forEach((entry, index) => nodes.entries.append(CONTENT_MODEL[kind].render(entry, index)));
  refreshContentPane(kind);
}

function focusEntry(entry) {
  const input = entry.card?.querySelector("input[type='text'], textarea");
  if (input) input.focus();
}

function addEntry(kind) {
  const entry = CONTENT_MODEL[kind].blank();
  state.content[kind].entries.push(entry);
  renderEntries(kind);
  focusEntry(entry);
}

function duplicateEntry(kind, entry) {
  const ct = state.content[kind];
  const copy = { ...entry, id: ++entrySeq, card: null, inputs: null, errorNodes: null, rest: { ...entry.rest } };
  if (kind === "artifacts") {
    copy.params = { ...entry.params };
    copy.extra = { ...entry.extra };
    if (copy.name.trim()) copy.name = `${copy.name.trim()}_copy`;
  }
  ct.entries.splice(ct.entries.indexOf(entry) + 1, 0, copy);
  renderEntries(kind);
  focusEntry(copy);
}

function removeEntry(kind, entry) {
  const ct = state.content[kind];
  ct.entries.splice(ct.entries.indexOf(entry), 1);
  renderEntries(kind);
  contentNodes(kind).addButton.focus();
}

/* ---- the pane: list, title, buttons, hints ---- */

function contentInfo(kind) {
  const ct = state.content[kind];
  const spec = CONTENT_KINDS[kind];
  const parts = [];
  if (contentInUse(kind)) parts.push(`The launch form uses this ${spec.one} (${contentSetting(kind)}).`);
  if (ct.files && ct.files.length > 1) parts.push(`The folder holds ${plural(ct.files.length, "JSON file", "JSON files")}: ${ct.files.join(", ")}.`);
  if (kind === "artifacts") {
    const types = state.artifactTypes;
    if (types.loading) parts.push("Loading artifact types…");
    else if (types.list) parts.push(`Artifact types ${state.preset ? `with preset ${state.preset}` : "without a preset"}: ${types.list.map((type) => type.name).join(", ")}.`);
    const world = currentWorldType();
    parts.push(`The launch form uses a ${world} world. New entries get a ${world === "grid" ? "cell pose [row, col]" : "node id pose"}.`);
  } else {
    const total = ct.entries.reduce((sum, entry) => sum + Math.max(0, toInt(entry.count) ?? 0), 0);
    const beings = displayValue("env.init_agents");
    parts.push(Number.isFinite(beings)
      ? `${plural(total, "persona", "personas")} for ${plural(beings, "initial being", "initial beings")}.`
      : `${plural(total, "persona", "personas")}.`);
  }
  return parts.join(" ");
}

function refreshContentPane(kind) {
  const ct = state.content[kind];
  const nodes = contentNodes(kind);
  const spec = CONTENT_KINDS[kind];
  const problems = validateContent(kind);
  let problemCount = 0;
  for (const entry of ct.entries) {
    const found = problems.get(entry.id) || {};
    problemCount += Object.keys(found).length;
    for (const [field, node] of Object.entries(entry.errorNodes || {})) {
      const message = found[field] || "";
      node.hidden = !message;
      node.textContent = message;
      for (const input of [].concat(entry.inputs?.[field] || [])) {
        setAttr(input, "aria-invalid", message ? "true" : null);
        setAttr(input, "aria-describedby", message ? node.id : null);
      }
    }
  }
  const dirty = contentDirty(kind);
  const inUse = contentInUse(kind);
  nodes.titleName.textContent = ct.path || `New ${spec.one}`;
  nodes.inUse.hidden = !inUse;
  nodes.unsaved.hidden = !dirty;
  let reason = "";
  if (ct.busy) reason = "Working…";
  else if (problemCount) reason = `Fix ${plural(problemCount, "problem", "problems")} before you save.`;
  else if (!ct.path && ct.entries.length) reason = `Use "Save as…" to save this new ${spec.one}.`;
  else if (ct.path && !ct.writable) reason = "This folder holds several JSON files. Save the set under a new name to change it.";
  else if (ct.path && ct.saved && !dirty) reason = "Nothing changed since the last save.";
  nodes.hint.textContent = reason;
  nodes.saveButton.disabled = ct.busy || !!problemCount || !ct.path || !dirty || !ct.writable;
  nodes.saveAsButton.disabled = ct.busy || !!problemCount;
  nodes.openButton.disabled = ct.busy;
  let note = "";
  if (!state.schema) note = "Waiting for the settings to load.";
  else if (!contentSettingKnown(kind)) note = `This TerraLingua version has no ${kind} setting.`;
  nodes.note.hidden = !note;
  nodes.note.textContent = note;
  nodes.useButton.disabled = ct.busy || !!note || !ct.path || !ct.saved || inUse;
  if (!ct.path || !ct.saved) nodes.useButton.title = `Save the ${spec.one} first.`;
  else if (inUse) nodes.useButton.title = "The launch form uses this file already.";
  else nodes.useButton.title = `Set ${contentSetting(kind)} to ${settingValueFor(kind, ct.path)}`;
  nodes.info.textContent = contentInfo(kind);
  for (const node of [...nodes.items.children, ...$$("[data-path]", nodes.source)]) {
    setAttr(node, "aria-current", node.dataset.path && node.dataset.path === ct.path ? "true" : null);
  }
  nodes.editor.classList.toggle("busy", ct.busy);
  nodes.editor.setAttribute("aria-busy", String(ct.busy));
}

function refreshContentPanes() {
  for (const kind of Object.keys(CONTENT_KINDS)) refreshContentPane(kind);
}

function setContentBusy(kind, busy) {
  state.content[kind].busy = busy;
  refreshContentPane(kind);
}

/* The files found in the suggested folders, grouped by folder. Only the launcher's own files can be deleted here. */
function renderContentList(kind) {
  const ct = state.content[kind];
  const nodes = contentNodes(kind);
  nodes.items.textContent = "";
  if (!ct.items.length) {
    nodes.items.append(el("li", { class: "empty" }, `No ${CONTENT_KINDS[kind].many} found yet.`));
    return;
  }
  let folder = null;
  for (const item of ct.items) {
    if (item.folder !== folder) {
      folder = item.folder;
      nodes.items.append(el("li", { class: "ct-folder" }, folderLabel(folder)));
    }
    const count = ct.counts[item.path];
    nodes.items.append(el("li", { class: "ct-item", "data-path": item.path, "aria-current": item.path === ct.path ? "true" : null },
      el("button", { type: "button", class: "ct-item-name", title: item.path, onclick: () => loadContentPath(kind, item.path) }, item.name),
      el("span", { class: "badge" }, count === undefined ? null : plural(count, "entry", "entries")),
      item.deletable
        ? el("button", { type: "button", class: "danger-ghost mini", "aria-label": `Delete ${item.name}`, onclick: () => deleteContentItem(kind, item) }, "Delete")
        : null));
  }
}

async function loadContentList(kind) {
  const ct = state.content[kind];
  const query = new URLSearchParams();
  for (const folder of suggestedFolders(kind)) query.append("folder", folder.path);
  try {
    ct.items = (await GET(`/api/content/${kind}?${query}`)).items;
  } catch (error) {
    showError(error.message);
    return;
  }
  renderContentList(kind);
}

function confirmDiscard(kind, action) {
  if (!contentDirty(kind)) return true;
  return window.confirm(`The current ${CONTENT_KINDS[kind].one} has unsaved changes. ${action} and lose them?`);
}

/* Shows a file ({name, path, data, files?, writable?}) in the editor as the saved state. */
function showContentItem(kind, result) {
  const ct = state.content[kind];
  const data = Array.isArray(result.data) ? result.data : isPlainObject(result.data) ? [result.data] : [];
  ct.name = result.name;
  ct.path = result.path;
  ct.saved = true;
  ct.writable = result.writable !== false;
  ct.files = Array.isArray(result.files) ? result.files : null;
  ct.entries = data.map((raw) => CONTENT_MODEL[kind].fromFile(raw));
  ct.savedText = JSON.stringify(serializeContent(kind));
  ct.counts[ct.path] = ct.entries.length;
  renderContentList(kind);
  renderContentSource(kind);
  renderEntries(kind);
}

/* Loads a file by its path under the working directory, such as the one the configuration names. */
async function loadContentPath(kind, path, quiet = false) {
  if (!quiet && !confirmDiscard(kind, `Load ${path}`)) return;
  const ct = state.content[kind];
  const seq = ++ct.loadSeq;
  setContentBusy(kind, true);
  try {
    const result = await GET(`/api/files/${kind}?path=${encodeURIComponent(path)}`);
    if (seq !== ct.loadSeq) return;
    showContentItem(kind, result);
    if (!quiet) contentNodes(kind).title.focus();
  } catch (error) {
    showError(error.message);
  } finally {
    if (seq === ct.loadSeq) setContentBusy(kind, false);
  }
}

function resetContentEditor(kind) {
  Object.assign(state.content[kind], { name: null, path: null, saved: false, writable: true, files: null, entries: [], savedText: "[]" });
}

function newContentItem(kind) {
  if (!confirmDiscard(kind, `Start a new ${CONTENT_KINDS[kind].one}`)) return;
  resetContentEditor(kind);
  renderContentList(kind);
  renderContentSource(kind);
  renderEntries(kind);
}

/* An empty editor for a file the configuration names but that does not exist yet. */
function startContentAt(kind, path) {
  if (!confirmDiscard(kind, `Start ${path}`)) return;
  resetContentEditor(kind);
  Object.assign(state.content[kind], { path, name: path.split("/").pop() });
  renderContentList(kind);
  renderContentSource(kind);
  renderEntries(kind);
}

function afterContentSaved(kind, result, data) {
  const ct = state.content[kind];
  ct.name = result.name;
  ct.path = result.path;
  ct.saved = true;
  ct.writable = true;
  ct.files = null;
  ct.savedText = JSON.stringify(data);
  ct.counts[ct.path] = data.length;
  renderContentSource(kind);
  toast(`Saved ${result.path}.`);
  scheduleEvaluate();
}

/* Writes the editor back to its file, wherever it is under the working directory. */
async function saveContent(kind) {
  const ct = state.content[kind];
  if (!ct.path) return;
  const data = serializeContent(kind);
  setContentBusy(kind, true);
  try {
    afterContentSaved(kind, await api("PUT", `/api/files/${kind}`, { path: ct.path, data }), data);
    await loadContentList(kind);
  } catch (error) {
    showError(error.message);
  } finally {
    setContentBusy(kind, false);
  }
}

async function deleteContentItem(kind, item) {
  const ct = state.content[kind];
  if (!window.confirm(`Delete the ${CONTENT_KINDS[kind].one} "${item.name}"? This removes ${item.path} from the working directory.`)) return;
  setContentBusy(kind, true);
  try {
    await api("DELETE", `/api/content/${kind}/${encodeURIComponent(item.name)}`);
    delete ct.counts[item.path];
    if (ct.path === item.path) {
      // the entries stay in the editor as an unsaved new list
      Object.assign(ct, { name: null, path: null, saved: false, writable: true, files: null, savedText: "[]" });
    }
    toast(`Deleted ${item.name}.`);
    scheduleEvaluate();
    await loadContentList(kind);
  } catch (error) {
    showError(error.message);
  } finally {
    setContentBusy(kind, false);
  }
}

/* ---- where files go: the save and open dialogs ---- */

let dialogKind = null;

function dirname(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function folderLabel(folder) {
  return folder ? `${folder}/` : "the working directory";
}

/* A folder or file typed by the user, relative to the working directory ("" is the directory itself);
   null when it lies outside. */
function normalizePath(text) {
  let path = text.trim();
  const workdir = state.settings?.workdir || "";
  if (workdir && path === workdir) return "";
  if (workdir && path.startsWith(`${workdir}/`)) path = path.slice(workdir.length + 1);
  if (path.startsWith("/")) return null;
  path = path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (path === ".") return "";
  if (path.split("/").includes("..")) return null;
  return path;
}

/* The file a name goes to in a folder. The launcher's own folder keeps one subfolder per kind. */
function targetPath(kind, folder, name) {
  const base = folder === "launcher_content" ? `launcher_content/${kind}` : folder;
  const suffix = kind === "artifacts" ? "" : kind === "instructions" ? ".md" : ".json";
  return `${base ? `${base}/` : ""}${name}${suffix}`;
}

function addFolder(list, path, why) {
  if (path === null || path === undefined || list.some((folder) => folder.path === path)) return;
  list.push({ path, why });
}

/* Folders a kind's files can go to, the most natural first: where the setting reads them,
   beside the preset or the current file, then the launcher's own folder. */
function suggestedFolders(kind) {
  const folders = [];
  const source = state.sources[kind];
  const preset = currentPreset();
  const presetFolder = preset && preset.location !== "(built-in)" ? dirname(preset.location) : null;
  if (source?.setting.startsWith(SCENARIO_PREFIX)) addFolder(folders, source.base, "where the scenario reads them");
  else addFolder(folders, presetFolder, "beside the preset");
  if (source?.relative) addFolder(folders, dirname(source.relative), "beside the file in the configuration");
  if (editorState(kind).path) addFolder(folders, dirname(editorState(kind).path), "the folder of the file in the editor");
  addFolder(folders, `launcher_content/${kind}`, "the launcher's own folder");
  return folders;
}

/* The three editors share the save and open dialogs. */
function editorState(kind) {
  return kind === "instructions" ? state.instructions : state.content[kind];
}

function editorData(kind) {
  return kind === "instructions" ? $("#currentInstructionsText").value : serializeContent(kind);
}

function kindLabel(kind) {
  return kind === "instructions" ? "instructions text" : CONTENT_KINDS[kind].one;
}

function afterSaved(kind, result, data) {
  if (kind !== "instructions") {
    afterContentSaved(kind, result, data);
    loadContentList(kind);
    return;
  }
  Object.assign(state.instructions, { path: result.path, name: result.name, savedText: data, saved: true, writable: true });
  toast(`Saved ${result.path}.`);
  scheduleEvaluate();
  refreshInstructionsPanel();
}

/* Folders for the files a design writes: the scenario's folder, the preset's folder, the launcher's own. */
function designFolders() {
  const folders = [];
  const scenario = Object.values(state.sources).find((source) => source.setting.startsWith(SCENARIO_PREFIX) && source.base !== null);
  if (scenario) addFolder(folders, scenario.base, "where the scenario reads its files");
  const preset = currentPreset();
  if (preset && preset.location !== "(built-in)") addFolder(folders, dirname(preset.location), "beside the preset");
  addFolder(folders, "launcher_content", "the launcher's own folder");
  return folders;
}

function folderChips(holder, folders, onPick) {
  holder.textContent = "";
  for (const folder of folders) {
    holder.append(el("button", { type: "button", class: "folder-chip", onclick: () => onPick(folder.path) },
      el("code", {}, folderLabel(folder.path)), ` ${folder.why}`));
  }
}

/* Completion of paths under the working directory, typed relative to it. */
function bindRelativeCompletion(input, list, options) {
  input.addEventListener("input", debounce(async () => {
    const workdir = state.settings?.workdir;
    if (!workdir) return;
    const opts = typeof options === "function" ? options() : options;
    const typed = input.value.trim().replace(/^(\.\/)+/, "");
    const query = new URLSearchParams({ prefix: typed.startsWith("/") ? typed : `${workdir}/${typed}`, dirs_only: String(!!opts.dirsOnly) });
    if (opts.suffix) query.set("suffix", opts.suffix);
    try {
      const result = await GET(`/api/fs?${query}`);
      list.textContent = "";
      for (const path of result.paths) {
        list.append(el("option", { value: path.startsWith(`${workdir}/`) ? path.slice(workdir.length + 1) : path }));
      }
    } catch (error) {
      showError(error.message);
    }
  }, 150));
}

/* A clickable list of the folders and files where the typed path points, under the working directory.
   A folder descends into it, a file fills the input. Returns the function that refreshes the list. */
function bindPathPicker(input, holder, options) {
  let seq = 0;
  const choose = (value, refresh) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (refresh) show();
  };
  async function show() {
    const workdir = state.settings?.workdir;
    if (!workdir) return;
    const opts = typeof options === "function" ? options() : options;
    const typed = input.value.trim().replace(/^(\.\/)+/, "");
    const query = new URLSearchParams({ prefix: typed.startsWith("/") ? typed : `${workdir}/${typed}`, dirs_only: String(!!opts.dirsOnly) });
    if (opts.suffix) query.set("suffix", opts.suffix);
    const mine = ++seq;
    let paths;
    try {
      paths = (await GET(`/api/fs?${query}`)).paths;
    } catch (error) {
      showError(error.message);
      return;
    }
    if (mine !== seq) return;
    holder.textContent = "";
    const listed = typed.includes("/") ? typed.slice(0, typed.lastIndexOf("/")) : "";
    if (listed) {
      const parent = dirname(listed);
      holder.append(el("button", { type: "button", class: "folder up", onclick: () => choose(parent ? `${parent}/` : "", true) }, ".."));
    }
    for (const path of paths) {
      const rel = path.startsWith(`${workdir}/`) ? path.slice(workdir.length + 1) : path;
      const isFolder = rel.endsWith("/");
      const name = rel.slice(rel.lastIndexOf("/", rel.length - 2) + 1);
      holder.append(el("button", { type: "button", class: isFolder ? "folder" : "file", title: rel, onclick: () => choose(rel, isFolder) }, name));
    }
    if (!paths.length) holder.append(el("p", { class: "hint" }, opts.dirsOnly ? "No folders here." : "Nothing here."));
  }
  input.addEventListener("input", debounce(show, 150));
  return show;
}

const pickers = {};

async function fileExists(kind, path) {
  try {
    await GET(`/api/files/${kind}?path=${encodeURIComponent(path)}`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

function openSaveDialog(kind) {
  const ct = editorState(kind);
  dialogKind = kind;
  const folders = suggestedFolders(kind);
  $("#contentSaveTitle").textContent = `Save the ${kindLabel(kind)} as`;
  $("#contentSaveName").value = ct.path ? (ct.name || "").replace(/\.(json|md)$/, "") : "";
  $("#contentSaveFolder").value = folders[0].path;
  folderChips($("#contentSaveChips"), folders, (path) => {
    $("#contentSaveFolder").value = path;
    refreshSaveDialog();
  });
  $("#contentSaveError").hidden = true;
  refreshSaveDialog();
  $("#contentSaveDialog").showModal();
  pickers.save();
}

function saveDialogTarget() {
  const kind = dialogKind;
  const name = $("#contentSaveName").value.trim();
  const folder = normalizePath($("#contentSaveFolder").value);
  let error = "";
  if (!name) error = "Type a name.";
  else if (contentNameError(name)) error = contentNameError(name);
  else if (folder === null) error = "The folder must be inside the working directory.";
  return { kind, name, folder, path: error ? null : targetPath(kind, folder, name), error };
}

function refreshSaveDialog() {
  const { kind, path, error } = saveDialogTarget();
  const preview = $("#contentSavePreview");
  $("#contentSaveConfirm").disabled = !!error;
  if (error) {
    preview.textContent = error;
    return;
  }
  const what = kind === "artifacts" ? `the folder ${path}/ with artifacts.json` : path;
  preview.textContent = `Writes ${what}. "Use in launch" then sets ${contentSetting(kind)} to ${settingValueFor(kind, path)}.`;
}

async function submitSaveDialog(event) {
  event.preventDefault();
  const { kind, path, error } = saveDialogTarget();
  if (error) return;
  const errorNode = $("#contentSaveError");
  const button = $("#contentSaveConfirm");
  button.disabled = true;
  try {
    const replacing = path !== editorState(kind).path && await fileExists(kind, path);
    if (replacing && !window.confirm(`${path} exists. Replace it?`)) return;
    const data = editorData(kind);
    const result = await api("PUT", `/api/files/${kind}`, { path, data });
    $("#contentSaveDialog").close();
    afterSaved(kind, result, data);
  } catch (failure) {
    errorNode.textContent = failure.message;
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function openOpenDialog(kind) {
  dialogKind = kind;
  $("#contentOpenTitle").textContent = kind === "instructions" ? "Open an instructions text" : `Open a ${kindLabel(kind)}`;
  $("#contentOpenPath").value = "";
  $("#contentOpenError").hidden = true;
  $("#contentOpenDialog").showModal();
  pickers.open();
}

async function submitOpenDialog(event) {
  event.preventDefault();
  const kind = dialogKind;
  const errorNode = $("#contentOpenError");
  const path = normalizePath($("#contentOpenPath").value);
  if (!path) {
    errorNode.textContent = "Type the path of a file inside the working directory.";
    errorNode.hidden = false;
    return;
  }
  const allowed = kind === "instructions" ? confirmDiscardInstructions(`Load ${path}`) : confirmDiscard(kind, `Load ${path}`);
  if (!allowed) return;
  try {
    const result = await GET(`/api/files/${kind}?path=${encodeURIComponent(path)}`);
    $("#contentOpenDialog").close();
    if (kind === "instructions") {
      showInstructions(result);
      $("#currentInstructionsText").focus();
    } else {
      showContentItem(kind, result);
      loadContentList(kind);
    }
  } catch (failure) {
    errorNode.textContent = failure.message;
    errorNode.hidden = false;
  }
}

function useContentInLaunch(kind) {
  const ct = state.content[kind];
  const setting = contentSetting(kind);
  if (!ct.path || !ct.saved || !(setting in state.fields)) return;
  const value = settingValueFor(kind, ct.path);
  setOverride(setting, value);
  toast(`Set ${setting} to ${value}`);
  refreshContentPane(kind);
}

function openContentTab(kind) {
  loadContentList(kind);
  if (kind === "artifacts") refreshArtifactTypes();
  renderContentSource(kind);
  refreshContentPane(kind);
}

/* Opens a kind's tab on the file the configuration names. */
function openContentSource(kind) {
  if (kind === "instructions") {
    switchTab("design");
    return;
  }
  switchTab(kind);
  const source = state.sources[kind];
  if (source?.exists && source.inside && state.content[kind].path !== source.relative) loadContentPath(kind, source.relative);
}

/* ---- the file the configuration names ---- */

function sourceKey(source) {
  return source ? JSON.stringify([source.setting, source.path, source.exists]) : "";
}

function renderContentSource(kind) {
  const nodes = contentNodes(kind);
  const spec = CONTENT_KINDS[kind];
  const source = state.sources[kind];
  const ct = state.content[kind];
  const holder = nodes.source;
  holder.textContent = "";
  if (!state.schema) {
    holder.append(el("p", { class: "hint" }, "Waiting for the settings to load."));
    return;
  }
  if (!source) {
    holder.append(el("p", { class: "hint" }, "Known once the configuration is valid."));
    return;
  }
  const setting = el("p", { class: "hint" }, "Named by ", el("code", {}, source.setting), ".");
  if (!source.value) {
    holder.append(el("p", { class: "hint" }, `The configuration names no ${spec.one}.`), setting);
    return;
  }
  const where = source.relative || source.path;
  if (!source.inside) {
    holder.append(el("p", { class: "ct-source-path" }, where),
      el("p", { class: "hint" }, "Outside the working directory. The launcher cannot open it."), setting);
    return;
  }
  if (!source.exists) {
    holder.append(el("p", { class: "ct-source-path" }, where), el("p", { class: "hint" }, "Not found."),
      el("button", { type: "button", class: "mini", onclick: () => startContentAt(kind, where) }, "Create it here"), setting);
    return;
  }
  const count = ct.counts[where];
  const files = source.files && source.files.length !== 1 ? plural(source.files.length, "JSON file", "JSON files") : null;
  holder.append(
    el("div", { class: "ct-item", "data-path": where, "aria-current": where === ct.path ? "true" : null },
      el("button", { type: "button", class: "ct-item-name", title: where, onclick: () => loadContentPath(kind, where) }, where),
      el("span", { class: "badge" }, count === undefined ? files : plural(count, "entry", "entries"))),
    setting);
}

/* The editor of each content tab follows the file the configuration names, unless it holds unsaved changes. */
function followSources() {
  for (const kind of Object.keys(CONTENT_KINDS)) {
    const ct = state.content[kind];
    const source = state.sources[kind] || null;
    const key = sourceKey(source);
    renderContentSource(kind);
    if (key !== ct.seen) {
      ct.seen = key;
      loadContentList(kind);
    }
    if (key === ct.followed || contentDirty(kind)) continue;
    ct.followed = key;
    if (source?.exists && source.inside) {
      if (ct.path !== source.relative) loadContentPath(kind, source.relative, true);
    } else if (ct.path) {
      resetContentEditor(kind);
      renderEntries(kind);
    }
  }
  followInstructions();
  renderDesignFolders();
}

/* ---------------- extra files: registered JSON files, edited as raw JSON ---------------- */

function extraDirty() {
  return state.extra.path !== null && state.extra.text !== (state.extra.savedText ?? "");
}

/* What keeps the current text from being saved: not JSON, or nothing at all. */
function extraProblem() {
  const text = state.extra.text.trim();
  if (!text) return "Type some JSON.";
  try {
    JSON.parse(text);
    return "";
  } catch (error) {
    return `Not valid JSON: ${error.message}`;
  }
}

function confirmDiscardExtra(action) {
  if (!extraDirty()) return true;
  return window.confirm(`${state.extra.path} has unsaved changes. ${action} and lose them?`);
}

function renderExtraList() {
  const holder = $("#extraItems");
  holder.textContent = "";
  if (!state.extra.paths.length) {
    holder.append(el("li", { class: "empty" }, "No files registered yet."));
    return;
  }
  for (const path of state.extra.paths) {
    const info = state.extra.info[path];
    const badge = !info ? null : !info.exists ? "missing" : info.references.length ? "in the configuration" : null;
    holder.append(el("li", { class: "ct-item", "data-path": path, "aria-current": path === state.extra.path ? "true" : null },
      el("button", { type: "button", class: "ct-item-name", title: path, onclick: () => loadExtraFile(path) }, path),
      el("span", { class: "badge" }, badge),
      el("button", { type: "button", class: "danger-ghost mini", "aria-label": `Remove ${path} from the list`, onclick: () => removeExtraFile(path) }, "Remove")));
  }
}

/* The settings whose value points at the file in the editor, from the last valid evaluation. */
function renderExtraReferences() {
  const holder = $("#extraReferences");
  holder.textContent = "";
  if (state.extra.path === null) return;
  const info = state.extra.info[state.extra.path];
  if (!info) {
    holder.append("Which setting names this file is known once the configuration is valid.");
    return;
  }
  if (!info.references.length) {
    holder.append("No setting in the current configuration names this file.");
    return;
  }
  holder.append("Named by ");
  info.references.forEach((setting, index) => {
    if (index) holder.append(" and ");
    holder.append(el("code", {}, setting));
  });
  holder.append(".");
}

function refreshExtraPane() {
  const ex = state.extra;
  const pane = $("#paneFiles");
  const editing = ex.path !== null;
  const problem = editing ? extraProblem() : "";
  const dirty = extraDirty();
  $(".ct-title-name", pane).textContent = ex.path || "No file selected";
  $(".ct-unsaved", pane).hidden = !dirty;
  $("#extraText").hidden = !editing;
  $("#extraEmpty").hidden = editing;
  let reason = "";
  if (ex.busy) reason = "Working…";
  else if (editing && problem) reason = problem;
  else if (editing && ex.savedText === null) reason = "The file does not exist yet. Save creates it.";
  else if (editing && !dirty) reason = "Nothing changed since the last save.";
  $("#extraHint").textContent = reason;
  $("#extraSave").disabled = ex.busy || !editing || !!problem || (!dirty && ex.savedText !== null);
  renderExtraReferences();
  for (const node of $$("[data-path]", $("#extraItems"))) {
    setAttr(node, "aria-current", node.dataset.path === ex.path ? "true" : null);
  }
  const editor = $(".content-editor", pane);
  editor.classList.toggle("busy", ex.busy);
  editor.setAttribute("aria-busy", String(ex.busy));
}

function setExtraBusy(busy) {
  state.extra.busy = busy;
  refreshExtraPane();
}

/* Shows a file in the editor; a missing one starts as an empty list to fill in. */
async function loadExtraFile(path) {
  if (path !== state.extra.path && !confirmDiscardExtra(`Load ${path}`)) return;
  const ex = state.extra;
  const seq = ++ex.loadSeq;
  setExtraBusy(true);
  try {
    const result = await GET(`/api/file?path=${encodeURIComponent(path)}`);
    if (seq !== ex.loadSeq) return;
    ex.path = result.path;
    ex.text = formatJson(result.data);
    ex.savedText = ex.text;
  } catch (error) {
    if (seq !== ex.loadSeq) return;
    if (error.status !== 404) {
      showError(error.message);
      return;
    }
    Object.assign(ex, { path, text: "[]", savedText: null });
  } finally {
    if (seq === ex.loadSeq) {
      $("#extraText").value = ex.text;
      renderExtraList();
      setExtraBusy(false);
    }
  }
}

async function saveExtraFile() {
  const ex = state.extra;
  if (ex.path === null || extraProblem()) return;
  const data = JSON.parse(ex.text.trim());
  setExtraBusy(true);
  try {
    const result = await api("PUT", "/api/file", { path: ex.path, data });
    ex.text = formatJson(data);
    ex.savedText = ex.text;
    $("#extraText").value = ex.text;
    toast(`Saved ${result.path}.`);
    scheduleEvaluate();
  } catch (error) {
    showError(error.message);
  } finally {
    setExtraBusy(false);
  }
}

function openExtraAddDialog() {
  $("#extraAddPath").value = "";
  $("#extraAddError").hidden = true;
  $("#extraAddDialog").showModal();
  pickers.extra();
}

async function submitExtraAdd(event) {
  event.preventDefault();
  const errorNode = $("#extraAddError");
  const typed = normalizePath($("#extraAddPath").value);
  if (!typed) {
    errorNode.textContent = "Type the path of a JSON file inside the working directory.";
    errorNode.hidden = false;
    return;
  }
  try {
    state.extra.paths = (await POST("/api/extra_files", { path: typed })).extra_files;
    $("#extraAddDialog").close();
    renderExtraList();
    scheduleEvaluate();
    loadExtraFile(typed);
  } catch (failure) {
    errorNode.textContent = failure.message;
    errorNode.hidden = false;
  }
}

async function removeExtraFile(path) {
  if (path === state.extra.path && !confirmDiscardExtra(`Remove ${path} from the list`)) return;
  try {
    state.extra.paths = (await api("DELETE", `/api/extra_files?path=${encodeURIComponent(path)}`)).extra_files;
  } catch (error) {
    showError(error.message);
    return;
  }
  if (path === state.extra.path) Object.assign(state.extra, { path: null, text: "", savedText: null });
  delete state.extra.info[path];
  toast(`Removed ${path} from the list. The file stays on disk.`);
  renderExtraList();
  refreshExtraPane();
}

/* A valid evaluation says which files exist and which settings name them. */
function applyExtraInfo(entries) {
  state.extra.info = Object.fromEntries(entries.map((entry) => [entry.path, entry]));
  state.extra.paths = entries.map((entry) => entry.path);
  renderExtraList();
  refreshExtraPane();
}

/* ---------------- scenario AI: a model writes the scenario content ---------------- */

const DESIGN_PARTS = { instructions: "Instructions", personas: "Personas", artifacts: "Artifacts", suggested_params: "Suggested settings" };

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

/* ---- the current instructions: the file the configuration names, editable ---- */

function instructionsDirty() {
  const it = state.instructions;
  return it.savedText !== null && it.writable && $("#currentInstructionsText").value !== it.savedText;
}

function confirmDiscardInstructions(action) {
  if (!instructionsDirty()) return true;
  return window.confirm(`The instructions text has unsaved changes. ${action} and lose them?`);
}

/* Shows a file ({name, path, data}) in the editor as the saved state. */
function showInstructions(result) {
  Object.assign(state.instructions, { path: result.path, name: result.name, savedText: result.data, saved: true, writable: result.writable !== false });
  $("#currentInstructionsText").value = result.data;
  refreshInstructionsPanel();
}

async function loadInstructions(path, quiet = false) {
  if (!quiet && !confirmDiscardInstructions(`Load ${path}`)) return;
  const it = state.instructions;
  const seq = ++it.loadSeq;
  it.busy = true;
  refreshInstructionsPanel();
  try {
    const result = await GET(`/api/files/instructions?path=${encodeURIComponent(path)}`);
    if (seq !== it.loadSeq) return;
    showInstructions(result);
    if (!quiet) $("#currentInstructionsText").focus();
  } catch (error) {
    showError(error.message);
  } finally {
    if (seq === it.loadSeq) {
      it.busy = false;
      refreshInstructionsPanel();
    }
  }
}

function newInstructions() {
  if (!confirmDiscardInstructions("Start a new text")) return;
  Object.assign(state.instructions, { path: null, name: null, savedText: "", saved: false, writable: true });
  $("#currentInstructionsText").value = "";
  refreshInstructionsPanel();
  $("#currentInstructionsText").focus();
}

/* An empty editor for the file the configuration names but that does not exist yet. */
function startInstructionsAt(path) {
  if (!confirmDiscardInstructions(`Start ${path}`)) return;
  const name = path.split("/").pop().replace(/\.[^.]+$/, "");
  Object.assign(state.instructions, { path, name, savedText: "", saved: false, writable: true });
  $("#currentInstructionsText").value = "";
  refreshInstructionsPanel();
  $("#currentInstructionsText").focus();
}

async function saveInstructions() {
  const it = state.instructions;
  if (!it.path || !it.writable) return;
  const text = $("#currentInstructionsText").value;
  it.busy = true;
  refreshInstructionsPanel();
  try {
    afterSaved("instructions", await api("PUT", "/api/files/instructions", { path: it.path, data: text }), text);
  } catch (error) {
    showError(error.message);
  } finally {
    it.busy = false;
    refreshInstructionsPanel();
  }
}

function useInstructionsInLaunch() {
  const it = state.instructions;
  const setting = contentSetting("instructions");
  if (!it.path || !it.saved || !(setting in state.fields)) return;
  const value = settingValueFor("instructions", it.path);
  setOverride(setting, value);
  toast(`Set ${setting} to ${value}`);
  refreshInstructionsPanel();
}

function instructionsInUse() {
  const it = state.instructions;
  const source = state.sources.instructions;
  return !!it.path && it.saved && !!source && source.relative === it.path;
}

/* The editor follows the file the configuration names, unless it holds unsaved changes. */
function followInstructions() {
  const it = state.instructions;
  const source = state.sources.instructions || null;
  const key = sourceKey(source);
  if (key !== it.followed && !instructionsDirty()) {
    it.followed = key;
    if (source?.exists && source.inside) {
      if (it.path !== source.relative) loadInstructions(source.relative, true);
    } else if (source?.exists && typeof source.text === "string") {
      // outside the working directory: shown as the server read it, not editable
      Object.assign(it, { path: null, name: null, savedText: source.text, saved: false, writable: false });
      $("#currentInstructionsText").value = source.text;
    } else if (it.savedText !== null) {
      Object.assign(it, { path: null, name: null, savedText: null, saved: false, writable: false });
      $("#currentInstructionsText").value = "";
    }
  }
  refreshInstructionsPanel();
}

function refreshInstructionsPanel() {
  const it = state.instructions;
  const source = state.sources.instructions;
  const area = $("#currentInstructionsText");
  const line = $("#currentInstructionsSource");
  const editing = it.savedText !== null;
  const dirty = instructionsDirty();
  const inUse = instructionsInUse();
  line.textContent = "";
  if (!state.schema) {
    line.textContent = "Waiting for the settings to load.";
  } else if (!source) {
    line.textContent = "Known once the configuration is valid.";
  } else {
    const setting = el("code", {}, source.setting);
    const where = source.relative || source.path;
    if (!source.value || source.builtin === "none") line.append("No instructions text: ", setting, source.value ? ' is "none". ' : " is not set. ", 'Use "New" to write one.');
    else if (source.builtin) line.append(`TerraLingua's built-in text "${source.builtin}", named by `, setting, '. The launcher cannot show it; use "New" to write your own.');
    else if (!source.exists) line.append(setting, ` points at ${where}, which does not exist. `, source.inside ? el("button", { type: "button", class: "mini", onclick: () => startInstructionsAt(where) }, "Create it here") : "");
    else if (!source.inside) line.append(`From ${where}, named by `, setting, ". Outside the working directory, so it cannot be changed here.");
    else line.append(`From ${where}, named by `, setting, ".");
  }
  area.hidden = !editing;
  area.disabled = it.busy || (editing && !it.writable);
  let what = "";
  if (editing && !it.writable) what = "A copy can be saved under the working directory with \"Save as…\".";
  else if (editing && !it.path) what = `A new text${dirty ? ", unsaved" : ""}. Use "Save as…" to write it to a file.`;
  else if (editing) what = `${it.path}${inUse ? " (in the configuration)" : ""}${dirty ? " (unsaved)" : it.saved ? "" : " (not written yet)"}`;
  $("#instructionsHint").textContent = what;
  $("#instructionsSave").disabled = it.busy || !editing || !it.path || !it.writable || !dirty;
  $("#instructionsSaveAs").disabled = it.busy || !editing;
  $("#instructionsOpen").disabled = it.busy;
  $("#instructionsNew").disabled = it.busy;
  const use = $("#instructionsUse");
  use.disabled = it.busy || !it.path || !it.saved || inUse || !contentSettingKnown("instructions");
  if (!it.path || !it.saved) use.title = "Save the text to a file first.";
  else if (inUse) use.title = "The launch form uses this file already.";
  else use.title = `Set ${contentSetting("instructions")} to ${settingValueFor("instructions", it.path)}`;
}

function defaultDesignName(description) {
  return description.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3).join("_").replace(/[^a-z0-9_]/g, "");
}

function onDesignDescriptionInput() {
  if (!state.designNameTouched) $("#designName").value = defaultDesignName($("#designDescription").value);
  refreshDesignActions();
}

function onDesignNameInput() {
  state.designNameTouched = $("#designName").value !== "";
  refreshDesignActions();
}

function onDesignFolderInput() {
  state.designFolderTouched = $("#designFolder").value !== "";
  refreshDesignActions();
}

/* The folder the design's files go to: suggested from the configuration unless the user typed one. */
function renderDesignFolders() {
  const folders = designFolders();
  folderChips($("#designFolderChips"), folders, (path) => {
    $("#designFolder").value = path;
    state.designFolderTouched = true;
    refreshDesignActions();
  });
  if (!state.designFolderTouched) $("#designFolder").value = folders[0].path;
  refreshDesignActions();
}

/* The design as the page shows it now: the model's reply with the edited instructions text. */
function currentDesign() {
  return { ...state.design.design, instructions: $("#designInstructions").value };
}

function designIssues() {
  return listOf(state.design?.issues);
}

/* The server's issue about one suggested setting, found by the path in its message. */
function paramIssue(path) {
  const found = designIssues().find((issue) => issue.where === "suggested_params"
    && (issue.message.includes(`'${path}'`) || issue.message.includes(` ${path} `)));
  if (found) return found;
  return path in state.fields ? null : { where: "suggested_params", message: "This setting does not exist." };
}

function designCard(title, pairs) {
  const list = el("dl", {});
  for (const [term, value] of pairs) {
    if (value === undefined || value === null || value === "") continue;
    list.append(el("dt", {}, term), el("dd", {}, typeof value === "string" ? value : formatJson(value)));
  }
  return el("div", { class: "design-card" }, el("h3", {}, title), list);
}

function personaCard(entry, index) {
  return designCard(`Persona ${index + 1}`, [["Persona", entry.persona], ["Name", entry.name], ["Count", entry.count]]);
}

function artifactCard(entry, index) {
  const params = isPlainObject(entry.params) && Object.keys(entry.params).length ? entry.params : undefined;
  return designCard(entry.name || `Artifact ${index + 1}`, [
    ["Type", entry.art_type], ["Payload", entry.payload], ["Pose", entry.pose], ["Lifespan", entry.lifespan],
    ["Movable", entry.movable === false ? "no" : "yes"], ["Params", params],
  ]);
}

function renderDesignCards(holder, entries, toCard, emptyText) {
  holder.textContent = "";
  if (!entries.length) holder.append(el("p", { class: "hint" }, emptyText));
  entries.forEach((entry, index) => holder.append(toCard(isPlainObject(entry) ? entry : {}, index)));
}

/* One table row per suggested setting. A setting with an issue is unchecked and disabled. */
function renderDesignParams(entries, attached) {
  const body = $("#designParams tbody");
  body.textContent = "";
  $("#designParams").hidden = !entries.length;
  $("#designParamsEmpty").hidden = !!entries.length;
  entries.forEach((raw, index) => {
    const entry = isPlainObject(raw) ? raw : {};
    const path = String(entry.path ?? "");
    const issue = paramIssue(path);
    if (issue) attached.add(issue);
    const id = `design-param-${index}`;
    body.append(el("tr", {},
      el("td", {}, el("input", { type: "checkbox", id, "data-index": String(index), checked: !issue, disabled: !!issue })),
      el("td", {}, el("label", { for: id }, el("code", {}, path))),
      el("td", {}, el("code", {}, formatValue(entry.value))),
      el("td", {}, entry.why || "", issue ? el("span", { class: "entry-error" }, issue.message) : null)));
  });
}

function renderDesignIssues(attached) {
  const list = $("#designIssues");
  const shown = designIssues().filter((issue) => !attached.has(issue));
  list.textContent = "";
  $("#designIssuesPanel").hidden = !shown.length;
  for (const issue of shown) list.append(el("li", {}, el("strong", {}, DESIGN_PARTS[issue.where] || issue.where), issue.message));
}

function renderDesign() {
  const design = state.design?.design;
  $("#designResult").hidden = !design;
  if (design) {
    $("#designNotes").textContent = typeof design.design_notes === "string" && design.design_notes ? design.design_notes : "No notes.";
    $("#designInstructions").value = typeof design.instructions === "string" ? design.instructions : "";
    renderDesignCards($("#designPersonas"), listOf(design.personas), personaCard, "No personas.");
    renderDesignCards($("#designArtifacts"), listOf(design.artifacts), artifactCard, "No artifacts.");
    const attached = new Set();
    renderDesignParams(listOf(design.suggested_params), attached);
    renderDesignIssues(attached);
  }
  refreshDesignActions();
}

function refreshDesignActions() {
  const name = $("#designName").value.trim();
  const blocking = designIssues().some((issue) => issue.where !== "suggested_params");
  let reason = "";
  if (blocking) reason = "The design has problems. Ask for changes under Refine.";
  else if (!name) reason = "Type a name for the content files.";
  else if (contentNameError(name)) reason = contentNameError(name);
  else if (normalizePath($("#designFolder").value) === null) reason = "The folder must be inside the working directory.";
  else if (!$("#designInstructions").value.trim()) reason = "The instructions text is empty.";
  $("#designBtn").disabled = state.designBusy;
  $("#designRefine").disabled = state.designBusy || !state.design || !$("#designFeedback").value.trim();
  $("#designApply").disabled = state.designBusy || !state.design || !!reason;
  $("#designApplyHint").textContent = state.design ? reason : "";
}

function setDesignBusy(text) {
  state.designBusy = !!text;
  $("#designStatus").textContent = text;
  refreshDesignActions();
}

function showDesignError(message) {
  showError(message);
  const node = $("#designError");
  node.textContent = message;
  node.hidden = false;
}

async function requestDesign(refine) {
  const body = {
    description: $("#designDescription").value,
    model: $("#designModel").value.trim(),
    api_key: $("#designKey").value,
    preset: state.preset,
    overrides: state.overrides,
  };
  if (refine) Object.assign(body, { previous: currentDesign(), feedback: $("#designFeedback").value.trim() });
  $("#designError").hidden = true;
  setDesignBusy("Asking the model… this takes a minute.");
  try {
    state.design = await POST("/api/design", body);
    if (refine) $("#designFeedback").value = "";
    renderDesign();
  } catch (error) {
    showDesignError(error.message);
  } finally {
    setDesignBusy("");
  }
}

/* Writes the content files into the chosen folder, then sets every override at once and evaluates once. */
async function applyDesign() {
  const name = $("#designName").value.trim();
  const folder = normalizePath($("#designFolder").value);
  const design = currentDesign();
  const writes = [["instructions", design.instructions]];
  if (listOf(design.personas).length) writes.push(["personas", design.personas]);
  if (listOf(design.artifacts).length) writes.push(["artifacts", design.artifacts]);
  $("#designError").hidden = true;
  setDesignBusy("Saving the files…");
  try {
    const targets = writes.map(([kind]) => targetPath(kind, folder, name));
    const existing = await Promise.all(targets.map((path, index) => fileExists(writes[index][0], path)));
    const taken = targets.filter((path, index) => existing[index]);
    if (taken.length && !window.confirm(`${taken.join(", ")} ${taken.length === 1 ? "exists" : "exist"}. Replace?`)) return;
    const values = {};
    for (const [index, [kind, data]] of writes.entries()) {
      const result = await api("PUT", `/api/files/${kind}`, { path: targets[index], data });
      if (contentSettingKnown(kind)) values[contentSetting(kind)] = settingValueFor(kind, result.path);
      if (!(kind in CONTENT_KINDS)) continue;
      if (state.content[kind].path === result.path) showContentItem(kind, { ...result, data });
      loadContentList(kind);
    }
    const suggested = listOf(design.suggested_params);
    for (const box of $$("#designParams input:checked:not(:disabled)")) {
      const entry = suggested[Number(box.dataset.index)];
      values[entry.path] = entry.value;
    }
    for (const [path, value] of Object.entries(values)) {
      delete state.jsonErrors[path];
      putOverride(path, value);
    }
    afterChange();
    toast(`Applied ${name}`);
    switchTab("launch");
  } catch (error) {
    showDesignError(error.message);
  } finally {
    setDesignBusy("");
  }
}

function clearDesign() {
  if (state.design && !window.confirm("Clear the design and the description?")) return;
  state.design = null;
  state.designNameTouched = false;
  state.designFolderTouched = false;
  $("#designForm").reset();
  $("#designFeedback").value = "";
  $("#designError").hidden = true;
  renderDesignFolders();
  renderDesign();
}

/* ---------------- console ---------------- */

function statusKind(status) {
  if (status === "running" || status === "finished") return status;
  return status.startsWith("exited") ? "exited" : "stopped";
}

async function pollProcs() {
  try {
    state.procs = (await GET("/api/procs")).procs;
  } catch (error) {
    if (error.message !== state.pollError) {
      state.pollError = error.message;
      showError(error.message);
    }
    return;
  }
  if (state.pollError !== null) {
    if ($("#errorText").textContent === state.pollError) hideError();
    state.pollError = null;
  }
  renderProcs();
}

function urlLink(url) {
  return el("a", { class: "proc-link", href: url, target: "_blank", rel: "noopener", title: "Opens in a new tab" }, url);
}

function procNode(proc) {
  let node = state.procNodes.get(proc.id);
  if (node) return node;
  const dot = el("span", { class: "dot", "aria-hidden": "true" });
  const status = el("span", { class: "proc-status" });
  const time = el("span", { class: "proc-time" });
  const stopButton = el("button", { type: "button", onclick: () => stopProc(proc.id, false) }, "Stop");
  const killButton = el("button", { type: "button", class: "danger-ghost", onclick: () => stopProc(proc.id, true) }, "Kill");
  const label = el("span", { class: "proc-label" });
  const cmd = el("code", { class: "proc-cmd" });
  const li = el("li", { class: "proc", "data-id": String(proc.id) },
    el("div", { class: "proc-head" }, dot, label, status, time, proc.url ? urlLink(proc.url) : null),
    cmd,
    el("div", { class: "proc-actions" },
      el("button", { type: "button", onclick: () => selectProc(proc.id) }, "View log"),
      stopButton, killButton));
  node = { li, dot, label, cmd, status, time, stopButton, killButton };
  state.procNodes.set(proc.id, node);
  return node;
}

function updateProcNode(proc) {
  const node = procNode(proc);
  const kind = statusKind(proc.status);
  node.dot.className = `dot ${kind}`;
  node.label.textContent = proc.label;
  node.cmd.textContent = proc.cmd;
  node.cmd.title = proc.cmd;
  node.status.textContent = proc.status;
  node.time.textContent = `started ${formatTime(proc.started_at)}`;
  node.stopButton.hidden = kind !== "running";
  node.killButton.hidden = kind !== "running";
  setAttr(node.li, "aria-current", proc.id === state.selectedProc ? "true" : null);
}

function renderProcs() {
  const list = $("#procList");
  const running = state.procs.filter((p) => p.status === "running").length;
  const badge = $("#consoleBadge");
  badge.textContent = running ? String(running) : "";
  badge.classList.toggle("live", running > 0);
  if (!state.procs.length) {
    state.procNodes.clear();
    list.textContent = "";
    list.append(el("li", { class: "empty" }, "Nothing launched yet."));
    return;
  }
  const wanted = state.procs.map((p) => p.id);
  const current = Array.from(list.children).map((li) => Number(li.dataset.id));
  const sameOrder = wanted.length === current.length && wanted.every((id, index) => id === current[index]);
  if (!sameOrder) {
    list.textContent = "";
    for (const proc of state.procs) list.append(procNode(proc).li);
  }
  for (const proc of state.procs) updateProcNode(proc);
  for (const id of [...state.procNodes.keys()]) {
    if (!wanted.includes(id)) state.procNodes.delete(id);
  }
}

function selectProc(id) {
  state.selectedProc = id;
  state.logSeq++;
  state.logOffset = 0;
  state.logDone = false;
  state.logError = null;
  $("#logView").textContent = "";
  $("#logStatus").textContent = "";
  const proc = state.procs.find((p) => p.id === id);
  const title = $("#logTitle");
  title.textContent = proc ? `Log of ${proc.label}` : "Log";
  if (proc?.url) title.append(" ", urlLink(proc.url));
  renderProcs();
  pollLog();
}

function dropLogSelection() {
  state.selectedProc = null;
  state.logSeq++;
  $("#logTitle").textContent = "Log";
  $("#logStatus").textContent = "";
  renderProcs();
}

async function stopProc(id, force) {
  try {
    await POST(`/api/procs/${id}/stop?force=${force}`);
    toast(force ? "Kill signal sent." : "Stop signal sent.");
    await pollProcs();
  } catch (error) {
    showError(error.message);
  }
}

function scrollLogToEnd() {
  const view = $("#logView");
  view.scrollTop = view.scrollHeight;
}

function appendLog(text) {
  const view = $("#logView");
  view.textContent += text;
  if (view.textContent.length > LOG_LIMIT) view.textContent = view.textContent.slice(-LOG_KEEP);
  if (state.follow) scrollLogToEnd();
}

async function pollLog() {
  if (state.logBusy || state.logDone || state.selectedProc === null || state.tab !== "console") return;
  state.logBusy = true;
  const id = state.selectedProc;
  const seq = state.logSeq;
  try {
    const result = await GET(`/api/procs/${id}/log?offset=${state.logOffset}`);
    if (seq !== state.logSeq) return;
    state.logOffset = result.offset;
    state.logError = null;
    if (result.text) appendLog(result.text);
    $("#logStatus").textContent = result.status;
    if (result.status !== "running" && !result.text) state.logDone = true;
  } catch (error) {
    if (seq !== state.logSeq) return;
    if (error.status === 404) {
      dropLogSelection();
      showError(`The log of process ${id} is not available: ${error.message}`);
    } else if (error.message !== state.logError) {
      state.logError = error.message;
      showError(`The log of process ${id} could not be read: ${error.message}`);
    }
  } finally {
    state.logBusy = false;
  }
}

/* ---------------- tabs, persistence, boot ---------------- */

function switchTab(name) {
  state.tab = name;
  for (const tab of $$(".tab")) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const pane of $$(".pane")) pane.hidden = pane.dataset.tab !== name;
  if (name === "console") {
    pollProcs();
    pollLog();
  }
  if (name in CONTENT_KINDS) openContentTab(name);
  if (name === "files") {
    renderExtraList();
    refreshExtraPane();
  }
  if (name === "design") renderDesignFolders();
}

function onTabKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const tabs = $$(".tab");
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  switchTab(next.dataset.tab);
}

function formState() {
  return { preset: state.preset, overrides: state.overrides, resume: state.resume };
}

const persistState = debounce(async () => {
  if (!state.loaded) return;
  try {
    await POST("/api/state", formState());
  } catch (error) {
    showError(error.message);
  }
}, PERSIST_DELAY);

function persistOnHide() {
  if (!state.loaded || !navigator.sendBeacon) return;
  navigator.sendBeacon("/api/state", new Blob([JSON.stringify(formState())], { type: "application/json" }));
}

function bindEvents() {
  $("#errorDismiss").addEventListener("click", hideError);
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsCancel").addEventListener("click", () => $("#settingsDialog").close());
  $("#settingsForm").addEventListener("submit", saveSettings);
  bindPathCompletion($("#settingsWorkdir"), $("#workdirList"), true);
  bindPathCompletion($("#settingsPython"), $("#pythonList"), false);
  for (const tab of $$(".tab")) tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  $(".tabs").addEventListener("keydown", onTabKey);
  $("#presetSelect").addEventListener("change", onPresetChange);
  $("#searchBox").addEventListener("input", (event) => {
    state.search = event.target.value;
    state.pinned = null;
    refreshRows();
  });
  $("#showInactive").addEventListener("change", (event) => {
    state.showInactive = event.target.checked;
    refreshRows();
  });
  $("#resetAll").addEventListener("click", resetAll);
  $("#resumeSwitch").addEventListener("change", (event) => {
    state.resume = event.target.checked;
    persistState();
    refreshPreview();
  });
  $("#form").addEventListener("focusout", () => refreshRows());
  $("#copyCmd").addEventListener("click", copyCommand);
  $("#savePresetBtn").addEventListener("click", openSavePreset);
  $("#savePresetCancel").addEventListener("click", () => $("#savePresetDialog").close());
  $("#savePresetForm").addEventListener("submit", savePreset);
  $("#updatePresetBtn").addEventListener("click", openUpdatePreset);
  $("#updatePresetCancel").addEventListener("click", () => $("#updatePresetDialog").close());
  $("#updatePresetForm").addEventListener("submit", updatePreset);
  $("#launchBtn").addEventListener("click", launch);
  $("#launchForm").addEventListener("submit", confirmLaunch);
  $("#launchCancel").addEventListener("click", () => $("#launchDialog").close());
  $("#followSwitch").addEventListener("change", (event) => {
    state.follow = event.target.checked;
    if (state.follow) scrollLogToEnd();
  });
  $("#logView").addEventListener("wheel", (event) => {
    if (event.deltaY < 0 && state.follow) {
      state.follow = false;
      $("#followSwitch").checked = false;
    }
  });
  $("#clearLog").addEventListener("click", () => { $("#logView").textContent = ""; });
  $("#designForm").addEventListener("submit", (event) => {
    event.preventDefault();
    requestDesign(false);
  });
  $("#designDescription").addEventListener("input", onDesignDescriptionInput);
  $("#designName").addEventListener("input", onDesignNameInput);
  $("#designInstructions").addEventListener("input", refreshDesignActions);
  $("#designFeedback").addEventListener("input", refreshDesignActions);
  $("#designRefine").addEventListener("click", () => requestDesign(true));
  $("#designApply").addEventListener("click", applyDesign);
  $("#designClear").addEventListener("click", clearDesign);
  for (const kind of Object.keys(CONTENT_KINDS)) {
    const nodes = contentNodes(kind);
    nodes.newButton.addEventListener("click", () => newContentItem(kind));
    nodes.openButton.addEventListener("click", () => openOpenDialog(kind));
    nodes.saveAsButton.addEventListener("click", () => openSaveDialog(kind));
    nodes.saveButton.addEventListener("click", () => saveContent(kind));
    nodes.addButton.addEventListener("click", () => addEntry(kind));
    nodes.useButton.addEventListener("click", () => useContentInLaunch(kind));
  }
  $("#contentSaveForm").addEventListener("submit", submitSaveDialog);
  $("#contentSaveCancel").addEventListener("click", () => $("#contentSaveDialog").close());
  $("#contentSaveName").addEventListener("input", refreshSaveDialog);
  $("#contentSaveFolder").addEventListener("input", refreshSaveDialog);
  pickers.save = bindPathPicker($("#contentSaveFolder"), $("#contentSavePicker"), { dirsOnly: true });
  $("#contentOpenForm").addEventListener("submit", submitOpenDialog);
  $("#contentOpenCancel").addEventListener("click", () => $("#contentOpenDialog").close());
  pickers.open = bindPathPicker($("#contentOpenPath"), $("#contentOpenPicker"), () => (
    dialogKind === "artifacts" ? { dirsOnly: true } : { suffix: dialogKind === "instructions" ? ".md" : ".json" }
  ));
  $("#currentInstructionsText").addEventListener("input", refreshInstructionsPanel);
  $("#instructionsNew").addEventListener("click", newInstructions);
  $("#instructionsOpen").addEventListener("click", () => openOpenDialog("instructions"));
  $("#instructionsSave").addEventListener("click", saveInstructions);
  $("#instructionsSaveAs").addEventListener("click", () => openSaveDialog("instructions"));
  $("#instructionsUse").addEventListener("click", useInstructionsInLaunch);
  $("#extraAddBtn").addEventListener("click", openExtraAddDialog);
  $("#extraAddForm").addEventListener("submit", submitExtraAdd);
  $("#extraAddCancel").addEventListener("click", () => $("#extraAddDialog").close());
  pickers.extra = bindPathPicker($("#extraAddPath"), $("#extraAddPicker"), { suffix: ".json" });
  $("#extraSave").addEventListener("click", saveExtraFile);
  $("#extraText").addEventListener("input", (event) => {
    state.extra.text = event.target.value;
    refreshExtraPane();
  });
  $("#designFolder").addEventListener("input", onDesignFolderInput);
  bindRelativeCompletion($("#designFolder"), $("#designFolderList"), { dirsOnly: true });
  window.addEventListener("pagehide", persistOnHide);
}

async function boot() {
  bindEvents();
  for (const kind of Object.keys(CONTENT_KINDS)) {
    renderEntries(kind);
    renderContentSource(kind);
  }
  refreshInstructionsPanel();
  try {
    state.settings = await GET("/api/settings");
  } catch (error) {
    showError(error.message);
  }
  renderHeader();
  state.extra.paths = Array.isArray(state.settings?.extra_files) ? state.settings.extra_files : [];
  renderExtraList();
  refreshExtraPane();
  const last = state.settings?.last || {};
  state.overrides = isPlainObject(last.overrides) ? last.overrides : {};
  state.resume = !!last.resume;
  $("#resumeSwitch").checked = state.resume;
  const presetsOk = await loadPresets();
  const found = state.presets.some((p) => p.name === last.preset);
  const wanted = presetsOk && !found ? null : last.preset || null;
  if (presetsOk && last.preset && !found) {
    state.overrides = {};
    toast(`The saved preset "${last.preset}" was not found. Starting from the defaults.`);
  }
  await selectPreset(wanted);
  if (!state.schema && wanted) await selectPreset(null);
  pollProcs();
  setInterval(pollProcs, 2000);
  setInterval(pollLog, 1000);
}

boot();
