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
    // Construct the API URL
    let apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;
    if (path) apiUrl += "/" + path;

    try {
      const data = await this._fetchAPI(apiUrl);
      if (!Array.isArray(data)) {
        // It's a single file — return its name
        return [path ? path.split("/").pop() : repo];
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

    // Root-level files (README.md, etc.)
    if (p.file === "README.md" || p.file === ".readme") {
      return await this._readme();
    }

    // If this looks like a root-level file but we don't know it, error
    if (!p.owner && p.file) {
      throw new Error("ENOENT: not a file path");
    }

    if (!p.owner || !p.repo) throw new Error("ENOENT: not a file path");

    const rawUrl = `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${this.branch}/${p.filePath}`;
    const resp = await fetch(rawUrl);
    if (!resp.ok) throw new Error("ENOENT");
    return resp.text();
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
