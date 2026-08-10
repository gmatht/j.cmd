package clib

// c-sh-go: C source -> A1 shIR JSON (the shell-flavored subset of C).
// v1 subset: printf, int assignments (+=/-=), binary arith, comparisons,
// if/else, while, for (lowered to the equivalent while — the A1 For node
// is for value-list iteration), function signatures (skipped; main's body
// becomes the program), user functions — now RUNTIME-callable bodies
// (if/else, while, array element writes `a[i] = v`, ++/--, printf;
// calls to them from main lower to the `exec` dispatch, so an async body
// is properly awaited), strcmp/strlen/atoi (literal-arg folding, see
// foldCallConst), comments, #include (skipped).
//
// cmp_call(cmpname, a, b) — the COMPARATOR BRIDGE: dispatch to a (bash)
// function by runtime name, capturing its echoed output (the C qsort
// convention -1/0/1). `char *a[N] = {...}` declares an ARRAY OF STRINGS
// (the brackets win over the pointer-to-string lowering). Runtime array
// indices write through the baked-subscript store name `a[<expr>]`.
// Emit shapes mirror the py-sh-go frontend so the estree runner executes
// them identically. Unsupported constructs fail loud (refuse > guess).
import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ── A1 node helpers ──────────────────────────────────────────────────
func st(s string) any { return map[string]any{"style": "DoubleQuoted", "type": "Str", "value": s} }
func call(f string, args []any) map[string]any {
	return map[string]any{"args": args, "func": f, "purity": "Emulable", "type": "Call"}
}

// addrTaken — names whose address is taken (&x): their storage must live
// in the sh2 store (the emitter would otherwise lift them to native JS
// bindings, and the mem.* seam reads/writes the store — divergence).
var addrTaken = map[string]bool{}

// arrayVars — `int a[3]` declarations: lowered to setArray (the runtime's
// array store). ptrTargets — a pointer whose target is STATICALLY known
// (p = &a[1] / p = a): the POINTER-TO-ARRAY reduction — the pointer
// becomes (array, index) and every use folds to direct array indexing;
// the pointer variable is compile-time only, never emitted.
var arrayVars = map[string]bool{}

// scalarAliases — STATIC ALIAS FOLDING for scalars: `int *p = &x;` where
// x is a scalar and p never escapes -> p is ELIMINATED; *p reads/writes
// become x directly (zero pointer machinery, zero mem calls). The alias
// chain (`int *q = p;`) folds too. Raw pointer-value uses (p == NULL,
// printf("%p", p)) refuse via the unsupported marker.
var scalarAliases = map[string]string{}
var ptrTargets = map[string]ptrTarget{}

type ptrTarget struct {
	arr  string
	base int
}

// heapPtrs — HEAP pointers (malloc): the pointer is a compile-time pair
// (root handle var + static element offset); every use lowers to the
// mem.* arena seam (memAlloc/memLoad/memStore/memFree) with the element
// type, mirroring slice 2 of the sh2 runtime arena (see
// sh2-namespace.mjs). The pointer variable itself is never emitted.
// The ROOT var holds the `\u0001mem:<id>:<size>` handle and is written
// ONLY via setVar (never a plain Assign: the core's native-lift would
// see an unanalysed Call source and the mem seam reads the store).
type heapPtr struct {
	root string // variable holding the memAlloc handle
	elem string // C element type name ("int"/"char"/...) — the mem.* `type` arg
	off  int    // static element offset (C pointer arithmetic: p = a + n)
}

var heapPtrs = map[string]heapPtr{}

// ptrDecls — every `int *p` / `char *p` declaration: name -> element
// type. char* is excluded (the pointer-to-string lowering owns it) and
// array/scalar-aliased pointers are promoted out via recordPtrTarget.
var ptrDecls = map[string]string{}

// fnPtrParams — the pointer params of the user function being EMITTED
// (buildUserFnA1 sets it for the body emission; empty elsewhere). A
// pointer param used with `p[i]` indexing is an ARRAY-NAME pointer: its
// value is the shell array's VARIABLE NAME (the transpiled-world "void
// *base" — arrays decay to their name at call sites), and indexed
// reads/writes go through the runtime store by that name.
var fnPtrParams = map[string]string{}

// fnPtrParamNames — FUNCTION-pointer parameters (`int (*cmp)(const void *,
// const void *)`): the param holds a comparator's NAME (a bash function,
// passed as a string — in the transpiled world the pointer value IS the
// name). A call through it — `cmp(a, b)` / `(*cmp)(a, b)` — dispatches to
// the comparator bridge (capture + exec), exactly like the cmp_call
// primitive it replaces.
var fnPtrParamNames = map[string]bool{}

// funcPtrs — function-pointer variables: `int (*f)(int) = twice;` — the
// variable is compile-time; a call f(args) folds through the target
// user function.
var funcPtrs = map[string]string{}

// structLayouts — `struct Point { int x; int y; };` member tables. The
// frontend flattens member accesses to dotted scalar vars ("p.x"); the
// layout is only needed for sizeof.
type structMember struct{ name, ctype string }

var structLayouts = map[string][]structMember{}

// varStruct — `struct Point p;` — a var's declared struct type (for
// sizeof(p) and member resolution).
var varStruct = map[string]string{}

// structPtrVars — `struct Node *p;` declarations: name -> tag. A struct
// POINTER's value is a heap handle string (malloc'd arena) or a global
// head; `p->member` reads/writes the arena at the member's byte offset
// (the runtime mem arena is byte-addressed with elem size 1 for these).
var structPtrVars = map[string]string{}

// macros — the #define table (object-like: no params; function-like:
// params + body token list). Expanded token-wise after lexing.
type macro struct {
	params []string
	body   []tok
}

var macros = map[string]macro{}

// cTypeSize — the ABI size of a single-word C type name (LP64, matching
// the runtime memElemSize table). Used for sizeof and malloc element
// counts. Pointer types (char*, struct Node*) are one word (8).
func cTypeSize(t string) (int, bool) {
	if strings.HasSuffix(t, "*") {
		return 8, true
	}
	switch t {
	case "char":
		return 1, true
	case "short":
		return 2, true
	case "int", "float", "long int":
		return 4, true
	case "long", "double", "size_t", "long long":
		return 8, true
	}
	return 0, false
}

// memberOffset — the byte offset of `member` in `tag`'s layout (sum of
// the preceding members' sizes) — the offsetof() the `p->member`
// lowering passes to the runtime memLoad/memStore.
func memberOffset(tag, member string) (int, bool) {
	off := 0
	for _, m := range structLayouts[tag] {
		if m.name == member {
			return off, true
		}
		sz, ok := cTypeSize(m.ctype)
		if !ok {
			return 0, false
		}
		off += sz
	}
	return 0, false
}

// structSize — the flattened sizeof of a declared struct type.
func structSize(tag string) (int, bool) {
	total := 0
	for _, m := range structLayouts[tag] {
		sz, ok := cTypeSize(m.ctype)
		if !ok {
			return 0, false
		}
		total += sz
	}
	return total, true
}

// storeAssignStmt — a store write (Expr(setVar(...))): for names the
// runtime store owns and the native-lift must never see (heap handles,
// dotted struct members). setVar-only vars are provably never lifted by
// the core, so the store stays the single source of truth.
func storeAssignStmt(name string, expr any) map[string]any {
	return map[string]any{"type": "Expr", "expr": call("setVar", []any{st(name), expr})}
}

// heapAssignRHS — `T *p = <rhs>` where <rhs> is malloc/calloc (root: p
// itself holds the handle), a heap-pointer copy (p = q), or heap pointer
// arithmetic (p = q + n / p = q - n with a literal n). Returns the
// compile-time pair; isRoot tells the caller to EMIT the handle assign.
func heapAssignRHS(name string, e *expr, declElem string) (hp heapPtr, isRoot, ok bool) {
	if e == nil {
		return heapPtr{}, false, false
	}
	if e.kind == "call" && (e.name == "malloc" || e.name == "calloc") {
		return heapPtr{root: name, elem: declElem, off: 0}, true, true
	}
	if e.kind == "id" {
		if hp, ok := heapPtrs[e.name]; ok {
			return hp, false, true // pointer copy p = q
		}
		return heapPtr{}, false, false
	}
	if e.kind == "bin" && (e.op == "+" || e.op == "-") && e.l != nil && e.l.kind == "id" {
		if hp, ok := heapPtrs[e.l.name]; ok {
			if k, ok2 := foldIndex(e.r); ok2 {
				if e.op == "-" {
					hp.off -= k
				} else {
					hp.off += k
				}
				return hp, false, true
			}
		}
	}
	return heapPtr{}, false, false
}

// exprUsesHeap — does the expression reference a heap-pointer variable
// (a raw handle value must never reach an Arith/string context)?
func exprUsesHeap(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "id":
		if _, ok := heapPtrs[e.name]; ok {
			return true
		}
		return false
	case "bin":
		return exprUsesHeap(e.l) || exprUsesHeap(e.r)
	case "deref", "addr", "index":
		return exprUsesHeap(e.l) || exprUsesHeap(e.r)
	case "call":
		for _, a := range e.args {
			if exprUsesHeap(a) {
				return true
			}
		}
	}
	return false
}

// ptrTargetFromExpr — is e a statically-resolvable pointer-into-array?
// &a[i] -> (a, i); &a / a (decay) -> (a, 0).
func ptrTargetFromExpr(e *expr) (ptrTarget, bool) {
	if e == nil {
		return ptrTarget{}, false
	}
	if e.kind == "addr" && e.l != nil {
		if e.l.kind == "index" && e.l.l != nil && e.l.l.kind == "id" && arrayVars[e.l.l.name] {
			b, ok := foldIndex(e.l.r)
			return ptrTarget{arr: e.l.l.name, base: b}, ok
		}
		if e.l.kind == "id" && arrayVars[e.l.name] {
			return ptrTarget{arr: e.l.name, base: 0}, true
		}
	}
	if e.kind == "id" && arrayVars[e.name] {
		return ptrTarget{arr: e.name, base: 0}, true
	}
	return ptrTarget{}, false
}

// foldIndex — a literal index (num, or unary-minus num) as an int.
func foldIndex(e *expr) (int, bool) {
	if e == nil {
		return 0, false
	}
	if e.kind == "num" {
		n, err := strconv.Atoi(e.num)
		return n, err == nil
	}
	if e.kind == "bin" && e.op == "-" && e.l != nil && e.l.kind == "num" && e.l.num == "0" && e.r != nil && e.r.kind == "num" {
		n, err := strconv.Atoi(e.r.num)
		return -n, err == nil
	}
	return 0, false
}

// recordPtrTarget — for a pointer variable `name` initialized with expr e:
// array target -> ptrTargets; scalar &x -> scalarAliases; pointer copy
// (p = q) -> chase the existing alias. Returns true if recorded (emit nothing).
func recordPtrTarget(name string, e *expr) bool {
	if e == nil {
		return false
	}
	if t, ok := ptrTargetFromExpr(e); ok {
		ptrTargets[name] = t
		return true
	}
	if e.kind == "addr" && e.l != nil && e.l.kind == "id" && !arrayVars[e.l.name] {
		scalarAliases[name] = e.l.name
		return true
	}
	if e.kind == "id" {
		if t, ok := scalarAliases[e.name]; ok {
			scalarAliases[name] = t
			return true
		}
		if t, ok := ptrTargets[e.name]; ok {
			ptrTargets[name] = t
			return true
		}
	}
	return false
}

// charPtrVars — `char *name` declarations: the POINTER-TO-STRING lowering.
// A char* is lowered to the string itself — no mem.* handles, no arena:
//
//	&"lit"     -> the literal string
//	s + n      -> a substring (param slice)
//	s[i]       -> a 1-char slice
//	%s / %c    -> the string / first char
//
// The pointer IS the string; the seam is bypassed entirely.
var charPtrVars = map[string]bool{}

func assignStmt(name string, expr any) map[string]any {
	return map[string]any{
		"expr":    expr,
		"targets": []any{map[string]any{"indices": []any{}, "sigil": nil, "var": name}},
		"type":    "Assign",
	}
}
func testCall(s string) map[string]any { return call("test", []any{st(s)}) }
func execPrintf(args []any) map[string]any {
	return map[string]any{"type": "Expr", "expr": call("exec", []any{st("printf"), map[string]any{"elements": args, "type": "Array"}})}
}

// wrapForContinues — for-body transform: each top-level `continue`
// (and each `continue` inside a non-loop if/else/block) is replaced
// with `Block{update, continue}`, so the C `for (i; c; u) { ...;
// continue; }` semantic (jump to update, then loop) is preserved in
// the A1 `while (c) { body; u }` lowering (the shell `continue`
// skips the rest of the while-body, including the trailing `u`).
// Nested loops (While/For/Function) are NOT recursed into — their
// `continue` binds to themselves, not the outer for. Switch is the
// same shape (it lowers to nested ifs, so continues inside an if
// branch get wrapped; in a switch-without-loop the c-sh-go's switch
// already strips continues, so this is a no-op there).
func wrapForContinues(stmts []any, update any) []any {
	out := make([]any, 0, len(stmts))
	for _, s := range stmts {
		m, ok := s.(map[string]any)
		if !ok {
			out = append(out, s)
			continue
		}
		t, _ := m["type"].(string)
		switch t {
		case "Expr":
			if c, ok := m["expr"].(map[string]any); ok {
				if fn, _ := c["func"].(string); fn == "continue" {
					out = append(out, map[string]any{
						"type": "Block",
						"body": []any{update, s},
					})
					continue
				}
			}
			out = append(out, s)
		case "If":
			if then, ok := m["then"].([]any); ok {
				m["then"] = wrapForContinues(then, update)
			}
			if elsifs, ok := m["elsifs"].([]any); ok {
				for _, eif := range elsifs {
					if pair, ok := eif.([]any); ok && len(pair) == 2 {
						if then, ok := pair[1].([]any); ok {
							pair[1] = wrapForContinues(then, update)
						}
					}
				}
			}
			if else_, ok := m["else"].([]any); ok {
				m["else"] = wrapForContinues(else_, update)
			}
			out = append(out, m)
		case "Block":
			if bs, ok := m["body"].([]any); ok {
				m["body"] = wrapForContinues(bs, update)
			}
			out = append(out, m)
		default:
			// While, For, Function — do NOT recurse; their `continue`
			// binds to the inner loop, not to the outer for.
			out = append(out, s)
		}
	}
	return out
}

// refuse — unsupported constructs fail loud (refuse > guess). Panic so
// the library entry (Shir) can recover it as an error; the CLI and the
// combined busybox both convert it to a stderr line + nonzero exit.
func refuse(msg string) {
	panic(msg)
}

// callNode — a C stdlib function-call expression in a VALUE position.
// The v1 subset implements the pure conversions the shell runtime
// already models:
//
//	strlen(s) — a string LITERAL is a compile-time constant (fold to its
//	  length); a VARIABLE lowers to ${#s} — the A1 param("len", name)
//	  idiom, which the estree renderer lowers to String(v).length for
//	  lifted vars (exact for the NUL-free subset).
//	atoi(s)  — a literal folds to its integer text (C leading-digit
//	  parse, 0 on failure); a variable IS its value (the store is
//	  string-typed; the Arith nodes coerce).
//	strcmp(a, b) / a user function call — constant-fold when every
//	  argument is a literal (see foldCallConst); anything else REFUSES
//	  (exit 1) — refuse > guess.
//	malloc(n) / calloc(n, sz) — a heap allocation: the RUNTIME memAlloc
//	  arena call (the size must fold — the arena needs a concrete byte
//	  count). The returned handle lands in a store variable; every
//	  pointer use lowers to memLoad/memStore/memFree (see heapPtrs).

// concatExpr — `a + b` as an A1 Interpolate (the estree renders
// Interpolate as a template literal — a plain BinOp Concat is Perl-only).
func concatExpr(a, b any) any {
	return map[string]any{
		"type": "Interpolate",
		"parts": []any{
			map[string]any{"kind": "expr", "expr": a},
			map[string]any{"kind": "expr", "expr": b},
		},
	}
}

// allLiteral — every arg is a compile-time literal (str/num/char).
func allLiteral(args []*expr) bool {
	for _, a := range args {
		if a.kind != "str" && a.kind != "num" && a.kind != "char" {
			return false
		}
	}
	return true
}
func callNode(e *expr) any {
	// a call through a FUNCTION-pointer parameter — `cmp(a, b)` /
	// `(*cmp)(a, b)`: the param holds the comparator's NAME (a bash
	// function); dispatch through the comparator bridge — capture the
	// echoed -1/0/1 verdict (the C qsort protocol), like cmp_call.
	if fnPtrParamNames[e.name] {
		elems := make([]any, 0, len(e.args))
		for _, a := range e.args {
			elems = append(elems, valueNode(a))
		}
		return map[string]any{
			"type": "Call", "func": "capture", "purity": "Emulable",
			"args": []any{map[string]any{
				"type": "Arrow",
				"body": []any{map[string]any{
					"type": "Expr",
					"expr": call("exec", []any{call("getVar", []any{st(e.name)}), map[string]any{"type": "Array", "elements": elems}}),
				}},
			}},
		}
	}
	switch e.name {
	case "strcpy", "strcat":
		// strcpy(dst, src) → dst = src; strcat(dst, src) → dst = dst + src
		// (immutable strings in the transpiled world)
		if len(e.args) == 2 && e.args[0].kind == "id" {
			var rhs any = valueNode(e.args[1])
			if e.name == "strcat" {
				rhs = concatExpr(call("getVar", []any{st(e.args[0].name)}), valueNode(e.args[1]))
			}
			return call("setVar", []any{st(e.args[0].name), rhs})
		}
		refuse("unsupported " + e.name)
	case "getline":
		// getline(&buf, &size, stdin) — the STANDARD POSIX line reader:
		// reads the next line into the variable `buf` points at (resolved
		// through the addr handle), returns the chars read, or -1 at EOF
		// (buf left unchanged). The size pointer and the FILE* stream are
		// accepted and ignored — the runtime store is untyped and stdin
		// is the current command's pipe input.
		if len(e.args) != 3 {
			refuse("getline needs (&buf, &size, stdin)")
		}
		ptr := e.args[0]
		if ptr.kind != "addr" || ptr.l == nil || ptr.l.kind != "id" {
			refuse("getline's first argument must be &buffer (a char **)")
		}
		// the buffer var is written by the runtime under its NAME — mark it
		// address-taken so every assign to it routes through setVar and the
		// store (the emitter's lift analysis can't see the runtime write;
		// a lifted native binding would desync from getLine's store write).
		addrTaken[ptr.l.name] = true
		return call("getLine", []any{st(ptr.l.name)})
	case "read_line":
		// read_line() — the stdin line bridge: pulls the next line of the
		// current command's pipe input ("" at EOF). A sourced C program
		// can slurp its stdin without a bash `read` builtin.
		if len(e.args) != 0 {
			refuse("read_line takes no arguments")
		}
		return call("readLine", []any{})
	case "cmp_call":
		// cmp_call(cmpname, a, b) — the COMPARATOR BRIDGE: dispatch to a
		// (bash) function by RUNTIME name, capturing its echoed output
		// (the C qsort convention: the function echoes -1/0/1). The name
		// is a runtime string (a char* param passed into my_qsort); the
		// call lowers to the command-substitution shape `$(cmp a b)` —
		// `await sh2.capture(() => sh2.exec(cmp, [a, b]))` — so the
		// comparator can be a real bash function living in sh2.functions.
		if len(e.args) < 2 {
			refuse("cmp_call needs at least (cmpname, a, b)")
		}
		elems := make([]any, 0, len(e.args)-1)
		for _, a := range e.args[1:] {
			elems = append(elems, valueNode(a))
		}
		return map[string]any{
			"type": "Call", "func": "capture", "purity": "Emulable",
			"args": []any{map[string]any{
				"type": "Arrow",
				"body": []any{map[string]any{
					"type": "Expr",
					"expr": call("exec", []any{valueNode(e.args[0]), map[string]any{"type": "Array", "elements": elems}}),
				}},
			}},
		}
	case "malloc":
		if len(e.args) != 1 {
			refuse("unsupported function call " + e.name)
		}
		s, ok := foldConst(e.args[0], nil)
		if !ok {
			refuse("malloc size must be a compile-time constant in the v1 subset")
		}
		return call("memAlloc", []any{st(s)})
	case "calloc":
		if len(e.args) != 2 {
			refuse("unsupported function call " + e.name)
		}
		a, ok1 := foldConst(e.args[0], nil)
		b, ok2 := foldConst(e.args[1], nil)
		if !ok1 || !ok2 {
			refuse("calloc args must be compile-time constants in the v1 subset")
		}
		n1, err1 := strconv.Atoi(a)
		n2, err2 := strconv.Atoi(b)
		if err1 != nil || err2 != nil {
			refuse("unsupported function call calloc (non-integer args)")
		}
		return call("memAlloc", []any{st(strconv.Itoa(n1 * n2))})
	case "strlen", "atoi":
		if len(e.args) != 1 {
			refuse("unsupported function call " + e.name)
		}
		a := e.args[0]
		if e.name == "strlen" {
			if a.kind == "str" {
				return st(strconv.Itoa(len(a.num)))
			}
			if a.kind == "id" {
				return call("param", []any{st("len"), st(a.name)})
			}
		} else {
			if a.kind == "str" {
				s := strings.TrimSpace(a.num)
				n, err := strconv.Atoi(s)
				if err != nil {
					n = 0 // C atoi: no leading digits -> 0
				}
				return st(strconv.Itoa(n))
			}
			if a.kind == "id" {
				return call("getVar", []any{st(a.name)})
			}
		}
		refuse("unsupported function call " + e.name)
	}
	// strcmp with RUNTIME args — a real call: the runtime `sh2.strcmp`
	// bridge returns the C sign (-1/0/1) from two store strings, so a
	// dynamic list walk can compare nodes (find). All-literal args still
	// fold at compile time.
	if e.name == "strcmp" && len(e.args) == 2 && !allLiteral(e.args) {
		return call("strcmp", []any{valueNode(e.args[0]), valueNode(e.args[1])})
	}
	// strcmp / user functions — fold with all-literal args (the v1
	// compile-time interpretation). A user function with a RUNTIME
	// (non-literal) argument is a real call: the A1 `fnCall` dispatch —
	// the definition is emitted as an IrStmt::Function (see Shir), and
	// the estree/perl backends lower fnCall to the function-map/sub
	// call. The varargs idiom stays literal-fold-only in v1 (the runtime
	// body model has no va_arg stack).
	if s, ok := foldCallConst(e, nil); ok {
		return st(s)
	}
	if fn, ok := userFuncs[e.name]; ok {
		if fn.varargs {
			refuse("unsupported function call " + e.name + " (varargs need literal args in v1)")
		}
		args := make([]any, 0, len(e.args))
		for _, a := range e.args {
			// ARRAY ARGS DECAY TO THEIR NAME: `my_qsort(a, …)` passes the
			// shell array's variable name (the transpiled-world pointer —
			// the `void *base` of qsort), not its space-joined value. The
			// callee's `char *base` param holds that name and indexes
			// through it.
			if a.kind == "id" && arrayVars[a.name] {
				args = append(args, st(a.name))
			} else {
				args = append(args, valueNode(a))
			}
		}
		// A user function with RUNTIME args is a real call: the `exec`
		// dispatch — the definition is emitted as an IrStmt::Function
		// (see Shir), and the estree lowers exec-of-a-defined-function to
		// sh2.fnCall (sync bodies) or `await sh2.exec` (async bodies,
		// e.g. one calling the comparator bridge). `exec` awaits async
		// bodies; a bare fnCall node would drop the promise.
		return call("exec", []any{st(e.name), map[string]any{"type": "Array", "elements": args}})
	}
	refuse("unsupported function call " + e.name)
	return nil
}

// userExprA1 — a user-function body expression → the A1 expr. Param
// reads lower to the positional `getVar("N")` (the $N shape the estree
// maps to sh2.positional[N-1]); everything else reuses the main's
// valueNode/arithNode lowering.
func userExprA1(e *expr, params []string) any {
	if e == nil {
		return st("")
	}
	switch e.kind {
	case "num", "str":
		return st(e.num)
	case "id":
		// read the STORE var by name — a param was bound at function entry
		// (`pn = getVar(N)`), so the store read is its current value; this
		// keeps `p = head` (a local copying a param) distinct from the
		// positional BINDING itself, which normalizeFunctions reads back
		// to build real JS parameters.
		return call("getVar", []any{st(e.name)})
	case "bin":
		return map[string]any{"type": "Arith", "ast": arithNode(e)}
	case "call":
		return callNode(e)
	case "index", "deref", "addr", "arrow":
		return valueNode(e)
	}
	return st("")
}

// userCondA1 — a user-body condition / array index → an A1 Arith AST
// (Num/Var/Bin — the `Arith.ast` contract), HOISTING runtime-value
// subexpressions (calls, array reads, derefs) into fresh temp store
// vars (`t = <read>; ... Var(t)`). The A1 Arith grammar has no
// Call/Index node, so a `cmp_call(...) > 0` condition or an
// `a[j]`-indexed write lowers to temp assigns + plain arith operands.
// Nested Bin arms recurse; anything that isn't a plain Num/Var is a
// runtime read and gets hoisted. Callers wrap the result in
// `{"type":"Arith","ast": …}` (or embed it as a Bin arm).
func userCondA1(e *expr, params []string, out *[]any) any {
	if e == nil {
		return map[string]any{"type": "Num", "value": 1}
	}
	// struct-pointer NULL checks: `p != 0` / `p == 0` / bare `p` — a
	// heap handle string is NOT numeric, so an Arith comparison would
	// coerce it to 0 and call every live pointer NULL. Lower to the
	// runtime TEST `"$p -ne 0"` — Number(handle)=NaN, and the runtime's
	// `-ne` is `NaN !== 0` (true for a live pointer) while NULL ("0") is
	// `0 !== 0` (false). Exactly the C pointer truthiness.
	if ptrCond, ok := structPtrCond(e); ok {
		return ptrCond
	}
	switch e.kind {
	case "num":
		n, _ := strconv.Atoi(e.num)
		return map[string]any{"type": "Num", "value": n}
	case "id":
		return map[string]any{"type": "Var", "name": e.name}
	case "bin":
		return map[string]any{
			"type": "Bin", "op": e.op,
			"lhs": userCondA1(e.l, params, out),
			"rhs": userCondA1(e.r, params, out),
		}
	}
	// a runtime value — hoist into a temp store var first
	userTempSeq++
	tmp := "___t" + strconv.Itoa(userTempSeq)
	*out = append(*out, map[string]any{
		"type":    "Assign",
		"targets": []any{map[string]any{"var": tmp, "indices": []any{}, "sigil": nil}},
		"expr":    userExprA1(e, params),
	})
	return map[string]any{"type": "Var", "name": tmp}
}

// structPtrCond — `p != 0` / `p == 0` / bare `p` on a struct-pointer
// variable → a plain A1 BinOp against the store read (see userCondA1).
func structPtrCond(e *expr) (any, bool) {
	ptr := func(x *expr) (string, bool) {
		if x != nil && x.kind == "id" {
			if _, ok := structPtrVars[x.name]; ok {
				return x.name, true
			}
		}
		return "", false
	}
	zero := func(x *expr) bool {
		return x != nil && x.kind == "num" && (x.num == "0" || x.num == "0.0")
	}
	if e.kind == "id" {
		if name, ok := ptr(e); ok {
			// `while (p)` — non-null: a live handle is a non-empty string
			return testCall("-n $" + name), true
		}
	}
	if e.kind == "bin" && (e.op == "!=" || e.op == "==") {
		flag := "-n"
		if e.op == "==" {
			flag = "-z"
		}
		if l, ok := ptr(e.l); ok && zero(e.r) {
			return testCall(flag + " $" + l), true
		}
		if r, ok := ptr(e.r); ok && zero(e.l) {
			return testCall(flag + " $" + r), true
		}
	}
	return nil, false
}

// userCondExpr — a user-body condition / index as a full A1 Arith EXPR
// (`Arith.ast` = userCondA1).
func userCondExpr(e *expr, params []string, out *[]any) any {
	// a struct-pointer NULL check lowers to a plain BinOp (string
	// semantics — see structPtrCond); everything else to the Arith form
	if c, ok := structPtrCond(e); ok {
		return c
	}
	return map[string]any{"type": "Arith", "ast": userCondA1(e, params, out)}
}

// interpName — `name[<arith expr>]` as an A1 Interpolate (a template
// literal `name[${...}]`): the runtime setVar's baked-subscript parsing
// evaluates the interpolated index. Used for DYNAMIC array writes.
func interpName(name string, idx any) any {
	return map[string]any{
		"type": "Interpolate",
		"parts": []any{
			map[string]any{"kind": "lit", "text": name + "["},
			map[string]any{"kind": "expr", "expr": idx},
			map[string]any{"kind": "lit", "text": "]"},
		},
	}
}

// ptrAdvanceDelta — is this assignment a POINTER advance (`p = p + 1`,
// `p += 2`, `p = p - 1`)? Returns the element delta. Only meaningful for
// pointer params (checked by the caller).
func ptrAdvanceDelta(s *uStmt) (int, bool) {
	if s.name == "" || s.e == nil {
		return 0, false
	}
	if s.op == "+=" || s.op == "-=" {
		if s.e.kind != "num" {
			return 0, false
		}
		n, err := strconv.Atoi(s.e.num)
		if err != nil {
			return 0, false
		}
		if s.op == "+=" {
			return n, true
		}
		return -n, true
	}
	// s.op == "=": `p = p ± N`
	if s.e.kind == "bin" && (s.e.op == "+" || s.e.op == "-") &&
		s.e.l != nil && s.e.l.kind == "id" && s.e.l.name == s.name &&
		s.e.r != nil && s.e.r.kind == "num" {
		n, err := strconv.Atoi(s.e.r.num)
		if err != nil {
			return 0, false
		}
		if s.e.op == "-" {
			n = -n
		}
		return n, true
	}
	return 0, false
}

// memAdvanceCall — `p = memAdvance(p, delta)` (a C pointer increment:
// walk the slice-1 handle to the next element).
func memAdvanceCall(name string, delta int) map[string]any {
	return map[string]any{
		"type":    "Assign",
		"targets": []any{map[string]any{"var": name, "indices": []any{}, "sigil": nil}},
		"expr":    call("memAdvance", []any{call("getVar", []any{st(name)}), st(strconv.Itoa(delta))}),
	}
}

// userTempSeq — a monotonically increasing counter for the temp vars
// compound assigns lower runtime reads into (see arithOperand).
var userTempSeq int

// exprNeedsTemp — does lowering this expression produce a runtime call
// (memLoad / arrayIndex / fnCall)? The A1 Arith grammar has no Call
// node (shir_json_in.rs), so such a read cannot sit inside an
// arithmetic tree — it must be stored into a temp var first.
func exprNeedsTemp(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "deref", "index", "addr", "call":
		return true
	case "bin":
		return exprNeedsTemp(e.l) || exprNeedsTemp(e.r)
	}
	return false
}

// arithOperand — lower `e` to an A1-arithmetic-safe operand (Num / Var
// / Str / nested Bin). Runtime reads are stored into a fresh temp var
// (`t = <read>`, appended to `out`) and the operand becomes Var(t).
func arithOperand(e *expr, params []string, out *[]any) any {
	if !exprNeedsTemp(e) {
		// plain exprs lower through arithNode (Num / Var / Bin) — the
		// Arith grammar's own shapes, NOT the shell-store getVar calls
		return arithNode(e)
	}
	userTempSeq++
	tmp := "___t" + strconv.Itoa(userTempSeq)
	*out = append(*out, map[string]any{
		"type":    "Assign",
		"targets": []any{map[string]any{"var": tmp, "indices": []any{}, "sigil": nil}},
		"expr":    userExprA1(e, params),
	})
	return map[string]any{"type": "Var", "name": tmp}
}

// userStmtsA1 — a user-function body (the uStmt mini-AST) → A1 stmts.
// `ptrs` maps pointer param names → element type ("int"/"char"): deref
// stores and pointer advances only lower for those (a plain var named p
// stays an ordinary shell variable).
func userStmtsA1(stmts []*uStmt, params []string, ptrs map[string]string) []any {
	out := []any{}
	for _, s := range stmts {
		switch s.kind {
		case "skip":
			continue
		case "assign":
			if _, isPtr := ptrs[s.name]; isPtr {
				if delta, ok := ptrAdvanceDelta(s); ok {
					// `p = p + 1` / `p += 1` — walk the pointer
					out = append(out, memAdvanceCall(s.name, delta))
					continue
				}
			}
			expr := userExprA1(s.e, params)
			// a runtime-store var (getline's &buffer — the runtime writes it
			// by NAME): every assign routes through setVar so the lift
			// analysis never moves it to a native binding (which would
			// desync from getLine's store write). A LITERAL source is
			// wrapped in a self-read (`setVar("b", getVar("b"))`) — a
			// runtime call source can't be lifted, and the value is
			// unchanged (an unset var reads "").
			if addrTaken[s.name] {
				if s.op == "=" {
					rhs := expr
					if isLiteralA1(rhs) {
						rhs = call("getVar", []any{st(s.name)})
					}
					out = append(out, map[string]any{
						"type": "Expr",
						"expr": call("setVar", []any{st(s.name), rhs}),
					})
					continue
				}
			}
			// a struct-pointer assigned NULL (`= 0`) — the empty string
			// (a live handle is any non-empty string; the `-n` null check)
			if _, isStructPtr := structPtrVars[s.name]; isStructPtr {
				if s.op == "=" && s.e != nil && s.e.kind == "num" && (s.e.num == "0" || s.e.num == "0.0") {
					expr = st("")
				}
			}
			if s.op == "+=" || s.op == "-=" {
				// `total += *s` — a compound assign: load, add, store.
				// The A1 Arith grammar has no Call node, so a runtime
				// read on the rhs is lowered into a temp var first.
				op := "+"
				if s.op == "-=" {
					op = "-"
				}
				expr = map[string]any{
					"type": "Arith",
					"ast": map[string]any{
						"type": "Bin",
						"op":   op,
						"lhs":  map[string]any{"type": "Var", "name": s.name},
						"rhs":  arithOperand(s.e, params, &out),
					},
				}
			}
			out = append(out, map[string]any{
				"type":    "Assign",
				"targets": []any{map[string]any{"var": s.name, "indices": []any{}, "sigil": nil}},
				"expr":    expr,
			})
		case "ptrinc":
			if _, isPtr := ptrs[s.name]; isPtr {
				delta := 1
				if s.op == "--" {
					delta = -1
				}
				out = append(out, memAdvanceCall(s.name, delta))
				continue
			}
			// a plain int var: i++ / i-- → i = i ± 1 (Arith — the A1
			// grammar has no inc/dec stmt)
			delta := 1
			if s.op == "--" {
				delta = -1
			}
			out = append(out, map[string]any{
				"type":    "Assign",
				"targets": []any{map[string]any{"var": s.name, "indices": []any{}, "sigil": nil}},
				"expr": map[string]any{"type": "Arith", "ast": map[string]any{
					"type": "Bin",
					"op":   "+",
					"lhs":  map[string]any{"type": "Var", "name": s.name},
					"rhs":  map[string]any{"type": "Num", "value": delta},
				}},
			})
		case "derefstore":
			elem, isPtr := ptrs[s.name]
			if !isPtr {
				continue
			}
			// `*p = v` — memStore through the handle (writes the shell
			// var / array element the pointer points at)
			rhs := userExprA1(s.e, params)
			if s.op == "+=" || s.op == "-=" {
				// `*p += v` — load the element into a temp, add, store
				// (the A1 Arith grammar has no Call node)
				op := "+"
				if s.op == "-=" {
					op = "-"
				}
				userTempSeq++
				tmp := "___t" + strconv.Itoa(userTempSeq)
				out = append(out, map[string]any{
					"type":    "Assign",
					"targets": []any{map[string]any{"var": tmp, "indices": []any{}, "sigil": nil}},
					"expr":    call("memLoad", []any{call("getVar", []any{st(s.name)}), st("0"), st(elem)}),
				})
				rhs = map[string]any{
					"type": "Arith",
					"ast": map[string]any{
						"type": "Bin",
						"op":   op,
						"lhs":  map[string]any{"type": "Var", "name": tmp},
						"rhs":  arithOperand(s.e, params, &out),
					},
				}
			}
			out = append(out, map[string]any{
				"type": "Expr",
				"expr": call("memStore", []any{
					call("getVar", []any{st(s.name)}),
					st("0"), st(elem), rhs,
				}),
			})
			if s.ptrPost {
				// `*p++ = v` — advance the pointer after the store
				out = append(out, memAdvanceCall(s.name, 1))
			}
		case "seq":
			// a comma-separated declaration list (flattened into assigns)
			out = append(out, userStmtsA1(s.body, params, ptrs)...)
		case "for":
			// for (init; cond; step) body — the init assign, then a While
			// whose body appends the step at its end
			if s.init != nil {
				out = append(out, userStmtsA1([]*uStmt{s.init}, params, ptrs)...)
			}
			body := s.body
			if s.step != nil {
				body = append(append([]*uStmt{}, s.body...), s.step)
			}
			out = append(out, map[string]any{
				"type": "While",
				"cond": userCondExpr(s.e, params, &out),
				"body": userStmtsA1(body, params, ptrs),
			})
		case "while":
			out = append(out, map[string]any{
				"type": "While",
				"cond": userCondExpr(s.e, params, &out),
				"body": userStmtsA1(s.body, params, ptrs),
			})
		case "if":
			out = append(out, map[string]any{
				"type":   "If",
				"cond":   userCondExpr(s.e, params, &out),
				"then":   userStmtsA1(s.body, params, ptrs),
				"elsifs": []any{},
				"else":   userStmtsA1(s.elseBody, params, ptrs),
			})
		case "idxassign":
			// a[idx] = v — a baked-subscript store write: the index is a
			// runtime arith (calls hoisted into temps) interpolated into
			// the name string `a[<expr>]`; the runtime store substitutes
			// ${var} references inside it and writes the element.
			idx := userCondExpr(s.idx, params, &out)
			var name any
			if _, isPtrParam := ptrs[s.name]; isPtrParam {
				// base[idx] = v on an ARRAY-NAME pointer param: the name is
				// the param's RUNTIME value (the array's variable name) —
				// `setVar(`${base}[${idx}]`, v)` (the store parses the
				// baked subscript).
				name = map[string]any{
					"type": "Interpolate",
					"parts": []any{
						map[string]any{"kind": "expr", "expr": call("getVar", []any{st(s.name)})},
						map[string]any{"kind": "lit", "text": "["},
						map[string]any{"kind": "expr", "expr": idx},
						map[string]any{"kind": "lit", "text": "]"},
					},
				}
			} else {
				name = interpName(s.name, idx)
			}
			out = append(out, map[string]any{
				"type": "Expr",
				"expr": call("setVar", []any{name, userExprA1(s.e, params)}),
			})
		case "arrowstore":
			// p->member = v — memStore the value into the arena at the
			// member's byte offset (the handle lives in the store).
			if tag, ok := structPtrVars[s.name]; ok {
				if off, ok := memberOffset(tag, s.member); ok {
					out = append(out, map[string]any{
						"type": "Expr",
						"expr": call("memStore", []any{
							call("getVar", []any{st(s.name)}),
							st(strconv.Itoa(off)), st("char"), userExprA1(s.e, params),
						}),
					})
					break
				}
			}
			refuse("arrow store to unknown struct member " + s.name + "->" + s.member)
		case "ret":
			out = append(out, map[string]any{
				"type":  "Return",
				"value": userExprA1(s.e, params),
			})
		case "exec":
			if s.a1 != nil {
				out = append(out, s.a1)
			}
		case "call":
			// fn(args); — a function-call statement in a function body:
			// the runtime dispatch (exec for user fns, the comparator
			// bridge for cmp_call).
			if s.e != nil && s.e.kind == "call" {
				out = append(out, map[string]any{"type": "Expr", "expr": callNode(s.e)})
			}
		}
	}
	return out
}

// buildUserFnA1 — a user function definition → the A1 `Function` stmt
// (the same shape the shell frontends emit; the estree lowers it to
// sh2.define, the perl backend to a `sub`). The params bind the
// positional args first ($1..$N — the fnCall/callDirect dispatch sets
// scriptArgs), then the body runs; `return e` carries the value out.
func buildUserFnA1(name string, fn *userFunc) map[string]any {
	body := []any{}
	for i, pn := range fn.params {
		// SIGNATURE-AWARE PARAM BINDINGS: an INTEGER param is cast to a
		// number at the boundary (`pn = sh2.arith("$N")` — the glue casts
		// the bash positional to the C type); pointer / string / function-
		// pointer params keep the raw name string (a pointer IS a name).
		// The normalizeFunctions pass reads the cast shape back to make
		// the param a real JS parameter (`Number(sh2.positional[N])` in
		// the adapter).
		if isIntType(fn.paramTypes[i]) && !fnPtrParamNames[pn] && fn.ptrParams[pn] == "" {
			body = append(body, map[string]any{
				"type":    "Assign",
				"targets": []any{map[string]any{"var": pn, "indices": []any{}, "sigil": nil}},
				"expr":    call("arith", []any{st("$" + strconv.Itoa(i+1))}),
			})
			continue
		}
		body = append(body, map[string]any{
			"type":    "Assign",
			"targets": []any{map[string]any{"var": pn, "indices": []any{}, "sigil": nil}},
			"expr":    call("getVar", []any{st(strconv.Itoa(i + 1))}),
		})
	}
	// array-name pointers: while this body emits, `p[i]` on a pointer
	// param reads/writes the runtime store under the name p holds.
	prevPtr := fnPtrParams
	fnPtrParams = fn.ptrParams
	body = append(body, userStmtsA1(fn.body, fn.params, fn.ptrParams)...)
	fnPtrParams = prevPtr
	return map[string]any{"type": "Function", "name": name, "body": body}
}

// isLiteralA1 — a Str/Int A1 expr (a liftable literal source).
func isLiteralA1(e any) bool {
	m, ok := e.(map[string]any)
	if !ok {
		return false
	}
	t, _ := m["type"].(string)
	return t == "Str" || t == "Int" || t == "Bool"
}

// isIntType — the C types whose values are numbers (cast at the boundary).
func isIntType(t string) bool {
	switch t {
	case "int", "long", "unsigned", "short", "float", "double", "long long", "unsigned long":
		return true
	}
	return false
}

// userFuncs — USER function definitions (`static int triple(int n) {
// return n * 3; }`). The v1 subset models a function as a small body of
// statements interpreted over LITERAL call args (substitution + evalua-
// tion): a single pure return expression, optionally wrapped in the
// varargs idiom (va_start/va_arg/va_end + a while loop). The A1 v1
// grammar has no call stack, so anything richer (variable args, body
// side effects with stdout) REFUSES. The body is never emitted — only
// main's body becomes the program.
type userFunc struct {
	params     []string
	paramTypes []string          // parallel to params: "int" | "char"
	ptrParams  map[string]string // pointer params: name -> element type ("int"/"char")
	varargs    bool              // `...` in the signature: extra call args feed va_arg
	body       []*uStmt
}

var userFuncs = map[string]*userFunc{}

// uStmt — a user-function body statement (the mini-AST the literal-arg
// fold interprets; see foldUserBody).
type uStmt struct {
	kind     string   // assign | while | if | ret | skip | exec | derefstore | ptrinc | idxassign | arrowstore | seq | for
	name     string   // assign target / deref pointer / ptrinc var / idxassign array / arrow pointer var
	member   string   // arrowstore: the struct member name
	op       string   // "=" | "+=" | "-="  (ptrinc: "++" | "--")
	e        *expr    // assign rhs / while cond / if cond / return expr / deref rhs / idxassign value / arrowstore value / for cond
	idx      *expr    // idxassign: the array index expression
	body     []*uStmt // while body / if then-arm / for body / seq items
	elseBody []*uStmt // if else-arm
	init     *uStmt   // for: the loop initializer (an assign)
	step     *uStmt   // for: the loop step (an assign)
	a1       any      // a raw A1 statement (exec-carrier kind)
	ptrPost  bool     // derefstore: `*p++ = v` — advance the pointer after the store
}

// evUExpr — evaluate a body expression with the va_arg stack (a
// top-level va_arg pops the next variadic literal). Everything else
// delegates to foldConst (which handles postfix ++/-- via env mutation).
func evUExpr(e *expr, env map[string]string, rest *[]string) (string, bool) {
	if e == nil {
		return "", false
	}
	if e.kind == "call" && e.name == "va_arg" {
		if len(*rest) == 0 {
			return "", false
		}
		v := (*rest)[0]
		*rest = (*rest)[1:]
		return v, true
	}
	return foldConst(e, env)
}

// interpUStmt — interpret one body statement over the literal env.
// Returns (retValue, hasRet, ok): hasRet unwinds a `return` inside a
// loop body to the enclosing fold.
func interpUStmt(s *uStmt, env map[string]string, rest *[]string) (string, bool, bool) {
	switch s.kind {
	case "skip":
		return "", false, true
	case "assign":
		v, ok := evUExpr(s.e, env, rest)
		if !ok {
			return "", false, false
		}
		if s.op == "=" {
			env[s.name] = v
			return "", false, true
		}
		a, err1 := strconv.ParseInt(env[s.name], 10, 64)
		b, err2 := strconv.ParseInt(v, 10, 64)
		if err1 != nil || err2 != nil {
			return "", false, false
		}
		if s.op == "+=" {
			env[s.name] = strconv.FormatInt(a+b, 10)
		} else {
			env[s.name] = strconv.FormatInt(a-b, 10)
		}
		return "", false, true
	case "while":
		for guard := 0; guard < 100000; guard++ {
			c, ok := evUExpr(s.e, env, rest)
			if !ok {
				return "", false, false
			}
			n, err := strconv.ParseInt(c, 10, 64)
			if err != nil {
				n = 0
			}
			if n == 0 {
				return "", false, true
			}
			for _, b := range s.body {
				if b.kind == "ret" {
					v, ok := evUExpr(b.e, env, rest)
					return v, ok, ok
				}
				if v, done, ok := interpUStmt(b, env, rest); !ok {
					return "", false, false
				} else if done {
					return v, true, true
				}
			}
		}
		return "", false, false // loop bound exceeded — not foldable
	case "ret":
		v, ok := evUExpr(s.e, env, rest)
		return v, ok, ok
	}
	return "", false, false
}

// foldUserBody — a user function over LITERAL argument values: bind the
// params (the rest feed va_arg), interpret the body, return the value of
// the (only) `return`. A body with no return is C UB — refuse.
func foldUserBody(fn *userFunc, argVals []string) (string, bool) {
	env := map[string]string{}
	for i, pn := range fn.params {
		env[pn] = argVals[i]
	}
	rest := argVals[len(fn.params):]
	for _, s := range fn.body {
		if v, done, ok := interpUStmt(s, env, &rest); !ok {
			return "", false
		} else if done {
			return v, true
		}
	}
	return "", false
}

// boolStr — a C truth value as its string form (the store is string-typed).
func boolStr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// foldConst — evaluate a pure v1 expression over a LITERAL environment to
// its string constant. C int semantics (int64) for the arithmetic subset;
// comparisons and &&/||/! yield 1/0; ==/!= on non-numeric literals falls
// back to string equality (strcmp("a","b") == 0 folds through this).
func foldConst(e *expr, env map[string]string) (string, bool) {
	if e == nil {
		return "", false
	}
	switch e.kind {
	case "num", "str":
		return e.num, true
	case "id":
		v, ok := env[e.name]
		return v, ok
	case "postinc", "postdec":
		// C postfix semantics: the expression's VALUE is the OLD value,
		// the variable is mutated as a side effect (`while (n--) ...`).
		v, ok := env[e.name]
		if !ok {
			return "", false
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return "", false
		}
		if e.kind == "postinc" {
			env[e.name] = strconv.FormatInt(n+1, 10)
		} else {
			env[e.name] = strconv.FormatInt(n-1, 10)
		}
		return v, true
	case "call":
		return foldCallConst(e, env)
	case "bin":
		switch e.op {
		case "+", "-", "*", "/", "%":
			l, ok1 := foldConst(e.l, env)
			r, ok2 := foldConst(e.r, env)
			if !ok1 || !ok2 {
				return "", false
			}
			a, err1 := strconv.ParseInt(l, 10, 64)
			b, err2 := strconv.ParseInt(r, 10, 64)
			if err1 != nil || err2 != nil {
				return "", false
			}
			var v int64
			switch e.op {
			case "+":
				v = a + b
			case "-":
				v = a - b
			case "*":
				v = a * b
			case "/":
				if b == 0 {
					return "", false
				}
				v = a / b // C truncation toward zero (Go division matches)
			case "%":
				if b == 0 {
					return "", false
				}
				v = a % b
			}
			return strconv.FormatInt(v, 10), true
		case "==", "!=", "<", ">", "<=", ">=":
			l, ok1 := foldConst(e.l, env)
			r, ok2 := foldConst(e.r, env)
			if !ok1 || !ok2 {
				return "", false
			}
			a, err1 := strconv.ParseInt(l, 10, 64)
			b, err2 := strconv.ParseInt(r, 10, 64)
			if err1 == nil && err2 == nil {
				c := a
				d := b
				switch e.op {
				case "==":
					return boolStr(c == d), true
				case "!=":
					return boolStr(c != d), true
				case "<":
					return boolStr(c < d), true
				case ">":
					return boolStr(c > d), true
				case "<=":
					return boolStr(c <= d), true
				case ">=":
					return boolStr(c >= d), true
				}
			}
			// non-numeric operands: string equality only (C's byte-wise
			// ordering of arbitrary strings is not modeled)
			if e.op == "==" {
				return boolStr(l == r), true
			}
			if e.op == "!=" {
				return boolStr(l != r), true
			}
			return "", false
		case "&&", "||":
			l, ok1 := foldConst(e.l, env)
			r, ok2 := foldConst(e.r, env)
			if !ok1 || !ok2 {
				return "", false
			}
			a, err1 := strconv.ParseInt(l, 10, 64)
			b, err2 := strconv.ParseInt(r, 10, 64)
			if err1 != nil || err2 != nil {
				return "", false
			}
			if e.op == "&&" {
				return boolStr(a != 0 && b != 0), true
			}
			return boolStr(a != 0 || b != 0), true
		case "!":
			v, ok := foldConst(e.l, env)
			if !ok {
				return "", false
			}
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				return "", false
			}
			return boolStr(n == 0), true
		}
	}
	return "", false
}

// foldCallConst — a stdlib/user call with all-literal arguments -> its
// string constant. strlen("lit") folds to the length, atoi("lit") to its
// integer text, strcmp(a,b) to the SIGN of the C result (-1/0/1 — the
// magnitude is implementation-defined), sizeof(T) to the ABI size of a
// single-word type name (or of a struct-typed var). A user function call
// substitutes the literal args for the params and folds the body (see
// foldUserBody — the v1 subset is a single pure return expression, or a
// small varargs body interpreted over the literal args). A function-
// pointer call folds through its target (funcPtrs).
func foldCallConst(e *expr, env map[string]string) (string, bool) {
	if e == nil {
		return "", false
	}
	switch e.name {
	case "strlen":
		if len(e.args) == 1 {
			if s, ok := foldConst(e.args[0], env); ok {
				return strconv.Itoa(len(s)), true
			}
		}
	case "atoi":
		if len(e.args) == 1 {
			if s, ok := foldConst(e.args[0], env); ok {
				t := strings.TrimSpace(s)
				n, err := strconv.Atoi(t)
				if err != nil {
					n = 0 // C atoi: no leading digits -> 0
				}
				return strconv.Itoa(n), true
			}
		}
	case "strcmp":
		if len(e.args) == 2 {
			a, ok1 := foldConst(e.args[0], env)
			b, ok2 := foldConst(e.args[1], env)
			if ok1 && ok2 {
				switch {
				case a == b:
					return "0", true
				case a < b:
					return "-1", true
				default:
					return "1", true
				}
			}
		}
	case "sizeof":
		if len(e.args) == 1 {
			a := e.args[0]
			if a.kind == "id" {
				if sz, ok := cTypeSize(a.name); ok {
					return strconv.Itoa(sz), true
				}
				// sizeof(p) on a struct-typed variable -> the layout size
				if tag, ok := varStruct[a.name]; ok {
					if sz, ok := structSize(tag); ok {
						return strconv.Itoa(sz), true
					}
				}
			}
		}
	}
	// user function (or a function-pointer call): substitute the literal
	// args for the params, fold the body
	name := e.name
	if tgt, ok := funcPtrs[name]; ok {
		name = tgt
	}
	if fn, ok := userFuncs[name]; ok {
		if !fn.varargs && len(e.args) != len(fn.params) {
			return "", false
		}
		if fn.varargs && len(e.args) < len(fn.params) {
			return "", false
		}
		argVals := make([]string, len(e.args))
		for i, a := range e.args {
			v, ok := foldConst(a, env)
			if !ok {
				return "", false
			}
			argVals[i] = v
		}
		return foldUserBody(fn, argVals)
	}
	return "", false
}

// ── lexer ────────────────────────────────────────────────────────────
type tok struct {
	kind string // id num str op
	text string
	line int // 1-based source line (stmt_lines / line maps)
}

func lex(src string) ([]tok, error) {
	var out []tok
	i, n := 0, len(src)
	line := 1
	for i < n {
		c := src[i]
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '/' && i+1 < n && src[i+1] == '/':
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && src[i+1] == '*':
			i += 2
			for i+1 < n && !(src[i] == '*' && src[i+1] == '/') {
				if src[i] == '\n' {
					line++ // block comments span lines — keep error line numbers true
				}
				i++
			}
			i += 2
		case c == '#': // preprocessor line — skip to newline
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '"':
			j := i + 1
			var sb strings.Builder
			for j < n && src[j] != '"' {
				if src[j] == '\\' && j+1 < n {
					switch src[j+1] {
					case 'n':
						sb.WriteByte('\n')
					case 't':
						sb.WriteByte('\t')
					case '\\':
						sb.WriteByte('\\')
					case '"':
						sb.WriteByte('"')
					default:
						sb.WriteByte(src[j+1])
					}
					j += 2
					continue
				}
				sb.WriteByte(src[j])
				j++
			}
			out = append(out, tok{"str", sb.String(), line})
			i = j + 1
		case c >= '0' && c <= '9':
			j := i
			for j < n && src[j] >= '0' && src[j] <= '9' {
				j++
			}
			// Float literal: a '.' followed by at least one digit
			// (the post-dot digits are required to disambiguate
			// `a.b` member access from a real literal — `1.` and
			// `.5` are NOT consumed, they parse as `1 . 5` /
			// `. 5`).
			if j+1 < n && src[j] == '.' && src[j+1] >= '0' && src[j+1] <= '9' {
				j++
				for j < n && src[j] >= '0' && src[j] <= '9' {
					j++
				}
			}
			out = append(out, tok{"num", src[i:j], line})
			i = j
		case isIdent(c):
			j := i
			for j < n && (isIdent(src[j]) || (src[j] >= '0' && src[j] <= '9')) {
				j++
			}
			out = append(out, tok{"id", src[i:j], line})
			i = j
		default:
			three := ""
			if i+2 < n {
				three = src[i : i+3]
			}
			two := ""
			if i+1 < n {
				two = src[i : i+2]
			}
			if three == "..." {
				// varargs marker: `int sum(int n, ...)` — parsed in user-func
				// signatures only; anywhere else it refuses later.
				out = append(out, tok{"op", "...", line})
				i += 3
				continue
			}
			switch two {
			case "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "++", "--", "->":
				out = append(out, tok{"op", two, line})
				i += 2
				continue
			}
			// `.` — member access (`p.x`) and float literals (`1.5` — the
			// float itself needs the core Float type; the tokens parse-fail
			// later and REFUSE, which is the honest gate for t23 until the
			// estree worker lands IrType::Float). `:` — switch case labels
			// (and goto labels — those refuse in the parser).
			if strings.ContainsRune("=+-*/%!<>&;{}()[],.:", rune(c)) {
				out = append(out, tok{"op", string(c), line})
				i++
			} else {
				return nil, fmt.Errorf("lex: unexpected %q", string(c))
			}
		}
	}
	return out, nil
}
func isIdent(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// ── preprocessor (the #define subset) ────────────────────────────────
// preprocessDefines — collect `#define NAME body` / `#define NAME(a,b)
// body` lines into the macro table. Other `#` lines (include) stay
// skipped by the lexer. Bodies are lexed as token lists.
func preprocessDefines(src string) {
	for _, line := range strings.Split(src, "\n") {
		tr := strings.TrimSpace(line)
		if !strings.HasPrefix(tr, "#define") {
			continue
		}
		rest := strings.TrimSpace(tr[len("#define"):])
		i := 0
		for i < len(rest) && (isIdent(rest[i]) || (rest[i] >= '0' && rest[i] <= '9')) {
			i++
		}
		if i == 0 {
			continue
		}
		name := rest[:i]
		rest = strings.TrimSpace(rest[i:])
		var params []string
		if strings.HasPrefix(rest, "(") {
			j := 1
			for j < len(rest) && rest[j] != ')' {
				j++
			}
			if j >= len(rest) {
				continue
			}
			for _, p := range strings.Split(rest[1:j], ",") {
				p = strings.TrimSpace(p)
				if p != "" {
					params = append(params, p)
				}
			}
			rest = strings.TrimSpace(rest[j+1:])
		}
		if rest == "" {
			continue
		}
		body, err := lex(rest)
		if err != nil {
			continue
		}
		macros[name] = macro{params: params, body: body}
	}
}

// expandMacros — splice macro definitions into the token stream
// (recursively, with a depth cap). Object-like: NAME -> body tokens.
// Function-like: NAME(args) -> body with the params substituted by the
// (recursively expanded) arg tokens.
func expandMacros(ts []tok) []tok { return expandMacrosDepth(ts, 0) }

func expandMacrosDepth(ts []tok, depth int) []tok {
	if depth > 32 {
		return ts
	}
	var out []tok
	for i := 0; i < len(ts); i++ {
		t := ts[i]
		if t.kind != "id" {
			out = append(out, t)
			continue
		}
		m, ok := macros[t.text]
		if !ok {
			out = append(out, t)
			continue
		}
		if len(m.params) == 0 {
			out = append(out, expandMacrosDepth(m.body, depth+1)...)
			continue
		}
		if i+1 >= len(ts) || ts[i+1].kind != "op" || ts[i+1].text != "(" {
			out = append(out, t)
			continue
		}
		args, next := splitMacroArgs(ts, i+2)
		if next < 0 || len(args) != len(m.params) {
			refuse("macro arg count mismatch for " + t.text)
		}
		sub := map[string][]tok{}
		for j, pn := range m.params {
			sub[pn] = expandMacrosDepth(args[j], depth+1)
		}
		var body []tok
		for _, bt := range m.body {
			if bt.kind == "id" {
				if rep, ok := sub[bt.text]; ok {
					body = append(body, rep...)
					continue
				}
			}
			body = append(body, bt)
		}
		out = append(out, expandMacrosDepth(body, depth+1)...)
		i = next - 1
	}
	return out
}

// splitMacroArgs — the argument token groups of NAME( ... ) starting at
// ts[from] (after the "("). Returns the groups and the index just past
// the matching ")", or -1 when unbalanced.
func splitMacroArgs(ts []tok, from int) ([][]tok, int) {
	depth := 1
	var args [][]tok
	var cur []tok
	for i := from; i < len(ts); i++ {
		t := ts[i]
		if t.kind == "op" && t.text == "(" {
			depth++
			cur = append(cur, t)
			continue
		}
		if t.kind == "op" && t.text == ")" {
			depth--
			if depth == 0 {
				args = append(args, cur)
				return args, i + 1
			}
			cur = append(cur, t)
			continue
		}
		if t.kind == "op" && t.text == "," && depth == 1 {
			args = append(args, cur)
			cur = nil
			continue
		}
		cur = append(cur, t)
	}
	return nil, -1
}

// ── parser ───────────────────────────────────────────────────────────
type parser struct {
	ts      []tok
	p       int
	retExpr *expr // the most recent `return <expr>;` (user-function bodies)
	// source lines for the A1 stmt_lines: topLines parallels the MAIN
	// stmts in emission order; userFuncLines maps a function's name to
	// the line of its signature (the userDefs are prepended, sorted).
	topLines      []int
	userFuncLines map[string]int
}

func (p *parser) peek() *tok {
	if p.p < len(p.ts) {
		return &p.ts[p.p]
	}
	return nil
}
func (p *parser) next() *tok {
	t := p.peek()
	if t != nil {
		p.p++
	}
	return t
}
func (p *parser) isOp(s string) bool { t := p.peek(); return t != nil && t.kind == "op" && t.text == s }
func (p *parser) isId(s string) bool { t := p.peek(); return t != nil && t.kind == "id" && t.text == s }
func (p *parser) expectOp(s string) error {
	if !p.isOp(s) {
		return fmt.Errorf("expected %q at token %v (line %d)", s, p.peek(), p.currentLine())
	}
	p.next()
	return nil
}

// expr: or -> and -> cmp -> add -> mul -> unary -> primary
type expr struct {
	kind string // num id bin addr deref str index call
	num  string
	name string
	op   string
	l, r *expr
	args []*expr // call: the argument expressions
}

func (p *parser) expr() (*expr, error) { return p.orExpr() }
func (p *parser) orExpr() (*expr, error) {
	l, err := p.andExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("||") {
		p.next()
		r, err := p.andExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: "||", l: l, r: r}
	}
	return l, nil
}
func (p *parser) andExpr() (*expr, error) {
	l, err := p.cmpExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("&&") {
		p.next()
		r, err := p.cmpExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: "&&", l: l, r: r}
	}
	return l, nil
}
func isCmpOp(op string) bool {
	switch op {
	case "==", "!=", "<", ">", "<=", ">=":
		return true
	}
	return false
}

func (p *parser) cmpExpr() (*expr, error) {
	l, err := p.addExpr()
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		if t == nil || t.kind != "op" || !isCmpOp(t.text) {
			break
		}
		op := t.text
		p.next()
		r, err := p.addExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: op, l: l, r: r}
	}
	return l, nil
}
func (p *parser) addExpr() (*expr, error) {
	l, err := p.mulExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("+") || p.isOp("-") {
		op := p.next().text
		r, err := p.mulExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: op, l: l, r: r}
	}
	return l, nil
}
func (p *parser) mulExpr() (*expr, error) {
	l, err := p.unaryExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("*") || p.isOp("/") || p.isOp("%") {
		op := p.next().text
		r, err := p.unaryExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: op, l: l, r: r}
	}
	return l, nil
}
func (p *parser) unaryExpr() (*expr, error) {
	if p.isOp("-") {
		p.next()
		e, err := p.unaryExpr()
		if err != nil {
			return nil, err
		}
		return &expr{kind: "bin", op: "-", l: &expr{kind: "num", num: "0"}, r: e}, nil
	}
	if p.isOp("!") {
		p.next()
		e, err := p.unaryExpr()
		if err != nil {
			return nil, err
		}
		return &expr{kind: "bin", op: "!", l: e}, nil
	}
	if p.isOp("&") {
		p.next()
		e, err := p.unaryExpr()
		if err != nil {
			return nil, err
		}
		return &expr{kind: "addr", l: e}, nil
	}
	if p.isOp("*") {
		p.next()
		e, err := p.unaryExpr()
		if err != nil {
			return nil, err
		}
		return &expr{kind: "deref", l: e}, nil
	}
	return p.primary()
}
func (p *parser) primary() (*expr, error) {
	t := p.peek()
	if t == nil {
		return nil, fmt.Errorf("unexpected end of expression")
	}
	switch t.kind {
	case "num":
		p.next()
		return &expr{kind: "num", num: t.text}, nil
	case "str":
		p.next()
		return &expr{kind: "str", num: t.text}, nil
	case "id":
		p.next()
		// sizeof(struct Tag) — the layout size, folded at parse time (the
		// struct definition precedes the use, so the table is complete)
		if t.text == "sizeof" && p.isOp("(") && p.p+1 < len(p.ts) && p.ts[p.p+1].kind == "id" && p.ts[p.p+1].text == "struct" {
			p.next() // (
			p.next() // struct
			tag := p.next()
			if tag == nil || tag.kind != "id" {
				return nil, fmt.Errorf("expected struct tag in sizeof")
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			sz, ok := structSize(tag.text)
			if !ok {
				return nil, fmt.Errorf("sizeof(struct %s): unknown layout", tag.text)
			}
			return &expr{kind: "num", num: strconv.Itoa(sz)}, nil
		}
		if p.isOp("[") {
			// id[expr] — indexing (pointer-to-string lowering: a 1-char slice)
			p.next()
			idx, err := p.expr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp("]"); err != nil {
				return nil, err
			}
			return &expr{kind: "index", l: &expr{kind: "id", name: t.text}, r: idx}, nil
		}
		if p.isOp("(") {
			// id(args) — a function call (strlen / atoi in the v1 subset)
			p.next()
			var args []*expr
			if !p.isOp(")") {
				for {
					a, err := p.expr()
					if err != nil {
						return nil, err
					}
					args = append(args, a)
					if p.isOp(")") {
						break
					}
					if err := p.expectOp(","); err != nil {
						return nil, err
					}
				}
			}
			p.next() // )
			return &expr{kind: "call", name: t.text, args: args}, nil
		}
		if p.isOp("++") || p.isOp("--") {
			// i++ / i-- — postfix increment/decrement (C semantics: the
			// expression value is the OLD value, the var is mutated).
			op := p.next().text
			kind := "postinc"
			if op == "--" {
				kind = "postdec"
			}
			return &expr{kind: kind, name: t.text}, nil
		}
		if p.isOp(".") {
			// p.x — struct member access, flattened to the dotted scalar
			// name "p.x" (the frontend's struct model).
			p.next()
			mn := p.next()
			if mn == nil || mn.kind != "id" {
				return nil, fmt.Errorf("expected member name after '.'")
			}
			return &expr{kind: "member", name: t.text + "." + mn.text}, nil
		}
		if p.isOp("->") {
			// p->member — struct-pointer member access: p holds a heap
			// handle (or the global head); the member reads/writes the mem
			// arena at its byte offset (see valueNode "arrow").
			p.next()
			mn := p.next()
			if mn == nil || mn.kind != "id" {
				return nil, fmt.Errorf("expected member name after '->'")
			}
			return &expr{kind: "arrow", name: mn.text, l: &expr{kind: "id", name: t.text}}, nil
		}
		return &expr{kind: "id", name: t.text}, nil
	case "op":
		if t.text == "(" {
			// `(int) e` / `(char) e` — a C type cast (identity in the v1
			// subset: every value is a string in the shell store)
			if p.p+2 < len(p.ts) {
				n1, n2 := p.ts[p.p+1], p.ts[p.p+2]
				if n1.kind == "id" && (n1.text == "int" || n1.text == "char") && n2.kind == "op" && n2.text == ")" {
					p.next()
					p.next()
					p.next()
					return p.unaryExpr()
				}
			}
			p.next()
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			// `(*cmp)(a, b)` — a call through a DEREF'D function pointer:
			// `(*cmp)` lowers to the deref expr, then the call applies.
			if p.isOp("(") && e.kind == "deref" && e.l != nil && e.l.kind == "id" {
				p.next() // (
				var args []*expr
				if !p.isOp(")") {
					for {
						a, err := p.expr()
						if err != nil {
							return nil, err
						}
						args = append(args, a)
						if p.isOp(")") {
							break
						}
						if err := p.expectOp(","); err != nil {
							return nil, err
						}
					}
				}
				p.next() // )
				return &expr{kind: "call", name: e.l.name, args: args}, nil
			}
			return e, nil
		}
	}
	return nil, fmt.Errorf("unexpected token in expression: %v", t)
}

// ── statement lowering → A1 ──────────────────────────────────────────
func arithNode(e *expr) any {
	switch e.kind {
	case "num":
		n, _ := strconv.Atoi(e.num)
		return map[string]any{"type": "Num", "value": n}
	case "id":
		return map[string]any{"type": "Var", "name": e.name}
	case "call":
		// a call in an arithmetic context (strcmp(a,b) < 0, triple(2) + 1):
		// fold to a constant when every argument is literal. The A1 Arith
		// grammar has no Call node, so a variable value cannot be modeled
		// — refuse (refuse > guess; silently folding to 0 would be a lie).
		s, ok := foldCallConst(e, nil)
		if !ok {
			refuse("unsupported function call " + e.name + " in arithmetic context")
		}
		n, err := strconv.Atoi(s)
		if err != nil {
			refuse("unsupported function call " + e.name + " (non-integer value)")
		}
		return map[string]any{"type": "Num", "value": n}
	case "bin":
		return map[string]any{"type": "Bin", "lhs": arithNode(e.l), "op": e.op, "rhs": arithNode(e.r)}
	case "index", "deref", "addr", "arrow":
		// an array element / pointer deref inside arithmetic — the A1
		// Arith grammar has no Call node, so a runtime array read cannot
		// be modeled. Refuse (refuse > guess — silently folding to 0
		// would be a lie). Lower the read to a temp first (`int v = p[i]`).
		refuse("array/pointer read in an arithmetic context (lower it to a temp: int v = p[i])")
	}
	return map[string]any{"type": "Num", "value": 0}
}

// derefFold — fold a nested deref (`**pp`) through the static alias
// table: *pp where pp->p->x reads x's storage.
func derefFold(e *expr) (string, bool) {
	if e == nil {
		return "", false
	}
	switch e.kind {
	case "id":
		t, ok := scalarAliases[e.name]
		return t, ok
	case "deref":
		if t, ok := derefFold(e.l); ok {
			if t2, ok2 := scalarAliases[t]; ok2 {
				return t2, true
			}
		}
	}
	return "", false
}

func valueNode(e *expr) any {
	switch e.kind {
	case "num":
		return st(e.num)
	case "str":
		return st(e.num)
	case "id":
		if _, ok := scalarAliases[e.name]; ok {
			return call("unsupported", []any{st("raw pointer value use of " + e.name)})
		}
		if _, ok := heapPtrs[e.name]; ok {
			refuse("raw pointer value use of " + e.name)
		}
		return call("getVar", []any{st(e.name)})
	case "member":
		// p.x — a flattened struct member: a plain store read
		return call("getVar", []any{st(e.name)})
	case "arrow":
		// p->member — through a struct-pointer handle: read the mem
		// arena at the member's byte offset (elem "char" = byte
		// addressing; the arena was malloc'd with sizeof(struct) bytes).
		if e.l != nil && e.l.kind == "id" {
			if tag, ok := structPtrVars[e.l.name]; ok {
				if off, ok := memberOffset(tag, e.name); ok {
					return call("memLoad", []any{
						call("getVar", []any{st(e.l.name)}),
						st(strconv.Itoa(off)), st("char"),
					})
				}
			}
		}
		return nil
	case "call":
		return callNode(e)
	case "addr":
		// &x — a handle to x's storage (allocation_id + offset; offset 0)
		if e.l != nil && e.l.kind == "id" {
			return call("addrOf", []any{st(e.l.name)})
		}
		return call("addrOf", []any{valueNode(e.l)})
	case "deref":
		// *p on a statically-aliased scalar — the alias folding: direct
		// read, chasing the chain (`**pp` where pp->p->x reads x)
		if e.l != nil && e.l.kind == "id" {
			if t, ok := scalarAliases[e.l.name]; ok {
				return call("getVar", []any{st(t)})
			}
			if t, ok := ptrTargets[e.l.name]; ok {
				return call("arrayIndex", []any{st(t.arr), st(strconv.Itoa(t.base))})
			}
			// *p on a heap pointer — the mem arena element read
			if hp, ok := heapPtrs[e.l.name]; ok {
				return call("memLoad", []any{call("getVar", []any{st(hp.root)}), st(strconv.Itoa(hp.off)), st(hp.elem)})
			}
		}
		// **pp — deref of a deref through the alias chain: fold to the
		// ultimate scalar's read
		if e.l != nil && e.l.kind == "deref" {
			if t, ok := derefFold(e.l); ok {
				return call("getVar", []any{st(t)})
			}
		}
		// *(q + n) on a pointer-into-array — fold to arrayIndex(arr,
		// base+n) with a constant offset
		if e.l != nil && e.l.kind == "bin" && e.l.l != nil && e.l.l.kind == "id" {
			if t, ok := ptrTargets[e.l.l.name]; ok {
				if k, ok := foldIndex(e.l.r); ok {
					base := t.base
					if e.l.op == "-" {
						base -= k
					} else {
						base += k
					}
					return call("arrayIndex", []any{st(t.arr), st(strconv.Itoa(base))})
				}
			}
		}
		// *p — load through the handle
		return call("memLoad", []any{valueNode(e.l)})
	case "index":
		// s[i] on a char* — the pointer-to-string lowering: a 1-char slice
		if e.l != nil && e.l.kind == "id" && charPtrVars[e.l.name] {
			return call("param", []any{st("slice"), st(e.l.name), offsetArg(e.r), st("1")})
		}
		// p[k] on a static pointer-into-array — the pointer-to-array
		// reduction: fold to arrayIndex(arr, base+k); a DYNAMIC index
		// lowers to arrayIndex(arr, arith("base + $i")) — the runtime
		// arith substitutes the variable and evaluates.
		if e.l != nil && e.l.kind == "id" {
			if t, ok := ptrTargets[e.l.name]; ok {
				if k, ok := foldIndex(e.r); ok {
					return call("arrayIndex", []any{st(t.arr), st(strconv.Itoa(t.base + k))})
				}
				return call("arrayIndex", []any{st(t.arr), indexArith(e.r, t.base)})
			}
			if arrayVars[e.l.name] {
				if k, ok := foldIndex(e.r); ok {
					return call("arrayIndex", []any{st(e.l.name), st(strconv.Itoa(k))})
				}
				return call("arrayIndex", []any{st(e.l.name), indexArith(e.r, 0)})
			}
			// p[k] on a heap pointer — mem arena element read at off+k
			if hp, ok := heapPtrs[e.l.name]; ok {
				if k, ok := foldIndex(e.r); ok {
					return call("memLoad", []any{call("getVar", []any{st(hp.root)}), st(strconv.Itoa(hp.off + k)), st(hp.elem)})
				}
				refuse("heap index must be a compile-time constant in the v1 subset")
			}
			// base[j] on an ARRAY-NAME pointer param — the param holds the
			// array's NAME (arrays decay to their name at call sites); read
			// through the runtime store by that name, like the `void *base`
			// of qsort. The index may be runtime (arith).
			if _, ok := fnPtrParams[e.l.name]; ok {
				return call("arrayIndex", []any{call("getVar", []any{st(e.l.name)}), indexArith(e.r, 0)})
			}
		}
		return nil
	case "bin":
		// a heap pointer in a VALUE position (printf arg, plain assign
		// rhs) — the handle is a tagged string; Arith would coerce it to
		// NaN. Refuse > guess.
		if exprUsesHeap(e) {
			refuse("heap pointer arithmetic outside a pointer assignment")
		}
		// char* + n / char* - n — pointer arithmetic lowered to a substring
		if (e.op == "+" || e.op == "-") && e.l != nil && e.l.kind == "id" && charPtrVars[e.l.name] {
			off := e.r
			if e.op == "-" {
				off = &expr{kind: "bin", op: "-", l: &expr{kind: "num", num: "0"}, r: e.r}
			}
			return call("param", []any{st("slice"), st(e.l.name), offsetArg(off), st("")})
		}
	}
	// Any float operand in the arithmetic (e.g. `x * 2.0`): the A1
	// Arith AST is integer-only (`ArithAst::Num(i64)`), so the
	// structured form would round `2.0` to `0`. Fall back to the
	// runtime `sh2.fparith(<string>)` call which evaluates the C
	// double expression with JS doubles (binary64 — the same IEEE-754
	// format as C doubles). The string form is slower than the native
	// AST but correct for the t23 printf("%.1f\n", 1.5*2.0) shape.
	// (bash's `$(( ))` arith is INTEGER-only — the old `sh2.arith`
	// fallback syntax-errored on `1.5`, the assignment was skipped,
	// and printf saw an unset y → "0.0".)
	if hasFloat(e) {
		return call("fparith", []any{st(exprToArithString(e))})
	}
	return map[string]any{"ast": arithNode(e), "type": "Arith"}
}

// hasFloat — true when `e` contains any numeric literal with a `.`
// (the float-literal token). The Arith AST can't represent floats;
// calls with float operands must use the string-arith fallback above.
func hasFloat(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "num":
		return strings.Contains(e.num, ".")
	case "bin":
		return hasFloat(e.l) || hasFloat(e.r)
	case "un":
		return hasFloat(e.r) // e.l is the op string
	}
	return false
}

// exprToArithString — reconstruct a C arithmetic expression as the
// bash-arithmetic string the runtime's `sh2.arith` consumes. Bare idents
// become `$name` (the runtime's `evalArith` reads the store). Numeric
// literals and operators pass through. Parentheses are added per the
// original C precedence (the runtime parses left-to-right with
// bash-arith precedence, which is the same as C's for the binary ops
// in the v1 subset).
func exprToArithString(e *expr) string {
	if e == nil {
		return ""
	}
	switch e.kind {
	case "num":
		return e.num
	case "id":
		return "$" + e.name
	case "bin":
		l := exprToArithString(e.l)
		r := exprToArithString(e.r)
		return "(" + l + " " + e.op + " " + r + ")"
	}
	return ""
}

// offsetArg — a literal slice offset as its string form (a bare id
// becomes "$name" — the runner's sliceOff parses arith).
func offsetArg(e *expr) any {
	if e != nil && e.kind == "num" {
		return st(e.num)
	}
	if e != nil && e.kind == "id" {
		return st("$" + e.name)
	}
	return st("0")
}

// indexArith — a dynamic array index as the runtime arith call:
// arrayIndex(arr, arith("base + $i")) — arith substitutes $i and
// evaluates the integer expression (a literal index folds earlier).
func indexArith(e *expr, base int) any {
	s := exprToArithString(e)
	if base != 0 {
		s = strconv.Itoa(base) + " + " + s
	}
	return call("arith", []any{st(s)})
}

// testExpr — C comparison → the bash test-expression string ($x -gt 1).
// A bare ident in the TOP-LEVEL test position means "is the value
// non-zero?" in C (numeric truth). Bash's `test $x` is "is the string
// non-empty?" — true for a set variable even when its value is "0" —
// which would silently invert every C `if (var)` and `while (var)`.
// `testExpr` appends `-ne 0` for top-level ids; `testOperand` (used
// inside binops) does NOT, so `$i -eq 1` stays that and doesn't turn
// into `$i -ne 0 -eq 1`.
func testOperand(e *expr) string {
	switch e.kind {
	case "num":
		return e.num
	case "id":
		return "$" + e.name
	case "bin":
		if e.op == "!" {
			return "! " + testOperand(e.l)
		}
		if e.op == "&&" {
			return testOperand(e.l) + " -a " + testOperand(e.r)
		}
		if e.op == "||" {
			return testOperand(e.l) + " -o " + testOperand(e.r)
		}
		return testOperand(e.l) + " " + cmpOp(e.op) + " " + testOperand(e.r)
	}
	return ""
}

func testExpr(e *expr) string {
	if hasFloat(e) {
		refuse("float comparison in a condition (the bash test grammar is integer-only)")
	}
	if e.kind == "id" {
		return "$" + e.name + " -ne 0"
	}
	return testOperand(e)
}
func cmpOp(op string) string {
	switch op {
	case ">":
		return "-gt"
	case "<":
		return "-lt"
	case ">=":
		return "-ge"
	case "<=":
		return "-le"
	case "==":
		return "-eq"
	case "!=":
		return "-ne"
	}
	return op
}

func (p *parser) stmts() ([]any, []int, error) {
	var out []any
	var lines []int
	for {
		t := p.peek()
		if t == nil {
			break
		}
		if t.kind == "op" && t.text == "}" {
			break
		}
		line := p.currentLine()
		if t.kind == "op" && t.text == "{" {
			// a top-level block (main's body): its stmts ARE top-level —
			// the inner lines propagate up through the return
			inner, ilines, err := p.block()
			if err != nil {
				return nil, nil, err
			}
			out = append(out, inner...)
			lines = append(lines, ilines...)
			continue
		}
		s, err := p.stmt()
		if err != nil {
			return nil, nil, err
		}
		if s != nil {
			// stmt() may return a `[]any` (e.g. a label-then-statement
			// sequence emits `[Label, inner]`) — flatten so the label
			// ends up at the SAME level as the surrounding stmts.
			if list, ok := s.([]any); ok {
				out = append(out, list...)
				for range list {
					lines = append(lines, line)
				}
			} else {
				out = append(out, s)
				lines = append(lines, line)
			}
		}
	}
	return out, lines, nil
}

// currentLine — the 1-based source line of the current token.
func (p *parser) currentLine() int {
	if p.p < len(p.ts) {
		return p.ts[p.p].line
	}
	return 0
}

func (p *parser) stmt() (any, error) {
	t := p.peek()
	if t == nil {
		return nil, nil
	}
	stmtStartLine := p.currentLine()
	// Label: `IDENT :` at statement position. Excluded: `default:`
	// (always a switch case — the switch parser handles it), and any
	// C statement keyword (`case` never appears without a value, so
	// the next token wouldn't be `:` — but defensive). The shared
	// `RestructureGoto` pass in shir_passes rewrites the resulting
	// `Label`/`Goto` into structured flow (while/inverted If/flag+break)
	// before any renderer sees it.
	if t.kind == "id" && t.text != "default" && t.text != "case" && p.p+1 < len(p.ts) && p.ts[p.p+1].kind == "op" && p.ts[p.p+1].text == ":" {
		p.next() // consume IDENT
		p.next() // consume :
		inner, err := p.stmt()
		if err != nil {
			return nil, err
		}
		label := map[string]any{"type": "Label", "name": t.text}
		if inner == nil {
			return label, nil
		}
		// Emit the label and the inner statement as a FLAT sequence
		// (a `[]any{Label, inner}`) — NOT a Block wrapper — so the
		// shared `RestructureGoto` pass sees the label at the same
		// level as the surrounding stmts (it scans top-level labels
		// only). `stmts()` / `stmtOrBlock()` flatten list returns.
		return []any{label, inner}, nil
	}
	switch {
	case p.isId("static"):
		// storage-class qualifier — `static int triple(...)`: consume and
		// fall through to the type-keyword handling
		p.next()
		return p.stmt()
	case p.isId("int") || p.isId("char") || p.isId("double") || p.isId("float") || p.isId("void") || p.isId("return"):
		kw := p.next().text
		if kw == "return" {
			var e *expr
			if !p.isOp(";") {
				var err error
				e, err = p.expr()
				if err != nil {
					return nil, err
				}
			}
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			p.retExpr = e   // captured for user-function constant folding
			return nil, nil // return: no stdout effect in the v1 subset
		}
		// [int|char] [*]* NAME ( = expr )? ;  — pointers: `int *p` / `char *s`
		isPtr := false
		for p.isOp("*") {
			p.next()
			isPtr = true
		}
		// function-pointer declaration `int (*f)(int) = twice;` — the `(`
		// precedes any name
		if !isPtr && p.isOp("(") && p.p+1 < len(p.ts) && p.ts[p.p+1].kind == "op" && p.ts[p.p+1].text == "*" {
			p.next() // (
			p.next() // *
			fp := p.next()
			if fp == nil || fp.kind != "id" {
				return nil, fmt.Errorf("expected function-pointer name")
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			if err := p.expectOp("("); err != nil {
				return nil, err
			}
			// parameter list — consumed (pointer types are not checked in
			// the v1 subset)
			for !p.isOp(")") {
				if p.isId("void") {
					p.next()
					continue
				}
				pt := p.next()
				if pt == nil || pt.kind != "id" {
					return nil, fmt.Errorf("expected parameter type in function-pointer declaration")
				}
				for p.isOp("*") {
					p.next()
				}
				if p.isOp(")") {
					break
				}
				pn := p.next()
				if pn == nil || pn.kind != "id" {
					return nil, fmt.Errorf("expected parameter name in function-pointer declaration")
				}
				if p.isOp(")") {
					break
				}
				if err := p.expectOp(","); err != nil {
					return nil, err
				}
			}
			p.next() // )
			if p.isOp("=") {
				p.next()
				tgt := p.next()
				if tgt == nil || tgt.kind != "id" {
					return nil, fmt.Errorf("expected function name in function-pointer initializer")
				}
				funcPtrs[fp.text] = tgt.text
			}
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			return nil, nil
		}
		name := p.next()
		if name.kind != "id" {
			return nil, fmt.Errorf("expected identifier after type")
		}
		// `char *a[4]` — an ARRAY of strings (brackets make it an array,
		// not a single string): the charPtrVars/ptrDecls markings are
		// deferred past the array `[` check below so the array lowering
		// owns the name.
		if p.isOp("[") {
			// array declaration: name[ size ] ( = { e, e, ... } )? ;
			p.next()
			if _, err := p.expr(); err != nil {
				return nil, err
			}
			if err := p.expectOp("]"); err != nil {
				return nil, err
			}
			arrayVars[name.text] = true
			if p.isOp("=") {
				p.next()
				if err := p.expectOp("{"); err != nil {
					return nil, err
				}
				var elems []any
				if !p.isOp("}") {
					for {
						e, err := p.expr()
						if err != nil {
							return nil, err
						}
						elems = append(elems, valueNode(e))
						if p.isOp("}") {
							break
						}
						if err := p.expectOp(","); err != nil {
							return nil, err
						}
					}
				}
				p.next() // }
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				return map[string]any{"type": "Expr", "expr": call("setArray", []any{st(name.text), map[string]any{"elements": elems, "type": "Array"}})}, nil
			}
			p.next() // bare `int a[3];` — create the array so later
			// individual writes (`a[i] = v`) build it in the runtime store
			return map[string]any{"type": "Expr", "expr": call("setArray", []any{st(name.text), map[string]any{"elements": []any{}, "type": "Array"}})}, nil
		}
		if kw == "char" && isPtr {
			charPtrVars[name.text] = true
		}
		if isPtr && kw != "char" {
			// every non-char pointer declaration starts as a heap-pointer
			// candidate (promoted out by recordPtrTarget / heapAssignRHS)
			ptrDecls[name.text] = kw
		}
		// function signature `int main ( void ) {` — or a USER function
		// `static int triple ( int n ) { return n * 3; }`. main's body
		// becomes the program; a user function is registered for
		// literal-arg constant folding (the body is parsed for its return
		// expression but never emitted).
		if p.isOp("(") {
			p.next()
			var params []string
			var paramTypes []string
			var ptrParams map[string]string
			isVarargs := false
			if !p.isOp(")") {
				// a bare `void` (main(void)) is the no-params form — but
				// `void *p` is a real VOID-POINTER param, so only the
				// `void )` shape shortcuts.
				if p.isId("void") && p.p+1 < len(p.ts) && p.ts[p.p+1].kind == "op" && p.ts[p.p+1].text == ")" {
					p.next() // main(void)
				} else {
					for {
						if p.isOp("...") {
							// varargs marker: `int sum(int n, ...)`
							p.next()
							isVarargs = true
							break
						}
						t := p.peek()
						if t == nil || t.kind != "id" || (t.text != "int" && t.text != "char" && t.text != "void" && t.text != "struct") {
							return nil, fmt.Errorf("expected parameter type (int|char|void|struct) at token %v", t)
						}
						// a STRUCT-POINTER parameter: `struct Node *head` — the
						// param receives a list/struct handle (an opaque string);
						// `head->member` goes through the mem arena (structPtrVars).
						if t.text == "struct" {
							p.next() // struct
							tag := p.next()
							if tag == nil || tag.kind != "id" {
								return nil, fmt.Errorf("expected struct tag in parameter type")
							}
							if !p.isOp("*") {
								return nil, fmt.Errorf("expected '*' after struct parameter type")
							}
							p.next() // *
							pn := p.next()
							if pn == nil || pn.kind != "id" {
								return nil, fmt.Errorf("expected parameter name at token %v", pn)
							}
							structPtrVars[pn.text] = tag.text
							params = append(params, pn.text)
							paramTypes = append(paramTypes, "struct")
							if p.isOp(")") {
								break
							}
							if err := p.expectOp(","); err != nil {
								return nil, err
							}
							continue
						}
						ptype := t.text
						p.next() // int | char | void
						isPtr := false
						for p.isOp("*") {
							p.next()
							isPtr = true
						}
						// a FUNCTION-pointer parameter: `int (*cmp)(const void *, const void *)`
						// — the `( * name )` form after the return type. The param
						// receives a comparator's NAME at runtime (a bash function);
						// calls through it (`cmp(a, b)` / `(*cmp)(a, b)`) lower to the
						// comparator bridge.
						if p.isOp("(") && p.p+1 < len(p.ts) && p.ts[p.p+1].kind == "op" && p.ts[p.p+1].text == "*" {
							p.next() // (
							p.next() // *
							pn := p.next()
							if pn == nil || pn.kind != "id" {
								return nil, fmt.Errorf("expected function-pointer parameter name")
							}
							if err := p.expectOp(")"); err != nil {
								return nil, err
							}
							// consume the comparator's own parameter list
							// (`(const void *, const void *)`) — tokens skipped
							if p.isOp("(") {
								p.next()
								for !p.isOp(")") {
									if p.peek() == nil {
										return nil, fmt.Errorf("unterminated function-pointer parameter list")
									}
									p.next()
								}
								p.next() // )
							}
							fnPtrParamNames[pn.text] = true
							params = append(params, pn.text)
							paramTypes = append(paramTypes, ptype)
							if p.isOp(")") {
								break
							}
							if err := p.expectOp(","); err != nil {
								return nil, err
							}
							continue
						}
						pn := p.next()
						if pn == nil || pn.kind != "id" {
							return nil, fmt.Errorf("expected parameter name at token %v", pn)
						}
						params = append(params, pn.text)
						paramTypes = append(paramTypes, ptype)
						if isPtr {
							if ptrParams == nil {
								ptrParams = map[string]string{}
							}
							ptrParams[pn.text] = ptype
						}
						if p.isOp(")") {
							break
						}
						if err := p.expectOp(","); err != nil {
							return nil, err
						}
					}
				}
			}
			p.next() // )
			if name.text == "main" {
				return nil, nil // signature consumed; the body follows as a block
			}
			// a user function: the body is parsed into the mini-AST the
			// literal-arg fold interprets (a pure return expression, or the
			// varargs idiom); the body is never emitted.
			body, err := p.userBlock()
			if err != nil {
				return nil, err
			}
			userFuncs[name.text] = &userFunc{params: params, paramTypes: paramTypes, ptrParams: ptrParams, varargs: isVarargs, body: body}
			if p.userFuncLines == nil {
				p.userFuncLines = map[string]int{}
			}
			p.userFuncLines[name.text] = stmtStartLine
			return nil, nil
		}
		var out []any
		// emit ONE declared name (with its optional initializer / pointer
		// registration), then continue over `,`-separated names — so
		// `int a, b;` / `char *x, *y;` / `int a = 1, b = 2;` all parse.
		for {
			emit, err := p.declOne(name, kw, isPtr)
			if err != nil {
				return nil, err
			}
			if emit != nil {
				out = append(out, emit)
			}
			if !p.isOp(",") {
				break
			}
			p.next() // ,
			// a `*` binds to the NAME (`char *x, *y;` — the type's star is
			// per-name in C)
			isPtr = false
			for p.isOp("*") {
				p.next()
				isPtr = true
			}
			name = p.next()
			if name == nil || name.kind != "id" {
				return nil, fmt.Errorf("expected identifier after ','")
			}
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		if len(out) == 0 {
			return nil, nil
		}
		if len(out) == 1 {
			return out[0], nil
		}
		return out, nil
	case p.isId("if"):
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		c, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		thenB, err := p.stmtOrBlock()
		if err != nil {
			return nil, err
		}
		elseB := []any{}
		if p.isId("else") {
			p.next()
			if p.isId("if") {
				// else if — nested If as the else arm
				nested, err := p.stmt()
				if err != nil {
					return nil, err
				}
				elseB = []any{nested}
			} else {
				elseB, err = p.stmtOrBlock()
				if err != nil {
					return nil, err
				}
			}
		}
		return map[string]any{"cond": testCall(testExpr(c)), "then": thenB, "elsifs": []any{}, "else": elseB, "type": "If"}, nil
	case p.isId("while"):
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		c, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		b, err := p.stmtOrBlock()
		if err != nil {
			return nil, err
		}
		return map[string]any{"cond": testCall(testExpr(c)), "body": b, "type": "While"}, nil
	case p.isId("for"):
		// for (init; cond; inc) body → init; while (cond) { body; inc }
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		var err error
		var init any
		if !p.isOp(";") {
			init, err = p.forHeaderAssign()
			if err != nil {
				return nil, err
			}
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		var cond *expr
		if !p.isOp(";") {
			cond, err = p.expr()
			if err != nil {
				return nil, err
			}
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		var inc any
		if !p.isOp(")") {
			inc, err = p.forHeaderAssign()
			if err != nil {
				return nil, err
			}
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		b, err := p.stmtOrBlock()
		if err != nil {
			return nil, err
		}
		// C's `for (i; c; u) { ... continue; }` jumps to the UPDATE then
		// re-tests the condition. The naive A1 lowering `while (c) {
		// body; u }` puts the update at the END of the body, so a shell
		// `continue` would skip the trailing update → infinite loop on
		// the second iteration (i never advances past the continue
		// site). Fix: wrap each top-level `continue` in the body with
		// the update so the update runs BEFORE the shell-continue skip.
		// Recurse into If/Block (where continues can also appear) but
		// NOT into While/For/Function (their `continue` binds to
		// themselves, not the outer for).
		if inc != nil {
			b = wrapForContinues(b, inc)
		}
		var body []any
		body = append(body, b...)
		if inc != nil {
			body = append(body, inc)
		}
		condStr := "1"
		if cond != nil {
			condStr = testExpr(cond)
		}
		var out []any
		if init != nil {
			out = append(out, init)
		}
		out = append(out, map[string]any{"cond": testCall(condStr), "body": body, "type": "While"})
		return map[string]any{"body": out, "type": "Block"}, nil
	case p.isId("break"), p.isId("continue"):
		// loop control — the A1 signal calls (the runtime while loop
		// catches BREAK/CONTINUE). In switch-case bodies the switch
		// parser strips them instead (a switch break binds to the
		// if-chain the switch lowers to — no loop signal).
		kw := p.next().text
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return map[string]any{"type": "Expr", "expr": call(kw, []any{})}, nil
	case p.isId("goto"):
		// goto IDENT; — emit a Label/Goto IR pair. The shared
		// `RestructureGoto` pass in shir_passes rewrites these into
		// structured flow (while/inverted If/flag+break) before any
		// renderer sees it. Backward gotos become while-loops;
		// forward guarded gotos become inverted ifs; nested gotos
		// become a flag + break per enclosing loop.
		p.next() // consume "goto"
		target := p.next()
		if target == nil || target.kind != "id" {
			return nil, fmt.Errorf("goto requires a label name")
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return map[string]any{"type": "Goto", "name": target.text}, nil
	case p.isId("switch"):
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		disc, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		if err := p.expectOp("{"); err != nil {
			return nil, err
		}
		type swCase struct {
			val  string
			body []any
		}
		var cases []swCase
		var defBody []any
		for !p.isOp("}") {
			if p.peek() == nil {
				return nil, fmt.Errorf("unterminated switch")
			}
			if p.isId("case") {
				p.next()
				cv, err := p.expr()
				if err != nil {
					return nil, err
				}
				v, ok := foldConst(cv, nil)
				if !ok {
					refuse("switch case must be a compile-time constant")
				}
				if err := p.expectOp(":"); err != nil {
					return nil, err
				}
				body, err := p.caseBody()
				if err != nil {
					return nil, err
				}
				cases = append(cases, swCase{v, body})
				continue
			}
			if p.isId("default") {
				p.next()
				if err := p.expectOp(":"); err != nil {
					return nil, err
				}
				defBody, err = p.caseBody()
				if err != nil {
					return nil, err
				}
				continue
			}
			return nil, fmt.Errorf("expected case/default in switch at token %v", p.peek())
		}
		p.next() // }
		// lower: if (x == c1) b1 else if (x == c2) b2 else default —
		// nested Ifs in the else arm (the frontend's else-if shape).
		elseB := defBody
		for i := len(cases) - 1; i >= 0; i-- {
			c := cases[i]
			cond := &expr{kind: "bin", op: "==", l: disc, r: &expr{kind: "num", num: c.val}}
			elseB = []any{map[string]any{"cond": testCall(testExpr(cond)), "then": c.body, "elsifs": []any{}, "else": elseB, "type": "If"}}
		}
		if len(cases) == 0 {
			return nil, nil
		}
		return elseB[0], nil
	case p.isId("do"):
		p.next()
		b, _, err := p.block()
		if err != nil {
			return nil, err
		}
		if !p.isId("while") {
			return nil, fmt.Errorf("expected while after do body")
		}
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		c, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		// do b while (c) → b; while (c) b — the A1 While is pre-test and
		// DoWhile has no ESTree lowering in the core, so the body
		// duplication is the faithful form (the body has no declarations
		// whose scope the duplication would break in the v1 subset)
		body := append([]any{}, b...)
		body = append(body, map[string]any{"cond": testCall(testExpr(c)), "body": append([]any{}, b...), "type": "While"})
		return map[string]any{"body": body, "type": "Block"}, nil
	case p.isId("struct"):
		return p.structDecl()
	case p.isId("printf"):
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		var args []any
		for {
			tk := p.peek()
			if tk != nil && tk.kind == "str" {
				args = append(args, st(tk.text))
				p.next()
			} else {
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				args = append(args, valueNode(e))
			}
			if p.isOp(")") {
				break
			}
			if err := p.expectOp(","); err != nil {
				return nil, err
			}
		}
		p.next() // )
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return execPrintf(args), nil
	case p.isId("int"):
		// handled above
		return nil, fmt.Errorf("unhandled int")
	default:
		// plain assignment `x = e;` / `x += e;`
		return p.simpleAssign()
	}
}

// simpleAssign — id ( = | += | -= ) expr ;  (or a bare `id;` skip)
// forHeaderAssign — like simpleAssign but does NOT consume the trailing
// ';' (the for header's separators are consumed by the for loop itself).
func (p *parser) forHeaderAssign() (any, error) {
	t := p.peek()
	if t == nil {
		return nil, nil
	}
	// a declaration in the for header: `for (int i = 1; ...)` — the type
	// keyword is consumed, the declaration lowers like a plain assignment
	if t.kind == "id" && (t.text == "int" || t.text == "char") {
		p.next()
		t = p.peek()
	}
	if t == nil || t.kind != "id" {
		return nil, nil
	}
	name := p.next().text
	if p.isOp("++") || p.isOp("--") {
		// i++ / i-- — postfix increment, lowered to i = i +/- 1
		op := p.next().text
		return p.buildAssign(name, "=", &expr{
			kind: "bin", op: op[:1],
			l: &expr{kind: "id", name: name},
			r: &expr{kind: "num", num: "1"},
		})
	}
	if p.isOp("=") || p.isOp("+=") || p.isOp("-=") {
		op := p.next().text
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		return p.buildAssign(name, op, e)
	}
	return nil, nil
}

func (p *parser) buildAssign(name, op string, e *expr) (any, error) {
	if op == "=" {
		return assignStmt(name, valueNode(e)), nil
	}
	arithOp := strings.TrimSuffix(op, "=")
	if hasFloat(e) {
		// A float operand in a compound assignment: the Arith AST is
		// integer-only (arithNode would Atoi("2.0") to 0 — silent
		// corruption). Route through the runtime float evaluator, the
		// same seam as the valueNode fallback.
		return assignStmt(name, call("fparith", []any{st("($" + name + " " + arithOp + " " + exprToArithString(e) + ")")})), nil
	}
	return assignStmt(name, map[string]any{"ast": map[string]any{
		"type": "Bin", "lhs": map[string]any{"type": "Var", "name": name},
		"op": arithOp, "rhs": arithNode(e)}, "type": "Arith"}), nil
}

func (p *parser) simpleAssign() (any, error) {
	if p.isOp("*") {
		// *p = v — a store through the handle
		p.next()
		target, err := p.expr()
		if err != nil {
			return nil, err
		}
		if !p.isOp("=") && !p.isOp("+=") && !p.isOp("-=") {
			return nil, fmt.Errorf("expected assignment after deref")
		}
		p.next()
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		// *p = v on a statically-aliased scalar — the alias folding: a direct
		// assignment to the aliased var
		if target != nil && target.kind == "id" {
			if t, ok := scalarAliases[target.name]; ok {
				return assignStmt(t, valueNode(e)), nil
			}
			// *p = v on a static pointer-into-array — reduce to the baked-name
			// array assign (the core's arr[1]=x shape; the runtime handles it)
			if t, ok := ptrTargets[target.name]; ok {
				return assignStmt(t.arr+"["+strconv.Itoa(t.base)+"]", valueNode(e)), nil
			}
			// *p = v on a heap pointer — the mem arena element store
			if hp, ok := heapPtrs[target.name]; ok {
				return map[string]any{
					"type": "Expr",
					"expr": call("memStore", []any{call("getVar", []any{st(hp.root)}), st(strconv.Itoa(hp.off)), st(hp.elem), valueNode(e)}),
				}, nil
			}
		}
		return map[string]any{
			"type": "Expr",
			"expr": call("memStore", []any{valueNode(target), valueNode(e)}),
		}, nil
	}
	name := p.next().text
	if p.isOp("++") || p.isOp("--") {
		// x++ / x-- — postfix increment (lowered to x = x +/- 1)
		op := p.next().text
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return p.buildAssign(name, "=", &expr{
			kind: "bin", op: op[:1],
			l: &expr{kind: "id", name: name},
			r: &expr{kind: "num", num: "1"},
		})
	}
	if p.isOp(".") {
		// p.x = v — a struct member write (flattened dotted scalar; the
		// store owns it — setVar, never a native-liftable Assign)
		p.next()
		mn := p.next()
		if mn == nil || mn.kind != "id" {
			return nil, fmt.Errorf("expected member name after '.'")
		}
		full := name + "." + mn.text
		if p.isOp("=") || p.isOp("+=") || p.isOp("-=") {
			op := p.next().text
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			if op == "=" {
				return storeAssignStmt(full, valueNode(e)), nil
			}
			// p.x += v — lower to the flat store write p.x = p.x + v
			arithOp := strings.TrimSuffix(op, "=")
			return storeAssignStmt(full, map[string]any{"ast": map[string]any{
				"type": "Bin", "lhs": map[string]any{"type": "Var", "name": full},
				"op": arithOp, "rhs": arithNode(e)}, "type": "Arith"}), nil
		}
	}
	if p.isOp("[") {
		// a[expr] = v — an indexed write
		p.next()
		idx, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp("]"); err != nil {
			return nil, err
		}
		if !p.isOp("=") && !p.isOp("+=") && !p.isOp("-=") {
			return nil, fmt.Errorf("expected assignment after index")
		}
		op := p.next().text
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		if op != "=" {
			refuse("compound assignment through an index is not in the v1 subset")
		}
		// a[i] = v on a heap pointer — the mem arena element store
		if hp, ok := heapPtrs[name]; ok {
			k, ok2 := foldIndex(idx)
			if !ok2 {
				refuse("heap index must be a compile-time constant in the v1 subset")
			}
			return map[string]any{
				"type": "Expr",
				"expr": call("memStore", []any{call("getVar", []any{st(hp.root)}), st(strconv.Itoa(hp.off + k)), st(hp.elem), valueNode(e)}),
			}, nil
		}
		// a[i] = v on a C array — the baked-name array write (the core's
		// arr[1]=x shape; the runtime handles it — same as the ptrTarget
		// reduction). A CONSTANT index bakes directly (`a[2]`); a runtime
		// index interpolates into the name (`a[${expr}]`) — the store's
		// baked-subscript parsing evaluates it.
		if arrayVars[name] {
			if k, ok2 := foldIndex(idx); ok2 {
				return assignStmt(name+"["+strconv.Itoa(k)+"]", valueNode(e)), nil
			}
			return map[string]any{
				"type": "Expr",
				"expr": call("setVar", []any{
					interpName(name, map[string]any{"type": "Arith", "ast": arithNode(idx)}),
					valueNode(e),
				}),
			}, nil
		}
		refuse("indexed assignment to " + name + " (not a heap pointer or array)")
	}
	if p.isOp("(") {
		// a call used as a statement: free(a) / sprintf(buf, ...) /
		// strcpy(dst, s) / va_start / va_end
		p.next()
		var args []*expr
		if !p.isOp(")") {
			for {
				a, err := p.expr()
				if err != nil {
					return nil, err
				}
				args = append(args, a)
				if p.isOp(")") {
					break
				}
				if err := p.expectOp(","); err != nil {
					return nil, err
				}
			}
		}
		p.next() // )
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		switch name {
		case "free":
			if len(args) == 1 && args[0].kind == "id" {
				if hp, ok := heapPtrs[args[0].name]; ok {
					return map[string]any{"type": "Expr", "expr": call("memFree", []any{call("getVar", []any{st(hp.root)})})}, nil
				}
			}
			return nil, nil
		case "sprintf":
			if len(args) >= 2 && args[0].kind == "id" {
				f, ok := printfFold(args[1], args[2:])
				if !ok {
					refuse("sprintf with non-constant format or args")
				}
				return storeAssignStmt(args[0].name, st(f)), nil
			}
			refuse("unsupported sprintf")
		case "strcpy":
			// strcpy(dst, src) — a string COPY: the transpiled world has
			// immutable strings, so this is dst = src (a char array used
			// as a buffer just becomes the string value).
			if len(args) == 2 && args[0].kind == "id" {
				return storeAssignStmt(args[0].name, valueNode(args[1])), nil
			}
			refuse("unsupported strcpy")
		case "strcat":
			// strcat(dst, src) — dst = dst + src (string concatenation)
			if len(args) == 2 && args[0].kind == "id" {
				return storeAssignStmt(args[0].name, concatExpr(
					call("getVar", []any{st(args[0].name)}), valueNode(args[1]))), nil
			}
			refuse("unsupported strcat")
		case "va_start", "va_end":
			return nil, nil // no stdout effect in the v1 subset
		}
		// any other call used as a statement: a USER function
		// (`my_qsort(...)`) or the comparator bridge (`cmp_call(...)`) —
		// emit the runtime dispatch (exec for user fns, capture for the
		// comparator).
		if _, isUser := userFuncs[name]; isUser || name == "cmp_call" {
			return map[string]any{"type": "Expr", "expr": callNode(&expr{kind: "call", name: name, args: args})}, nil
		}
		return nil, nil
	}
	if p.isOp("=") || p.isOp("+=") || p.isOp("-=") {
		op := p.next().text
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		if op == "=" && recordPtrTarget(name, e) {
			return nil, nil
		}
		if _, isPtr := ptrDecls[name]; isPtr {
			if op == "=" {
				// a heap pointer (or pointer-copy / ptr-arith) assignment
				if hp, isRoot, ok := heapAssignRHS(name, e, ptrDecls[name]); ok {
					heapPtrs[name] = hp
					if isRoot {
						return storeAssignStmt(name, valueNode(e)), nil
					}
					return nil, nil
				}
			} else {
				// p += k / p -= k — in-place heap pointer arithmetic
				if hp, ok := heapPtrs[name]; ok {
					if k, ok2 := foldIndex(e); ok2 {
						if op == "+=" {
							hp.off += k
						} else {
							hp.off -= k
						}
						heapPtrs[name] = hp
						return nil, nil
					}
				}
			}
			refuse("unsupported pointer assignment to " + name)
		}
		return p.buildAssign(name, op, e)
	}
	// bare id ; — skip
	for !p.isOp(";") && p.peek() != nil {
		p.next()
	}
	if p.isOp(";") {
		p.next()
	}
	return nil, nil
}

// declOne — emit one declared name of a `T name [= expr]` (or a member of
// a `,`-separated list). The pointer star is per-name in C: `char *x, *y;`
// (both pointers), `char *x, y;` (y a plain char). Registers the name in
// charPtrVars / ptrDecls and emits the initializer (if any).
func (p *parser) declOne(name *tok, kw string, isPtr bool) (any, error) {
	if p.isOp("=") {
		p.next()
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		// static pointer target (array / scalar alias / copy): compile-time
		// only — emit NOTHING
		if isPtr && recordPtrTarget(name.text, e) {
			return nil, nil
		}
		// heap pointer initializer (malloc / pointer copy / p = q + n)
		if isPtr && kw != "char" {
			if hp, isRoot, ok := heapAssignRHS(name.text, e, kw); ok {
				heapPtrs[name.text] = hp
				if isRoot {
					// p itself holds the memAlloc handle — the store
					// write (setVar: the mem seam reads the store)
					return storeAssignStmt(name.text, valueNode(e)), nil
				}
				return nil, nil // compile-time pair only
			}
			refuse("unsupported pointer initializer for " + name.text)
		}
		return assignStmt(name.text, valueNode(e)), nil
	}
	// bare declaration `int x;` / `char *s;` / `int *p;`
	if kw == "char" && isPtr {
		charPtrVars[name.text] = true
	}
	if isPtr && kw != "char" {
		ptrDecls[name.text] = kw
		// uninitialized heap-pointer candidate: seed the base pair so a
		// later `*p = v` / `p = q + n` resolves even if the first
		// assignment is not the declaration
		heapPtrs[name.text] = heapPtr{root: name.text, elem: kw, off: 0}
	}
	return nil, nil
}

func (p *parser) block() ([]any, []int, error) {
	if err := p.expectOp("{"); err != nil {
		return nil, nil, err
	}
	body, lines, err := p.stmts()
	if err != nil {
		return nil, nil, err
	}
	if err := p.expectOp("}"); err != nil {
		return nil, nil, err
	}
	return body, lines, nil
}

// stmtOrBlock — a statement body that may be a single statement
// (`if (c) x = 1;`) or a block (`if (c) { ... }`). C allows both.
// When the single statement is a label-then-statement sequence (a
// `[]any{Label, inner}` from stmt()), we wrap the whole thing in a
// fresh Block so the body-position holds a single IR node — the label
// stays at the same nesting level as it would in a `{ ... }` block.
func (p *parser) stmtOrBlock() ([]any, error) {
	if p.isOp("{") {
		b, _, err := p.block()
		return b, err
	}
	s, err := p.stmt()
	if err != nil {
		return nil, err
	}
	if s == nil {
		return []any{}, nil
	}
	if list, ok := s.([]any); ok {
		return []any{map[string]any{"type": "Block", "body": list}}, nil
	}
	return []any{s}, nil
}

// caseBody — the statements of one switch case (until the next
// case/default/}). TOP-LEVEL break statements are stripped: a switch
// break binds to the switch, which lowers to an if-chain — there is no
// loop to signal (a break inside a loop INSIDE the case stays — it is
// not at the case's top level).
func (p *parser) caseBody() ([]any, error) {
	var out []any
	for {
		t := p.peek()
		if t == nil {
			return nil, fmt.Errorf("unterminated switch case")
		}
		if t.kind == "id" && (t.text == "case" || t.text == "default") {
			break
		}
		if t.kind == "op" && t.text == "}" {
			break
		}
		if t.kind == "op" && t.text == "{" {
			inner, _, err := p.block()
			if err != nil {
				return nil, err
			}
			out = append(out, inner...)
			continue
		}
		s, err := p.stmt()
		if err != nil {
			return nil, err
		}
		if s == nil {
			continue
		}
		if m, ok := s.(map[string]any); ok && m["type"] == "Expr" {
			if e, ok := m["expr"].(map[string]any); ok && e["func"] == "break" {
				continue
			}
		}
		out = append(out, s)
	}
	return out, nil
}

// structDecl — `struct Tag { int x; int y; };` (a definition: the member
// table feeds sizeof and member flattening) or `struct Tag var;` (a
// variable of a declared struct type). Member accesses flatten to dotted
// scalar vars ("p.x") whose writes go through setVar (the store owns
// them — a dotted name must never reach the native-lift).
func (p *parser) structDecl() (any, error) {
	p.next() // struct
	tn := p.next()
	if tn == nil || tn.kind != "id" {
		return nil, fmt.Errorf("expected struct tag")
	}
	if !p.isOp("{") {
		// `struct Point p;` (a value — flattened dotted vars) or
		// `struct Node *p [= init];` (a POINTER — holds a heap handle /
		// the global head; `p->member` goes through the mem arena).
		if p.isOp("*") {
			p.next() // *
			vn := p.next()
			if vn == nil || vn.kind != "id" {
				return nil, fmt.Errorf("expected variable name after 'struct Tag *'")
			}
			structPtrVars[vn.text] = tn.text
			if p.isOp("=") {
				p.next()
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				// the handle lives in the store (the mem seam reads it there);
				// `= 0` is NULL -> the empty string (a live handle is any
				// non-empty string)
				if e.kind == "num" && (e.num == "0" || e.num == "0.0") {
					return storeAssignStmt(vn.text, st("")), nil
				}
				return storeAssignStmt(vn.text, valueNode(e)), nil
			}
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			// uninitialized pointer -> NULL
			return storeAssignStmt(vn.text, st("")), nil
		}
		vn := p.next()
		if vn == nil || vn.kind != "id" {
			return nil, fmt.Errorf("expected variable name after struct tag")
		}
		varStruct[vn.text] = tn.text
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return nil, nil
	}
	p.next() // {
	var members []structMember
	for !p.isOp("}") {
		if p.peek() == nil {
			return nil, fmt.Errorf("unterminated struct definition")
		}
		// member type: `char *word;` / `struct Node *next;` (a pointer
		// member is one word — the stored handle/string). The BASE type
		// is parsed once; a `*` binds to each NAME (`char *x, *y;` — both
		// pointers, but `char *x, y;` leaves y a plain char).
		var base string
		if p.isId("struct") {
			p.next() // struct
			sub := p.next()
			if sub == nil || sub.kind != "id" {
				return nil, fmt.Errorf("expected struct tag in member type")
			}
			base = "struct " + sub.text
		} else {
			mt := p.next()
			if mt == nil || mt.kind != "id" {
				return nil, fmt.Errorf("expected member type at token %v", mt)
			}
			base = mt.text
		}
		// comma-separated member names: `int a, b;` / `char *x, *y;`
		for {
			ctype := base
			for p.isOp("*") {
				p.next()
				ctype += "*"
			}
			mn := p.next()
			if mn == nil || mn.kind != "id" {
				return nil, fmt.Errorf("expected member name at token %v", mn)
			}
			members = append(members, structMember{mn.text, ctype})
			if !p.isOp(",") {
				break
			}
			p.next() // ,
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
	}
	p.next() // }
	if err := p.expectOp(";"); err != nil {
		return nil, err
	}
	structLayouts[tn.text] = members
	return nil, nil
}

// userBlock — `{ ... }` parsed into the user-function mini-AST (see
// uStmt). Only the statements the literal-arg fold understands are
// recorded; va_start/va_end/declarations become skips. The body is never
// emitted.
func (p *parser) userBlock() ([]*uStmt, error) {
	if err := p.expectOp("{"); err != nil {
		return nil, err
	}
	var out []*uStmt
	for {
		t := p.peek()
		if t == nil {
			return nil, fmt.Errorf("unterminated function body")
		}
		if t.kind == "op" && t.text == "}" {
			break
		}
		if t.kind == "op" && t.text == "{" {
			inner, err := p.userBlock()
			if err != nil {
				return nil, err
			}
			out = append(out, inner...)
			continue
		}
		s, err := p.userStmt()
		if err != nil {
			return nil, err
		}
		if s != nil {
			if s.kind == "seq" {
				// a comma-separated declaration list — flatten so the
				// mini-AST (and its fold interpreter) sees flat assigns
				out = append(out, s.body...)
			} else {
				out = append(out, s)
			}
		}
	}
	p.next() // }
	return out, nil
}

func (p *parser) userStmt() (*uStmt, error) {
	t := p.peek()
	if t == nil {
		return nil, nil
	}
	switch {
	case p.isId("return"):
		p.next()
		var e *expr
		if !p.isOp(";") {
			var err error
			e, err = p.expr()
			if err != nil {
				return nil, err
			}
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return &uStmt{kind: "ret", e: e}, nil
	case p.isId("int") || p.isId("char") || p.isId("double") || p.isId("float") || p.isId("va_list"):
		// a local declaration: `int s = 0;` / `va_list ap;` — and
		// comma-separated names: `int i, j, t;` (a "seq" of assigns)
		p.next()
		for p.isOp("*") {
			p.next()
		}
		var seq []*uStmt
		for {
			nm := p.next()
			if nm == nil || nm.kind != "id" {
				return nil, fmt.Errorf("expected identifier in declaration")
			}
			if p.isOp("=") {
				p.next()
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				seq = append(seq, &uStmt{kind: "assign", name: nm.text, op: "=", e: e})
			} else {
				// uninitialized local — emit `x = ""` so the store owns it
				// and later reads lower as store reads (a never-written
				// name would render as "" — the runtime-only writers like
				// getLine("b") are invisible to the static never-written
				// analysis).
				seq = append(seq, &uStmt{kind: "assign", name: nm.text, op: "=", e: &expr{kind: "str", num: ""}})
			}
			if !p.isOp(",") {
				break
			}
			p.next() // ,
			for p.isOp("*") {
				p.next()
			}
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		if len(seq) == 1 {
			return seq[0], nil
		}
		return &uStmt{kind: "seq", body: seq}, nil
	case p.isId("struct"):
		// `struct Node *n = malloc(sizeof(struct Node));` — a local
		// struct-POINTER declaration in a function body (records the
		// pointer's tag so `n->member` resolves; the value is the heap
		// handle).
		p.next() // struct
		tag := p.next()
		if tag == nil || tag.kind != "id" {
			return nil, fmt.Errorf("expected struct tag in declaration")
		}
		if !p.isOp("*") {
			// a struct VALUE local — not supported in function bodies
			for !p.isOp(";") && p.peek() != nil {
				p.next()
			}
			if p.isOp(";") {
				p.next()
			}
			return &uStmt{kind: "skip"}, nil
		}
		p.next() // *
		nm := p.next()
		if nm == nil || nm.kind != "id" {
			return nil, fmt.Errorf("expected pointer name in declaration")
		}
		structPtrVars[nm.text] = tag.text
		if p.isOp("=") {
			p.next()
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			return &uStmt{kind: "assign", name: nm.text, op: "=", e: e}, nil
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return &uStmt{kind: "skip"}, nil
	case p.isId("printf"):
		// printf(...) in a function body — the same execPrintf lowering
		// the main body uses, carried as a raw A1 stmt.
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		var args []any
		for {
			if tk := p.peek(); tk != nil && tk.kind == "str" {
				args = append(args, st(tk.text))
				p.next()
			} else {
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				args = append(args, valueNode(e))
			}
			if p.isOp(")") {
				break
			}
			if err := p.expectOp(","); err != nil {
				return nil, err
			}
		}
		p.next() // )
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return &uStmt{kind: "exec", a1: execPrintf(args)}, nil
	case p.isId("va_start") || p.isId("va_end"):
		p.next()
		for !p.isOp(";") && p.peek() != nil {
			p.next()
		}
		p.next()
		return &uStmt{kind: "skip"}, nil
	case p.isId("for"):
		// for (init; cond; step) body — a `while` with a pre-assign and
		// a step appended to the body's end (`i = 0; while (i < n) { …;
		// i = i + 1; }`). init/step are assignments in the v1 subset.
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		var init *uStmt
		if !p.isOp(";") {
			nm := p.next()
			if nm == nil || nm.kind != "id" {
				return nil, fmt.Errorf("expected assignment in for-initializer")
			}
			if !p.isOp("=") && !p.isOp("+=") && !p.isOp("-=") {
				return nil, fmt.Errorf("expected assignment in for-initializer")
			}
			op := p.next().text
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			init = &uStmt{kind: "assign", name: nm.text, op: op, e: e}
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		var cond *expr
		if !p.isOp(";") {
			var err error
			cond, err = p.expr()
			if err != nil {
				return nil, err
			}
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		var step *uStmt
		if !p.isOp(")") {
			nm := p.next()
			if nm == nil || nm.kind != "id" {
				return nil, fmt.Errorf("expected assignment in for-step")
			}
			if !p.isOp("=") && !p.isOp("+=") && !p.isOp("-=") {
				return nil, fmt.Errorf("expected assignment in for-step")
			}
			op := p.next().text
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			step = &uStmt{kind: "assign", name: nm.text, op: op, e: e}
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		var body []*uStmt
		if p.isOp("{") {
			var err error
			body, err = p.userBlock()
			if err != nil {
				return nil, err
			}
		} else {
			one, err := p.userStmt()
			if err != nil {
				return nil, err
			}
			body = []*uStmt{one}
		}
		return &uStmt{kind: "for", e: cond, body: body, init: init, step: step}, nil
	case p.isId("while"):
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		c, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		var body []*uStmt
		if p.isOp("{") {
			body, err = p.userBlock()
			if err != nil {
				return nil, err
			}
		} else {
			one, err := p.userStmt()
			if err != nil {
				return nil, err
			}
			body = []*uStmt{one}
		}
		return &uStmt{kind: "while", e: c, body: body}, nil
	case p.isId("if"):
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		c, err := p.expr()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp(")"); err != nil {
			return nil, err
		}
		var body []*uStmt
		if p.isOp("{") {
			body, err = p.userBlock()
			if err != nil {
				return nil, err
			}
		} else {
			one, err := p.userStmt()
			if err != nil {
				return nil, err
			}
			body = []*uStmt{one}
		}
		var elseBody []*uStmt
		if p.isId("else") {
			p.next()
			if p.isOp("{") {
				elseBody, err = p.userBlock()
				if err != nil {
					return nil, err
				}
			} else {
				one, err := p.userStmt()
				if err != nil {
					return nil, err
				}
				elseBody = []*uStmt{one}
			}
		}
		return &uStmt{kind: "if", e: c, body: body, elseBody: elseBody}, nil
	default:
		if t.kind == "id" {
			nm := p.next()
			if p.isOp("[") {
				// a[idx] = v — an array-element write in a function body
				p.next()
				idx, err := p.expr()
				if err != nil {
					return nil, err
				}
				if err := p.expectOp("]"); err != nil {
					return nil, err
				}
				if !p.isOp("=") && !p.isOp("+=") && !p.isOp("-=") {
					return nil, fmt.Errorf("expected assignment after index")
				}
				op := p.next().text
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				if op != "=" {
					refuse("compound assignment through an index is not in the v1 subset")
				}
				return &uStmt{kind: "idxassign", name: nm.text, idx: idx, e: e}, nil
			}
			if p.isOp("->") {
				// p->member = v — a struct-pointer member write in a
				// function body (memStore through the handle)
				p.next()
				mn := p.next()
				if mn == nil || mn.kind != "id" {
					return nil, fmt.Errorf("expected member name after '->'")
				}
				if !p.isOp("=") {
					return nil, fmt.Errorf("expected '=' after member access")
				}
				p.next()
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				return &uStmt{kind: "arrowstore", name: nm.text, member: mn.text, op: "=", e: e}, nil
			}
			if p.isOp("++") || p.isOp("--") {
				// p++ / p-- — postfix pointer advance (a no-op for
				// non-pointer vars; the emit only advances ptr params)
				op := p.next().text
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				return &uStmt{kind: "ptrinc", name: nm.text, op: op}, nil
			}
			if p.isOp("=") || p.isOp("+=") || p.isOp("-=") {
				op := p.next().text
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				return &uStmt{kind: "assign", name: nm.text, op: op, e: e}, nil
			}
		}
		if t.kind == "op" && t.text == "*" {
			// *p = expr — a deref STORE (also *p++ = expr / *p-- = expr:
			// the target's postfix advances the pointer after the store).
			p.next() // *
			target, err := p.expr()
			if err != nil {
				return nil, err
			}
			if (target.kind == "id" || target.kind == "postinc" || target.kind == "postdec") &&
				(p.isOp("=") || p.isOp("+=") || p.isOp("-=")) {
				op := p.next().text
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				return &uStmt{kind: "derefstore", name: target.name, op: op, e: e,
					ptrPost: target.kind == "postinc" || target.kind == "postdec"}, nil
			}
		}
		if t.kind == "id" && p.isOp("(") {
			// fn(args); — a function call used as a statement in a function
			// body (gen_line(line); sink();): the id was already consumed,
			// parse the argument list and build the call expr (its runtime
			// dispatch — exec for user fns / the comparator bridge).
			p.next() // (
			var args []*expr
			if !p.isOp(")") {
				for {
					a, err := p.expr()
					if err != nil {
						return nil, err
					}
					args = append(args, a)
					if p.isOp(")") {
						break
					}
					if err := p.expectOp(","); err != nil {
						return nil, err
					}
				}
			}
			p.next() // )
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			return &uStmt{kind: "call", e: &expr{kind: "call", name: t.text, args: args}}, nil
		}
		// any other expression statement — consume to ';' (uninterpreted)
		for !p.isOp(";") && p.peek() != nil {
			p.next()
		}
		if p.isOp(";") {
			p.next()
		}
		return &uStmt{kind: "skip"}, nil
	}
}

// printfFold — sprintf's format with literal args folded to its C text
// (the %d/%s/%c/%f family; widths/flags/precision are skipped). Used by
// the sprintf statement lowering.
func printfFold(f *expr, args []*expr) (string, bool) {
	if f == nil || f.kind != "str" {
		return "", false
	}
	fs := f.num
	out := ""
	ai := 0
	for i := 0; i < len(fs); i++ {
		c := fs[i]
		if c != '%' {
			out += string(c)
			continue
		}
		if i+1 >= len(fs) {
			return "", false
		}
		i++
		// flags / width / precision / length modifiers
		for i < len(fs) && strings.ContainsRune("-+ 0#.123456789lhz", rune(fs[i])) {
			i++
		}
		if i >= len(fs) {
			return "", false
		}
		spec := fs[i]
		if spec == '%' {
			out += "%"
			continue
		}
		if ai >= len(args) {
			return "", false
		}
		v, ok := foldConst(args[ai], nil)
		if !ok {
			return "", false
		}
		ai++
		switch spec {
		case 'd', 'i', 'u':
			if _, err := strconv.Atoi(strings.TrimSpace(v)); err != nil {
				return "", false
			}
			out += strings.TrimSpace(v)
		case 's', 'c', 'f', 'g', 'e', 'x', 'X', 'o':
			out += v
		default:
			return "", false
		}
	}
	return out, true
}

// applyStoreRouting — after the whole program is parsed (and the pointer
// folding is fully known), route the assignments of address-taken vars
// that were NOT folded (their storage is still reachable through the
// mem.* seam, which reads/writes the sh2 store — a native JS binding
// would be invisible to it) through setVar. Folded vars keep the native
// Assign stmt: the alias writes ARE the variable, so no store is needed.
func applyStoreRouting(stmts []any) []any {
	folded := map[string]bool{}
	for _, v := range scalarAliases {
		folded[v] = true
	}
	for _, t := range ptrTargets {
		folded[t.arr] = true
	}
	var walk func([]any) []any
	walk = func(ss []any) []any {
		if len(ss) == 0 {
			return []any{}
		}
		var out []any
		for _, sx := range ss {
			m, ok := sx.(map[string]any)
			if !ok {
				out = append(out, st)
				continue
			}
			if m["type"] == "Assign" {
				tgts, _ := m["targets"].([]any)
				if len(tgts) > 0 {
					t0, _ := tgts[0].(map[string]any)
					if v, _ := t0["var"].(string); v != "" && addrTaken[v] && !folded[v] {
						out = append(out, map[string]any{
							"type": "Expr",
							"expr": call("setVar", []any{st(v), m["expr"]}),
						})
						continue
					}
				}
			}
			// recurse into compound stmts (if/while/block bodies)
			for _, key := range []string{"then", "else", "body"} {
				if b, ok := m[key].([]any); ok {
					m[key] = walk(b)
				}
			}
			out = append(out, sx)
		}
		return out
	}
	return walk(stmts)
}

// ── Shir — c-sh-go as a library: C source -> A1 shIR JSON bytes (no
// trailing newline). Both the CLI (cmd/c-sh-go) and the combined busybox
// dispatch through this single entry point. Parser refusals panic (see
// refuse) and are recovered here as errors. ───────────────────────────
func Shir(src string) (out []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("REFUSE: %v", r)
		}
	}()
	// pre-scan: address-taken names (&x) keep their storage in the store
	addrTaken = map[string]bool{}
	for _, m := range regexp.MustCompile(`&([A-Za-z_][A-Za-z0-9_]*)`).FindAllStringSubmatch(src, -1) {
		addrTaken[m[1]] = true
	}
	// per-run state (the binary parses one file per invocation, but the
	// worker may exec it repeatedly in-process via wrappers)
	heapPtrs = map[string]heapPtr{}
	ptrDecls = map[string]string{}
	funcPtrs = map[string]string{}
	fnPtrParamNames = map[string]bool{}
	structLayouts = map[string][]structMember{}
	varStruct = map[string]string{}
	macros = map[string]macro{}
	preprocessDefines(src)
	ts, err := lex(src)
	if err != nil {
		return nil, fmt.Errorf("REFUSE: %w", err)
	}
	ts = expandMacros(ts)
	pr := &parser{ts: ts}
	stmts, topLines, err := pr.stmts()
	if err != nil {
		return nil, fmt.Errorf("REFUSE: %w", err)
	}
	stmts = applyStoreRouting(stmts)
	// The user function definitions — the runtime-callable subset (the
	// varargs idiom stays literal-fold-only in v1). Prepended so the
	// definitions precede every call site; the estree/perl backends turn
	// them into sh2.define / `sub` declarations.
	userDefs := []any{}
	for name, fn := range userFuncs {
		if fn.varargs {
			continue
		}
		userDefs = append(userDefs, buildUserFnA1(name, fn))
	}
	sort.Slice(userDefs, func(i, j int) bool {
		return userDefs[i].(map[string]any)["name"].(string) < userDefs[j].(map[string]any)["name"].(string)
	})
	// stmt_lines — the A1 contract [{stmt, line}]: the userDefs (sorted,
	// prepended) come first, then the main statements in emission order.
	// The GUI's source↔generated line map walks the estree in this order.
	stmtLines := make([]any, 0, len(userDefs)+len(stmts))
	for i, u := range userDefs {
		if nm, ok := u.(map[string]any)["name"].(string); ok {
			if l, ok := pr.userFuncLines[nm]; ok {
				stmtLines = append(stmtLines, map[string]any{"stmt": i, "line": l})
			}
		}
	}
	for j, l := range topLines {
		stmtLines = append(stmtLines, map[string]any{"stmt": len(userDefs) + j, "line": l})
	}
	stmts = append(userDefs, stmts...)
	prog := map[string]any{
		"type":             "Program",
		"contract_version": 1,
		"imports":          []any{},
		"requires":         []any{},
		"stmt_lines":       stmtLines,
		"stmts":            stmts,
		"subs":             []any{},
		"var_const":        []any{},
		"var_lengths":      []any{},
		"var_lifetimes":    []any{},
		"var_types":        []any{},
	}
	return json.Marshal(prog)
}
