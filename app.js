const API = "https://core-api.dominic-calandro1991.workers.dev/api/v1/events";
const ANOMALY = new Set(["critical", "fatal", "high", "error"]);
const MIN_SPIN_MS = 400;

const state = {
  events: [],
  fetchedAt: null,
  error: null,
  query: "",
  severity: "all",
  source: "all",
  openId: null,
  freshIds: new Set(),
  syncing: false,
};

const seen = new Set();
let firstLoad = true;
let inflight = null;
let lastRefreshTap = 0;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

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

async function load(userInitiated) {
  if (inflight) inflight.abort();
  const ac = new AbortController();
  inflight = ac;
  const started = Date.now();
  if (userInitiated) {
    state.syncing = true;
    render();
  }
  try {
    const res = await fetch(API + "?limit=150&_=" + Date.now(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: ac.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || ("HTTP " + res.status));
    const next = Array.isArray(data.events) ? data.events : [];
    if (!firstLoad) {
      const fresh = new Set();
      next.forEach((ev) => {
        const id = String(ev.id);
        if (!seen.has(id)) fresh.add(id);
      });
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
      const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - started));
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
    if (inflight === ac) {
      state.syncing = false;
      inflight = null;
      render();
    }
  }
}

function requestRefresh(e) {
  if (e) e.preventDefault();
  const now = Date.now();
  if (now - lastRefreshTap < 350) return;
  lastRefreshTap = now;
  load(true);
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
  const b = el("button", "chip" + (active ? " active" : ""), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function renderAnomalies(anoms, now) {
  const list = document.getElementById("anomalyList");
  const count = document.getElementById("anomCount");
  const panel = document.querySelector(".anomaly-panel");
  count.textContent = String(anoms.length);
  panel.classList.toggle("hot", anoms.length > 0);
  list.replaceChildren();
  if (!anoms.length) {
    list.appendChild(el("li", "empty", "Clear — no high-severity events."));
    return;
  }
  anoms.forEach((ev) => {
    const li = el("li");
    const btn = el("button", "anom-card");
    btn.type = "button";
    btn.appendChild(el("span", "sev danger", String(ev.severity || "high")));
    btn.appendChild(el("span", "source", ev.source || "unknown"));
    btn.appendChild(el("span", "type", (ev.event_type || "event") + " · " + ago(ev.created_at, now)));
    btn.addEventListener("click", () => {
      state.openId = ev.id;
      state.severity = "all";
      state.source = "all";
      render();
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function render() {
  const now = Date.now();
  const live = !state.error && Boolean(state.fetchedAt);
  const pill = document.getElementById("livePill");
  const refreshBtn = document.getElementById("refreshBtn");
  if (state.syncing) {
    pill.textContent = "SYNCING";
    pill.className = "pill on";
  } else {
    pill.textContent = live ? "LIVE" : "OFFLINE";
    pill.className = "pill " + (live ? "on" : "off");
  }
  refreshBtn.classList.toggle("busy", state.syncing);

  const sources = Array.from(new Set(state.events.map((e) => e.source).filter(Boolean))).sort();
  const sevs = Array.from(new Set(state.events.map((e) => String(e.severity || "info").toLowerCase()))).sort();
  const rows = filtered();
  const anoms = state.events.filter((e) => isAnomaly(e.severity));

  document.getElementById("statCount").textContent = String(state.events.length);
  document.getElementById("statAnom").textContent = String(anoms.length);
  document.getElementById("statSources").textContent = String(sources.length);
  document.getElementById("statLast").textContent = state.events[0] ? ago(state.events[0].created_at, now) : "—";

  const err = document.getElementById("errorBox");
  if (state.error) {
    err.hidden = false;
    err.textContent = "Telemetry link failed: " + state.error;
  } else {
    err.hidden = true;
  }

  renderAnomalies(anoms, now);

  const sev = document.getElementById("sevChips");
  sev.replaceChildren();
  ["all", "anomaly"].concat(sevs).forEach((key) => {
    sev.appendChild(chip(key, state.severity === key, () => { state.severity = key; render(); }));
  });
  const src = document.getElementById("srcChips");
  src.replaceChildren();
  src.appendChild(chip("all sources", state.source === "all", () => { state.source = "all"; render(); }));
  sources.forEach((name) => {
    src.appendChild(chip(name, state.source === name, () => { state.source = name; render(); }));
  });

  const syncLine = state.syncing
    ? "syncing…"
    : (state.fetchedAt ? "sync " + ago(state.fetchedAt, now) : "awaiting sync");
  document.getElementById("meta").textContent =
    rows.length + " shown · created_at DESC · poll 5s · " + syncLine;

  const list = document.getElementById("list");
  list.replaceChildren();
  if (!rows.length) {
    list.appendChild(el("li", "empty", state.events.length ? "No events match this filter." : "Listening for ingest…"));
    return;
  }
  rows.forEach((ev) => {
    const cls = (isAnomaly(ev.severity) ? "anomaly" : "") + (state.freshIds.has(String(ev.id)) ? " fresh" : "");
    const li = el("li", cls.trim());
    const btn = el("button", "row");
    btn.type = "button";
    btn.appendChild(el("span", "time", clock(ev.created_at)));
    btn.appendChild(el("span", "sev " + tone(ev.severity), ev.severity || "info"));
    const mid = el("span");
    mid.appendChild(el("span", "source", ev.source || "unknown"));
    mid.appendChild(el("div", "type", ev.event_type || "event"));
    btn.appendChild(mid);
    btn.appendChild(el("span", "ago", ago(ev.created_at, now)));
    btn.addEventListener("click", () => {
      state.openId = state.openId === ev.id ? null : ev.id;
      render();
    });
    li.appendChild(btn);
    if (state.openId === ev.id) {
      const pre = el("pre", "payload", preview(ev.payload));
      li.appendChild(pre);
    }
    list.appendChild(li);
  });
}

document.getElementById("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});

const refreshBtn = document.getElementById("refreshBtn");
refreshBtn.addEventListener("click", requestRefresh);
refreshBtn.addEventListener("touchend", requestRefresh, { passive: false });

load(false);
setInterval(() => {
  if (document.visibilityState === "hidden") return;
  if (state.syncing) return;
  load(false);
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load(false);
});
setInterval(render, 1000);
