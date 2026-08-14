# PLAN — Boxed pointers with a layout registry (generic walk over any pointer structure)

**Status:** IMPLEMENTED (2025-03: runtime boxes + layout registry + generic-walk sample + tests all
landed; every harness incl. the 34-file C corpus passes) · **Decision:** pointers are BOXED VALUES
inside the runtime (`{arena, off, tag}`), never strings for deref; the legacy `\u0001mem:` envelope
is READ-ONLY compat; string→pointer conversion is FORBIDDEN (forgery is structurally impossible)
· **Scope:** c-sh-go frontend + sh2 runtime + samples + tests
**Files:** `www/bin/c-sh-go/main.go` · `src/sh2runtime.js` · `src/estree.js` ·
`www/examples/c/generic_walk.c` · `__generic-walk-test.mjs`

**Implemented:** `memAlloc(size, tag)` returns `{arena, size, tag, off, __id}` (toString →
`\u0001mem:<id>:<off>`); `memLoad`/`memStore`/`memAdvance` accept boxes (direct arena access)
AND envelopes/names (read-compat); `registerStruct(tag, members)` + `nodeChild(p,k)` /
`nodeData(p,k)` / `ptrTag(p)` + `ptrMembers(p)` — the generic-walk seam; the c-sh-go frontend
emits `registerStruct("Tag-<fnv1a>", …)` per `struct` and tags `malloc(sizeof(struct Tag))`; the
estree passes that make it work end-to-end: box-preserving `setVar`/positional maps,
`unwrapStoreString`, `nullSentinel` ("0" is NULL), `returnInLoop` (in-loop C returns become
`sh2.ReturnSignal` throws), `awaitSyncFnCalls`; `www/examples/c/generic_walk.c` +
`__generic-walk-test.mjs` prove a layout-agnostic walker over a Node list.

**Bonus — the ptrfs (pointer-as-filesystem):** `cd $ptr` enters a box as a virtual directory
(the shared shellcore `cd`/`find`/`ls` builtins, both shells). The layout registry's members
are its children: pointer members are directories (descended via `nodeChild`), scalar members
are files, NULL sentinels (`""`/`"0"`) are hidden. `pwd` shows the handle chain
(`\u0001mem:3:0/next`); `cd MEMBER` descends, `cd ..` unwinds, `cd ..` at the root restores
the real fs cwd; `find .` walks the whole tree with the normal predicates (`-name`, `-type`,
`-maxdepth`), `ls` lists members, `cat MEMBER` prints a scalar member's value. Paths are
multi-component (`cd next/next`, `ls next/word`, `cd ../..`); the interactive prompt shows the
handle chain (`jtsh:mem:4:0/next$`), and the browser's ?cwd= URL sync is skipped while
inside a pointer (the handle is runtime-local). **Searching:** `grep PATTERN .` greps the
structure's scalar members recursively (labeled `./path:value`; `-h`/`-H` control labels),
`find . -exec grep -h PATTERN '{}' ;` runs the command per matched member (paths resolve back
through the pointer; `-exec` suppresses the default print like GNU find), and `rg PATTERN` is the
ripgrep-ish recursive alias. The `looksLikeBash` router no longer misroutes `find -exec` lines
(the `{}` placeholder and `\;` terminator are native tokens, not bash control syntax). Covered by
`__ptrfs-test.mjs` (39 checks). A doubly linked list (`www/examples/c/doubly_linked_list.c`) —
`prev` + `next` per node, so the pointer graph is cyclic — is built, walked both directions by C
and by the ptrfs (the `prev` back-edges show as directories but are never re-walked), and covered
by `__dll-test.mjs` (15 checks).

## 1. Goal

A **genuinely generic walker/finder over any linked pointer structure** — `generic_find(p, match)`
works on a linked list, a binary tree, or any future structure, without the walker knowing the
structure's layout. Today the walker is struct-specific: `p->next` is lowered by the frontend to
`memLoad(p, "<compile-time offset>", "char")` — the offset baked from `structLayouts`.

**This revision:** pointer identity and type live in a **boxed value** and a **layout registry** —
never in a string. Type information + dynamic introspection are available for any tagged
allocation. (Prior "out-of-band NAME" revision superseded: names were simpler at the shell
boundary but added registry lookups per deref; boxes are cheaper and make forgery structurally
impossible.)

## 2. The model

### 2.1 A pointer is a box

```js
// the value held by a pointer-typed variable (heap allocation):
{ arena: [ … ], size: 16, tag: "Node-3f9a1c2e", off: 0 }
```

- `memAlloc(size, tag?)` creates the arena and returns the **box**. `n = malloc(sizeof(struct Node))`
  puts the box in `n`.
- Deref: `p.arena[p.off + memberOffset]` — direct field access, no parse, no lookup.
- `p = p->next` — read the box (or a name/`""`) out of the cell.
- Shell variables hold boxes: the transpiler passes them through variable reads, so
  `$linkedlist` is a box and `sink2 $linkedlist` passes the box.
- **String→pointer conversion does not exist.** A string is never dereferenced as a heap
  pointer — even a display id. Forgery is structurally impossible: you cannot construct a box
  from shell-visible text.

### 2.2 Named-variable references (the shell-boundary form)

A pointer to a shell VARIABLE (array/scalar — `void *base` = `"a"`) stays a name-reference:
the value is the variable's NAME; deref reads the variable. This is the ONLY string that can
be dereferenced, and it is safe by construction (a name references a variable you could
already write). It is the cross-line mechanism: a C function stores a heap box in a variable
(`last = head`) and hands out the variable's NAME; a later line passes the name and deref
resolves name → variable → box.

### 2.3 The layout registry

The frontend emits each struct's layout once per sourced file; each arena's tag is set at
`memAlloc`:

```js
sh2.registerStruct("Node-3f9a1c2e", 16, [
  { name: "word", isPtr: false, off: 0 },   // data — not walked
  { name: "next", isPtr: true,  off: 8 },   // child — walked
]);
```

- Tag = FNV-1a over the member `(isPtr, off)` pairs — same layout in two files shares a tag,
  different layouts never collide.
- `nodeChild(p, k)` — the k-th pointer-typed member (precomputed `ptrOffsets`); `""` when none
  or untagged. `nodeData(p, k)` optional.
- The tag is uniform: every typed malloc carries it. Untyped malloc (`int` arrays, blobs) →
  `tag: null` → `nodeChild` → `""`.

### 2.4 Structs with arrays

Inline arrays are **cell runs** — `coords[10]` is 10 cells at `off + i * elemSize` — no JSON, no
extra representation. The arena IS the flat layout C uses.

## 3. Security model

| Threat | Defense |
|---|---|
| Forgery (crafting a pointer from text) | Impossible by construction: no string→box conversion exists |
| Display id / leaked id re-used as a pointer | Inert — a string is never dereferenced as a heap pointer |
| Type confusion (valid pointer, wrong structure) | `box.tag` vs the registry — `nodeChild` returns `""` on mismatch |
| Cross-context disclosure (across `su`) | `heapTable`/arenas cleared or partitioned on `su` |
| Code-level forgery (a wasm builds a fake box) | Out of scope: running code is full trust |

**Legacy note:** persisted `\u0001mem:` envelopes (saved sessions) parse read-only with the old
bounds checks; they are never issued and never create arenas from crafted strings.

## 4. Runtime API (src/sh2runtime.js)

- `memAlloc(size, tag?) → box {arena, size, tag, off}` — the ONLY way to obtain a heap pointer.
- `memLoad(box, off, type)` / `memStore` — direct arena index (box) or named-var/legacy path.
- `memAdvance(box, delta)` — returns `{…box, off: off+delta}` (new box; sharing a box must copy).
- `registerStruct(tag, size, members)` — the layout registry; precompute `ptrOffsets`.
- `nodeChild(ptr, k)` — generic walk primitive (tag → layout → ptrOffsets[k] → arena read).
- `nodeCount(ptr)` optional.
- `String(box)` / display — an inert id (for `echo`/persistence); never deref-able.
- Legacy `\u0001mem:` parse stays for read-compat (memLoad1/memArenaOf).

## 5. Frontend (www/bin/c-sh-go/main.go)

- Emit `registerStruct` for every `structLayouts[tag]` (tag = FNV-1a of `(isPtr, off)`).
- `malloc` → `memAlloc(size, "<Tag>-<hash>")` when the receiving var is a struct pointer
  (`structPtrVars`); else `memAlloc(size)` (untagged).
- `nodeChild(ptr, k)` special call (like `cmp_call`/`getline`).
- `p->member` / `*p` / `p = p->next` — unchanged lowering (memLoad/memStore/memAdvance), which
  now receive boxes.

## 6. Samples

- `linked_list.c` — `slurp2` stores the head box in `$last` and the demo passes the variable's
  NAME (`sink2 last`), instead of printing a `\u0001mem:` handle string.
- `generic_walk.c` — `generic_find(void *p, int (*match)(void*, void*), void *arg)` +
  `generic_count(void *p)`, walked over a linked list AND a binary tree with the same code.
- Regenerate curated examples (`www/otranspiler-examples.js`), bump `?v=`.

## 7. Tests (no deploy)

- Harness mirroring `__linked-list-test.mjs`:
  - two different `struct Node` layouts → distinct tags, no clobber;
  - same layout in two files → shared tag, interop;
  - forged text (random strings, display ids, legacy `\u0001mem:` guesses) → `""`, no crash;
  - `generic_find` over a list and a tree; missing node; empty structure;
  - legacy `\u0001mem:` envelopes still load/store (read-compat);
  - shell-variable box passing (`sink2 "$last"`).
- Rebuild `www/wasm-bin/otranspiler-busybox.wasm` + bump `BUSYBOX_VERSION`.

## 8. Non-goals / deferred

- Recursive traversal (no call stack) — walkers use explicit work-lists.
- Pointers that survive processes/network — boxes are in-runtime; persistence is a flat-arena
  dump (cycle-safe) or a display id.
- Hash-only registry keys (cross-name layout sharing) — optional later.
- Revocable/expiring capabilities — out of scope.
- Typed numeric arenas (`Int32Array`) — a later perf lever; values stay strings for uniformity.
