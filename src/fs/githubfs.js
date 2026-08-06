// ─── GitHubFS: Browse GitHub repos as a filesystem ──────────────
//
// Path format:
//   /mount/github/                          — featured repos + orgs
//   /mount/github/{owner}/                  — list repos for owner
//   /mount/github/{owner}/{repo}/           — list repo contents
//   /mount/github/{owner}/{repo}/{path}      — read file
//   /mount/github/README.md                 — usage guide
//
// Lists via: GET api.github.com
// Reads via: GET raw.githubusercontent.com
// Listings are cached persistently (LsCache, 24h TTL) so repeat `ls`
// calls are instant and don't burn the API rate limit.
// -----------------------------------------------------------------

import { LsCache, LS_TTL } from "./lscache.js";

const FEATURED = [
  { owner: "gmatht", repo: "sh2perl", desc: "the sh2perl transpiler" },
  { owner: "gmatht", repo: "debashc", desc: "shell script converter" },
  { owner: "torvalds", repo: "linux", desc: "Linux kernel source" },
  { owner: "rust-lang", repo: "rust", desc: "Rust compiler" },
  { owner: "python", repo: "cpython", desc: "Python interpreter" },
  { owner: "nodejs", repo: "node", desc: "Node.js runtime" },
  { owner: "microsoft", repo: "vscode", desc: "VS Code editor" },
  { owner: "facebook", repo: "react", desc: "React framework" },
  { owner: "curl", repo: "curl", desc: "curl HTTP tool" },
  { owner: "git", repo: "git", desc: "Git version control" },
];

export class GitHubFS {
  constructor(branch = "main") {
    this.branch = branch;
    this.lsCache = new LsCache("github");
    // Paths the user has actually visited (dirs end with '/', files don't).
    // locate uses this to search what's been fetched without enumerating
    // all of GitHub.
    this.visited = new Set();
  }

  // Return visited paths as a flat list, for locate
  async listVisited() {
    return [...this.visited].sort();
  }

  // Parse /{owner}/{repo}/{path...} from a relative path
  // Returns { owner, repo, filePath } or partial { owner } or null
  _parse(relative) {
    const parts = relative.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length === 0) return { root: true };
    // Root-level files like README.md are not owners
    if (parts.length === 1 && parts[0].includes(".")) return { file: parts[0] };
    if (parts.length === 1) return { owner: parts[0] };
    return {
      owner: parts[0],
      repo: parts[1],
      filePath: parts.slice(2).join("/"),
    };
  }

  async _fetchAPI(url) {
    const resp = await fetch(url, {
      headers: { "Accept": "application/vnd.github.v3+json" }
    });
    this._noteRate(resp);
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    return resp.json();
  }

  // Remember the API's rolling-hour usage from the response headers so
  // the shell can report "52/60 requests used this hour" after a fresh
  // fetch — the header is exact for the IP, not an estimate.
  _noteRate(resp) {
    const remaining = resp.headers && resp.headers.get("X-RateLimit-Remaining");
    const limit = resp.headers && resp.headers.get("X-RateLimit-Limit");
    if (remaining != null && limit != null) {
      this.apiRate = {
        name: "GitHub",
        limit: Number(limit) || 0,
        remaining: Number(remaining) || 0,
        period: "this hour",  // GitHub REST: 60 req/hr per IP
      };
    }
  }

  // Rolling-hour API usage from the most recent response — but only when
  // the last listing actually hit the network (not the cache).
  rateInfo() {
    if (this._lastListServedFromCache) return null;
    return this.apiRate || null;
  }

  // ─── Directory listing ──────────────────────────────────────

  async list(path) {
    const p = this._parse(path);

    // Root level or root-level files: featured repos + orgs
    if (p.root || p.file) {
      const owners = [...new Set(FEATURED.map(f => f.owner))].sort();
      return [
        ...owners.map(o => o + "/"),
        "README.md",
        "...",
      ];
    }

    // Owner level: list repos for this owner
    if (!p.repo) {
      return await this._listRepos(p.owner);
    }

    // Repo root or path within repo
    return await this._listContents(p.owner, p.repo, p.filePath);
  }

  // Cache metadata for a listing ({ age, stale }) or null — `ls` prints
  // "cached X ago" from this. Mirrors the cache keys of _listRepos and
  // _listContents.
  cacheInfo(relative) {
    const p = this._parse(relative || "/");
    let key = null;
    if (p.root || p.file) return null;   // static root/README — not cached
    if (!p.repo) key = `repos:${p.owner}`;
    else key = `contents:${p.owner}/${p.repo}/${p.filePath || ""}`;
    const age = this.lsCache.age(key);
    if (age === null) return null;
    return { age, stale: age > LS_TTL };
  }

  async _listRepos(owner) {
    const key = `repos:${owner}`;
    const cached = this.lsCache.get(key);
    this._lastListServedFromCache = !!cached;
    if (cached) return cached.data;  // fresh cache — no API call

    try {
      const data = await this._fetchAPI(
        `https://api.github.com/users/${owner}/repos?per_page=20&sort=updated&type=owner`
      );
      if (!Array.isArray(data)) return [];
      const entries = data.map(r => r.name + "/").sort();
      this.lsCache.set(key, entries);
      return entries;
    } catch {
      // API rate-limited / offline — stale cache first, then degrade to
      // the featured-repos list for this owner. "..." marks the
      // truncation (same convention as the root listing).
      const stale = this.lsCache.getStale(key);
      if (stale) return stale.data;
      const repos = FEATURED.filter(f => f.owner === owner).map(f => f.repo + "/");
      return [...repos, "..."];
    }
  }

  // Fetch (and cache) the contents API response for a path. The same
  // endpoint serves both directory listings and stat probes, so one
  // cache entry backs ls output, its dir/file coloring, and completion.
  async _fetchContents(owner, repo, path) {
    const key = `contents:${owner}/${repo}/${path || ""}`;
    const cached = this.lsCache.get(key);
    if (cached) return cached.data;  // fresh cache — no API call
    let apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
    if (path) apiUrl += "/" + path;
    const data = await this._fetchAPI(apiUrl);
    this.lsCache.set(key, data);
    return data;
  }

  async _listContents(owner, repo, path) {
    // Record the visited directory
    this.visited.add(`/${owner}/${repo}/${path}`.replace(/\/$/, "") + "/");

    const key = `contents:${owner}/${repo}/${path || ""}`;
    this._lastListServedFromCache = !!this.lsCache.get(key);

    try {
      const data = await this._fetchContents(owner, repo, path);
      if (!Array.isArray(data)) {
        // It's a single file — return its name
        this.visited.add(`/${owner}/${repo}/${path}`);
        return [path ? path.split("/").pop() : repo];
      }
      // Record the entries as visited too (they're what the user saw)
      for (const item of data) {
        this.visited.add(`/${owner}/${repo}/${path ? path + "/" : ""}${item.name}` + (item.type === "dir" ? "/" : ""));
      }
      return data
        .map(item => item.type === "dir" ? item.name + "/" : item.name)
        .sort();
    } catch {
      // API rate-limited / offline — stale cache if we have one, else
      // "..." marks that the listing is truncated, not empty.
      const stale = this.lsCache.getStale(`contents:${owner}/${repo}/${path || ""}`);
      if (stale && Array.isArray(stale.data)) return stale.data;
      return ["..."];
    }
  }

  // ─── File reading ───────────────────────────────────────────

  async read(path) {
    const p = this._parse(path);

    if (p.file === "README.md" || p.file === ".readme") {
      return await this._readme();
    }
    if (!p.owner && p.file) {
      throw new Error("ENOENT: not a file path");
    }
    if (!p.owner || !p.repo) throw new Error("ENOENT: not a file path");

    // Record the fetched file
    this.visited.add(`/${p.owner}/${p.repo}/${p.filePath}`);

    const rawUrl = `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${this.branch}/${p.filePath}`;
    let resp = await fetch(rawUrl);
    if (!resp.ok && this.branch === "main") {
      // Old repos still use master as the default branch (torvalds/linux,
      // ...). Retry once — raw reads aren't API-rate-limited, so this
      // stays fast even when api.github.com is exhausted.
      resp = await fetch(rawUrl.replace("/main/", "/master/"));
    }
    if (!resp.ok) throw new Error("ENOENT");
    return resp.text();
  }

  async readBlob(path) {
    const p = this._parse(path);
    if (p.file === "README.md" || p.file === ".readme") {
      return new Blob([await this._readme()], { type: "text/plain" });
    }
    if (!p.owner || !p.repo) throw new Error("ENOENT");

    this.visited.add(`/${p.owner}/${p.repo}/${p.filePath}`);

    const rawUrl = `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${this.branch}/${p.filePath}`;
    let resp = await fetch(rawUrl);
    if (!resp.ok && this.branch === "main") {
      // Same master-branch fallback as read() (torvalds/linux, ...)
      resp = await fetch(rawUrl.replace("/main/", "/master/"));
    }
    if (!resp.ok) throw new Error("ENOENT");
    return resp.blob();
  }

  // ─── stat: metadata for a path ─────────────────────────────
  // The GitHub contents API returns an array for directories and a
  // single object for files, so one probe tells the type (and the
  // byte size for files).
  async stat(path) {
    const p = this._parse(path);
    if (p.root) return { type: "dir", size: 0, mtime: undefined };
    if (p.file) return { type: "file", size: 0, mtime: undefined }; // root guide
    if (!p.repo) return { type: "dir", size: 0, mtime: undefined }; // owner level
    return this._statPath(p.owner, p.repo, p.filePath);
  }

  async _statPath(owner, repo, path) {
    // The contents API returns the full entry array for a directory, so
    // if the parent listing is cached the type is already known — no
    // extra API call. Without this, `ls` stats every entry and each
    // stat fetches the API (the old behaviour burned the 60/hr quota in
    // a few listings). The repos listing is the same story one level up:
    // every repo is a dir.
    const parts = String(path || "").split("/").filter(Boolean);
    const name = parts.length ? parts[parts.length - 1] : "";
    const parent = parts.slice(0, -1).join("/");
    const parentCache = this.lsCache.get(`contents:${owner}/${repo}/${parent}`);
    if (parentCache && Array.isArray(parentCache.data)) {
      for (const item of parentCache.data) {
        if (item.name === name) {
          if (item.type === "dir") return { type: "dir", size: 0, mtime: undefined };
          return { type: "file", size: item.size || 0, mtime: undefined };
        }
      }
    }
    if (name === "" || name === repo) {
      // Repo root: the repos listing (stored with trailing slashes)
      // knows every repo is a dir — no fetch needed.
      const reposCache = this.lsCache.get(`repos:${owner}`);
      if (reposCache && reposCache.data.includes((name === "" ? repo : name) + "/")) {
        return { type: "dir", size: 0, mtime: undefined };  // it's a repo
      }
    }
    try {
      const data = await this._fetchContents(owner, repo, path);
      if (Array.isArray(data)) {
        return { type: "dir", size: 0, mtime: undefined };
      }
      return { type: "file", size: data.size || 0, mtime: undefined };
    } catch {
      throw new Error("ENOENT");
    }
  }

  async _readme() {
    let text = `GitHub Filesystem
==================

Mount point for browsing GitHub repositories as a filesystem.

Usage:
  ls /mount/github/owner/repo
  cat /mount/github/owner/repo/README.md
  cat /mount/github/owner/repo/src/main.rs

Featured repos:\n`;
    for (const f of FEATURED) {
      text += `  ${f.owner}/${f.repo}  — ${f.desc}\n`;
    }
    text += `\nBrowse any public repo: ls /mount/github/{owner}/{repo}/\n`;
    text += `List repos for a user:  ls /mount/github/{owner}/\n`;
    return text;
  }

  async write(path, content) {
    throw new Error("EROFS: GitHub is read-only (use git push)");
  }

  async remove(path) {
    throw new Error("EROFS: GitHub is read-only");
  }
}

// ─── GitHubRepoFS: a single repo pinned at a mount point ────────
//
// Backend for the shell's `mount` command:
//   mount github:user/repo /mymount
// Pins a GitHubFS to one repo, so /mymount/ contains the repo's
// contents directly — no {owner}/{repo}/ prefix needed. Read-only,
// like GitHubFS itself.
// -----------------------------------------------------------------

export class GitHubRepoFS extends GitHubFS {
  constructor(owner, repo, branch = "main") {
    super(branch);
    this.owner = owner;
    this.repo = repo;
  }

  // "/README.md" → "README.md"; "/" → ""
  _rel(path) {
    return (path || "/").replace(/^\//, "").replace(/\/$/, "");
  }

  async list(path) {
    return this._listContents(this.owner, this.repo, this._rel(path));
  }

  // Same cache metadata, mapped onto the pinned repo's keys.
  cacheInfo(relative) {
    const rel = this._rel(relative || "/");
    const age = this.lsCache.age(`contents:${this.owner}/${this.repo}/${rel}`);
    if (age === null) return null;
    return { age, stale: age > LS_TTL };
  }

  async read(path) {
    const filePath = this._rel(path);
    if (!filePath) throw new Error("EISDIR: Is a directory");
    const rawUrl = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${filePath}`;
    let resp = await fetch(rawUrl);
    if (!resp.ok && this.branch === "main") {
      // Same master-branch fallback as read() (torvalds/linux, ...)
      resp = await fetch(rawUrl.replace("/main/", "/master/"));
    }
    if (!resp.ok) throw new Error("ENOENT");
    return resp.text();
  }

  async readBlob(path) {
    const filePath = this._rel(path);
    if (!filePath) throw new Error("EISDIR: Is a directory");
    const rawUrl = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${filePath}`;
    let resp = await fetch(rawUrl);
    if (!resp.ok && this.branch === "main") {
      // Same master-branch fallback as read() (torvalds/linux, ...)
      resp = await fetch(rawUrl.replace("/main/", "/master/"));
    }
    if (!resp.ok) throw new Error("ENOENT");
    return resp.blob();
  }

  async stat(path) {
    const rel = this._rel(path);
    if (!rel) return { type: "dir", size: 0, mtime: undefined };
    return this._statPath(this.owner, this.repo, rel);
  }

  async write(path, content) {
    throw new Error("EROFS: GitHub is read-only (use git push)");
  }

  async remove(path) {
    throw new Error("EROFS: GitHub is read-only");
  }
}
