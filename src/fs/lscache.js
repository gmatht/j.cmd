// ─── LsCache: persistent directory-listing cache with TTL ──────
//
// Listings of remote mounts (GitHub / GitLab REST APIs) are expensive
// and rate-limited (60 req/hr unauthenticated on GitHub). The shells
// cache them so repeat `ls` calls are instant and don't burn quota.
//
// Storage: localStorage in the browser (survives reloads — the cache
// is per-origin, keyed by mount namespace + path). In Node (CLI) there
// is no localStorage, so it falls back to an in-memory Map that lasts
// for the process lifetime (a full interactive session).
//
// TTL is 24 hours: get() serves fresh entries without touching the
// network. getStale() is the last-resort fallback when the API is down
// or rate-limited — stale data beats no data, and the backends report
// the age so the shell can tell the user it's from cache.
// -----------------------------------------------------------------

export const LS_TTL = 24 * 60 * 60 * 1000;  // 24 hours
const MAX_ENTRY = 256 * 1024;               // skip giant listings (localStorage quota)

export class LsCache {
  constructor(namespace) {
    this.namespace = namespace;
    this.mem = new Map();  // Node CLI fallback (per-process)
  }

  _key(path) {
    return `fs:lscache:${this.namespace}:${path}`;
  }

  _load(path) {
    const key = this._key(path);
    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch {}
      return null;
    }
    return this.mem.get(key) ?? null;
  }

  _store(path, entry) {
    const key = this._key(path);
    if (typeof localStorage !== "undefined") {
      try { localStorage.setItem(key, JSON.stringify(entry)); } catch {}
    } else {
      this.mem.set(key, entry);
    }
  }

  // Fresh entry (< TTL): { data, age } or null.
  get(path) {
    const e = this._load(path);
    if (!e || !("data" in e)) return null;
    const age = Date.now() - e.ts;
    if (age > LS_TTL) return null;
    return { data: e.data, age };
  }

  // Any entry regardless of age: { data, age } or null.
  getStale(path) {
    const e = this._load(path);
    if (!e || !("data" in e)) return null;
    return { data: e.data, age: Date.now() - e.ts };
  }

  // Age of a stored entry in ms, or null if there is none.
  age(path) {
    const e = this._load(path);
    return e ? Date.now() - e.ts : null;
  }

  set(path, data) {
    const entry = { ts: Date.now(), data };
    const serialized = JSON.stringify(entry);
    if (serialized.length > MAX_ENTRY) return;  // too big to cache
    const key = this._key(path);
    if (typeof localStorage !== "undefined") {
      try { localStorage.setItem(key, serialized); } catch {}
    } else {
      this.mem.set(key, entry);
    }
  }
}

// "3h 12m ago" / "45m ago" / "just now" / "2d 4h ago"
export function formatAge(ms) {
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h ago` : `${d}d ago`;
}
