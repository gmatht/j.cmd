// ─── GitLabFS: Browse GitLab repos as a filesystem ──────────────
//
// Path format:
//   /mount/gitlab/                          — featured repos + orgs
//   /mount/gitlab/{owner}/                  — list projects for owner
//   /mount/gitlab/{owner}/{repo}/           — list repo contents
//   /mount/gitlab/{owner}/{repo}/{path}      — read file
//   /mount/gitlab/README.md                 — usage guide
//
// Lists via: GET gitlab.com/api/v4
// Reads via: GET gitlab.com/api/v4/projects/{ns}%2F{proj}/repository/files/{path}/raw?ref={branch}
//   (NOT the /-/raw/ web endpoint — it redirects to a lowercase namespace,
//   404s for mirror repos (GNOME/gtk's README is 404 even on master), and
//   sends no CORS headers, so browser reads fail as "Failed to fetch".
//   The API endpoint is CORS-enabled and resolves any branch, falling
//   back main → master → default branch.)
// Listings are cached persistently (LsCache, 24h TTL) like GitHubFS.
// -----------------------------------------------------------------

import { LsCache, LS_TTL } from "./lscache.js";

// The top-10 most-starred repos on gitlab.com (queried via the API's
// order_by=star_count; snapshot of the current standings). Listed at
// the /gitlab root in rank order, and used as the rate-limit fallback
// for org listings.
const FEATURED = [
  { owner: "gitlab-org", repo: "gitlab-foss", desc: "★7.2k — GitLab Community Edition mirror" },
  { owner: "gitlab-org", repo: "gitlab", desc: "★6.1k — GitLab DevSecOps platform" },
  { owner: "inkscape", repo: "inkscape", desc: "★4.0k — Inkscape vector graphics editor" },
  { owner: "CalcProgrammer1", repo: "OpenRGB", desc: "★3.4k — open-source RGB lighting control" },
  { owner: "fdroid", repo: "fdroidclient", desc: "★2.6k — F-Droid Android client" },
  { owner: "gitlab-org", repo: "gitlab-runner", desc: "★2.6k — GitLab CI/CD runner" },
  { owner: "veloren", repo: "veloren", desc: "★2.4k — multiplayer voxel RPG (Rust)" },
  { owner: "baserow", repo: "baserow", desc: "★2.3k — open-source no-code database" },
  { owner: "AuroraOSS", repo: "AuroraStore", desc: "★2.2k — FOSS Google Play client" },
  { owner: "wireshark", repo: "wireshark", desc: "★1.6k — network protocol analyzer" },
];

export class GitLabFS {
  constructor(branch = "main") {
    this.branch = branch;
    this.visited = new Set();
    this.lsCache = new LsCache("gitlab");  // replaces the old 60s in-memory cache
  }

  // Return visited paths as a flat list, for locate
  async listVisited() {
    return [...this.visited].sort();
  }

  _parse(relative) {
    const parts = relative.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length === 0) return { root: true };
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
      headers: { "Accept": "application/json" }
    });
    this._noteRate(resp);
    if (!resp.ok) throw new Error(`GitLab API ${resp.status}`);
    return resp.json();
  }

  // GitLab sends RateLimit-* headers (unauthenticated IP limits) — keep
  // them so the shell can report usage after a fresh fetch.
  _noteRate(resp) {
    const remaining = resp.headers && resp.headers.get("RateLimit-Remaining");
    const limit = resp.headers && resp.headers.get("RateLimit-Limit");
    if (remaining != null && limit != null) {
      this.apiRate = {
        name: "GitLab",
        limit: Number(limit) || 0,
        remaining: Number(remaining) || 0,
        // GitLab.com throttles unauthenticated API per-minute, not
        // per-hour like GitHub's REST API.
        period: "this minute",
      };
    }
  }

  rateInfo() {
    if (this._lastListServedFromCache) return null;
    return this.apiRate || null;
  }

  async list(path) {
    const p = this._parse(path);

    if (p.root || p.file) {
      // Feature the top-10 most-starred repos (rank order), then the
      // orgs they belong to (for browsing everything an org hosts),
      // then the README and the "..." truncation marker.
      const featured = FEATURED.map(f => `${f.owner}/${f.repo}/`);
      const owners = [...new Set(FEATURED.map(f => f.owner))].sort();
      return [...featured, ...owners.map(o => o + "/"), "README.md", "..."];
    }

    if (!p.repo) {
      return await this._listProjects(p.owner);
    }

    return await this._listContents(p.owner, p.repo, p.filePath);
  }

  async _listProjects(owner) {
    const key = `projects:${owner}`;
    const cached = this.lsCache.get(key);
    this._lastListServedFromCache = !!cached;
    if (cached) return cached.data;  // fresh cache — no API call

    try {
      // GitLab API: /users/{user}/projects or /groups/{group}/projects.
      // GitLab uses order_by/sort, NOT GitHub's sort=updated.
      let data;
      try {
        data = await this._fetchAPI(
          `https://gitlab.com/api/v4/users/${encodeURIComponent(owner)}/projects?per_page=20&order_by=updated_at&sort=desc`
        );
      } catch {
        data = await this._fetchAPI(
          `https://gitlab.com/api/v4/groups/${encodeURIComponent(owner)}/projects?per_page=20&order_by=updated_at&sort=desc`
        );
      }
      if (!Array.isArray(data)) return [];
      const entries = data.map(p => p.path + "/").sort();
      this.lsCache.set(key, entries);
      return entries;
    } catch {
      // API rate-limited / offline — stale cache first, then degrade to
      // the featured-projects list. "..." marks the truncation.
      const stale = this.lsCache.getStale(key);
      if (stale) return stale.data;
      const repos = FEATURED.filter(f => f.owner === owner).map(f => f.repo + "/");
      return [...repos, "..."];
    }
  }

  async _listContents(owner, repo, path) {
    this.visited.add(`/${owner}/${repo}/${path}`.replace(/\/$/, "") + "/");

    const key = `contents:${owner}/${repo}/${path || ""}`;
    const cached = this.lsCache.get(key);
    this._lastListServedFromCache = !!cached;
    if (cached) return cached.data;  // fresh cache — no API call

    const projectPath = `${encodeURIComponent(owner)}%2F${encodeURIComponent(repo)}`;
    let apiUrl = `https://gitlab.com/api/v4/projects/${projectPath}/repository/tree`;
    if (path) apiUrl += `?path=${encodeURIComponent(path)}`;

    try {
      const data = await this._fetchAPI(apiUrl);
      if (!Array.isArray(data)) return [];
      for (const item of data) {
        this.visited.add(`/${owner}/${repo}/${path ? path + "/" : ""}${item.name}` + (item.type === "tree" ? "/" : ""));
      }
      const entries = data
        .map(item => item.type === "tree" ? item.name + "/" : item.name)
        .sort();
      this.lsCache.set(key, entries);
      return entries;
    } catch {
      // API rate-limited / offline — stale cache if we have one, else
      // "..." marks that the listing is truncated, not empty.
      const stale = this.lsCache.getStale(key);
      if (stale) return stale.data;
      return ["..."];
    }
  }

  // Cache metadata for a listing ({ age, stale }) or null — `ls` prints
  // "cached X ago" from this.
  cacheInfo(relative) {
    const p = this._parse(relative || "/");
    let key = null;
    if (p.root || p.file) return null;   // static root/README — not cached
    if (!p.repo) key = `projects:${p.owner}`;
    else key = `contents:${p.owner}/${p.repo}/${p.filePath || ""}`;
    const age = this.lsCache.age(key);
    if (age === null) return null;
    return { age, stale: age > LS_TTL };
  }

  // Fetch a file's content via the API raw endpoint (CORS-enabled),
  // trying this.branch, then master (legacy default), then no ref at
  // all (the repo's actual default branch — what listings show).
  async _fetchFile(p, asBlob) {
    if (!p.filePath) throw new Error("ENOENT"); // directory, not a file
    const filePath = p.filePath.split("/").map(encodeURIComponent).join("%2F");
    const base = `https://gitlab.com/api/v4/projects/${encodeURIComponent(p.owner)}%2F${encodeURIComponent(p.repo)}/repository/files/${filePath}/raw`;
    const refs = [this.branch, "master", null]; // null → default branch
    for (const ref of refs) {
      const url = base + (ref ? `?ref=${ref}` : "");
      let resp;
      try {
        resp = await fetch(url);
      } catch (e) {
        throw new Error(`GitLab: fetch failed for ${p.owner}/${p.repo}/${p.filePath} (${e.message})`);
      }
      if (resp.ok) return asBlob ? resp.blob() : resp.text();
    }
    throw new Error("ENOENT");
  }

  async read(path) {
    const p = this._parse(path);

    if (p.file === "README.md" || p.file === ".readme") {
      return await this._readme();
    }
    if (!p.owner && p.file) throw new Error("ENOENT");
    if (!p.owner || !p.repo) throw new Error("ENOENT");

    this.visited.add(`/${p.owner}/${p.repo}/${p.filePath}`);
    return this._fetchFile(p, false);
  }

  async readBlob(path) {
    const p = this._parse(path);
    if (p.file === "README.md" || p.file === ".readme") {
      return new Blob([await this._readme()], { type: "text/plain" });
    }
    if (!p.owner || !p.repo) throw new Error("ENOENT");

    this.visited.add(`/${p.owner}/${p.repo}/${p.filePath}`);
    return this._fetchFile(p, true);
  }

  async _readme() {
    let text = `GitLab Filesystem
===================

Mount point for browsing GitLab repositories as a filesystem.

Usage:
  ls /mount/gitlab/owner/project
  cat /mount/gitlab/owner/project/README.md

Top-10 most-starred repos (featured at the root, in rank order):\n`;
    for (const f of FEATURED) {
      text += `  ${f.owner}/${f.repo}/  — ${f.desc}\n`;
    }
    text += `\nBrowse any public project: ls /mount/gitlab/{owner}/{project}/\n`;
    text += `List projects for a user/org:  ls /mount/gitlab/{owner}/\n`;
    return text;
  }

  async write(path, content) {
    throw new Error("EROFS: GitLab is read-only (use git push)");
  }

  async remove(path) {
    throw new Error("EROFS: GitLab is read-only");
  }
}
