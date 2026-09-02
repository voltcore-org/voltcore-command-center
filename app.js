const API = "https://core-api.dominic-calandro1991.workers.dev/api/v1/events";
const REMEDIATE = "https://core-api.dominic-calandro1991.workers.dev/api/v1/remediate";
const ANOMALY = new Set(["critical", "fatal", "high", "error"]);
const PINNED = [
  { id: "global", label: "Global Health", sources: null },
  { id: "storm-path", label: "Storm Path", sources: ["storm-path", "storm-path-mobile", "storm-path-web"] },
  { id: "nano-cloud", label: "nano-cloud", sources: ["snca-codec", "nano-cloud"] },
  { id: "nano-sandbox", label: "nano-sandbox", sources: ["nano-sandbox"] },
];
const NAMED = {
  "storm-path": [
    ["gps_accuracy", "GPS Signal Quality", "gauge"],
    ["nws_radar_status", "NWS Radar Sync", "badge"],
    ["weather_api_health", "Weather Feed", "badge"],
    ["frame_rate", "UI Performance", "gauge"],
  ],
  "nano-cloud": [
    ["cpu_utilization", "CPU", "gauge"],
    ["memory_mb", "Memory", "gauge"],
    ["uptime_seconds", "Uptime", "log"],
    ["edge_latency", "Edge latency", "gauge"],
  ],
  "nano-sandbox": [
    ["active_containers", "Containers", "gauge"],
    ["execution_errors", "Exec errors", "gauge"],
    ["api_rate_limit_remaining", "Rate limit remaining", "gauge"],
  ],
};
const SOURCE_TAB = {};
PINNED.forEach((t) => (t.sources || []).forEach((s) => { SOURCE_TAB[s] = t.id; }));

const state = {
  events: [], fetchedAt: null, error: null, query: "", severity: "all", source: "all",
  tab: "global", openId: null, freshIds: new Set(), syncing: false, remediate: null,
};
const seen = new Set();
let firstLoad = true, inflight = null, lastRefreshTap = 0;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function isAnomaly(sev) { return ANOMALY.has(String(sev || "").toLowerCase()); }
function remediable(sev) {
  const s = String(sev || "").toLowerCase();
  return s === "high" || s === "critical" || s === "fatal" || s === "error";
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
function rec(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}
function tabsFrom(events) {
  const extra = [];
  const seenSrc = new Set();
  events.forEach((ev) => {
    const src = String(ev.source || "").trim();
    if (!src || SOURCE_TAB[src] || seenSrc.has(src)) return;
    seenSrc.add(src);
    extra.push({ id: src, label: src, sources: [src] });
  });
  extra.sort((a, b) => a.label.localeCompare(b.label));
  return PINNED.concat(extra);
}
function tabEvents(events, tab) {
  if (!tab.sources) return events;
  const set = new Set(tab.sources);
  return events.filter((e) => set.has(String(e.source || "")));
}
function gaugePct(key, n) {
  const k = String(key).toLowerCase();
  if (k.indexOf("frame") >= 0) return Math.max(0, Math.min(100, (n / 60) * 100));
  if (k.indexOf("memory") >= 0) return Math.max(0, Math.min(100, (n / 512) * 100));
  if (k.indexOf("latency") >= 0) return Math.max(0, Math.min(100, (n / 500) * 100));
  if (k.indexOf("uptime") >= 0) return Math.max(0, Math.min(100, (n / 86400) * 100));
  if (k.indexOf("container") >= 0) return Math.max(0, Math.min(100, (n / 8) * 100));
  if (k.indexOf("error") >= 0) return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n * 10));
  if (n >= 0 && n <= 1) return n * 100;
  if (n >= 0 && n <= 100) return n;
  return Math.max(0, Math.min(100, n / 10));
}
function fmt(key, value) {
  if (value == null) return "awaiting metric";
  const k = String(key).toLowerCase();
  if (typeof value === "boolean") return value ? "healthy" : "down";
  if (typeof value === "number") {
    if (k.indexOf("uptime") >= 0) {
      const s = Math.round(value);
      if (s < 60) return s + "s";
      if (s < 3600) return Math.floor(s / 60) + "m";
      return Math.floor(s / 3600) + "h";
    }
    if (k.indexOf("memory") >= 0) return Math.round(value) + " MB";
    if (k.indexOf("latency") >= 0) return Math.round(value) + " ms";
    if (k.indexOf("frame") >= 0) return Math.round(value) + " fps";
    if (k.indexOf("accuracy") >= 0 || k.indexOf("cpu") >= 0 || k.indexOf("utilization") >= 0) {
      const pct = value <= 1 ? value * 100 : value;
      return Math.round(pct) + "%";
    }
    return String(value);
  }
  return String(value);
}
function latestPayload(events) {
  const out = {};
  events.forEach((ev) => {
    const r = rec(ev.payload);
    Object.keys(r).forEach((k) => {
      if (!(k in out) && r[k] != null) out[k] = r[k];
    });
  });
  return out;
}

async function load(userInitiated) {
  if (inflight) inflight.abort();
  const ac = new AbortController();
  inflight = ac;
  const started = Date.now();
  if (userInitiated) { state.syncing = true; render(); }
  try {
    const res = await fetch(API + "?limit=150&_=" + Date.now(), {
      headers: { Accept: "application/json" }, cache: "no-store", signal: ac.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || ("HTTP " + res.status));
    const next = Array.isArray(data.events) ? data.events : [];
    if (!firstLoad) {
      const fresh = new Set();
      next.forEach((ev) => { if (!seen.has(String(ev.id))) fresh.add(String(ev.id)); });
      if (fresh.size) {
        state.freshIds = fresh;
        window.setTimeout(() => { state.freshIds = new Set(); render(); }, 1600);
      }
    }
    firstLoad = false;
    seen.clear();
    next.forEach((ev) => seen.add(String(ev.id)));
    state.events = next;
    state.fetchedAt = data.fetched_at || new Date().toISOString();
    state.error = null;
  } catch (err) {
    if (err && err.name === "AbortError") return;
    state.error = err.message || "Fetch failed";
  } finally {
    if (userInitiated) {
      const wait = Math.max(0, 400 - (Date.now() - started));
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
    if (inflight === ac) { state.syncing = false; inflight = null; render(); }
  }
}

function requestRefresh(e) {
  if (e) e.preventDefault();
  const now = Date.now();
  if (now - lastRefreshTap < 350) return;
  lastRefreshTap = now;
  load(true);
}

function chip(label, active, onClick) {
  const b = el("button", "chip" + (active ? " active" : ""), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function metricCard(key, label, kind, value, waiting) {
  const art = el("article", "metric");
  art.appendChild(el("p", "metric-label", label));
  if (waiting) {
    art.appendChild(el("p", "muted", "awaiting metric"));
    return art;
  }
  if (kind === "badge") {
    const on = Boolean(value);
    art.appendChild(el("p", on ? "ok" : "danger", fmt(key, value)));
  } else if (kind === "log") {
    art.appendChild(el("p", "metric-val", fmt(key, value)));
  } else {
    art.appendChild(el("p", "metric-val", fmt(key, value)));
    const bar = el("div", "bar");
    const fill = el("div", "bar-fill");
    fill.style.width = gaugePct(key, typeof value === "number" ? value : 0) + "%";
    bar.appendChild(fill);
    art.appendChild(bar);
  }
  return art;
}

function openSheet(ev) {
  state.remediate = ev;
  const sheet = document.getElementById("sheet");
  sheet.hidden = false;
  document.getElementById("sheetTitle").textContent = ev.source || "unknown";
  document.getElementById("sheetSub").textContent = ev.event_type || "event";
  document.getElementById("sheetStatus").textContent = "Asking the free coding model…";
  document.getElementById("sheetModel").textContent = "";
  document.getElementById("sheetSummary").textContent = "";
  document.getElementById("sheetPatch").textContent = "";
  document.getElementById("copyPatch").hidden = true;
  fetch(REMEDIATE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ event: { id: ev.id, source: ev.source, event_type: ev.event_type, severity: ev.severity, payload: ev.payload } }),
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || ("HTTP " + res.status));
    document.getElementById("sheetStatus").textContent = "";
    document.getElementById("sheetModel").textContent = data.model || "";
    document.getElementById("sheetSummary").textContent = data.summary || "";
    document.getElementById("sheetPatch").textContent = data.patch || preview(ev.payload);
    document.getElementById("copyPatch").hidden = false;
  }).catch((err) => {
    document.getElementById("sheetStatus").textContent = err.message || "Remediate failed";
  });
}
function closeSheet() {
  state.remediate = null;
  document.getElementById("sheet").hidden = true;
}

function render() {
  const now = Date.now();
  const live = !state.error && Boolean(state.fetchedAt);
  const pill = document.getElementById("livePill");
  const refreshBtn = document.getElementById("refreshBtn");
  pill.textContent = state.syncing ? "SYNCING" : live ? "LIVE" : "OFFLINE";
  pill.className = "pill " + (state.error ? "off" : "on");
  refreshBtn.classList.toggle("busy", state.syncing);

  const allTabs = tabsFrom(state.events);
  let tab = allTabs.find((t) => t.id === state.tab) || allTabs[0];
  const rowsAll = tabEvents(state.events, tab);
  const sources = Array.from(new Set(rowsAll.map((e) => e.source).filter(Boolean))).sort();
  const sevs = Array.from(new Set(rowsAll.map((e) => String(e.severity || "info").toLowerCase()))).sort();
  const anoms = rowsAll.filter((e) => isAnomaly(e.severity));
  const q = state.query.trim().toLowerCase();
  const rows = rowsAll.filter((ev) => {
    if (state.severity === "anomaly" && !isAnomaly(ev.severity)) return false;
    if (state.severity !== "all" && state.severity !== "anomaly" && String(ev.severity || "").toLowerCase() !== state.severity) return false;
    if (state.source !== "all" && ev.source !== state.source) return false;
    if (!q) return true;
    return [ev.source, ev.event_type, ev.severity, preview(ev.payload)].join(" ").toLowerCase().includes(q);
  });

  const tabsEl = document.getElementById("tabs");
  tabsEl.replaceChildren();
  allTabs.forEach((t) => {
    const b = el("button", "chip" + (t.id === tab.id ? " active" : ""), t.label);
    b.type = "button";
    b.addEventListener("click", () => { state.tab = t.id; state.source = "all"; render(); });
    tabsEl.appendChild(b);
  });

  document.getElementById("statCount").textContent = String(rowsAll.length);
  document.getElementById("statAnom").textContent = String(anoms.length);
  document.getElementById("statSources").textContent = String(sources.length);
  document.getElementById("statLast").textContent = rowsAll[0] ? ago(rowsAll[0].created_at, now) : "—";

  const err = document.getElementById("errorBox");
  if (state.error) { err.hidden = false; err.textContent = "Telemetry link failed: " + state.error; }
  else err.hidden = true;

  const grid = document.getElementById("metricGrid");
  grid.replaceChildren();
  if (tab.id === "global") {
    const map = new Map();
    rowsAll.forEach((ev) => {
      const src = String(ev.source || "unknown");
      const cur = map.get(src) || { source: src, count: 0, lastAt: ev.created_at, worst: ev.severity || "info" };
      cur.count += 1;
      if (ev.created_at && (!cur.lastAt || ev.created_at > cur.lastAt)) cur.lastAt = ev.created_at;
      if (isAnomaly(ev.severity)) cur.worst = ev.severity;
      map.set(src, cur);
    });
    if (!map.size) grid.appendChild(el("p", "empty", "No sources in this window."));
    map.forEach((h) => {
      const b = el("button", "health-card");
      b.type = "button";
      b.appendChild(el("span", "source", h.source));
      b.appendChild(el("span", isAnomaly(h.worst) ? "sev danger" : "sev ok", String(h.worst)));
      b.appendChild(el("span", "type", h.count + " events · " + ago(h.lastAt, now)));
      b.addEventListener("click", () => { state.tab = SOURCE_TAB[h.source] || h.source; render(); });
      grid.appendChild(b);
    });
  } else {
    const latest = latestPayload(rowsAll);
    const named = NAMED[tab.id] || [];
    const skip = new Set(named.map((n) => n[0]));
    named.forEach(([key, label, kind]) => {
      grid.appendChild(metricCard(key, label, kind, latest[key], latest[key] == null));
    });
    Object.keys(latest).forEach((key) => {
      if (skip.has(key)) return;
      const v = latest[key];
      if (typeof v === "boolean") grid.appendChild(metricCard(key, key.replace(/_/g, " "), "badge", v, false));
      else if (typeof v === "number") grid.appendChild(metricCard(key, key.replace(/_/g, " "), "gauge", v, false));
      else if (typeof v === "string") grid.appendChild(metricCard(key, key.replace(/_/g, " "), "log", v, false));
    });
    if (!grid.children.length) grid.appendChild(el("p", "empty", "awaiting metric"));
  }

  const listA = document.getElementById("anomalyList");
  document.getElementById("anomCount").textContent = String(anoms.length);
  document.querySelector(".anomaly-panel").classList.toggle("hot", anoms.length > 0);
  listA.replaceChildren();
  if (!anoms.length) listA.appendChild(el("li", "empty", "Clear — no high-severity events."));
  else anoms.forEach((ev) => {
    const li = el("li");
    const btn = el("button", "anom-card");
    btn.type = "button";
    btn.appendChild(el("span", "sev danger", String(ev.severity || "high")));
    btn.appendChild(el("span", "source", ev.source || "unknown"));
    btn.appendChild(el("span", "type", (ev.event_type || "event") + " · " + ago(ev.created_at, now)));
    btn.appendChild(el("span", "ok", "Remediate"));
    btn.addEventListener("click", () => openSheet(ev));
    li.appendChild(btn);
    listA.appendChild(li);
  });

  const sev = document.getElementById("sevChips");
  sev.replaceChildren();
  ["all", "anomaly"].concat(sevs).forEach((key) => {
    sev.appendChild(chip(key, state.severity === key, () => { state.severity = key; render(); }));
  });
  const src = document.getElementById("srcChips");
  src.replaceChildren();
  src.appendChild(chip("all sources", state.source === "all", () => { state.source = "all"; render(); }));
  sources.forEach((name) => src.appendChild(chip(name, state.source === name, () => { state.source = name; render(); })));

  document.getElementById("meta").textContent =
    rows.length + " shown · " + tab.label + " · poll 5s · " +
    (state.syncing ? "syncing…" : state.fetchedAt ? "sync " + ago(state.fetchedAt, now) : "awaiting sync");

  const list = document.getElementById("list");
  list.replaceChildren();
  if (!rows.length) {
    list.appendChild(el("li", "empty", rowsAll.length ? "No events match this filter." : "Listening for ingest…"));
    return;
  }
  rows.forEach((ev) => {
    const li = el("li", (isAnomaly(ev.severity) ? "anomaly" : "") + (state.freshIds.has(String(ev.id)) ? " fresh" : ""));
    const row = el("div", "row-wrap");
    const btn = el("button", "row");
    btn.type = "button";
    btn.appendChild(el("span", "time", clock(ev.created_at)));
    btn.appendChild(el("span", "sev " + (isAnomaly(ev.severity) ? "danger" : "ok"), ev.severity || "info"));
    const mid = el("span");
    mid.appendChild(el("span", "source", ev.source || "unknown"));
    mid.appendChild(el("div", "type", ev.event_type || "event"));
    btn.appendChild(mid);
    btn.appendChild(el("span", "ago", ago(ev.created_at, now)));
    btn.addEventListener("click", () => { state.openId = state.openId === ev.id ? null : ev.id; render(); });
    row.appendChild(btn);
    if (remediable(ev.severity)) {
      const r = el("button", "rem-btn", "Remediate");
      r.type = "button";
      r.addEventListener("click", () => openSheet(ev));
      row.appendChild(r);
    }
    li.appendChild(row);
    if (state.openId === ev.id) li.appendChild(el("pre", "payload", preview(ev.payload)));
    list.appendChild(li);
  });
}

document.getElementById("search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
const refreshBtn = document.getElementById("refreshBtn");
refreshBtn.addEventListener("click", requestRefresh);
refreshBtn.addEventListener("touchend", requestRefresh, { passive: false });
document.getElementById("sheetClose").addEventListener("click", closeSheet);
document.getElementById("sheetBackdrop").addEventListener("click", closeSheet);
document.getElementById("copyPatch").addEventListener("click", async () => {
  const text = document.getElementById("sheetPatch").textContent || "";
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  document.getElementById("copyPatch").textContent = "Copied";
  setTimeout(() => { document.getElementById("copyPatch").textContent = "Copy Patch"; }, 1600);
});

load(false);
setInterval(() => {
  if (document.visibilityState === "hidden" || state.syncing) return;
  load(false);
}, 5000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(false); });
setInterval(render, 1000);
