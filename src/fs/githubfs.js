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
// -----------------------------------------------------------------

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
    this.cache = new Map();
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
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    return resp.json();
  }

  // ─── Directory listing ──────────────────────────────────────

  async list(path) {
    const p = this._parse(path);

    // Root level or root-level files: featured repos + orgs
    if (p.root || p.file) {
      const owners = [...new Set(FEATURED.map(f => f.owner))].sort();
      return [
        ...owners.map(o => o + "/"),
        "...",
        "README.md",
      ];
    }

    // Owner level: list repos for this owner
    if (!p.repo) {
      return await this._listRepos(p.owner);
    }

    // Repo root or path within repo
    return await this._listContents(p.owner, p.repo, p.filePath);
  }

  async _listRepos(owner) {
    try {
      const data = await this._fetchAPI(
        `https://api.github.com/users/${owner}/repos?per_page=20&sort=updated&type=owner`
      );
      if (!Array.isArray(data)) return [];
      return data.map(r => r.name + "/").sort();
    } catch {
      // Fallback: show featured repos for this owner
      const repos = FEATURED.filter(f => f.owner === owner).map(f => f.repo + "/");
      return repos.length ? repos : [];
    }
  }

  async _listContents(owner, repo, path) {
    // Record the visited directory
    this.visited.add(`/${owner}/${repo}/${path}`.replace(/\/$/, "") + "/");

    let apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
    if (path) apiUrl += "/" + path;

    try {
      const data = await this._fetchAPI(apiUrl);
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
      return [];
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
    const resp = await fetch(rawUrl);
    if (!resp.ok) throw new Error("ENOENT");
    return resp.text();
  }

  async readBlob(path) {
    const p = this._parse(path);
    if (!p.owner || !p.repo) throw new Error("ENOENT");

    this.visited.add(`/${p.owner}/${p.repo}/${p.filePath}`);

    const rawUrl = `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${this.branch}/${p.filePath}`;
    const resp = await fetch(rawUrl);
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
    let apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
    if (path) apiUrl += "/" + path;
    try {
      const data = await this._fetchAPI(apiUrl);
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

  async read(path) {
    const filePath = this._rel(path);
    if (!filePath) throw new Error("EISDIR: Is a directory");
    const rawUrl = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${filePath}`;
    const resp = await fetch(rawUrl);
    if (!resp.ok) throw new Error("ENOENT");
    return resp.text();
  }

  async readBlob(path) {
    const filePath = this._rel(path);
    if (!filePath) throw new Error("EISDIR: Is a directory");
    const rawUrl = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${filePath}`;
    const resp = await fetch(rawUrl);
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
