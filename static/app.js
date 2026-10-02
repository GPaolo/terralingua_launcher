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
  state.toastTimer = setTimeout(() => { node.hidden = true; }, 2500);
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
  $("#settingsError").hidden = true;
  $("#settingsDialog").showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const errorNode = $("#settingsError");
  const saveButton = $("#settingsSave");
  saveButton.disabled = true;
  try {
    state.settings = await POST("/api/settings", {
      workdir: $("#settingsWorkdir").value.trim(),
      python: $("#settingsPython").value.trim(),
    });
    $("#settingsDialog").close();
    renderHeader();
    state.schemaCache = {};
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
  try {
    state.presets = (await GET("/api/presets")).presets;
  } catch (error) {
    state.presets = [];
    showError(error.message);
  }
  renderPresetOptions();
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
    buildForm();
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
    if (load === state.loadSeq) setFormBusy(false);
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

function setOverride(path, value) {
  const holder = overrideHolder(path);
  if (holder) {
    setNested(state.overrides[holder], relativeKeys(holder, path), value);
  } else if (path in state.base && sameValue(value, state.base[path])) {
    delete state.overrides[path];
  } else {
    state.overrides[path] = value;
  }
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
  if (path in state.base) return state.base[path];
  const values = state.evaluation?.values;
  if (values && path in values) return values[path];
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
  const row = el("div", { class: "row", "data-path": path },
    label,
    el("div", { class: "row-control" }, control.el),
    el("div", { class: "row-actions" }, reset, detailsButton),
    reasonNode, errorNode, detailsNode);
  state.rows[path] = { path, section, el: row, control, reset, detailsButton, changedMark, reasonNode, errorNode, errorText, detailsNode };
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

function applyEvaluationResult(result, seq) {
  if (seq !== state.evalSeq) return;
  state.evalPending = false;
  state.evalValid = !!(result && result.valid);
  state.diagnostics = result ? result.diagnostics || [] : [];
  if (state.evalValid) {
    state.evaluation = {
      states: result.fields || {},
      values: collectValues(result),
      derived: result.derived || {},
    };
    renderDerived();
  }
  renderDiagnostics(result !== null);
  $("#statesNote").hidden = state.evalValid || !state.evaluation;
  refreshRows();
  updateActionButtons();
  refreshPreview();
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
  $("#launchHint").textContent = reason;
}

/* ---------------- launch and save ---------------- */

async function launch() {
  $("#launchBtn").disabled = true;
  try {
    const result = await POST("/api/launch", { preset: state.preset, overrides: state.overrides, resume: state.resume });
    toast(`Started ${result.proc.label}.`);
    state.procs = [result.proc, ...state.procs.filter((p) => p.id !== result.proc.id)];
    selectProc(result.proc.id);
    switchTab("console");
  } catch (error) {
    showError(error.message);
  } finally {
    updateActionButtons();
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
    const kept = state.overrides;
    state.overrides = {};
    state.jsonErrors = {};
    state.schemaCache = {};
    await loadPresets();
    const ok = await selectPreset(name);
    if (!ok) {
      state.overrides = kept;
      afterChange();
      return;
    }
    persistState();
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    confirmButton.disabled = false;
  }
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
    el("div", { class: "proc-head" }, dot, label, status, time),
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
  $("#logTitle").textContent = proc ? `Log of ${proc.label}` : "Log";
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
  $("#paneLaunch").hidden = name !== "launch";
  $("#paneConsole").hidden = name !== "console";
  if (name === "console") {
    pollProcs();
    pollLog();
  }
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
  try {
    await POST("/api/state", formState());
  } catch (error) {
    showError(error.message);
  }
}, PERSIST_DELAY);

function persistOnHide() {
  if (!navigator.sendBeacon) return;
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
  $("#launchBtn").addEventListener("click", launch);
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
  window.addEventListener("pagehide", persistOnHide);
}

async function boot() {
  bindEvents();
  try {
    state.settings = await GET("/api/settings");
  } catch (error) {
    showError(error.message);
  }
  renderHeader();
  const last = state.settings?.last || {};
  state.overrides = isPlainObject(last.overrides) ? last.overrides : {};
  state.resume = !!last.resume;
  $("#resumeSwitch").checked = state.resume;
  await loadPresets();
  const found = state.presets.some((p) => p.name === last.preset);
  const wanted = found ? last.preset : null;
  if (last.preset && !found) {
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
