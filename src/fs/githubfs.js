// ─── GitHubFS: Browse GitHub repos as a filesystem ──────────────
//
// Path format:  /mount/github/{owner}/{repo}/{path}
// Lists via:    GET api.github.com/repos/{owner}/{repo}/contents/{path}
// Reads via:    GET raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
//
// Example:
//   ls /mount/github/gmatht/sh2perl
//   cat /mount/github/gmatht/sh2perl/README.md
// -----------------------------------------------------------------

export class GitHubFS {
  constructor(branch = "main") {
    this.branch = branch;
    this.cache = new Map();  // path → { entries | content }
  }

  _parsePath(relative) {
    // relative = /{owner}/{repo}/...path
    const parts = relative.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    const filePath = parts.slice(2).join("/");
    return { owner, repo, filePath };
  }

  async _fetchAPI(url) {
    const resp = await fetch(url, {
      headers: { "Accept": "application/vnd.github.v3+json" }
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${url}`);
    return resp.json();
  }

  async list(path) {
    const info = this._parsePath(path);
    if (!info) return [];

    // Root of a specific repo — list its contents
    const apiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${info.filePath}`;

    try {
      const data = await this._fetchAPI(apiUrl);
      if (!Array.isArray(data)) {
        // It's a single file, not a directory
        return [info.filePath.split("/").pop()];
      }
      return data.map(item => item.type === "dir" ? item.name + "/" : item.name).sort();
    } catch (e) {
      // If the repo root itself fails, maybe it's a listing of users/repos?
      // For now, return empty
      return [];
    }
  }

  async read(path) {
    const info = this._parsePath(path);
    if (!info) throw new Error("ENOENT: invalid GitHub path");

    const rawUrl = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${this.branch}/${info.filePath}`;
    const resp = await fetch(rawUrl);
    if (!resp.ok) throw new Error(`ENOENT: ${rawUrl}`);
    return resp.text();
  }

  async write(path, content) {
    throw new Error("EROFS: GitHub is read-only via the filesystem (use git push)");
  }

  async remove(path) {
    throw new Error("EROFS: GitHub is read-only via the filesystem");
  }
}
