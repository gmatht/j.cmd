# Why all the junk?

A field guide to the odd files around this repo — what created them, what
they prove, and what is safe to delete.

Short version: **most of it is scratch from agent sessions**, and a small,
interesting subset is **evidence of a real transpiler bug**. The two look
similar on disk and should not be treated the same.

---

## The three kinds of junk

### 1. Scratch from agent sessions (the bulk — ~87 untracked files)

Files named `__*.mjs`, `__*.tmp.mjs`, `probe_*.mjs`, `repro-*.mjs`,
`mc-debug*.js`, plus a pile of `tmp/` output.

| Pattern | Examples | What it is |
|---|---|---|
| `__<topic>-test.mjs` | `__gameplay-test.mjs`, `__mime-test.mjs` | one-off probes by a working agent; some were later promoted to real gates (`__upstream-guard-test.mjs`), most were not |
| `__<topic>.tmp.mjs` | `__json3.tmp.mjs`, `__h4a.tmp.mjs` | explicitly temporary — the `.tmp.` is the author saying "delete me" |
| `probe_*.mjs` | `probe_pyexec2.mjs` | one-question experiments (does `pyExec` do X?) |
| `mc-debug.js`, `mc-debug-t.js` | 487 KB / 3.8 MB | dumped ESTree from debugging mimecroft's transpile step |
| `out.txt`, `errors.log`, `final_result.txt`, `comparison.txt` | 0–3 bytes | stray redirect targets from manual runs (`... > out.txt`) |
| `*.png` at the root | `left_block_flat.png`, `Smooth.png`, `pir.png` | screenshots taken during visual-diff work |

None of this is referenced by any build, test, or script. It is the
sediment of many sessions, and it is why `git status` is noisy.

**Except one** — see §2.

### 2. The 130-byte file with the shell source in its name

```
=$(echo "scale=4; 0.0 - $relz + 0.0" | bc)\n  if [ "$(echo "scale=4; if ($w < 0.0001) 1 else 0" | bc)" = "1" ]; then w=0.0001; fi|
```

Contents: `   bc)| bc)` (12 bytes).

This one is **not** scratch. It is a bug report written by the filesystem.

It is an **unquoted command substitution used as a redirect target**. Read
the name carefully and you can see the two halves of its origin:

- `$(echo "scale=4; 0.0 - $relz + 0.0" | bc)` — a bash float capture from
  `www/examples/mimecroft-vertex.sh:82`
  (`w=$(echo "scale=4; 0.0 - $relz + 0.0" | bc)`)
- `if [ ... ]; then w=0.0001; fi` — the *shell-syntax* form of a GLSL clamp
  that `www/bin/mimecroft.sh:1307` injects into the generated shader

Two details are diagnostic:

- The `\n` is a **literal backslash-n**, never a real newline. That is the
  fingerprint of the text being re-escaped at least twice on its way into a
  filename.
- The contents `   bc)| bc)` are the stdout of two `bc` runs — the pipe
  fragments split the redirect target.

#### The bug it exposes

bash's contract for a redirect target built from a command substitution is
**word splitting**, and it is exact:

| Expansion produces | bash's behaviour |
|---|---|
| **one word** | the redirect happens — the file is created |
| **zero words** | `ambiguous redirect`, status 1, **no file** |
| **many words** | `ambiguous redirect`, status 1, **no file** |

The name above has spaces, so bash sees *many* words and refuses outright —
**real bash never wrote this file.** Something more permissive did.

The JS backend emits `sh2.fs.writeFile(...)` with the *word-splitter's
array* as the path:

```js
await sh2.fs.writeFile(
  sh2.captureWords(() => sh2.builtin("echo", ["alpha"])),   // ← an ARRAY
  "hi" + "\n")
```

So one word errors with `path.startsWith is not a function`, and two words
collapse to `alpha,beta`. Upstream (`sh2perl`), `--target js` lowers the
whole statement to a `TODO(unsupported)` marker — prints nothing, creates
nothing, exits 0 — while `--target sh` renders `echo hi >$(echo onepiece)`
correctly, so this is **JS-target specific, not a parse failure**.

A permissive path like this is how a multi-word expansion ends up writing a
file named after shader source instead of failing loudly.

**Pinned by:** `upstream-repros/08-unquoted-cmdsub-redirect-target.sh`
(repo-local) and `__redirect-target-test.mjs` (unit half). Registered in
`__upstream-guard-test.mjs` as `KNOWN_OPEN`, so it cannot block a deploy but
also cannot be silently forgotten. Upstream half:
`sh2perl/bash_tests/redirect_target_ambiguity.sh`.

### 3. Same bug family, elsewhere on the box

`/home/llm/sh2loop/` (outside this repo) holds ~20 more of the same class —
`"${f}"`, `"a.sh"`, `$__sh2_rd0`, `&1`, `&2`, `&3`, `&4`, `-`, and one
several-hundred-byte name that is a dumped A1 shIR JSON fragment. These are
redirect-target fragments and unquoted-expansion artifacts accumulated by
the same kind of run. They are not this repo's problem, but they are the
same bug, and their existence is corroboration that the shape above is
systematic rather than a one-off.

---

## Things I got wrong while investigating (worth recording)

Kept here because both mistakes are easy to repeat.

1. **"No such file" is not always the interesting error.** The original
   report was `www/py.js:1:1 Invalid or unexpected token`. There *is no*
   `www/py.js` — the file is `src/py.js`, loaded by `www/vendor/py-worker.js`
   via a relative path (`var PY_SRC = "../../src/py.js"`, line 38). The path
   in the error was a red herring.

2. **That `src/py.js` was 8828 NUL bytes.** Not truncated, not empty —
   zeroed while *larger* than its 5094-byte original: an
   allocated-then-never-filled write. I initially blamed ENOSPC confidently;
   `dmesg` showed no ENOSPC and no OOM, so that remains **unproven**. The
   disk is 94% full, which makes it plausible, but the log evidence does not
   support it. Restored from `HEAD`.

3. **A false-positive detector wasted a pass.** My first "all-NUL files"
   sweep used `grep -qv $'\x00'`, whose NUL pattern matches *everything* —
   it flagged ~250 healthy files. A byte-level `python3` check found the
   single genuinely-zeroed file. Pattern scans for binary corruption need
   byte comparison, not regex.

4. **My own probes were broken and I misread them.** Early redirect tests
   piped through `2>&1 | head`, so bash's `ambiguous redirect` (status 1)
   was swallowed and I concluded bash rejects the construct *entirely*. It
   does not — it accepts the single-word case and creates the file. The
   corrected contract is in §2's table.

5. **Two agents were running at once.** A `src/py.js` rewrite appeared
   between two of my checks. It was not corruption and not a rogue watcher:
   `.pir/sessions/` showed two sessions, one `completed`, one mine. The
   commit is real work; provenance was unclear at the time, which is why the
   commit message describes the diff rather than claiming authorship.

---

## Not junk (don't "clean" these)

- `src/lower.js`, `src/jtsh.js`, `src/py2cy.js`, `bench/py2cy-smoke.mjs`,
  `www/auto_cython*.js` — **modified tracked source**, i.e. uncommitted work.
  Check `git status` before assuming untracked = disposable.
- `www/examples/textures/texture-*.png` — show as modified, but the diffs are
  **PNG `tIME` chunks only** (9 bytes each): regeneration timestamps. Pixel
  data is untouched. A jittery diff, not a visual change.
- `.pir/` — agent session state and undo backups (gitignored).
- `isolate-*.log` — an 11 MB V8 CPU profile from a `--prof` run
  (gitignored).
- `.gitattributes` — was extended by pir itself (`*.png binary` etc.). The
  existing `!www/wasm-bin/*.wasm` un-ignore rules mean this repo *tracks*
  binaries by design; see the pre-commit note below.

---

## Why junk accumulates here specifically

- **Agents work in-tree.** Every probe script, screenshot and dumper lands
  in the repo root unless someone moves it.
- **The runtime is permissive.** Where bash refuses, sh2runtime sometimes
  proceeds (or partly proceeds) — §2 is the sharpest example. A permissive
  path silently produces artifacts instead of an error.
- **Heavy binary/asset work.** Texture regeneration, wasm builds and
  screenshot diffs all write files as a side effect.
- **No cleanup pass.** There is no `make clean` for scratch, and `.gitignore`
  only ever covered build outputs.

---

## Practical policy

1. **Treat the §2 file as evidence, not litter.** It is the only artifact
   documenting a live bug. Don't delete it until
   `upstream-repros/08-…sh` *matches* real bash.
2. **Everything in §1 is disposable.** If in doubt, `git status --short`
   first: if it starts with `??` and isn't §2, it is scratch.
3. **Prefer `.gitignore` over deletion** for agent state (`.pir/`), profiles
   (`isolate-*.log`) and generated assets — those recur.
4. **`git add -A` is unsafe here.** Commit named files. There are ~87
   untracked scratch files (some multi-megabyte) that should never reach
   history.
5. **The pre-commit hook blocks all binary diffs.** This repo tracks PNGs
   and `.wasm` on purpose (`.gitattributes` un-ignores them), so committing
   them needs `--no-verify`. A path allowlist would be better than that
   escape hatch.
6. **When a file looks corrupt, read the bytes.** `file`, `stat`, and a
   `python3` byte check beat any regex — see mistake 3 above.

---

## Related

- `docs/architectural-considerations.md` — why the runtime is shaped this way
- `docs/realbash.md` — the real-bash wasm path
- `upstream-repros/README.md` — the reproducer convention and status table
- `__redirect-target-test.mjs` — the unit half of the §2 bug
