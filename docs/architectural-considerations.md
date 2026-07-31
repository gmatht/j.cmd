# Architectural Considerations for Multi-Language, Multi-Input Transpilation

This document captures the architectural analysis, trade-offs, and design
decisions that shape debashc's evolution from a shell-to-Perl converter into
a multi-language, multi-input transpilation framework.

## Table of Contents

1. [Comparison with bson-transpilers](#1-comparison-with-bson-transpilers)
2. [Can We Reuse bson-transpilers' Parts?](#2-can-we-reuse-bson-transpilers-parts)
3. [ESTree as an Intermediate Representation](#3-estree-as-an-intermediate-representation)
4. [BSON as an Intermediate Representation](#4-bson-as-an-intermediate-representation)
5. [Extended ESTree + Lowering Passes](#5-extended-estree--lowering-passes)
6. [The Multi-Input, Multi-Output N×M Problem](#6-the-multi-input-multi-output-nm-problem)
7. [A Common Shell-Language IR](#7-a-common-shell-language-ir)
8. [Type Inference for a Rust Backend](#8-type-inference-for-a-rust-backend)
9. [Recommended Architecture](#9-recommended-architecture)

---

## 1. Comparison with bson-transpilers

[bson-transpilers](https://www.npmjs.com/package/bson-transpilers) is an npm
package from MongoDB Compass that transpiles MongoDB shell query syntax
(e.g. `{ item: "book", qty: Int32(10) }`) into language-specific driver code
(Java, C#, Python, Ruby, Go, etc.).

### Similarities

Both are **source-to-source compilers**. Both handle multiple output languages.

### Differences

| Aspect | bson-transpilers | debashc |
|---|---|---|
| **Language** | JavaScript/Node.js | Rust |
| **Parser** | ANTLR 4.7.2 + custom `ECMAScript.g4` | Custom lexer (logos crate) + recursive-descent parser |
| **AST** | ANTLR `ParserRuleContext` tree | Native Rust structs (`Command`, `Pipeline`, etc.) |
| **Input** | MongoDB shell query expressions | Full shell/bash language |
| **Scope** | Expression-level (BSON documents only) | Full language (pipelines, control flow, functions, I/O) |
| **Codegen** | YAML "symbol tables" + visitor inheritance chain | Procedural Rust string-building per submodule |
| **License** | SSPL | GPLv3 |

### Key Architectural Pattern: Symbol Tables

bson-transpilers' YAML symbol tables define per-language mappings for types:

```yaml
Int32:
  template: "new Document()"    # Java override
  args: [Integer, String]       # accepted argument types
  argsTemplate: "($1)"          # argument formatting
  code: 104                     # import classifier
```

This declarative approach lets contributors add a target language by writing
a YAML file instead of implementing visitor methods. However, it works because
BSON documents are a **small, fixed set of types** (~12). Shell's semantic
domain is vastly larger (hundreds of commands, control flow, I/O patterns).

### Key Architectural Pattern: Import Tracking

bson-transpilers assigns every type a numeric "import code" and lazily
collects which ones are needed via `requiredImports[code]`. The
`getImports()` method renders only the required imports. This is cleaner
than debashc's current ad-hoc `needs_file_copy()` / `needs_posix()` booleans.

---

## 2. Can We Reuse bson-transpilers' Parts?

### Cannot Reuse: Language and Parser Stack

bson-transpilers is JavaScript with an ANTLR-generated parser. debashc is
Rust with a custom parser. Direct code reuse is impossible.

### Cannot Reuse: Semantic Domain

bson-transpilers handles expression-level BSON document construction.
debashc handles full programs with control flow, pipelines, I/O redirection,
signal handling, and command execution. The code generation patterns are
fundamentally different.

### Could Borrow: Declarative Command Tables

The symbol-table concept could map shell builtins to target-language
constructs declaratively:

```yaml
# Hypothetical: command definitions per language
echo:
  perl:  "print {args} . \"\\n\""
  rust:  'println!("{args}")'
  python: "print({args})"
  js:    "console.log({args})"

mkdir:
  perl:  "mkdir({path}) or die ..."
  rust:  'std::fs::create_dir({path}).unwrap_or_else(|e| ...)'
  python: "os.makedirs({path}, exist_ok=True)"
```

This would reduce boilerplate for the ~100+ builtin commands. However,
the template approach struggles with commands whose translation depends
on flags, context, or complex argument patterns — which is most of them.

### Could Borrow: Unified Import Registry

Replace scattered `needs_*()` checks with a unified system:

```rust
struct ImportRegistry {
    needed: HashSet<ImportKind>,
}

enum ImportKind {
    FileCopy,
    FilePath,
    DigestSha,
    POSIX,
    CaptureTiny,
    Locale,
    // etc.
}
```

Each codegen operation registers its needs, and a final pass emits the
`use` statements. This is cleaner and makes multi-language backends more
predictable (each language has its own import mapping).

---

## 3. ESTree as an Intermediate Representation

[ESTree](https://github.com/estree/estree) is the standard AST format for
JavaScript, used by Babel, ESLint, Prettier, and others.

### Pros

- **Standardized** — well-defined spec, many implementations
- **Tooling** — `@babel/generator` turns any ESTree-compliant tree into valid JS
- **Serializable** — pure JSON, language-agnostic
- **Extensible** — Babel allows custom node types via plugins

### Cons

**Semantic impedance mismatch.** Shell concepts have no natural ESTree equivalent:

| Shell | ESTree equivalent | Problem |
|---|---|---|
| `ls \| grep foo` | `CallExpression(wrapper, [Arrow, Arrow])` | Pipeline semantics hidden inside JS wrappers |
| `[ -f /tmp/x ]` | `CallExpression(bash_test, [UnaryExpr(-f)])` | `-f` is not a valid JS unary operator |
| `echo $x` | `CallExpression(exec, [TemplateLiteral])` | Shell variable expansion vs JS template literal |
| `exec 3>/tmp/log` | No node type exists | Requires non-standard extension |
| `trap cleanup EXIT` | No node type exists | Requires non-standard extension |
| `$(date)` | `AwaitExpression(CallExpression(exec, "date"))` | Command substitution disguised as async JS |

Every shell concept requires either:
- A **non-standard ESTree extension** (losing the "standard" advantage)
- A **JavaScript runtime helper** (making the output rely on a polyfill library)

### The Free Lunch Only Goes to JavaScript

`@babel/generator` gives you **free JavaScript output** from ESTree. But for
every other language (Perl, Rust, Python, C, Go), **no ESTree-to-X codegen
exists**. You must write it from scratch — and ESTree just adds an extra
serialization/deserialization step.

| Target | ESTree helps? | Why |
|---|---|---|
| **JavaScript** | ✅ | `@babel/generator` gives free JS output |
| **TypeScript** | 🟡 | With estree→ts conversion, partial help |
| **Perl** | ❌ | No ESTree→Perl codegen exists |
| **Rust** | ❌ | No ESTree→Rust codegen exists |
| **Python** | ❌ | No ESTree→Python codegen exists |
| **C** | ❌ | No ESTree→C codegen exists |
| **Go** | ❌ | No ESTree→Go codegen exists |

### Verdict

ESTree is the right format for a **leaf backend targeting JavaScript**.
It should not be the universal IR — but as a backend, it's the **easiest to
build** because `@babel/generator` handles all formatting automatically.
No other target language offers this kind of shortcut.

---

## 4. BSON as an Intermediate Representation

BSON is a typed data serialization format (used by MongoDB). It has ~12 types:
double, string, document, array, binary, ObjectId, boolean, datetime, null,
regex, int32, int64, decimal128.

### What BSON Does Well

BSON's type system maps cleanly to systems languages:

| BSON Type | C | Rust |
|---|---|---|
| `Double` | `double` | `f64` |
| `Int32` | `int32_t` | `i32` |
| `Int64` | `int64_t` | `i64` |
| `String` | `char*` | `String` |
| `Document` | `struct` / `bson_t` | `BTreeMap` / struct |
| `Array` | typed `*` + length | `Vec<T>` |
| `Boolean` | `bool` | `bool` |
| `Null` | `NULL` | `Option::None` |

### What BSON Cannot Represent

BSON is a **data format**, not a **code format**. It cannot represent:

- Control flow (`if`, `else`, `while`, `for`)
- Function calls
- Variable assignment
- Pipelines and redirections
- Side effects
- Error handling
- Any executable semantics

There is no BSON type for `if`. BSON describes what data **is**, not what a
program **does**. It is the wrong abstraction level for code generation.

### Verdict

BSON's design philosophy — minimal typed primitives mapping directly to
systems languages — is good. But BSON itself is a data format, not a code IR.
The lesson is: **design an IR with few, well-chosen primitives that map
directly to target languages' execution models**, not JavaScript's.

---

## 5. Extended ESTree + Lowering Passes

A more sophisticated idea: extend ESTree with shell-specific node types,
then lower them to standard ESTree via compiler passes.

### The Pipeline

```
shell → Frontend → Extended ESTree (with Pipeline, Redirect, etc.)
                       ↓
                 Lowering Passes
                       ↓
                 Standard ESTree
                       ↓
                 @babel/generator → JavaScript
```

### Example: Lowering a Pipeline

```bash
ls -la | grep foo | wc -l
```

**Extended ESTree** (with shell-specific nodes):
```json
{
  "type": "PipelineExpression",
  "stages": [
    { "type": "CommandExpression", "name": "ls", "args": ["-la"] },
    { "type": "CommandExpression", "name": "grep", "args": ["foo"] },
    { "type": "CommandExpression", "name": "wc", "args": ["-l"] }
  ]
}
```

**After lowering to standard ESTree** (for JavaScript):
```json
{
  "type": "ExpressionStatement",
  "expression": {
    "type": "CallExpression",
    "callee": { "type": "MemberExpression", "property": { "name": "pipeline" } },
    "arguments": [
      { "type": "ArrowFunctionExpression",
        "body": { "type": "CallExpression",
          "callee": { "type": "Identifier", "name": "spawn" },
          "arguments": [{ "value": "ls", "raw": "\"ls\"" }, { "value": "-la" }]
        }
      },
      // ... grep, wc stages
    ]
  }
}
```

### This Is Real Compiler Architecture

This mirrors how all major compilers work:

| Compiler | High IR | Mid IR | Low IR |
|---|---|---|---|
| GCC | GENERIC | GIMPLE | RTL |
| LLVM | MLIR dialects | LLVM IR | Machine code |
| Rust | HIR | MIR | LLVM IR |
| **This proposal** | Extended ESTree | Lowered | Standard ESTree |

### The Asymmetry Problem

The lowered ESTree still targets **JavaScript semantics**. A Rust backend
needs a completely different lowering:

```json
// Lowered for Rust (not standard ESTree — uses :: paths)
{
  "type": "ExpressionStatement",
  "expression": {
    "type": "MethodCallExpression",
    "object": "std::process::Command",
    "method": "new",
    "arguments": ["ls"]
    // Then .args(["-la"]).output()
    // Then pipe through .stdin()/.stdout() chains
  }
}
```

This isn't ESTree anymore. Every non-JS target would need its own
lowering target format.

### The Thread Experiment

If a backend doesn't understand `Pipeline`, you could lower it to threads:

```
Pipeline(ls, grep, wc)
    ↓  lowering
ThreadSpawn("ls", pipe_to: ThreadSpawn("grep", pipe_to: ThreadSpawn("wc")))
```

But `ThreadSpawn` is itself a concept that each target implements differently:
- **JavaScript**: `child_process.spawn()`
- **C**: `pthread_create()` + `pipe()` + `dup2()`
- **Rust**: `std::thread::spawn()` + `std::process::Command::new()`
- **Perl**: `fork()` + `exec()` + `pipe()`

You haven't reduced complexity — you just renamed `Pipeline` to
`ThreadSpawn`. Each backend still needs to know what that means in its
language.

### Verdict

Extended ESTree + lowering passes is a valid architecture. The JavaScript
path gets the "free lunch" of `@babel/generator` — all formatting,
parenthesization, escaping, and indentation are handled automatically.
This makes the JavaScript backend **the easiest new backend to build**,
not the hardest. Every other output language requires a manually written
pretty-printer.

---

## 6. The Multi-Input, Multi-Output N×M Problem

Without a common IR, supporting multiple input languages and multiple output
languages requires **N × M implementations**:

```
Inputs ↓ \ Outputs →   Perl    Rust    Python    JavaScript
Shell (done)            ✅       🟡      🟡         ❌
Batch                   ❌       ❌      ❌         ❌
PowerShell              ❌       ❌      ❌         ❌
POSIX sh                ❌       ❌      ❌         ❌
```

That's potentially **16 backends** for 4 input × 4 output languages.

### With a Common IR: N + M Implementations

```
                    ┌──→ Perl backend
                    │
Shell ──→ Shell F.E. ───→ Rust backend
Batch ──→ Batch F.E. ───→ Python backend
PowerShell → PS F.E. ──→ JavaScript backend
POSIX sh → POSIX F.E. ──→ ...
                    │
                    └── Common Shell-Language IR
```

Now it's **N frontends + M backends** = 4 + 4 = 8 implementations instead of 16.
Each frontend and backend is written once against a shared IR contract.

### The Challenge: The Common IR Must Span All Inputs

The IR must be rich enough to express the superset of all input languages,
but simple enough to make backends tractable.

| Concept | Shell | Batch | PowerShell | Covers Common IR? |
|---|---|---|---|---|
| Command exec | `ls -la` | `dir` | `Get-ChildItem` | ✅ |
| Pipeline | `a \| b` | `a \| b` | `a \| b` | ✅ |
| Exit code | `$?` | `%ERRORLEVEL%` | `$LASTEXITCODE` | ✅ |
| Redirection | `>` `<` `2>&1` | `>` `<` | `>` `2>&1` | ✅ |
| Variable | `$var` | `%var%` | `$var` | ✅ |
| Conditional | `if [ -f x ]` | `if exist x` | `if (Test-Path x)` | ✅ |
| Loop | `for i in ...` | `for %%i` | `foreach` | ✅ |
| Function | `f() { ... }` | `call :label` | `function f { ... }` | ✅ |
| Arithmetic | `$((a+b))` | `SET /a` | `$a + $b` | ✅ |
| String interp | `"Hi $name"` | `Hi %name%` | `"Hi $name"` | ✅ |
| File test | `[ -f x ]` | `if exist x` | `Test-Path x` | ✅ |
| Objects | ❌ | ❌ | ✅ (full .NET) | 🟡 Partial |
| Modules | `source` | `call` | `Import-Module` | ✅ |
| Event handling | `trap` | ❌ | `Register-EngineEvent` | 🟡 |

The IR must be designed at a level where PowerShell's object pipeline and
shell's text pipeline can both be represented — likely as an abstract
`Pipeline` node whose semantics differ per frontend but produce compatible
lowerings.

---

## 7. A Common Shell-Language IR

A proposed language-agnostic "shell-language IR" that sits between frontends
and backends:

```rust
/// A language-agnostic intermediate representation for shell-like languages.
///
/// This IR models the semantic intersection of bash, POSIX sh, Batch,
/// PowerShell, and similar languages. It avoids language-specific features
/// (sigils, object systems, specific error handling) in favor of an
/// abstract model that backends can lower as needed.

enum ShIrNode {
    // ── Execution ────────────────────────────────────────────
    Exec {
        command: String,
        args: Vec<Expr>,
        redirects: Vec<Redirect>,
        env_overrides: Vec<(String, Expr)>,
    },
    Pipeline {
        stages: Vec<ShIrNode>,
        background: bool,
    },

    // ── Control flow ─────────────────────────────────────────
    If {
        condition: Expr,
        then_body: Vec<ShIrNode>,
        else_body: Vec<ShIrNode>,
    },
    ForEach {
        variable: String,
        collection: Expr,
        body: Vec<ShIrNode>,
    },
    While {
        condition: Expr,
        body: Vec<ShIrNode>,
    },
    Function {
        name: String,
        params: Vec<String>,
        body: Vec<ShIrNode>,
    },
    Break(Option<u32>),
    Continue(Option<u32>),
    Return(Option<Expr>),

    // ── Data operations ──────────────────────────────────────
    Assign {
        target: AssignTarget,
        value: Expr,
        operator: AssignOp,
    },
    Declare {
        variable: String,
        kind: VarKind,       // Scalar, Array, Map, Readonly, Reference
        init: Option<Expr>,
        export: bool,
    },

    // ── I/O ──────────────────────────────────────────────────
    Redirect {
        fd: FdSpec,          // Specific FD, or all, or merged
        mode: RedirectMode,  // Read, Write, Append, ReadWrite, Dup
        target: RedirectTarget, // File path, FD, or command (for process subst)
    },
    Read {
        target: String,      // Variable to read into
        prompt: Option<Expr>,
        raw: bool,           // -r flag
        nchars: Option<Expr>, // -n flag
    },
    Write {
        content: Expr,
        target: OutputTarget, // Stdout, Stderr, File, Custom FD
        newline: bool,
    },
}

enum Expr {
    String(String, StringStyle),
    Int(i64),
    Float(f64),
    Bool(bool),
    Var(String, VarSigil),
    Array(Vec<Expr>),
    Map(Vec<(String, Expr)>),
    BinaryOp(Box<Expr>, BinOp, Box<Expr>),
    UnaryOp(UnaryOp, Box<Expr>),
    CommandSubst(Box<ShIrNode>),      // $(cmd), `cmd`, %cmd%
    FileTest(FileTestOp, Box<Expr>),  // [ -f x ], Test-Path, if exist
    Call(String, Vec<Expr>),          // Built-in or external function call
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    Index(Box<Expr>, Box<Expr>),      // array[index], map[key]
    Slice(Box<Expr>, Box<Expr>, Option<Box<Expr>>), // ${arr[@]:start:len}
}

enum VarKind { Scalar, Array, Map, Readonly, Reference }
enum VarSigil { Dollar, At, Percent, None }  // Language-specific, may be lowered away
enum StringStyle { Literal, DoubleQuoted, Verbatim }
enum AssignOp { Set, Add, Sub, Mul, Div, Mod }
enum FileTestOp { Exists, File, Dir, Symlink, Readable, Writable, Executable, ... }
```

### Design Principles

1. **No language-specific error handling** — backends add their own
   (Perl's `or die`, Rust's `?` / `.unwrap()`, Go's `if err != nil`).

2. **No language-specific naming** — no sigils in the IR (they're added by
   backends), no `$PROGRAM_NAME` vs `$0` vs `std::env::args()`.

3. **Abstract file tests** — `FileTest(Exists, path)` rather than
   `[ -e "$path" ]` or `Test-Path $path` or `path.exists()`.

4. **Abstract I/O** — `Write { content, target, newline }` unified across
   `echo`, `Write-Output`, `printf`, etc.

5. **Optionally typed** — `Expr` nodes can carry `Option<Type>` annotations
   for backends that need static types (Rust, C, Go). The type inference
   pass fills these in.

---

## 8. Type Inference for a Rust Backend

Shell is dynamically typed (everything is a string or coerces to one).
Rust is statically typed. A Rust backend cannot work without type inference.

### What Needs Inference

```bash
x=42                # string "42" in shell, but clearly an integer
y="hello"           # string
z=$(ls -la)         # string from command output
declare -i i=5      # shell tells us: integer
items=(a b c)       # array of strings
if [ -f "$path" ]   # path: string or Path, result: bool
echo $((counter+1)) # counter: int
cmd; echo $?        # $?: exit code (integer)
```

### Inference Rules

| Rule | Shell pattern | Inferred type |
|---|---|---|
| Explicit declaration | `declare -i x` | `Int` |
| | `declare -a arr` | `Vec<String>` |
| | `declare -A map` | `HashMap<String, String>` |
| Arithmetic context | `$((expr))`, `-eq`, `-gt`, `-lt` | `Int` |
| String operations | `${#var}`, `${var%.*}`, `"$var"` | `String` |
| File tests | `[ -f x ]`, `[ -d x ]` | `Bool` |
| Exit code | `$?`, `if cmd` | `Int` (ExitCode) |
| Command substitution | `$(cmd)` | `String` |
| Array literal | `arr=(a b c)` | `Vec<String>` |
| Numeric literal | `x=42` in arithmetic context | `Int` |
| String literal | `x="hello"` | `String` |

### The Hard Case: Polymorphic Variables

```bash
x=$1               # x: unknown — depends on caller
x=42               # maybe Int?
echo "$x"          # used as String
echo $((x + 1))    # used as Int too — conflict
```

Options for handling polymorphism:

**A. Conservative: default to `String` everywhere**
```rust
let x: String = std::env::args().nth(1).unwrap_or_default();
if let Ok(n) = x.parse::<i64>() {
    println!("{}", n + 1);
}
```
Matches shell semantics exactly. Verbose but correct.

**B. Union type**
```rust
enum ShellValue {
    Str(String),
    Int(i64),
    Float(f64),
    Array(Vec<ShellValue>),
}
let x: ShellValue = /* from argv */;
```
Requires a runtime type tag. Safe but non-idiomatic Rust.

**C. SSA-style splitting**
```rust
let x_raw: String = std::env::args().nth(1).unwrap_or_default();
// x used in string context → keep string
println!("{}", x_raw);
// x used in arithmetic context → parse
let x_int: i64 = x_raw.parse().unwrap_or(0);
println!("{}", x_int + 1);
```
Most idiomatic Rust. But requires tracking variable versions through
the IR — similar to SSA form in compilers.

### Where Inference Lives

```
            ┌──────────────────┐
            │  Shell Frontend   │  (untyped AST — pure syntax)
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │  Type Inference   │  ← NEW shared pass
            │     Pass          │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │   Typed ShIR      │  (every Var has Option<Type>)
            └──────┬───────────┘
                   │
           ┌───────┼───────────┐
           ▼       ▼           ▼
     Perl Bknd  Rust Bknd  Python Bknd
     (ignores   (uses      (optionally
      types)     types)     types)
```

The type inference pass should be **IR-level, not backend-specific**.
Otherwise each statically-typed backend repeats the same analysis.

---

## 9. Recommended Architecture

### Current State

```
Shell script → Shell Frontend → Generator → Perl text
                                    ↑
                            (hard-coded Perl in 50+ Rs files)
```

### Near Term: IR-Powered Codegen

```
Shell script → Shell Frontend → ShIR → Perl Backend → Perl text
                                    → JavaScript Backend (via ESTree) → JS code
                                    → Python Backend → Python code
                                    → Rust Backend → Rust code
```

- Migrate generators to produce `ShIrNode` instead of raw Perl strings
- Each backend is a `ShIrNode → String` pretty-printer
- Shared passes (constant folding, dead code elimination) operate on ShIR

#### Recommended Backend Order

| Priority | Language | Why this order |
|---|---|---|
| 1st | **JavaScript** | Easiest codegen — `@babel/generator` handles all formatting, parenthesization, escaping, indentation automatically. No pretty-printer to write. Just construct ESTree JSON and serialize. |
| 2nd | **Python** | Most requested. Dynamic typing (no type inference needed). But must write full pretty-printer from scratch. |
| 3rd | **Rust** | Requires type inference pass. Validates the IR's ability to carry type annotations. By this point the IR is proven by two backends. |
| 4th | **Go** | Also requires type inference. Smaller audience than Python or JS. |

#### Why JavaScript is Easiest — Not Hardest

The conventional wisdom was that ESTree is "JavaScript-ecosystem-only" and
therefore adds complexity for non-JS targets. This is correct, but it misses
the key implication: **the JavaScript path has the most automated codegen of
any target**, because `@babel/generator` absorbs all formatting work.

Comparison of codegen effort:

| Task | Python (manual) | JavaScript (via ESTree) |
|---|---|---|
| Map shell builtins | Same | Same |
| Pipeline lowering to library calls | Same (`subprocess`) | Same (`child_process`) |
| Operator precedence in output | Must emit parens correctly | Automatic from tree structure |
| String escaping | Must handle | `@babel/generator` handles `StringLiteral` |
| Indentation & line breaks | Must manage | Automatic |
| Statement separators (semicolons, commas) | Must emit | Automatic |
| Comments attachment | Must track | `estree-util-attach-comments` |
| External dependency | None | Node.js + `@babel/generator` |

**Conclusion**: The semantic mapping work (pipelines, redirects, file tests)
is identical between Python and JavaScript. The difference is that
JavaScript gets ~2000 lines of pretty-printer for free. Python requires
writing them.

### Medium Term: Multi-Input

```
Shell ──→ Shell Frontend ─┐
Batch ──→ Batch Frontend ─┤
POSIX sh → POSIX Frontend ─┤
                           ▼
                    Common ShIR ← Type Inference ← (optional typed IR)
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         Perl Backend  Rust Backend  Python Backend
              │            │            │
              │    ┌───────┘            │
              │    ▼                    │
              │  Extended ShIR          │
              │  (Rust-specific types,  │
              │   lifetimes, error      │
              │   handling patterns)    │
              │         │               │
              ▼         ▼               ▼
           perl.pl    lib.rs          app.py
```

### JavaScript via ESTree (Parallel Track)

Because JavaScript is the easiest new backend (auto-formatted via
`@babel/generator`), it should be built **concurrently with or before**
the Python backend, not deferred to "long term":

```
Common ShIR
    │
    ├──→ Perl Backend → perl.pl
    │
    ├──→ JS Lowering Pass → Extended ESTree → Targeting Passes → Standard ESTree
    │                                                                    │
    │                                                                    ▼
    │                                                            @babel/generator → .js
    │
    ├──→ Python Backend → app.py
    │
    └──→ Rust Backend → lib.rs
```

The ESTree path is **one backend among many** — not the universal IR.
It's the right choice for JavaScript output because `@babel/generator`
provides a genuine "free lunch" that no other target language offers.

Implementation steps:

1. Define ESTree node types as Rust structs with `#[derive(Serialize)]`
2. Write a `ShIR → Extended ESTree` lowering pass (adds shell-specific node types)
3. Write targeting passes that lower each extended node to standard ESTree:
   - `Pipeline` → `CallExpression` wrapping `child_process.spawn` calls
   - `FileTest` → `CallExpression` wrapping `fs.existsSync` / `fs.statSync`
   - `Redirect` → `CallExpression` wrapping `fs.openSync` / `fs.createWriteStream`
   - `CommandSubstitution` → `AwaitExpression` + `execSync` / `execFile`
4. Serialize to JSON and pipe through `@babel/generator` (via subprocess or WASM)

### Summary of Architectural Decisions

| Decision | Recommendation | Rationale |
|---|---|---|
| Universal IR | Purpose-built ShIR (not ESTree, not BSON) | Shell semantics are unique; no off-the-shelf format fits |
| Type inference | Shared pass, optional annotations | Only needed for statically-typed backends (Rust, C) |
| JavaScript output | Via ESTree + `@babel/generator` | **Easiest backend to build.** ESTree construction is simpler than writing a pretty-printer. `@babel/generator` handles all formatting automatically. |
| Multi-input | N frontends + M backends vs. N×M | Common IR makes this tractable; but each frontend is still significant effort |
| Declarative mappings | Useful for simple builtins, not complex semantics | Templates work for `echo` → `print`; not for `grep` → regex logic |
| Import tracking | Unified registry per backend | Cleaner than ad-hoc booleans; enables import minimization |

### Key Risks

1. **IR design is hard.** Too high-level → backends duplicate work.
   Too low-level → frontends lose semantics. Getting this right requires
   iterating with real backends.

2. **Frontends are the expensive part.** A Batch frontend means re-implementing
   decades of edge cases. POSIX sh alone has a 600+ page specification.

3. **Type inference for shell is genuinely difficult.** Shell's semantics
   revolve around string coercion. Making safe, idiomatic Rust from this
   requires sophisticated analysis that may produce counterintuitive results
   for edge cases.

4. **ESTree is a JavaScript-ecosystem-only tool, but that's a feature, not a bug.**
   It only helps for JavaScript output — but for JavaScript it helps enormously,
   eliminating ~2000 lines of formatting code. The risk is over-investing in
   ESTree infrastructure before the core IR is validated by a non-JS backend.

### Separable Components

Most of the browser-shell vision does not require modifying sh2perl.
The runtime library (`sh2runtime`), virtual filesystem mounts
(ramfs, localStorage, HTTP, GitHub), terminal REPL, and device drivers
(`/dev/webgl`, `/dev/input`) can all be built as standalone JavaScript
projects. sh2perl's only role is bash→JS transpilation — everything else
is a runtime concern.

---

*See also: [bash-game-vision.md](bash-game-vision.md) for a speculative
walkthrough of what these architectural pieces could build — a 3D game
written entirely in bash, running in the browser via sh2perl transpilation
and the /dev/ filesystem metaphor.*
