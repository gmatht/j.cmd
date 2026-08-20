# Security

## Threat model

**The code in this repository is not audited.** The security features it
ships (the URL-parameter allow-lists below, the sandboxing hooks, the
path checks) are meant mainly for **experimental purposes** — treat them
as conveniences and guard-rails, not as a hardened security boundary.

The **real battle-hardened security line is the browser**. The webpage
runs inside the browser's sandbox (WebGL, the virtual filesystem, the
WASM runtimes), which should stop the page from doing anything too
harmful to your machine — **provided you don't trust the webpage with
anything too critical**. In particular:

- Everything the page does runs inside the browser tab's own memory and
  virtual filesystem; it cannot touch your real files beyond what the
  page's own permission prompts allow.
- Do not paste sensitive data (passwords, tokens, private keys) into the
  page and expect the in-page "security features" to protect it — they
  are not audited.
- A compromised or maliciously-served copy of this page would be a
  risk; only load it from a source you trust.

## URL parameters that auto-run or pre-fill code

The page accepts a few URL parameters that influence what runs on
load. They follow one rule: **only fixed, trusted strings are ever
auto-executed**; anything user-supplied is at most pre-filled for the
user's explicit Enter.

### `?demo=<name>` — auto-start a bundled demo

`https://…/?demo=MIMEcroft.sh` starts the MIMEcroft game automatically
when the page loads (the legacy lowercase `?demo=mimecroft.sh` is also
accepted).

The value is URL-supplied, so it is checked against a **fixed
allow-list of trusted strings** before anything runs:

```js
// www/index.html — the only place a URL parameter is auto-executed
const DEMO_ALLOWLIST = ["MIMEcroft.sh", "mimecroft.sh"];
```

Currently the only allowed values are `"MIMEcroft.sh"` and the legacy
lowercase `"mimecroft.sh"` (mapped to the page's own bundled
`MIMEcroft` command). Any other value — including
anything that looks like a command — is **silently ignored**. This is
the deliberate exception to the "pre-fill, never auto-run" rule: a demo
link is meant to start the game, but the allow-list bounds it to the
page's own self-contained, bundled demos. If new demos are added, add
their fixed names to `DEMO_ALLOWLIST` (and the `DEMO_CMD` map) — never
accept a free-form command string from the URL.

### `#prefill=…` and `#try=…` — pre-fill, never auto-run

The otranspiler GUI's share links (`#prefill=<cmd>`, `#try={src,…}`)
write the payload and **pre-fill the command line for the user's
review** — pressing Enter is the only thing that runs it. A URL alone
must never execute a user-supplied command line (a crafted link could
otherwise run `rm -rf /` or exfiltrate data), so these two are
deliberately not auto-run. Control characters are stripped from the
URL-derived strings at the boundary.

### `?cwd=…` — working directory restore

Restores the shell's working directory after a refresh. Invalid or
missing paths silently fall back to the default; the URL is normalized
to the canonical resolved path afterwards.

## Reporting issues

This is an experimental project; if you find a bug in the guard-rails
above, treat it as a normal bug (open an issue) rather than assuming a
security response process exists.
