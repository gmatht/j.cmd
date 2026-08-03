// ─── bugreport.js ──────────────────────────────────────────────
// The `bug` command: file a bug report from inside the shell as a
// GitHub issue on gmatht/j.cmd, tagged with the bug-report label.
//
// The shell captures terminal context (last 20 lines by default, or
// more / the whole terminal / the whole page DOM), asks the user what
// they expected (or to trust us to infer it from the snippet), and
// POSTs a structured markdown report. With no token, the report is
// saved to /tmp and (in the browser) copied to the clipboard instead.
//
// Triage on the repo side: ./bug-triage.sh  (list / show / pick)
// -----------------------------------------------------------------

export const BUG_REPO = "gmatht/j.cmd";
export const BUG_LABEL = "bug-report";
export const BUG_SITE = "https://gmatht.github.io/j.cmd/www/";

/**
 * Assemble the markdown report body.
 *  scope: "20" | "500" | "terminal" | "dom" — how much context was sent
 */
export function buildReport({ summary = "", expected = "", snippet = "", scope = "20" }) {
  const scopeLabel =
    scope === "500" ? "Terminal (last 500 lines)"
    : scope === "terminal" ? "Terminal (whole scrollback)"
    : scope === "dom" ? "Page DOM (first 200KB)" // the DOM dump is capped in the shell
    : "Terminal (last 20 lines)";
  const expectedText = expected.trim()
    ? expected.trim()
    : "— (user trusts us to infer the expected behavior from the snippet)";
  const summaryText = summary.trim() || "— (see snippet)";
  return `<!-- jtsh bug report · filed by the shell's \`bug\` command · ${BUG_LABEL} -->
**Reported:** ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC
**Source:** ${BUG_SITE} (browser shell) / node CLI
**Version:** jtsh 0.1.0

## Summary
${summaryText}

## Expected
${expectedText}

## ${scopeLabel}
\`\`\`text
${String(snippet).replace(/\s+$/, "")}
\`\`\`
`;
}

/**
 * Post a report to the GitHub issues API. Returns the issue URL.
 * Falls back to posting without the label if the label doesn't exist
 * yet (GitHub 422s on unknown labels).
 */
export async function postIssue({ token, title, body }) {
  const base = `https://api.github.com/repos/${BUG_REPO}/issues`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const payload = { title, body, labels: [BUG_LABEL] };
  let res = await fetch(base, { method: "POST", headers, body: JSON.stringify(payload) });
  if (res.status === 422) {
    // Label probably doesn't exist yet — retry without it.
    delete payload.labels;
    res = await fetch(base, { method: "POST", headers, body: JSON.stringify(payload) });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data.message || res.statusText}`);
  return data.html_url || `${base}/${data.number}`;
}

// ─── token storage ─────────────────────────────────────────────
// Browser: localStorage. CLI: $JTSH_GITHUB_TOKEN, then ~/.jtsh-gh-token.

export async function getBugToken(storage) {
  if (storage && typeof storage.getItem === "function") {
    return storage.getItem("jtsh.githubToken");
  }
  if (typeof process !== "undefined" && process.env?.JTSH_GITHUB_TOKEN) {
    return process.env.JTSH_GITHUB_TOKEN;
  }
  if (typeof process !== "undefined") {
    try {
      const { readFileSync } = await import("node:fs");
      const p = `${process.env.HOME || process.cwd()}/.jtsh-gh-token`;
      return readFileSync(p, "utf8").trim();
    } catch { return null; }
  }
  return null;
}

export async function setBugToken(storage, token) {
  if (storage && typeof storage.setItem === "function") {
    storage.setItem("jtsh.githubToken", token);
    return;
  }
  if (typeof process !== "undefined") {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${process.env.HOME || process.cwd()}/.jtsh-gh-token`, token.trim(), { mode: 0o600 });
  }
}

export function clearBugToken(storage) {
  if (storage && typeof storage.removeItem === "function") {
    storage.removeItem("jtsh.githubToken");
  }
}
