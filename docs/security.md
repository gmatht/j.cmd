# Security Model

j.cmd (jtsh) is a JavaScript shell that runs entirely in the browser (or the
Node CLI) over a virtual filesystem. This document describes what is actually
enforced, what is cooperative, and where the real trust boundaries lie — so a
user knows exactly what `su nobody` does, why a browser API key is safe from
other websites but not from page visitors, and what to do before deploying
publicly.

## Threat model in one paragraph

The browser sandbox protects the *host machine* and *other websites* from the
page. It draws **one** trust boundary — the page's origin. Everything inside
that boundary (all of the page's JS, its localStorage, its in-memory VFS)
shares a single trust domain. The shell therefore implements *users* as a
role/permission layer *within* that domain: enforcement lives in the
filesystem layer and in command resolution, so shell commands cannot bypass
it. That enforcement is cooperative only against the page's own module code
and the browser console — not against a compromised page.

```
host machine  ─── browser sandbox ───  page origin (one trust domain)
                                        ├─ VirtualFS  ← permissions enforced here
                                        ├─ command resolution ← exec gate here
                                        ├─ llm keys    ← per-client, origin-scoped
                                        └─ network     ← CORS-gated
```

## Trust boundaries

| Boundary | Enforced by | Bypassable by |
|---|---|---|
| Host machine vs page | Browser sandbox | — (this is the browser's job) |
| Other websites vs page data (localStorage, keys, VFS) | Same-Origin Policy + CORS | — (demonstrated: cross-origin reads are blocked) |
| User A vs user B *within* the page | VirtualFS permission layer + exec gate | Page module code, browser console (cooperative) |
| Shell commands vs the VFS | VirtualFS checks (all commands reach the FS only through `fs`) | Nothing the shell runs — commands get the `fs` facade, not backend internals |

## Users and the permission layer

`su` switches `env.USER`; every VFS operation checks the current user against
each path's owner and Unix mode bits.

- **Files/dirs carry owner + mode** (e.g. `0644`, `0700`). New files are
  attributed to the writer; unknown/legacy paths default to `jtsh` `0755`.
- **Enforcement points**: `read`, `write`, `list`, `remove`, `stat`,
  `statSync` (the sync path powers `[ -f ]` inside bash). Reads need the read
  bit; writes need the write bit plus traverse on the parent; listing needs
  the read bit; stat needs only traverse (metadata is visible, content is
  not — like Unix).
- **`su nobody` consequences**: cannot read a `0600` jtsh file (`EACCES`),
  cannot write into jtsh's home, cannot `chmod` files it doesn't own.
  Unprivileged users are `nobody`, `daemon`, `guest`, `www-data`.
- **Admin bypass**: `jtsh` and `root` bypass all checks (the boot-created
  world is jtsh's).
- **`su` homes** are owned by the target user (`0700`) — an account can always
  write in its own home.
- **`chmod OCTAL file...`** — owner or admin only.
- **`mount --bind <src> <dst>` and `chroot <dir>`** are **admin-only**:
  an unprivileged user could otherwise bind a directory over a protected one
  to bypass permissions, or jail themselves to evade checks. Bind mounts
  translate permission lookups back to the *original* paths — a bind never
  bypasses ownership or mode bits.

### Why this is real, not cosmetic

Commands only reach the filesystem through the `fs` facade (they never get the
backend objects or the `localStorage` keys directly), so the permission layer
is enforced against everything the shell runs — including the `llm` agent's
`read`/`write`/`edit` tools, `bash` pipelines, and `.js` commands. This is the
same "row-level security" model databases use: cooperative against the
application's own code, hard against everything else that matters.

### Limitations

- **No group concept**: group bits are treated as "other".
- **Cooperative against the page itself**: the shell's module code and the
  browser console can reach `localStorage` directly. This is inherent to a
  single-page app — the page's code *is* the trust root.
- **`statSync` is synchronous** (bash's `[ -f ]`), so file tests work only on
  local mounts; remote paths report false.

## Custom-code execution gate

Unprivileged users may run only **builtins and `.js`/`.wasm` files owned by
`jtsh`** (the admin-trusted set). Anything they — or another non-admin —
created is refused:

```
nobody:/home/nobody$ /home/nobody/evil.js
operation not permitted: unprivileged users cannot run custom code (owned by nobody)
```

Rationale: arbitrary `.js`/`.wasm` is full code execution in the page's trust
domain (it can read the VFS, run commands, even `fetch` to the network). Letting
an unprivileged session run custom code would hand it the keys to escalate.
Wasm auto-loading is also gated (unprivileged users never auto-load, and
couldn't write to `/usr/bin` anyway).

## LLM keys and secrets (the `llm` command)

The `llm` command reads its key from `$LLM_API_KEY` or `~/.config/llm.key`
(a file in the VFS — localStorage-backed in the browser).

### The Same-Origin question

- **Other websites cannot read your localStorage.** Same-Origin Policy scopes
  `localStorage`, cookies, IndexedDB and the DOM to *scheme + host + port*.
  Demonstrated live: a page on origin B fetching origin A's data gets
  `TypeError`; a cross-origin frame touching `contentWindow.localStorage`
  throws `SecurityError`.
- **Visitors to a deployed page also cannot read your key.** `localStorage` is
  *per-client*: every visitor gets their own empty storage for the origin.
  Your key was written to *your* browser and is never part of the served
  bytes — as long as it isn't committed to the repo (verified: it isn't).

### Where your key actually is exposed

| Who | Can they read your key? |
|---|---|
| Other websites | No (SOP) |
| Visitors to the page | No (per-client localStorage) |
| **Same-origin code running in *your* browser** | **Yes** — browser extensions, an XSS hole, or a malicious `.js` command the shell runs |
| Anyone with access to your machine/browser | **Yes** — DevTools, session theft, shared machines |

The mirror-image case: a *visitor* who enters their own key on your deployed
page is trusting the site's code (same-origin — the shell could read their
key, and a malicious `.js` command could exfiltrate it via `fetch`). That is
fine when the visitor is you and the tool is yours; it is exactly the BYOK
model — each user brings their own key, and each key is only as safe as the
machine and the commands that touch it.

### Recommendations

- **Personal demo**: keep the key in your browser/local config; the residual
  risk is extensions, malicious commands, and machine access — not the
  public-ness of the site.
- **Public deployment**: hold the key on a small server/proxy and point the
  shell at it (`llm --base http://your-proxy/v1`). The browser then never sees
  the key, SOP actually protects it, and you can restrict/rotate it at the
  provider.
- **Never commit keys** to the repo (the deployed site is built from it).
- Audit what extensions you run and what commands the shell executes.

## Network and CORS

- The `/http/` mount is CORS-enabled `fetch`: it can reach any endpoint that
  sends `Access-Control-Allow-Origin`; other origins' data is unreadable.
- The `llm` command works from the browser because most LLM APIs are
  CORS-enabled. Verified: OpenAI, Groq, Mistral, OpenRouter, Gemini and
  DeepSeek all send `Access-Control-Allow-Origin`; **Anthropic does not**.
- Remote mounts (`/github`, `/gitlab`, `/git`, `/http`) are read-only;
  writes land in a local overlay (stored in localStorage under `fs:ovl:`
  keys) with a warning, never on the remote.

## Deployment checklist

- [ ] No secrets in the repo or served files (`git grep` for key shapes).
- [ ] If public: keys live server-side (proxy + `--base`), or each user BYOKs.
- [ ] Restrict/rotate provider keys; prefer domain/spend restrictions.
- [ ] Keep unprivileged-user and custom-code gates enabled — they are the
      defense against a compromised or malicious command inside the shell.
- [ ] Remember: the page's own code and the browser console can always bypass
      the in-page layers — that is the price of a single-page app.
