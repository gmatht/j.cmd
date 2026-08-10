# PLAN — Out-of-band pointers (generic walk over any pointer structure)

**Status:** DRAFT · **Decision:** pointers are VARIABLE BINDINGS, not self-describing
strings — the embedded `\u0001mem:` envelope is LEGACY · **Scope:** c-sh-go frontend
+ sh2 runtime + samples
**Files:** `www/bin/c-sh-go/main.go` · `src/sh2runtime.js` · `www/examples/c/*.c`

## 1. Goal

Make a **genuinely generic walker/finder over any linked pointer structure** possible —
`generic_find(p, match)` should work on a linked list, a binary tree, or any future
structure, without the walker knowing the structure's layout.

Today the walker is struct-specific: `p->next` is lowered by the frontend to
`memLoad(p, "<compile-time offset>", "char")`. The offset is baked from
`structLayouts`, so the same C code cannot walk a different layout.

**Decision (this revision):** pointer identity and type are carried **out of band** —
in a variable binding and in the runtime's heap registry — never embedded in the value.
This *removes the forging surface entirely* instead of making it expensive, and matches
the model the shell already uses for arrays (`void *base` = the array's name).

## 2. Current state

- **Legacy handle format (runtime, `src/sh2runtime.js`):** `\u0001mem:<size>[:<NAME>-<HASH>:<token>]`
  — the value itself encodes arena identity + optional layout tag + capability token.
  `memLoad/memStore` parse the envelope (`memArenaOf`), bounds-check, and index the arena.
- **Layout tables (frontend):** `structLayouts[tag] = []structMember{name, ctype}`;
  `memberOffset` sums preceding `cTypeSize`s. **Known at compile time only — never
  reaches the runtime.**
- **What already works:** `void *` params, fn-pointer params (`(*cmp)(…)` — a bash
  function), dynamic walks (`p = p->next`), `find $linkedlist two` (struct-specific),
  `strcpy`/`strcat` string building.
- **The array precedent:** `void *base` in `my_qsort` is ALREADY out-of-band — the
  value is the array's variable NAME; the store decides what it is.

## 3. The design: out-of-band pointers

### 3.1 The model

- **A pointer is a variable binding**, not a string grammar. `memAlloc` registers a
  heap arena under a **generated heap name** and returns the NAME — a plain string
  with no marker byte:
  ```
  __heap_<random token>          ← a heap pointer's value (a NAME)
  "a"                            ← an array-name pointer (unchanged, already out-of-band)
  "fig"                          ← data — just a string
  ```
- **The type is out of band, in two places:**
  1. *Compile time:* the frontend's symbol table (`structPtrVars` — "p is
     `struct Node *`") already specializes every `p->…` into the right operation.
  2. *Runtime:* the **heap registry** (`heapTable`) maps each heap name → its arena,
     byte size, and layout tag — the tag is looked up from the name, never carried
     in the value.
- **Consequence:** a value is a pointer *because a pointer-typed variable holds it and
  the name resolves in the registry* — never because its bytes look like a handle.
  A data file's contents cannot become a pointer on their own; they would have to be
  assigned to a pointer variable, and even then the name must be a registered heap
  name (a random token — ~2⁻⁶⁴ to guess).

### 3.2 Heap names

- `memAlloc(size, tag?)` draws a fresh random token (`crypto.getRandomValues`, 64+
  bits; deterministic PRNG fallback when `SH2_DETERMINISTIC_RANDOM` is set), registers
  `heapTable["__heap_<token>"] = { arena, size, tag }`, and returns the name.
- Names are the **capability**: a handle can only be dereferenced if it was *issued*.
  Forging reduces to guessing a valid random heap name — infeasible — and the
  permission layer can gate which contexts may deref which names.

### 3.3 The layout registry

The frontend emits each struct's layout to the runtime at program load, and each
arena's tag is stored in `heapTable`:

```js
// generated, once per sourced file (a top-level statement):
sh2.registerStruct("Node-3f9a1c2e", 16, [
  { name: "word", isPtr: false, off: 0 },   // data — not walked
  { name: "next", isPtr: true,  off: 8 },   // child — walked
]);
```

- `structLayouts` — keyed by the full `NAME-HASH` (FNV-1a over the member list's
  `(isPtr, off)` pairs; same-layout structs share a tag, different layouts don't
  clobber) — with the pointer-member offsets **precomputed** at `registerStruct`.
- `heapTable[name].tag` — the arena's layout tag, set at `memAlloc`.
- **Type confusion guard:** a deref of a name whose registered tag doesn't match the
  receiving variable's expected tag returns `""`.

### 3.4 The bridge: `nodeChild(ptr, k)`

A runtime primitive + frontend special call (the same category as `cmp_call`/
`getline`):

```c
void *child = nodeChild(p, k);   // C source — generic
```
```go
// callNode:
case "nodeChild":
    // nodeChild(ptr, k) → the k-th POINTER-typed member of whatever
    // structure ptr points to ("" when none) — generic walk
    return call("nodeChild", []any{ getVar(ptr), <k expr> })
```
```js
// runtime:
function nodeChild(name, k) {
  const h = heapTable[String(name)];          // name → arena (no envelope parse)
  if (!h) return "";
  const layout = structLayouts[h.tag];
  if (!layout) return "";
  const off = layout.ptrOffsets[Number(k)];   // precomputed indexed read
  if (off === undefined) return "";
  return memLoad(name, off, "char");          // bounds-checked arena read
}
```

The walker never knows the structure: the name → registry → layout → offset, all at
runtime, with no value grammar to forge.

## 4. Security model

**The forging surface is removed, not priced.** In the legacy envelope model, a
crafted `\u0001mem:…` string could match a real arena if the grammar + ids were
guessable. In the out-of-band model there is no handle grammar at all — only names,
and the registry decides what they mean.

| Threat | Out-of-band defense |
|---|---|
| Forgery (crafting a handle) | Impossible by construction: the value has no pointer grammar; a name must resolve in `heapTable` |
| Random data containing a "pointer" | It's just text; only a pointer-typed VARIABLE holding a *registered* name dereferences — a random `__heap_…` matches a real token at ~2⁻⁶⁴ |
| Type confusion (valid pointer, wrong structure) | `heapTable[name].tag` vs the variable's expected tag → `""` |
| Cross-context disclosure (persistent arenas across `su`) | `heapTable` cleared/partitioned on `su`, matching the custom-code gate |
| Resource exhaustion | Cap arena count + total bytes per session |

**Declared contract:** pointer handles are issued by the runtime; user-constructed
handle strings are **unsupported** and must never be relied upon.

**Legacy note:** persisted `\u0001mem:` handles (saved sessions, files) remain
readable for backward compatibility, with the old bounds checks; new allocations use
heap names. The marker byte was never a security boundary — the legacy format is
kept only for compat, not as a model to extend.

## 5. Performance

- **Cheaper derefs:** a `heapTable` name lookup replaces the per-deref envelope
  regex parse. Values are short names (`__heap_<token>`) instead of long envelopes.
- **Unchanged costs:** the untyped-string model (`Number(x)||0` coercions, string
  values, memory for names stored in node members) and the *Sync/native-lifting
  mitigations are as before.
- **`nodeChild`** is a name lookup + an indexed read (`ptrOffsets` precomputed).
- Levers if needed (all local to `src/sh2runtime.js`, no format change): typed numeric
  arenas (`Int32Array`), LRU name→arena cache, base36 tokens to shorten names.

## 6. Implementation plan

### M1 — Runtime: heap registry + names (sh2runtime.js)
- `memAlloc(size, tag?)` → random heap name (`crypto.getRandomValues`, deterministic
  fallback), `heapTable[name] = { arena, size, tag }`, return the name.
- `memLoad`/`memStore`/`memArenaOf`: resolve by name; bounds check; tag-mismatch →
  `""`. **Keep the legacy `\u0001mem:` envelope parsing** (backward compat).
- `structLayouts` + `registerStruct(tag, size, members)`; precompute `ptrOffsets`.
- Cap arena count/size per session.

### M2 — Frontend emits the registry (c-sh-go main.go)
- After parsing, for each `structLayouts[tag]`: compute `NAME-HASH` (FNV-1a over
  `(isPtr, off)` pairs), prepend an A1 `Call{func:"registerStruct", …}` statement.

### M3 — malloc tagging (names, not envelopes)
- Where `struct Node *n = malloc(sizeof(struct Node))` is parsed, the malloc lowers
  to `memAlloc(size, "Node-<hash>")` (the frontend knows the receiving var's tag via
  `structPtrVars`). The returned NAME flows into `n`; `n->next` stores child NAMEs.
- Heap pointers become names end-to-end; `p != 0` stays the string-nonempty test.

### M4 — nodeChild bridge
- Frontend: `nodeChild(ptr, k)` special call (3.4). Runtime: `nodeChild(name, k)`.
- Optional `nodeCount(ptr)`.

### M5 — Generic walker sample
- `www/examples/c/generic_walk.c`: `generic_find(void *p, int (*match)(void*, void*), void *arg)`
  + `generic_count(void *p)`, used over a **linked list** and a **binary tree** with
  the SAME code — proving layout-agnostic walking.
- Bash demo: build a tree, `generic_find $tree match_fn fig`.
- Regenerate curated examples (`www/otranspiler-examples.js`), bump `?v=`.

### M6 — Hardening + tests
- `heapTable` cleared/partitioned on `su`; caps verified.
- Harnesses mirroring `__linked-list-test.mjs`:
  - two different `struct Node` layouts → distinct tags, no clobber;
  - same-layout `struct Node` in two files → shared tag, interop;
  - forged values (random bytes, `__heap_…` guesses, legacy `\u0001mem:…`) → `""`,
    never a crash or OOB;
  - `generic_find` on a list and a tree; missing-node; empty structure;
  - legacy `\u0001mem:` handles still load/store (backward compat).
- Rebuild `www/wasm-bin/otranspiler-busybox.wasm` + bump `BUSYBOX_VERSION`.

## 7. Edge cases & decisions

| Case | Decision |
|---|---|
| Two files, same `struct Node` layout | Same hash → shared registry entry; interchangeable. |
| Two files, different `struct Node` layouts | Different hash → `Node-<h1>` vs `Node-<h2>`; never mis-walked. |
| Same layout, different NAME | Full tag differs → separate entries (harmless). Hash-only matching optional later. |
| `char *word` member | `isPtr: false` — data; not walked. |
| `struct Node *next` member | `isPtr: true` — walked. |
| Untyped `malloc` (int arrays, blobs) | `heapTable[name].tag = null`; `nodeChild` → `""`. |
| Legacy `\u0001mem:` handles (persisted) | Parsed with old bounds checks — compat only. |
| Random data containing `__heap_…` | Just text; deref requires a registered random name. |
| Heap name leaked | Usable (capability, not revocation) — `su` clearing limits reuse. |
| Recursion | Off the table (no call stack — verified stack overflow); generic walk must be iterative (work-list of names). |

## 8. Non-goals / deferred

- Truly arbitrary structures with no registry — still impossible (a pointer must
  name its layout; the registry IS the type table).
- Recursive traversal — needs a call stack; use an explicit work-list.
- Hash-only registry keys (cross-name layout sharing) — optional later.
- Self-contained pointers that survive files/network — the out-of-band model
  deliberately trades this away (a name means nothing outside the runtime).
- Revocable / expiring capabilities — out of scope (capability model, not ACLs).

## 9. Open questions

1. Should `nodeChild` match the full `NAME-HASH` or just the `HASH` (cross-name
   interchange of identical layouts)? Default: full tag (conservative).
2. Heap-name format: `__heap_<16-hex>` vs base36-short — cosmetic; pick base36.
3. Should the walker expose DATA members too (a `nodeData(ptr, k)` bridge), or is
   the predicate's struct-specific access enough? Default: predicate-side.
4. Typed numeric arenas (`Int32Array`): worth the bookkeeping, or keep strings for
   uniformity? Default: strings, revisit on a hot numeric loop.
5. When do we STOP issuing legacy `\u0001mem:` envelopes (drop-in, or keep for
   persisted-state compat indefinitely)? Default: keep parsing, stop issuing.
