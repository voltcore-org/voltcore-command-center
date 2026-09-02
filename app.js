const API = "https://core-api.dominic-calandro1991.workers.dev/api/v1/events";
const ANOMALY = new Set(["critical", "fatal", "high", "error"]);

const state = {
  events: [],
  fetchedAt: null,
  error: null,
  query: "",
  severity: "all",
  source: "all",
  openId: null,
};

function isAnomaly(sev) {
  return ANOMALY.has(String(sev || "").toLowerCase());
}
function tone(sev) {
  const s = String(sev || "").toLowerCase();
  if (ANOMALY.has(s)) return "danger";
  if (s === "warn" || s === "warning" || s === "medium") return "warn";
  return "ok";
}
function preview(payload) {
  if (payload == null) return "—";
  if (typeof payload === "string") return payload;
  try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
}
function clock(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function ago(iso, now = Date.now()) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function load() {
  try {
    const res = await fetch(API + "?limit=150", { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    state.events = Array.isArray(data.events) ? data.events : [];
    state.fetchedAt = data.fetched_at || new Date().toISOString();
    state.error = null;
  } catch (err) {
    state.error = err.message || "Fetch failed";
  }
  render();
}

function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.events.filter((ev) => {
    if (state.severity === "anomaly" && !isAnomaly(ev.severity)) return false;
    if (state.severity !== "all" && state.severity !== "anomaly" && String(ev.severity || "").toLowerCase() !== state.severity) return false;
    if (state.source !== "all" && ev.source !== state.source) return false;
    if (!q) return true;
    return [ev.source, ev.event_type, ev.severity, preview(ev.payload)].join(" ").toLowerCase().includes(q);
  });
}

function chip(label, active, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip" + (active ? " active" : "");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function render() {
  const now = Date.now();
  const live = !state.error && Boolean(state.fetchedAt);
  const pill = document.getElementById("livePill");
  pill.textContent = live ? "LIVE" : "OFFLINE";
  pill.className = "pill " + (live ? "on" : "off");

  const sources = Array.from(new Set(state.events.map((e) => e.source).filter(Boolean))).sort();
  const rows = filtered();
  const anoms = state.events.filter((e) => isAnomaly(e.severity)).length;

  document.getElementById("statCount").textContent = String(state.events.length);
  document.getElementById("statAnom").textContent = String(anoms);
  document.getElementById("statSources").textContent = String(sources.length);
  document.getElementById("statLast").textContent = state.events[0] ? ago(state.events[0].created_at, now) : "—";

  const err = document.getElementById("errorBox");
  if (state.error) {
    err.hidden = false;
    err.textContent = "Telemetry link failed: " + state.error + " — deploy core-api GET /api/v1/events.";
  } else {
    err.hidden = true;
  }

  const sev = document.getElementById("sevChips");
  sev.replaceChildren();
  ["all", "anomaly", "error", "info"].forEach((key) => {
    sev.appendChild(chip(key, state.severity === key, () => { state.severity = key; render(); }));
  });
  const src = document.getElementById("srcChips");
  src.replaceChildren();
  src.appendChild(chip("all sources", state.source === "all", () => { state.source = "all"; render(); }));
  sources.forEach((name) => {
    src.appendChild(chip(name, state.source === name, () => { state.source = name; render(); }));
  });

  document.getElementById("meta").textContent =
    rows.length + " shown · poll 5s · " + (state.fetchedAt ? "sync " + ago(state.fetchedAt, now) : "awaiting sync");

  const list = document.getElementById("list");
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = state.events.length ? "No events match this filter." : "Listening for ingest…";
    list.appendChild(empty);
    return;
  }
  rows.forEach((ev) => {
    const li = document.createElement("li");
    if (isAnomaly(ev.severity)) li.className = "anomaly";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row";
    btn.innerHTML =
      '<span class="time">' + clock(ev.created_at) + "</span>" +
      '<span class="sev ' + tone(ev.severity) + '">' + (ev.severity || "info") + "</span>" +
      '<span><span class="source">' + (ev.source || "unknown") + "</span><div class='type'>" + (ev.event_type || "event") + "</div></span>";
    btn.addEventListener("click", () => {
      state.openId = state.openId === ev.id ? null : ev.id;
      render();
    });
    li.appendChild(btn);
    if (state.openId === ev.id) {
      const pre = document.createElement("pre");
      pre.className = "payload";
      pre.textContent = preview(ev.payload);
      li.appendChild(pre);
    }
    list.appendChild(li);
  });
}

document.getElementById("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});
document.getElementById("refreshBtn").addEventListener("click", () => { load(); });

load();
setInterval(() => {
  if (document.visibilityState === "hidden") return;
  load();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});
setInterval(render, 1000);
