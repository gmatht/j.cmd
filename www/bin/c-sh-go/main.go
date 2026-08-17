package clib

// c-sh-go: C source -> A1 shIR JSON (the shell-flavored subset of C).
// v1 subset: printf, int assignments (+=/-=), binary arith, comparisons,
// if/else, while, for (lowered to the equivalent while — the A1 For node
// is for value-list iteration), function signatures (skipped; main's body
// becomes the program), user functions (a single pure `return <expr>;`
// body — a call with LITERAL args constant-folds through it; the body is
// never emitted), return (skipped), strcmp/strlen/atoi (literal-arg
// folding, see foldCallConst), comments, #include (skipped).
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

// isBreakStmt — a break statement (the first-class `{"type":"Break"}`
// node OR the legacy `Expr(Call(func:"break"))` form the switch lowering
// used to emit). Both render to the same runtime signal.
func isBreakStmt(m map[string]any) bool {
	if m["type"] == "Break" {
		return true
	}
	if m["type"] == "Expr" {
		if e, ok := m["expr"].(map[string]any); ok && e["func"] == "break" {
			return true
		}
	}
	return false
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
	dyn  bool   // position is RUNTIME (the pointer was advanced / re-targeted):
	// the position lives in the hv handle var's embedded offset, never in
	// the compile-time off (slice 2 dynamic pointer arithmetic — mem-slice2)
	hv string // dedicated handle var when dyn (the pointer's own position
	// handle; the root var always holds the base `:0` allocation handle)
}

var heapPtrs = map[string]heapPtr{}

// ptrDecls — every `int *p` / `char *p` declaration: name -> element
// type. char* is excluded (the pointer-to-string lowering owns it) and
// array/scalar-aliased pointers are promoted out via recordPtrTarget.
var ptrDecls = map[string]string{}

// funcPtrs — function-pointer variables: `int (*f)(int) = twice;` — the
// variable is compile-time; a call f(args) folds through the target
// user function.
var funcPtrs = map[string]string{}

// structLayouts — `struct Point { int x; int y; };` member tables. The
// frontend flattens member accesses to dotted scalar vars ("p.x"); the
// layout is only needed for sizeof.
type structMember struct{ name, ctype string }

var structLayouts = map[string][]structMember{}

// structRegs — the layout-registry registrations collected during the
// parse: each `struct Tag { … }` emits one registerStruct A1 call
// (`sh2.registerStruct("Tag-<fnv1a-hex>", [[name, offset, type], …])`).
// The runtime keeps the tag → layout table; `malloc(sizeof(struct Tag))`
// tags its box so nodeChild/nodeData can introspect it.
var structRegs []any

// structTag — the plan's "Tag-<fnv1a-hex>" key: a stable hash of the
// struct name (the runtime registry is keyed by this).
func structTag(name string) string {
	h := uint32(2166136261)
	for i := 0; i < len(name); i++ {
		h ^= uint32(name[i])
		h *= 16777619
	}
	return fmt.Sprintf("Tag-%08x", h)
}

// structPtrVars — `struct Node *p;` declarations (params, locals, globals):
// name -> tag. A struct-pointer member access `p->x` resolves the member's
// byte offset from structLayouts[tag] at compile time (see valueNode "arrow").
var structPtrVars = map[string]string{}

// fnPtrParamNames — FUNCTION-pointer parameters (`int (*cmp)(const void *, const void *)`):
// the param receives a comparator's NAME; calls through it lower to the comparator bridge.
var fnPtrParamNames = map[string]bool{}

// varStruct — `struct Point p;` — a var's declared struct type (for
// sizeof(p) and member resolution).
var varStruct = map[string]string{}

// macros — the #define table (object-like: no params; function-like:
// params + body token list). Expanded token-wise after lexing.
type macro struct {
	params []string
	body   []tok
}

var macros = map[string]macro{}

// cTypeSize — the ABI size of a single-word C type name (LP64, matching
// the runtime memElemSize table). Used for sizeof and malloc element
// counts.
func cTypeSize(t string) (int, bool) {
	switch t {
	case "char", "unsigned char", "signed char":
		return 1, true
	case "short", "unsigned short", "signed short", "short int", "unsigned short int", "signed short int":
		return 2, true
	case "int", "float", "unsigned", "unsigned int", "signed", "signed int":
		return 4, true
	case "long", "long int", "double", "size_t", "long long", "long long int",
		"unsigned long", "unsigned long int", "unsigned long long", "unsigned long long int",
		"signed long", "signed long int", "signed long long", "signed long long int":
		return 8, true
	}
	// `struct Tag*` / `void*` / `char*` — a pointer member is one word
	// (8 bytes in the runtime arena; the arena is byte-indexed and the
	// frontend reads pointer members with elem "char" at the byte offset)
	if strings.HasSuffix(t, "*") {
		return 8, true
	}
	return 0, false
}

// isTypeKw — true for any C type keyword (including modifiers that
// combine into compound types like "unsigned long long").
func isTypeKw(text string) bool {
	switch text {
	case "int", "char", "double", "float", "void",
		"long", "short", "unsigned", "signed",
		"va_list", "size_t":
		return true
	}
	return false
}

// isTypeContinuation — true when `next` can follow `first` in a
// compound C type (e.g. "unsigned" + "long", "long" + "long").
func isTypeContinuation(first, next string) bool {
	switch first {
	case "unsigned", "signed":
		return next == "int" || next == "long" || next == "short" || next == "char"
	case "long", "unsigned long", "signed long":
		return next == "long" || next == "int"
	case "short", "unsigned short", "signed short":
		return next == "int"
	}
	return false
}

// consumeTypeKeywords — after the first type keyword has been consumed,
// greedily consume additional keywords to build a compound type name
// like "unsigned long long" or "long long".
func (p *parser) consumeTypeKeywords(first string) string {
	kw := first
	for {
		t := p.peek()
		if t == nil || t.kind != "id" || !isTypeContinuation(kw, t.text) {
			break
		}
		p.next()
		kw = kw + " " + t.text
	}
	return kw
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

// memberOffset — the byte offset of a struct member (sum of preceding
// cTypeSizes); the `p->x` lowering reads the mem arena at this offset.
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

// heapRefs — does the expression reference a heap-pointer variable?
func heapRefs(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "id":
		_, ok := heapPtrs[e.name]
		return ok
	case "bin":
		return heapRefs(e.l) || heapRefs(e.r)
	case "deref", "addr", "index":
		return heapRefs(e.l) || heapRefs(e.r)
	case "call":
		for _, a := range e.args {
			if heapRefs(a) {
				return true
			}
		}
	}
	return false
}

// heapExprHasDyn — does the pointer expression reference any
// runtime-position pointer (a dyn heapPtr)? A static pair fold is only
// sound when every referenced pointer is compile-time.
func heapExprHasDyn(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "id":
		if hp, ok := heapPtrs[e.name]; ok && hp.dyn {
			return true
		}
	case "bin":
		return heapExprHasDyn(e.l) || heapExprHasDyn(e.r)
	case "call":
		for _, a := range e.args {
			if heapExprHasDyn(a) {
				return true
			}
		}
	}
	return false
}

// heapPos — resolve an expression to a heap POINTER POSITION (an A1
// expr evaluating to the position HANDLE) + ok. An id of a heapPtr:
// static -> memAdvance(base, off) (the base handle stays :0 — the
// ORIGINAL position, C's pointer-copy semantics); dyn -> the dedicated
// handle var. bin +/- of a position with a constant advances it.
func heapPos(e *expr) (any, bool) {
	if e == nil {
		return nil, false
	}
	switch e.kind {
	case "id":
		if hp, ok := heapPtrs[e.name]; ok {
			if hp.dyn {
				return call("getVar", []any{st(hp.hv)}), true
			}
			return call("memAdvance", []any{call("getVar", []any{st(hp.root)}), st(strconv.Itoa(hp.off))}), true
		}
		return nil, false
	case "bin":
		if e.op == "+" || e.op == "-" {
			if l, ok := heapPos(e.l); ok {
				if k, ok2 := foldIndex(e.r); ok2 {
					if e.op == "-" {
						k = -k
					}
					return call("memAdvance", []any{l, st(strconv.Itoa(k))}), true
				}
			}
			if r, ok := heapPos(e.r); ok {
				if k, ok2 := foldIndex(e.l); ok2 && e.op == "+" {
					return call("memAdvance", []any{r, st(strconv.Itoa(k))}), true
				}
			}
		}
	}
	return nil, false
}

// heapCompareCall — a comparison whose operands are heap-pointer
// positions: lower to the runtime memTest (the test-string grammar
// cannot compare handles). One-sided (pointer vs non-pointer) refuses.
func heapCompareCall(e *expr) (map[string]any, bool) {
	if e == nil || e.kind != "bin" {
		return nil, false
	}
	switch e.op {
	case "==", "!=", "<", ">", "<=", ">=":
	default:
		return nil, false
	}
	lh, rh := heapRefs(e.l), heapRefs(e.r)
	if lh != rh {
		if lh || rh {
			refuse("pointer vs non-pointer comparison is not in the subset")
		}
		return nil, false
	}
	if !lh {
		return nil, false
	}
	l, ok1 := heapPos(e.l)
	r, ok2 := heapPos(e.r)
	if !ok1 || !ok2 {
		return nil, false
	}
	return call("memTest", []any{st(e.op), l, r}), true
}

// markPtrDyn — transition a heapPtr to the runtime-position model: give
// it a dedicated handle var (the position lives in the handle's embedded
// offset from now on). Returns the updated pair.
func (p *parser) markPtrDyn(name string, hp heapPtr) heapPtr {
	if !hp.dyn {
		hp.dyn = true
		hp.hv = "___hp_" + name
		heapPtrs[name] = hp
	}
	return heapPtrs[name]
}

// ptrAssignStmt — `p = <position>`: (re-)target the pointer at runtime;
// the position (a handle expr) lands in the pointer's handle var.
func (p *parser) ptrAssignStmt(name string, hp heapPtr, pos any) map[string]any {
	hp = p.markPtrDyn(name, hp)
	return storeAssignStmt(hp.hv, pos)
}

// ptrAdvanceStmt — `p++` / `p--` / `p += n` / `p -= n`: advance the
// runtime position by a delta (element count, type-scaled at load/store).
// The FIRST advance snapshots the current position into the new handle
// var first (the base handle stays :0 — never mutated).
func (p *parser) ptrAdvanceStmt(name string, hp heapPtr, delta string) map[string]any {
	wasDyn := hp.dyn
	hp = p.markPtrDyn(name, hp)
	adv := storeAssignStmt(hp.hv, call("memAdvance", []any{call("getVar", []any{st(hp.hv)}), st(delta)}))
	if !wasDyn {
		init := storeAssignStmt(hp.hv, call("memAdvance", []any{call("getVar", []any{st(hp.root)}), st(strconv.Itoa(hp.off))}))
		return map[string]any{"body": []any{init, adv}, "type": "Block"}
	}
	return adv
}

// ptrNeedsDyn — pre-scan the REMAINING tokens for uses of `name` that
// force the runtime-position model (slice 2): pointer comparisons
// (`p < end`, `end > p`) or self-advance (`p = p + n`, `p++`, `p += n`).
// The frontend emits the while-header cond BEFORE the body's advance, so
// a pointer that will advance in a loop must carry its position in a
// runtime handle var from its DECLARATION (the compile-time off could
// never advance per-iteration — the cond would bake the initial offset
// and the loop would spin). `*p` / `&p` / `p[i]` (deref/addr/index) are
// VALUE uses — not pointer-position uses.
func ptrNeedsDyn(name string, rest []tok) bool {
	for i := 0; i < len(rest); i++ {
		t := rest[i]
		if t.kind != "id" || t.text != name {
			continue
		}
		if i > 0 {
			prev := rest[i-1].text
			if prev == "*" || prev == "&" || prev == "." || prev == "[" {
				continue
			}
			// op-then-name: `end > p` / `q == p` — the comparison PRECEDES
			if prev == "<" || prev == ">" || prev == "<=" || prev == ">=" || prev == "==" || prev == "!=" {
				return true
			}
		}
		if i+1 < len(rest) {
			next := rest[i+1].text
			switch next {
			case "<", ">", "<=", ">=", "==", "!=", "++", "--", "+=", "-=":
				return true
			case "=":
				// p = p (self-reassign) — the position must advance at
				// runtime (the compile-time off cannot change per loop)
				if i+2 < len(rest) && rest[i+2].kind == "id" && rest[i+2].text == name {
					return true
				}
			}
		}
	}
	return false
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

// charVars — `char c;` declarations (non-pointer): the variable's value
// is a 1-CHAR STRING in the store (there is no int type). Comparisons of
// char vars / char literals must therefore use the STRING test operators
// (`=` / `!=`), not the numeric `-eq`/`-ne` (which would coerce both
// sides to 0). See testOperand.
var charVars = map[string]bool{}

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
	case "sizeof":
		// sizeof(T) / sizeof(p) — fold to the ABI byte size (the runtime
		// arena is byte-indexed). sizeof(struct Tag) arrives as the marker
		// id "struct <Tag>".
		if len(e.args) == 1 {
			a := e.args[0]
			if a.kind == "id" {
				if sz, ok := cTypeSize(a.name); ok {
					return st(strconv.Itoa(sz))
				}
				if strings.HasPrefix(a.name, "struct ") {
					if sz, ok := structSize(strings.TrimPrefix(a.name, "struct ")); ok {
						return st(strconv.Itoa(sz))
					}
				}
				if tag, ok := varStruct[a.name]; ok {
					if sz, ok := structSize(tag); ok {
						return st(strconv.Itoa(sz))
					}
				}
			}
		}
		refuse("sizeof needs a type name or struct variable")
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
		// as addrTaken so the native-lift never promotes it (a lifted
		// native binding would desync from getLine's store write).
		addrTaken[ptr.l.name] = true
		return call("getLine", []any{st(ptr.l.name)})
	case "malloc":
		if len(e.args) != 1 {
			refuse("unsupported function call " + e.name)
		}
		s, ok := foldConst(e.args[0], nil)
		if !ok {
			refuse("malloc size must be a compile-time constant in the v1 subset")
		}
		// `malloc(sizeof(struct Tag))` — tag the box with the layout
		// key (the runtime's nodeChild/nodeData introspection seam).
		tag := ""
		if e.args[0].kind == "call" && e.args[0].name == "sizeof" && len(e.args[0].args) == 1 &&
			e.args[0].args[0].kind == "id" {
			if tn := strings.TrimPrefix(e.args[0].args[0].name, "struct "); structLayouts[tn] != nil {
				tag = structTag(tn)
			}
		}
		if tag != "" {
			return call("memAlloc", []any{st(s), st(tag)})
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
	// the layout-registry introspection bridge: `nodeChild(p, k)` /
	// `nodeData(p, k)` read a tagged allocation's k-th member (offset +
	// element size from the registered layout); `ptrTag(p)` returns the
	// box's "Tag-<hash>" key. The generic-walk seam — a walker that
	// works over ANY tagged structure without knowing its layout.
	if (e.name == "nodeChild" || e.name == "nodeData") && len(e.args) == 2 {
		return call(e.name, []any{valueNode(e.args[0]), valueNode(e.args[1])})
	}
	if e.name == "ptrTag" && len(e.args) == 1 {
		return call("ptrTag", []any{valueNode(e.args[0])})
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
			args = append(args, valueNode(a))
		}
		// fnValue — the VALUE-returning dispatch (a C function call in a
		// value position carries its return value back; sh2.fnCall is the
		// shell STATUS channel and would silently drop it — see the
		// runtime fnValue). The perl backend renders the same A1 as a
		// direct sub call (ir.rs); the estree backend as sh2.fnValue.
		return call("fnValue", []any{st(e.name), map[string]any{"type": "Array", "elements": args}})
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
		for i, pn := range params {
			if pn == e.name {
				return call("getVar", []any{st(strconv.Itoa(i + 1))})
			}
		}
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

// structPtrCond — `p != 0` / `p == 0` / bare `p` on a struct-pointer
// variable → the STRING-nonempty test (`-n $p` / `-z $p`): a live heap
// handle is a non-empty string, and Number(handle) would coerce to 0.
func structPtrCond(e *expr) (any, bool) {
	ptr := func(x *expr) (string, bool) {
		if x != nil && x.kind == "id" {
			if _, ok := structPtrVars[x.name]; ok {
				return x.name, true
			}
			// a plain pointer param (void* / int* / …): a NULL check on
			// one must also be the string-nonempty test — the boxed
			// pointer is an object, and Number(box) is NaN → 0, which
			// would call every live pointer NULL.
			if _, ok := ptrDecls[x.name]; ok {
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
		if l, ok := ptr(e.r); ok && zero(e.l) {
			return testCall(flag + " $" + l), true
		}
	}
	return nil, false
}

// condA1 — a user-body condition → A1: struct-pointer NULL checks lower
// to the string test; everything else to the Arith form. Runtime reads
// (array elements, derefs) are hoisted into a temp store var first
// (`___tN = <read>`), because the A1 Arith grammar has no Call node.
func condA1(e *expr, params []string, out *[]any) any {
	if c, ok := structPtrCond(e); ok {
		return c
	}
	return map[string]any{"type": "Arith", "ast": condArith(e, params, out)}
}

// condArith — the Arith AST for a condition, hoisting runtime reads.
func condArith(e *expr, params []string, out *[]any) any {
	if e == nil {
		return map[string]any{"type": "Num", "value": 1}
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
			"lhs": condArith(e.l, params, out),
			"rhs": condArith(e.r, params, out),
		}
	}
	// a runtime value (array element / deref / call) — hoist into a temp
	userTempSeq++
	tmp := "___t" + strconv.Itoa(userTempSeq)
	*out = append(*out, map[string]any{
		"type":    "Assign",
		"targets": []any{map[string]any{"var": tmp, "indices": []any{}, "sigil": nil}},
		"expr":    userExprA1(e, params),
	})
	return map[string]any{"type": "Var", "name": tmp}
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
	if e == nil {
		return map[string]any{"type": "Num", "value": 0}
	}
	if e.kind == "bin" {
		// recurse into the operands — only the runtime-READ subtrees
		// become temps (`*x = *x + 1`: the deref is temped, the arith
		// stays structural)
		return map[string]any{"type": "Bin", "op": e.op,
			"lhs": arithOperand(e.l, params, out),
			"rhs": arithOperand(e.r, params, out)}
	}
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
			if s.op != "=" {
				// `total += *s` — a compound assign: load, add, store.
				// The A1 Arith grammar has no Call node, so a runtime
				// read on the rhs is lowered into a temp var first.
				arithOp := strings.TrimSuffix(s.op, "=")
				expr = map[string]any{
					"type": "Arith",
					"ast": map[string]any{
						"type": "Bin",
						"op":   arithOp,
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
			}
		case "derefstore":
			elem, isPtr := ptrs[s.name]
			if !isPtr {
				continue
			}
			// the pointer PARAM's handle is the positional it was passed as
			// ($N — the out-param transform classifies memStore targets by
			// the positional; the leading `Assign name = getVar(N)` binding
			// is identity, so the positional IS the handle either way)
			pos := "1"
			for i, pn := range params {
				if pn == s.name {
					pos = strconv.Itoa(i + 1)
					break
				}
			}
			// `*p = v` — memStore through the handle (writes the shell
			// var / array element the pointer points at)
			var rhs any
			if s.op == "=" && exprNeedsTemp(s.e) {
				// a plain `*p = <rhs>` whose RHS READS memory
				// (`*p = *p + 1` — the read+write out-param idiom): the read
				// goes through a temp (the A1 Arith AST has no Call node —
				// the memLoad is a runtime call), so the store value is an
				// Arith over the temp
				rhs = map[string]any{"type": "Arith", "ast": arithOperand(s.e, params, &out)}
			} else {
				rhs = userExprA1(s.e, params)
			}
			if s.op != "=" {
				// `*p += v` — load the element into a temp, add, store
				// (the A1 Arith grammar has no Call node)
				arithOp := strings.TrimSuffix(s.op, "=")
				userTempSeq++
				tmp := "___t" + strconv.Itoa(userTempSeq)
				out = append(out, map[string]any{
					"type":    "Assign",
					"targets": []any{map[string]any{"var": tmp, "indices": []any{}, "sigil": nil}},
					"expr":    call("memLoad", []any{call("getVar", []any{st(pos)}), st("0"), st(elem)}),
				})
				rhs = map[string]any{
					"type": "Arith",
					"ast": map[string]any{
						"type": "Bin",
						"op":   arithOp,
						"lhs":  map[string]any{"type": "Var", "name": tmp},
						"rhs":  arithOperand(s.e, params, &out),
					},
				}
			}
			out = append(out, map[string]any{
				"type": "Expr",
				"expr": call("memStore", []any{
					call("getVar", []any{st(pos)}),
					st("0"), st(elem), rhs,
				}),
			})
			if s.ptrPost {
				// `*p++ = v` — advance the pointer after the store
				out = append(out, memAdvanceCall(s.name, 1))
			}
		case "if":
			out = append(out, map[string]any{
				"type":   "If",
				"cond":   condA1(s.e, params, &out),
				"then":   userStmtsA1(s.body, params, ptrs),
				"elsifs": []any{},
				"else":   userStmtsA1(s.elseBody, params, ptrs),
			})
		case "while":
			out = append(out, map[string]any{
				"type": "While",
				"cond": condA1(s.e, params, &out),
				"body": userStmtsA1(s.body, params, ptrs),
			})
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
				"cond": condA1(s.e, params, &out),
				"body": userStmtsA1(body, params, ptrs),
			})
		case "idxassign":
			// a[idx] = v — a baked-subscript store write: the index
			// interpolates into the name string `a[<expr>]`; the runtime
			// store substitutes ${var} references inside it and writes
			// the element.
			idx := userExprA1(s.idx, params)
			var name any
			if _, isPtrParam := ptrs[s.name]; isPtrParam {
				// base[idx] = v on an ARRAY-NAME pointer param: the name is
				// the param's RUNTIME value (the array's variable name) —
				// `setVar(`${base}[${idx}]`, v)`.
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
				name = map[string]any{
					"type": "Interpolate",
					"parts": []any{
						map[string]any{"kind": "lit", "text": s.name + "["},
						map[string]any{"kind": "expr", "expr": idx},
						map[string]any{"kind": "lit", "text": "]"},
					},
				}
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
		}
	}
	return out
}

// buildUserFnA1 — a user function definition → the A1 `Function` stmt
// (the same shape the shell frontends emit; the estree lowers it to
// sh2.define, the perl backend to a `sub`). The params bind the
// positional args first ($1..$N — the fnCall/callDirect dispatch sets
// scriptArgs), then the body runs; `return e` carries the value out.
// fnPtrParams — the CURRENT user function's pointer params (set while its
// body emits): `base[j]` on a `void *base` param reads the runtime store
// by the array NAME the param holds.
var fnPtrParams = map[string]string{}

func buildUserFnA1(name string, fn *userFunc) map[string]any {
	body := []any{}
	for i, pn := range fn.params {
		body = append(body, map[string]any{
			"type":    "Assign",
			"targets": []any{map[string]any{"var": pn, "indices": []any{}, "sigil": nil}},
			"expr":    call("getVar", []any{st(strconv.Itoa(i + 1))}),
		})
	}
	prevPtr := fnPtrParams
	fnPtrParams = fn.ptrParams
	body = append(body, userStmtsA1(fn.body, fn.params, fn.ptrParams)...)
	fnPtrParams = prevPtr
	return map[string]any{"type": "Function", "name": name, "body": body}
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
	kind     string   // assign | while | if | ret | skip | exec | derefstore | ptrinc | seq | for | idxassign | arrowstore
	name     string   // assign target / deref pointer / ptrinc var / idxassign array / arrow pointer var
	member   string   // arrowstore: the struct member name
	op       string   // "=" | "+=" | "-="  (ptrinc: "++" | "--")
	e        *expr    // assign rhs / while cond / return expr / deref rhs / for cond / idxassign value / arrowstore value
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
	case "cond":
		// cond ? a : b — fold the condition (C numeric truth) then the
		// taken branch (literal-arg folding for switch-case values and
		// user-function bodies)
		c, ok := foldConst(e.l, env)
		if !ok {
			return "", false
		}
		n, err := strconv.ParseInt(c, 10, 64)
		if err != nil {
			return "", false
		}
		if n != 0 {
			return foldConst(e.r, env)
		}
		if len(e.args) == 1 {
			return foldConst(e.args[0], env)
		}
		return "", false
	case "preinc", "predec":
		// ++i / --i — the expression's VALUE is the NEW value (prefix)
		v, ok := env[e.name]
		if !ok {
			return "", false
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return "", false
		}
		if e.kind == "preinc" {
			n++
		} else {
			n--
		}
		env[e.name] = strconv.FormatInt(n, 10)
		return env[e.name], true
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
				// sizeof(struct Tag) — the marker id "struct <Tag>"
				if strings.HasPrefix(a.name, "struct ") {
					if sz, ok := structSize(strings.TrimPrefix(a.name, "struct ")); ok {
						return strconv.Itoa(sz), true
					}
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
type tok struct{ kind, text string } // id num str op ; { } ( ) , + += - -= * / % ! == != < > <= >= && ||

func lex(src string) ([]tok, error) {
	var out []tok
	i, n := 0, len(src)
	for i < n {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '/' && i+1 < n && src[i+1] == '/':
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && src[i+1] == '*':
			i += 2
			for i+1 < n && !(src[i] == '*' && src[i+1] == '/') {
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
			out = append(out, tok{"str", sb.String()})
			i = j + 1
		case c == '\'':
			// char literal `'a'` — decoded like a string but tokenized as
			// "chr" so primary() can refuse multi-char literals (a C char
			// literal is an int; the v2 subset models the 1-char string
			// form — comparisons and %c — only)
			j := i + 1
			var sb strings.Builder
			for j < n && src[j] != '\'' {
				if src[j] == '\\' && j+1 < n {
					switch src[j+1] {
					case 'n':
						sb.WriteByte('\n')
					case 't':
						sb.WriteByte('\t')
					case '\\':
						sb.WriteByte('\\')
					case '\'':
						sb.WriteByte('\'')
					default:
						sb.WriteByte(src[j+1])
					}
					j += 2
					continue
				}
				sb.WriteByte(src[j])
				j++
			}
			out = append(out, tok{"chr", sb.String()})
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
			// C integer suffixes: u/U, l/L, ll/LL, and combinations
			for j < n && (src[j] == 'u' || src[j] == 'U' || src[j] == 'l' || src[j] == 'L') {
				j++
			}
			out = append(out, tok{"num", src[i:j]})
			i = j
		case isIdent(c):
			j := i
			for j < n && (isIdent(src[j]) || (src[j] >= '0' && src[j] <= '9')) {
				j++
			}
			out = append(out, tok{"id", src[i:j]})
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
				out = append(out, tok{"op", "..."})
				i += 3
				continue
			}
			switch three {
			case "<<=", ">>=":
				out = append(out, tok{"op", three})
				i += 3
				continue
			}
			switch two {
			case "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "++", "--", "->",
				"<<", ">>", "*=", "/=", "%=", "&=", "|=", "^=":
				out = append(out, tok{"op", two})
				i += 2
				continue
			}
			// `.` — member access (`p.x`) and float literals (`1.5` — the
			// float itself needs the core Float type; the tokens parse-fail
			// later and REFUSE, which is the honest gate for t23 until the
			// estree worker lands IrType::Float). `:` — switch case labels
			// (and goto labels — those refuse in the parser). `?` — the
			// ternary operator; `~` `|` `^` — the bitwise ops (v2).
			if strings.ContainsRune("=+-*/%!<>&|^~?;{}()[],.:", rune(c)) {
				out = append(out, tok{"op", string(c)})
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
func (p *parser) nextIf(s string) bool {
	if p.isOp(s) {
		p.next()
		return true
	}
	return false
}

func (p *parser) isOp(s string) bool { t := p.peek(); return t != nil && t.kind == "op" && t.text == s }
func (p *parser) isId(s string) bool { t := p.peek(); return t != nil && t.kind == "id" && t.text == s }
func (p *parser) expectOp(s string) error {
	if !p.isOp(s) {
		return fmt.Errorf("expected %q at token %v", s, p.peek())
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

func (p *parser) expr() (*expr, error) { return p.ternaryExpr() }

// ternaryExpr — `cond ? a : b` (v2). The loosest operator in an
// expression; the lowering is the runtime `ternary` call (see
// valueNode / foldConst — the cond is the test-string grammar).
func (p *parser) ternaryExpr() (*expr, error) {
	cond, err := p.orExpr()
	if err != nil {
		return nil, err
	}
	if !p.isOp("?") {
		return cond, nil
	}
	p.next()
	a, err := p.expr()
	if err != nil {
		return nil, err
	}
	if err := p.expectOp(":"); err != nil {
		return nil, err
	}
	b, err := p.expr()
	if err != nil {
		return nil, err
	}
	return &expr{kind: "cond", l: cond, r: a, args: []*expr{b}}, nil
}
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
	l, err := p.bitorExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("&&") {
		p.next()
		r, err := p.bitorExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: "&&", l: l, r: r}
	}
	return l, nil
}
func (p *parser) bitorExpr() (*expr, error) {
	l, err := p.bitxorExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("|") {
		p.next()
		r, err := p.bitxorExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: "|", l: l, r: r}
	}
	return l, nil
}
func (p *parser) bitxorExpr() (*expr, error) {
	l, err := p.bitandExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("^") {
		p.next()
		r, err := p.bitandExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: "^", l: l, r: r}
	}
	return l, nil
}
func (p *parser) bitandExpr() (*expr, error) {
	l, err := p.eqExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("&") {
		p.next()
		r, err := p.eqExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: "&", l: l, r: r}
	}
	return l, nil
}
func (p *parser) eqExpr() (*expr, error) {
	l, err := p.relExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("==") || p.isOp("!=") {
		op := p.next().text
		r, err := p.relExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: op, l: l, r: r}
	}
	return l, nil
}
func (p *parser) relExpr() (*expr, error) {
	l, err := p.shiftExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("<") || p.isOp(">") || p.isOp("<=") || p.isOp(">=") {
		op := p.next().text
		r, err := p.shiftExpr()
		if err != nil {
			return nil, err
		}
		l = &expr{kind: "bin", op: op, l: l, r: r}
	}
	return l, nil
}
func (p *parser) shiftExpr() (*expr, error) {
	l, err := p.addExpr()
	if err != nil {
		return nil, err
	}
	for p.isOp("<<") || p.isOp(">>") {
		op := p.next().text
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
	if p.isOp("~") {
		p.next()
		e, err := p.unaryExpr()
		if err != nil {
			return nil, err
		}
		// ~x → x ^ -1 — two's complement on the 32-bit int domain (JS `^`
		// operates on int32, matching C's `int` ~)
		return &expr{kind: "bin", op: "^", l: e, r: &expr{kind: "num", num: "-1"}}, nil
	}
	if p.isOp("++") || p.isOp("--") {
		// ++i / --i — PREFIX increment/decrement in EXPRESSION position
		// (the value is the NEW value; hoisted to an increment statement
		// + the plain var read at the statement level — see
		// hoistArithCalls / hoistCondReads). Statements and for headers
		// lower directly (simpleAssign / forHeaderAssign).
		op := p.next().text
		e, err := p.unaryExpr()
		if err != nil {
			return nil, err
		}
		if e == nil || e.kind != "id" {
			refuse("prefix ++/-- on non-variables is not in the subset")
		}
		kind := "preinc"
		if op == "--" {
			kind = "predec"
		}
		return &expr{kind: kind, name: e.name}, nil
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
	case "chr":
		p.next()
		if len(t.text) != 1 {
			// multi-char literal: C packs the bytes big-endian into an
			// int (implementation-defined; GCC: 'ab' = 0x6162)
			v := 0
			for i := 0; i < len(t.text); i++ {
				v = v*256 + int(t.text[i])
			}
			return &expr{kind: "num", num: strconv.Itoa(v)}, nil
		}
		return &expr{kind: "str", num: t.text}, nil
	case "id":
		p.next()
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
					// sizeof(struct Tag) — the arg is a TYPE name; consume
					// it as a marker id ("struct Node") for the sizeof fold
					if t.text == "sizeof" && p.isId("struct") {
						p.next() // struct
						tg := p.next()
						if tg == nil || tg.kind != "id" {
							return nil, fmt.Errorf("expected struct tag in sizeof")
						}
						args = append(args, &expr{kind: "id", name: "struct " + tg.text})
						if p.isOp(")") {
							break
						}
						if err := p.expectOp(","); err != nil {
							return nil, err
						}
						continue
					}
					// sizeof(type) — the arg is a primitive type name
					// like sizeof(int), sizeof(long long), sizeof(unsigned long long)
					if t.text == "sizeof" && p.peek() != nil && p.peek().kind == "id" && isTypeKw(p.peek().text) {
						typeName := p.next().text
						typeName = p.consumeTypeKeywords(typeName)
						args = append(args, &expr{kind: "id", name: typeName})
						if p.isOp(")") {
							break
						}
						if err := p.expectOp(","); err != nil {
							return nil, err
						}
						continue
					}
					// generic expression arg — if sizeof and next is a type
					// keyword, the type-kw handler above should have caught it;
					// this fallback means the type wasn't recognized.
					if t.text == "sizeof" {
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
						continue
					}
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
			// `(int) e` / `(char) e` / `(unsigned long long) e` — a C
			// type cast (identity in the v1 subset: every value is a
			// string in the shell store)
			if p.p+1 < len(p.ts) && p.ts[p.p+1].kind == "id" && isTypeKw(p.ts[p.p+1].text) {
				// scan ahead to see if all tokens until `)` are type keywords
				j := p.p + 1
				for j < len(p.ts) && p.ts[j].kind == "id" && isTypeKw(p.ts[j].text) {
					j++
				}
				if j < len(p.ts) && p.ts[j].kind == "op" && p.ts[j].text == ")" {
					// consume ( type-keyword* )
					for p.p < j+1 {
						p.next()
					}
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
	case "cond":
		// a ternary inside arithmetic: fold when the condition is a
		// compile-time constant, else refuse (the Arith AST has no cond)
		if s, ok := foldConst(e, nil); ok {
			n, _ := strconv.Atoi(s)
			return map[string]any{"type": "Num", "value": n}
		}
		refuse("ternary in an arithmetic context (lower it to a temp: int v = c ? a : b)")
	case "bin":
		if e.r == nil {
			// the unary-`!` shape (`b = !b`): the A1 Arith Un node — a nil
			// RHS would crash the Bin lowering (fleet parity: the shared
			// lowering emits Un for nil-RHS bin nodes).
			return map[string]any{"type": "Un", "op": e.op, "arg": arithNode(e.l)}
		}
		return map[string]any{"type": "Bin", "lhs": arithNode(e.l), "op": e.op, "rhs": arithNode(e.r)}
	case "index", "deref", "addr":
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
		if arrayVars[e.name] {
			// an ARRAY name in a value position (a C call argument like
			// `my_qsort(a, ...)`): decay to the NAME — the runtime treats
			// a pointer as the variable name it aliases. getVar would
			// return element 0 and break the callee's arrayIndex walks.
			return st(e.name)
		}
		return call("getVar", []any{st(e.name)})
	case "member":
		// p.x — a flattened struct member: a plain store read
		return call("getVar", []any{st(e.name)})
	case "cond":
		// cond ? a : b — the runtime ternary (the cond is the frontend's
		// test-string or arith-truth call, lowered native-first by the
		// core; the branches are pure values — evaluated eagerly, sound
		// for the pure-expression subset)
		var condArg any
		if condNeedsArith(e.l) {
			condArg = call("testArith", []any{st(exprToArithString(e.l))})
		} else {
			condArg = st(testExpr(e.l))
		}
		if len(e.args) == 1 {
			return call("ternary", []any{condArg, valueNode(e.r), valueNode(e.args[0])})
		}
		return call("ternary", []any{condArg, valueNode(e.r), st("")})
	case "call":
		return callNode(e)
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
			// *p on a heap pointer — the mem arena element read (a dyn
			// pointer reads via its position handle's embedded offset)
			if hp, ok := heapPtrs[e.l.name]; ok {
				if hp.dyn {
					return call("memLoad", []any{call("getVar", []any{st(hp.hv)}), st("0"), st(hp.elem)})
				}
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
			// p[k] on a heap pointer — mem arena element read at off+k (a
			// dyn pointer positions the read via its handle's embedded
			// offset plus the index)
			if hp, ok := heapPtrs[e.l.name]; ok {
				if hp.dyn {
					if k, ok := foldIndex(e.r); ok {
						return call("memLoad", []any{call("getVar", []any{st(hp.hv)}), st(strconv.Itoa(k)), st(hp.elem)})
					}
					return call("memLoad", []any{call("getVar", []any{st(hp.hv)}), indexArith(e.r, 0), st(hp.elem)})
				}
				if k, ok := foldIndex(e.r); ok {
					return call("memLoad", []any{call("getVar", []any{st(hp.root)}), st(strconv.Itoa(hp.off + k)), st(hp.elem)})
				}
				return call("memLoad", []any{call("getVar", []any{st(hp.root)}), indexArith(e.r, hp.off), st(hp.elem)})
			}
		}
		// base[j] on an ARRAY-NAME pointer param — the param holds the
		// array's NAME (arrays decay to their name at call sites); read
		// through the runtime store by that name, like the `void *base`
		// of qsort. The index may be runtime (arith).
		if _, ok := fnPtrParams[e.l.name]; ok {
			return call("arrayIndex", []any{call("getVar", []any{st(e.l.name)}), indexArith(e.r, 0)})
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
		if e.op == "!" {
			return "(!" + l + ")"
		}
		return "(" + l + " " + e.op + " " + r + ")"
	case "cond":
		refuse("ternary inside arithmetic/index expressions is not in the subset (lower it to a temp)")
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
// operandIsString — whether a test operand carries a STRING value (a
// char literal / string literal, or a `char` variable — the store has no
// int type for chars). Comparisons involving one compare with `=`/`!=`
// (string equality); pure int comparisons keep `-eq`/`-ne`.
func operandIsString(e *expr) bool {
	if e == nil {
		return false
	}
	if e.kind == "str" {
		return true
	}
	if e.kind == "id" && charVars[e.name] {
		return true
	}
	return false
}

// hoistToTemp — replace a nested runtime-call/ternary with a temp var,
// emitting its value assignment first (the A1 Arith AST has no Call or
// Cond node, so calls/ternaries nested inside arithmetic must be hoisted
// to statement-level temps — the "lower it to a temp" discipline
// automated). The temp is a plain store var; the arith then sees a Var.
func (p *parser) hoistToTemp(e *expr, out *[]any) *expr {
	userTempSeq++
	tmp := "___t" + strconv.Itoa(userTempSeq)
	*out = append(*out, assignStmt(tmp, valueNode(e)))
	return &expr{kind: "id", name: tmp}
}

// hoistArithCalls — rewrite `e` so no runtime call or ternary remains
// nested inside arithmetic (bin/un) operands: each is replaced by a temp
// Var with the assignment appended to `out`. The TOP node of the value
// (a top-level call/ternary) stays — valueNode lowers those directly
// (fnValue / the runtime ternary).
func (p *parser) hoistArithCalls(e *expr, out *[]any, top bool) *expr {
	if e == nil {
		return e
	}
	switch e.kind {
	case "bin", "un":
		e.l = p.hoistArithCalls(e.l, out, false)
		e.r = p.hoistArithCalls(e.r, out, false)
		if len(e.args) > 0 {
			e.args[0] = p.hoistArithCalls(e.args[0], out, false)
		}
		return e
	case "deref", "index":
		// a memory read inside arithmetic — hoisted to a temp (the A1
		// Arith AST has no Call node; the memLoad/arrayIndex is the value)
		return p.hoistToTemp(e, out)
	case "preinc", "predec":
		// ++i / --i — the value is the NEW value: emit the increment
		// statement, replace with the plain var read
		op := "+"
		if e.kind == "predec" {
			op = "-"
		}
		inc := &expr{kind: "bin", op: op, l: &expr{kind: "id", name: e.name}, r: &expr{kind: "num", num: "1"}}
		*out = append(*out, assignStmt(e.name, valueNode(inc)))
		return &expr{kind: "id", name: e.name}
	case "cond":
		// the TEST (e.l) may hold runtime value reads the test-string
		// grammar cannot express — hoist them via the cond-read walker
		// first; the branches hoist arith-calls as usual
		if condValueRead(e.l) {
			e.l = p.hoistCondReads(e.l, out)
		}
		e.r = p.hoistArithCalls(e.r, out, false)
		if len(e.args) > 0 {
			e.args[0] = p.hoistArithCalls(e.args[0], out, false)
		}
		if top {
			return e
		}
		return p.hoistToTemp(e, out)
	case "call":
		for i, a := range e.args {
			e.args[i] = p.hoistArithCalls(a, out, false)
		}
		if top {
			return e
		}
		if _, ok := foldCallConst(e, nil); ok {
			return e
		}
		return p.hoistToTemp(e, out)
	}
	return e
}

func testOperand(e *expr) string {
	switch e.kind {
	case "num":
		return e.num
	case "id":
		return "$" + e.name
	case "str":
		return "'" + e.num + "'"
	case "cond":
		refuse("ternary in a test condition is not in the subset (lower it to a temp)")
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
		// char/string comparisons use the STRING test operators (the
		// store is string-typed; `-eq` would coerce both sides to 0)
		if (e.op == "==" || e.op == "!=") && (operandIsString(e.l) || operandIsString(e.r)) {
			op := "="
			if e.op == "!=" {
				op = "!="
			}
			return testOperand(e.l) + " " + op + " " + testOperand(e.r)
		}
		return testOperand(e.l) + " " + cmpOp(e.op) + " " + testOperand(e.r)
	}
	return ""
}

// condNeedsArith — whether `e` contains an ARITHMETIC operator the bash
// test-string grammar cannot express (bitwise / shift / mod / ... — the
// test grammar is comparison + -a/-o/! only). Such a condition routes
// the WHOLE expression to the runtime arith-eval truth test (testArith:
// bash `$(( ))` semantics — evalArith evaluates arithmetic AND
// comparisons together).
func condNeedsArith(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "bin":
		switch e.op {
		case "==", "!=", "<", ">", "<=", ">=", "&&", "||", "!":
			return condNeedsArith(e.l) || condNeedsArith(e.r)
		}
		return true // any other bin op is arithmetic
	case "cond":
		return true
	}
	return false
}

// splitMidBreaks — a case body's `break`s, split against the merged
// fallthrough tail (`rest`):
//   - a TRAILING bare break ends the arm — it (and nothing else) drops,
//     `rest` is NOT merged (no fallthrough);
//   - a GUARDED mid-arm break (`if (c) break;` — possibly block-wrapped)
//     keeps the guard with an EMPTY then (a true guard exits the switch
//     by skipping everything) and wraps the REMAINDER (the rest of this
//     body + the merged next-arm) in the guard's ELSE (a false guard
//     falls through — the C fallthrough semantics);
//   - a BARE mid-arm break makes the rest unreachable (C) — dropped.
//
// Nested-loop breaks are inside While stmts and never seen here (they
// bind to their own loop).
func splitMidBreaks(body, rest []any) []any {
	for i, st := range body {
		m, ok := st.(map[string]any)
		if !ok {
			continue
		}
		if m["type"] == "Break" || m["type"] == "Expr" {
			if isBreakStmt(m) {
				// trailing or bare mid break: drop it and the rest
				return body[:i]
			}
		}
		if m["type"] == "If" {
			then, _ := m["then"].([]any)
			if len(then) == 1 {
				if b2, ok2 := then[0].(map[string]any); ok2 {
					// unwrap a Block wrapper: `if (c) { break; }`
					if bl, ok3 := b2["body"].([]any); ok3 && b2["type"] == "Block" && len(bl) == 1 {
						b2 = bl[0].(map[string]any)
					}
					if isBreakStmt(b2) {
						// guarded break: the else carries the remainder
						rem := append(append([]any{}, body[i+1:]...), rest...)
						m["then"] = []any{}
						m["else"] = splitMidBreaks(rem, []any{})
						return append(append([]any{}, body[:i]...), m)
					}
				}
			}
		}
	}
	// no breaks: fall through into the merged tail
	return append(append([]any{}, body...), rest...)
}

// condValueRead — does a CONDITION expression contain a runtime VALUE
// read (deref / index / call / prefix-inc) that the test-string and
// arith-string grammars cannot express? Such reads are hoisted to temps
// (hoistCondReads) so the remaining condition lowers through condCall.
func condValueRead(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "deref", "index", "preinc", "predec", "cond":
		return true
	case "call":
		// ANY call in a condition is hoisted (even a foldable one — the
		// test-string grammar has no call node; the folded constant rides
		// the temp)
		return true
	case "bin", "un":
		return condValueRead(e.l) || condValueRead(e.r) || (len(e.args) > 0 && condValueRead(e.args[0]))
	}
	return false
}

// hoistCondReads — rewrite a CONDITION expression, replacing every
// runtime value read with a temp var (the temp assignment appended to
// `out`); the rewritten condition is expressible in the test/arith
// grammars (comparisons over the temps). A `cond` (ternary) in a test
// position is hoisted whole — its value is a runtime call.
func (p *parser) hoistCondReads(e *expr, out *[]any) *expr {
	if e == nil {
		return e
	}
	switch e.kind {
	case "deref", "index":
		return p.hoistToTemp(e, out)
	case "preinc", "predec":
		// ++i in a condition: increment first, test the new value
		op := "+"
		if e.kind == "predec" {
			op = "-"
		}
		inc := &expr{kind: "bin", op: op, l: &expr{kind: "id", name: e.name}, r: &expr{kind: "num", num: "1"}}
		*out = append(*out, assignStmt(e.name, valueNode(inc)))
		return &expr{kind: "id", name: e.name}
	case "call":
		return p.hoistToTemp(e, out)
	case "cond":
		e.l = p.hoistCondReads(e.l, out)
		e.r = p.hoistCondReads(e.r, out)
		if len(e.args) > 0 {
			e.args[0] = p.hoistCondReads(e.args[0], out)
		}
		return p.hoistToTemp(e, out)
	case "bin", "un":
		e.l = p.hoistCondReads(e.l, out)
		e.r = p.hoistCondReads(e.r, out)
		if len(e.args) > 0 {
			e.args[0] = p.hoistCondReads(e.args[0], out)
		}
		return e
	}
	return e
}

// condCall — the A1 condition for `if`/`while`/...: the test-string
// grammar when expressible, else the runtime arith-truth call.
func condCall(c *expr) map[string]any {
	// pointer-position comparisons lower to the runtime memTest (the
	// test-string grammar cannot compare handles) — slice 2
	if mc, ok := heapCompareCall(c); ok {
		return mc
	}
	if condNeedsArith(c) {
		return call("testArith", []any{st(exprToArithString(c))})
	}
	return testCall(testExpr(c))
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

func (p *parser) stmts() ([]any, error) {
	var out []any
	for {
		t := p.peek()
		if t == nil {
			break
		}
		if t.kind == "op" && t.text == "}" {
			break
		}
		if t.kind == "op" && t.text == "{" {
			inner, err := p.block()
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
		if s != nil {
			// stmt() may return a `[]any` (e.g. a label-then-statement
			// sequence emits `[Label, inner]`) — flatten so the label
			// ends up at the SAME level as the surrounding stmts.
			if list, ok := s.([]any); ok {
				out = append(out, list...)
			} else {
				out = append(out, s)
			}
		}
	}
	return out, nil
}

func (p *parser) stmt() (any, error) {
	t := p.peek()
	if t == nil {
		return nil, nil
	}
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
	case p.isId("int") || p.isId("char") || p.isId("double") || p.isId("float") || p.isId("void") || p.isId("return") || p.isId("long") || p.isId("unsigned") || p.isId("short") || p.isId("signed") || p.isId("size_t") || p.isId("va_list"):
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
		// consume compound types: unsigned long long, long long, etc.
		kw = p.consumeTypeKeywords(kw)
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
		if strings.HasSuffix(kw, "char") && isPtr {
			charPtrVars[name.text] = true
		}
		if strings.HasSuffix(kw, "char") && !isPtr {
			charVars[name.text] = true
		}
		if isPtr && !strings.HasSuffix(kw, "char") {
			// every non-char pointer declaration starts as a heap-pointer
			// candidate (promoted out by recordPtrTarget / heapAssignRHS)
			ptrDecls[name.text] = kw
		}
		// `int a, b;` / `int a = 1, b = 2;` — multi-declarator (v2). The
		// pointer-init machinery is per-name and the array path returns
		// early, so pointers refuse here (the common case is the plain
		// int/char list).
		if p.isOp(",") {
			if isPtr {
				refuse("multi-declarator pointer declarations are not in the subset")
			}
			var out []any
			decl := name.text
			for {
				if p.isOp("=") {
					p.next()
					e, err := p.expr()
					if err != nil {
						return nil, err
					}
					out = append(out, assignStmt(decl, valueNode(e)))
				}
				if !p.isOp(",") {
					break
				}
				p.next()
				nm := p.next()
				if nm == nil || nm.kind != "id" {
					return nil, fmt.Errorf("expected identifier in declaration")
				}
				decl = nm.text
			}
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			if len(out) == 0 {
				return nil, nil
			}
			return map[string]any{"body": out, "type": "Block"}, nil
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
						if t == nil || t.kind != "id" || (!isTypeKw(t.text) && t.text != "struct") {
							return nil, fmt.Errorf("expected parameter type at token %v", t)
						}
						// a STRUCT-POINTER parameter: `struct Node *head` — the
						// param receives a list/struct handle (a name/box);
						// `head->member` goes through the mem arena.
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
						p.next() // first type keyword
						ptype = p.consumeTypeKeywords(ptype)
						isPtr := false
						for p.isOp("*") {
							p.next()
							isPtr = true
						}
						// a FUNCTION-pointer parameter: `int (*cmp)(const void *, const void *)`
						// — the `( * name )` form after the return type. The param receives
						// a comparator's NAME; calls through it (`cmp(a, b)` / `(*cmp)(a, b)`)
						// lower to the comparator bridge.
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
							// a plain pointer param (void* / int* / …):
							// NULL checks on it are the string-nonempty
							// test (structPtrCond) — a boxed pointer is
							// an object, and Number(box) is NaN → 0.
							ptrDecls[pn.text] = ptype
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
			return nil, nil
		}
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
		if p.isOp("=") {
			p.next()
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			// `int a = 1, b = 2;` — multi-declarator with initializers
			// (the first declarator already parsed; pointers refuse)
			if p.isOp(",") {
				if isPtr {
					refuse("multi-declarator pointer declarations are not in the subset")
				}
				var out []any
				out = append(out, assignStmt(name.text, valueNode(e)))
				for p.isOp(",") {
					p.next()
					nm := p.next()
					if nm == nil || nm.kind != "id" {
						return nil, fmt.Errorf("expected identifier in declaration")
					}
					if p.isOp("=") {
						p.next()
						e2, err2 := p.expr()
						if err2 != nil {
							return nil, err2
						}
						out = append(out, assignStmt(nm.text, valueNode(e2)))
					}
				}
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				return map[string]any{"body": out, "type": "Block"}, nil
			}
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			// static pointer target (array / scalar alias / copy): the pointer
			// is compile-time only — emit NOTHING
			if isPtr && recordPtrTarget(name.text, e) {
				return nil, nil
			}
			// heap pointer initializer (malloc / pointer copy / p = q + n)
			if isPtr && kw != "char" {
				if hp, isRoot, ok := heapAssignRHS(name.text, e, kw); ok {
					if isRoot {
						// p itself holds the memAlloc handle — the store
						// write (setVar: the mem seam reads the store)
						heapPtrs[name.text] = hp
						return storeAssignStmt(name.text, valueNode(e)), nil
					}
					// slice 2: a pointer whose later uses ADVANCE or COMPUTE
					// its position at runtime (walk loops) carries it in a
					// dedicated handle var from the declaration — the
					// while-header cond is emitted BEFORE the body's advance,
					// so a compile-time off could never advance per-iteration
					if ptrNeedsDyn(name.text, p.ts[p.p:]) {
						hp.dyn = true
						hp.hv = "___hp_" + name.text
						heapPtrs[name.text] = hp
						return storeAssignStmt(hp.hv, call("memAdvance", []any{call("getVar", []any{st(hp.root)}), st(strconv.Itoa(hp.off))})), nil
					}
					heapPtrs[name.text] = hp
					return nil, nil // compile-time pair only
				}
				refuse("unsupported pointer initializer for " + name.text)
			}
			// calls/ternaries nested inside the arithmetic initializer are
			// hoisted to temps (the A1 Arith AST has no Call/Cond node)
			var temps []any
			e = p.hoistArithCalls(e, &temps, true)
			init := assignStmt(name.text, valueNode(e))
			if len(temps) > 0 {
				return map[string]any{"body": append(temps, init), "type": "Block"}, nil
			}
			return init, nil
		}
		// bare declaration `int x;` / `int *p;`
		if isPtr && kw != "char" {
			// an uninitialized heap-pointer candidate: seed the base pair
			// so a later `*p = v` / `p = q + n` resolves even if the first
			// assignment is not the declaration; a pointer whose later
			// uses advance/compute its position goes runtime from the start
			hp := heapPtr{root: name.text, elem: kw, off: 0}
			if ptrNeedsDyn(name.text, p.ts[p.p:]) {
				hp.dyn = true
				hp.hv = "___hp_" + name.text
			}
			heapPtrs[name.text] = hp
		}
		p.next() // ;
		return nil, nil
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
		// runtime value reads in the condition (deref / index / call /
		// prefix-inc) are hoisted to temps — the test-string grammar
		// cannot express them (single evaluation — fine for an if)
		var condTemps []any
		if condValueRead(c) {
			c = p.hoistCondReads(c, &condTemps)
		}
		ifStmt := map[string]any{"cond": condCall(c), "then": thenB, "elsifs": []any{}, "else": elseB, "type": "If"}
		if len(condTemps) > 0 {
			return map[string]any{"body": append(condTemps, ifStmt), "type": "Block"}, nil
		}
		return ifStmt, nil
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
		if condValueRead(c) {
			// the condition needs RUNTIME reads: the temps must refresh
			// every iteration, so the loop becomes
			//   while (1) { temps; if (!cond) break; body }
			// — the If's else arm runs the shell BREAK signal the runtime
			// while loop catches.
			var condTemps []any
			c = p.hoistCondReads(c, &condTemps)
			guard := map[string]any{
				"body": append(append([]any{}, condTemps...), map[string]any{
					"cond":   condCall(c),
					"then":   []any{},
					"elsifs": []any{},
					"else":   []any{map[string]any{"type": "Expr", "expr": call("break", []any{})}},
					"type":   "If",
				}),
				"type": "Block",
			}
			body := append([]any{guard}, b...)
			return map[string]any{"cond": testCall("1"), "body": body, "type": "While"}, nil
		}
		return map[string]any{"cond": condCall(c), "body": b, "type": "While"}, nil
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
		// C's `for (i; c; u) { ... continue; }` — emit the RICH ForInit
		// node; the core's strip_cfor pass lowers it to
		// `init; while(c){ body-with-step-before-continues; step }` for
		// the shell-flavored renderers (the continue/step interaction
		// is the strip's job now, not this frontend's).
		var body []any
		body = append(body, b...)
		condStmt := testCall("1")
		if cond != nil {
			if condValueRead(cond) {
				// the cond needs runtime reads — the body gets the
				// refresh-and-guard structure (the strip's While has the
				// step at the body end, so the temps refresh before the
				// cond check — same structure as before)
				var condTemps []any
				cond = p.hoistCondReads(cond, &condTemps)
				guard := map[string]any{
					"body": append(append([]any{}, condTemps...), map[string]any{
						"cond":   condCall(cond),
						"then":   []any{},
						"elsifs": []any{},
						"else":   []any{map[string]any{"type": "Break"}},
						"type":   "If",
					}),
					"type": "Block",
				}
				body = append([]any{guard}, body...)
			} else {
				condStmt = condCall(cond)
			}
		}
		forInit := map[string]any{
			"type": "ForInit",
			"init": []any{},
			"cond": condStmt,
			"step": []any{},
			"body": body,
		}
		if init != nil {
			forInit["init"] = []any{init}
		}
		if inc != nil {
			forInit["step"] = []any{inc}
		}
		return forInit, nil
	case p.isId("break"), p.isId("continue"):
		// loop control — the A1 signal calls (the runtime while loop
		// catches BREAK/CONTINUE). In switch-case bodies the switch
		// parser strips them instead (a switch break binds to the
		// if-chain the switch lowers to — no loop signal).
		kw := p.next().text
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		// first-class loop-control statements (the A1 contract nodes;
		// the renderers map them to the runtime's break/continue)
		return map[string]any{"type": strings.ToUpper(kw[:1]) + kw[1:]}, nil
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
			val           string
			body          []any
			endsWithBreak bool
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
				body, ends, err := p.caseBody()
				if err != nil {
					return nil, err
				}
				cases = append(cases, swCase{v, body, ends})
				continue
			}
			if p.isId("default") {
				p.next()
				if err := p.expectOp(":"); err != nil {
					return nil, err
				}
				var ends bool
				defBody, ends, err = p.caseBody()
				if err != nil {
					return nil, err
				}
				_ = ends // the default is last — nothing falls through it
				continue
			}
			return nil, fmt.Errorf("expected case/default in switch at token %v", p.peek())
		}
		p.next() // }
		// a runtime-read DISCRIMINANT (`switch (*p)`) is hoisted into a
		// temp once, before the dispatch chain (the test-string grammar
		// cannot express the read)
		var discTemps []any
		if condValueRead(disc) {
			disc = p.hoistCondReads(disc, &discTemps)
		}
		// lower: the case ARMS are merged for FALLTHROUGH first (C
		// semantics — a case body that does NOT end with a break runs the
		// next case's arm too; the shared-body `case 1: case 2: body`
		// form falls out: an empty body merges the next arm), then the
		// dispatch chain: if (x == c1) arm1 else if (x == c2) arm2 ...
		// else default. (A break in the MIDDLE of a case body is still
		// stripped — the if-chain has no mid-arm escape.)
		arms := make([][]any, len(cases))
		var nextArm []any = defBody
		for i := len(cases) - 1; i >= 0; i-- {
			arms[i] = splitMidBreaks(cases[i].body, nextArm)
			nextArm = arms[i]
		}
		elseB := defBody
		for i := len(cases) - 1; i >= 0; i-- {
			c := cases[i]
			cond := &expr{kind: "bin", op: "==", l: disc, r: &expr{kind: "num", num: c.val}}
			elseB = []any{map[string]any{"cond": condCall(cond), "then": arms[i], "elsifs": []any{}, "else": elseB, "type": "If"}}
		}
		if len(cases) == 0 {
			return nil, nil
		}
		if len(discTemps) > 0 {
			return map[string]any{"body": append(discTemps, elseB[0]), "type": "Block"}, nil
		}
		return elseB[0], nil
	case p.isId("do"):
		p.next()
		b, err := p.block()
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
		// whose scope the duplication would break in the v1 subset). A
		// cond needing runtime reads gets the refresh-and-guard While.
		body := append([]any{}, b...)
		if condValueRead(c) {
			var condTemps []any
			c = p.hoistCondReads(c, &condTemps)
			guard := map[string]any{
				"body": append(append([]any{}, condTemps...), map[string]any{
					"cond":   condCall(c),
					"then":   []any{},
					"elsifs": []any{},
					"else":   []any{map[string]any{"type": "Expr", "expr": call("break", []any{})}},
					"type":   "If",
				}),
				"type": "Block",
			}
			body = append(body, map[string]any{"cond": testCall("1"), "body": append([]any{guard}, append([]any{}, b...)...), "type": "While"})
		} else {
			body = append(body, map[string]any{"cond": condCall(c), "body": append([]any{}, b...), "type": "While"})
		}
		return map[string]any{"body": body, "type": "Block"}, nil
	case p.isId("struct"):
		return p.structDecl()
	case p.isId("printf"):
		p.next()
		if err := p.expectOp("("); err != nil {
			return nil, err
		}
		var fmtStr string
		var valueExprs []*expr
		for {
			tk := p.peek()
			if tk != nil && tk.kind == "str" {
				if fmtStr == "" {
					fmtStr = tk.text
				} else {
					// a non-leading string literal arg is a VALUE
					valueExprs = append(valueExprs, &expr{kind: "str", num: tk.text})
				}
				p.next()
			} else {
				e, err := p.expr()
				if err != nil {
					return nil, err
				}
				valueExprs = append(valueExprs, e)
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
		// calls/ternaries nested inside arithmetic args are hoisted to
		// temps (the A1 Arith AST has no Call/Cond node)
		var temps []any
		args := []any{st(fmtStr)}
		for _, e := range valueExprs {
			e = p.hoistArithCalls(e, &temps, true)
			args = append(args, valueNode(e))
		}
		if len(temps) > 0 {
			return map[string]any{"body": append(temps, execPrintf(args)), "type": "Block"}, nil
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
	if t.kind == "id" && isTypeKw(t.text) {
		p.next()
		p.consumeTypeKeywords(t.text)
		t = p.peek()
	}
	// prefix ++i / --i in the for header (v2) — same lowering as postfix
	if t != nil && (p.isOp("++") || p.isOp("--")) {
		op := p.next().text
		nm := p.next()
		if nm == nil || nm.kind != "id" {
			return nil, nil
		}
		return p.buildAssign(nm.text, "=", &expr{
			kind: "bin", op: op[:1],
			l: &expr{kind: "id", name: nm.text},
			r: &expr{kind: "num", num: "1"},
		})
	}
	if t == nil || t.kind != "id" {
		return nil, nil
	}
	name := p.next().text
	if p.isOp("++") || p.isOp("--") {
		// i++ / i-- — postfix increment, lowered to i = i +/- 1; a heap
		// pointer advances its runtime position handle instead (slice 2)
		op := p.next().text
		if hp, ok := heapPtrs[name]; ok {
			d := "1"
			if op == "--" {
				d = "-1"
			}
			return p.ptrAdvanceStmt(name, hp, d), nil
		}
		return p.buildAssign(name, "=", &expr{
			kind: "bin", op: op[:1],
			l: &expr{kind: "id", name: name},
			r: &expr{kind: "num", num: "1"},
		})
	}
	if p.isAssignOp() {
		op := p.next().text
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		// heap-pointer assignments in the for header (slice 2): `p = a`
		// / `p = a + n` re-target, `p += n` / `p -= n` advance
		if hp, ok := heapPtrs[name]; ok {
			if op == "=" {
				if pos, ok2 := heapPos(e); ok2 {
					if !heapExprHasDyn(e) {
						if hp2, _, ok3 := heapAssignRHS(name, e, hp.elem); ok3 {
							heapPtrs[name] = hp2
							return nil, nil
						}
					}
					return p.ptrAssignStmt(name, hp, pos), nil
				}
			} else if op == "+=" || op == "-=" {
				d := exprToArithString(e)
				if op == "-=" {
					d = "(0 - " + d + ")"
				}
				return p.ptrAdvanceStmt(name, hp, d), nil
			}
			refuse("compound pointer assignment " + op + " is not in the subset")
		}
		// calls/ternaries nested inside the arithmetic RHS are hoisted to
		// temps (the A1 Arith AST has no Call/Cond node). A compound op's
		// RHS is an implicit arith OPERAND (x + e), so even a top-level
		// call/ternary there must hoist; a plain `=` keeps the top-level
		// value node (fnValue / the runtime ternary lower it directly).
		var temps []any
		e = p.hoistArithCalls(e, &temps, op == "=")
		stmt, err := p.buildAssign(name, op, e)
		if err != nil {
			return nil, err
		}
		if len(temps) > 0 {
			return map[string]any{"body": append(temps, stmt), "type": "Block"}, nil
		}
		return stmt, nil
	}
	return nil, nil
}

// isAssignOp — any assignment operator the v2 subset parses: plain =
// plus the compound family (+= -= *= /= %= <<= >>= &= |= ^=; buildAssign
// strips the trailing '=' and lowers the op through the Arith AST).
func (p *parser) isAssignOp() bool {
	return p.isOp("=") || p.isOp("+=") || p.isOp("-=") || p.isOp("*=") || p.isOp("/=") || p.isOp("%=") ||
		p.isOp("<<=") || p.isOp(">>=") || p.isOp("&=") || p.isOp("|=") || p.isOp("^=")
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
	if p.isOp("++") || p.isOp("--") {
		// ++i / --i — prefix increment (v2; statement position discards
		// the expression value, so the lowering is the same i = i +/- 1
		// as the postfix statement form)
		op := p.next().text
		nm := p.next()
		if nm == nil || nm.kind != "id" {
			return nil, fmt.Errorf("expected identifier after prefix " + op)
		}
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		return p.buildAssign(nm.text, "=", &expr{
			kind: "bin", op: op[:1],
			l: &expr{kind: "id", name: nm.text},
			r: &expr{kind: "num", num: "1"},
		})
	}
	if p.isOp("*") {
		// *p = v — a store through the handle
		p.next()
		target, err := p.expr()
		if err != nil {
			return nil, err
		}
		if !p.isAssignOp() {
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
			// *p = v on a heap pointer — the mem arena element store (dyn
			// pointers store through their position handle)
			if hp, ok := heapPtrs[target.name]; ok {
				if hp.dyn {
					return map[string]any{
						"type": "Expr",
						"expr": call("memStore", []any{call("getVar", []any{st(hp.hv)}), st("0"), st(hp.elem), valueNode(e)}),
					}, nil
				}
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
		// x++ / x-- — postfix increment (lowered to x = x +/- 1); a heap
		// pointer advances its runtime position handle instead (slice 2)
		op := p.next().text
		if err := p.expectOp(";"); err != nil {
			return nil, err
		}
		if hp, ok := heapPtrs[name]; ok {
			d := "1"
			if op == "--" {
				d = "-1"
			}
			return p.ptrAdvanceStmt(name, hp, d), nil
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
		if p.isAssignOp() {
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
		if !p.isAssignOp() {
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
		// a[i] = v on a heap pointer — the mem arena element store (the
		// offset is static, or a runtime arith call for a dynamic index;
		// dyn pointers store through their position handle)
		if hp, ok := heapPtrs[name]; ok {
			if hp.dyn {
				var off any
				if k, ok2 := foldIndex(idx); ok2 {
					off = st(strconv.Itoa(k))
				} else {
					off = indexArith(idx, 0)
				}
				return map[string]any{
					"type": "Expr",
					"expr": call("memStore", []any{call("getVar", []any{st(hp.hv)}), off, st(hp.elem), valueNode(e)}),
				}, nil
			}
			var off any
			if k, ok2 := foldIndex(idx); ok2 {
				off = st(strconv.Itoa(hp.off + k))
			} else {
				off = indexArith(idx, hp.off)
			}
			return map[string]any{
				"type": "Expr",
				"expr": call("memStore", []any{call("getVar", []any{st(hp.root)}), off, st(hp.elem), valueNode(e)}),
			}, nil
		}
		// a[i] = v on a C array — the baked-name array write (the core's
		// arr[1]=x shape; the runtime handles it — same as the ptrTarget
		// reduction). A DYNAMIC index emits the runtime arrayStore call
		// instead: the baked `a[$i]` target would resolve the subscript
		// via the STORE (stale for natively-lifted index vars), while the
		// arith arg here is lowered natively by the core's `arith` arm.
		if arrayVars[name] {
			if k, ok2 := foldIndex(idx); ok2 {
				return assignStmt(name+"["+strconv.Itoa(k)+"]", valueNode(e)), nil
			}
			return map[string]any{
				"type": "Expr",
				"expr": call("arrayStore", []any{st(name), indexArith(idx, 0), valueNode(e)}),
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
				// sizeof(type) / sizeof(struct Tag) — the arg is a TYPE
				// name, not an expression
				if name == "sizeof" && p.isId("struct") {
					p.next()
					tg := p.next()
					if tg == nil || tg.kind != "id" {
						return nil, fmt.Errorf("expected struct tag in sizeof")
					}
					args = append(args, &expr{kind: "id", name: "struct " + tg.text})
				} else if name == "sizeof" && p.peek() != nil && p.peek().kind == "id" && isTypeKw(p.peek().text) {
					typeName := p.next().text
					typeName = p.consumeTypeKeywords(typeName)
					args = append(args, &expr{kind: "id", name: typeName})
				} else {
					a, err := p.expr()
					if err != nil {
						return nil, err
					}
					args = append(args, a)
				}
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
			if len(args) == 2 && args[0].kind == "id" {
				return storeAssignStmt(args[0].name, valueNode(args[1])), nil
			}
			refuse("unsupported strcpy")
		case "va_start", "va_end":
			return nil, nil // no stdout effect in the v1 subset
		}
		// a USER function called as a statement: emit the fnCall (the
		// value is discarded, the call executes). The out-param transform
		// (harness/outparam_to_returns.py) rewrites these call sites for
		// out-parameter functions — before that landed, such calls were
		// silently DROPPED (getdim(&w, &h) emitted nothing, w/h stayed 0).
		if _, ok := userFuncs[name]; ok {
			argsA1 := make([]any, 0, len(args))
			for _, a := range args {
				argsA1 = append(argsA1, valueNode(a))
			}
			return map[string]any{"type": "Expr", "expr": call("fnCall", []any{st(name), map[string]any{"elements": argsA1, "type": "Array"}})}, nil
		}
		return nil, nil
	}
	if p.isAssignOp() {
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
				// root allocation: `p = malloc(...)` — p itself holds the
				// memAlloc handle (the base `:0` handle; never advanced)
				if hp, isRoot, ok := heapAssignRHS(name, e, ptrDecls[name]); ok && isRoot {
					heapPtrs[name] = hp
					return storeAssignStmt(name, valueNode(e)), nil
				}
				// a pointer POSITION assignment. When every involved
				// pointer is static, keep the compile-time pair; when any
				// is runtime-positioned (dyn), the position lands in the
				// pointer's own handle var (slice-2 model).
				if pos, ok2 := heapPos(e); ok2 {
					if !heapExprHasDyn(e) {
						if hp, _, ok3 := heapAssignRHS(name, e, ptrDecls[name]); ok3 {
							heapPtrs[name] = hp
							return nil, nil
						}
					}
					return p.ptrAssignStmt(name, heapPtrs[name], pos), nil
				}
			} else if op == "+=" || op == "-=" {
				// p += k / p -= k — in-place heap pointer arithmetic. A
				// static pointer with a literal delta keeps the
				// compile-time off; a runtime delta or a dyn pointer
				// advances the runtime position handle.
				if hp, ok := heapPtrs[name]; ok {
					if !hp.dyn {
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
					d := exprToArithString(e)
					if op == "-=" {
						d = "(0 - " + d + ")"
					}
					return p.ptrAdvanceStmt(name, hp, d), nil
				}
			}
			refuse("unsupported pointer assignment to " + name)
		}
		// calls/ternaries nested inside the arithmetic RHS are hoisted to
		// temps (the A1 Arith AST has no Call/Cond node). A compound op's
		// RHS is an implicit arith OPERAND (x + e), so even a top-level
		// call/ternary there must hoist; a plain `=` keeps the top-level
		// value node (fnValue / the runtime ternary lower it directly).
		var temps []any
		e = p.hoistArithCalls(e, &temps, op == "=")
		stmt, err := p.buildAssign(name, op, e)
		if err != nil {
			return nil, err
		}
		if len(temps) > 0 {
			return map[string]any{"body": append(temps, stmt), "type": "Block"}, nil
		}
		return stmt, nil
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

func (p *parser) block() ([]any, error) {
	if err := p.expectOp("{"); err != nil {
		return nil, err
	}
	body, err := p.stmts()
	if err != nil {
		return nil, err
	}
	if err := p.expectOp("}"); err != nil {
		return nil, err
	}
	return body, nil
}

// stmtOrBlock — a statement body that may be a single statement
// (`if (c) x = 1;`) or a block (`if (c) { ... }`). C allows both.
// When the single statement is a label-then-statement sequence (a
// `[]any{Label, inner}` from stmt()), we wrap the whole thing in a
// fresh Block so the body-position holds a single IR node — the label
// stays at the same nesting level as it would in a `{ ... }` block.
func (p *parser) stmtOrBlock() ([]any, error) {
	if p.isOp("{") {
		return p.block()
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
func (p *parser) caseBody() ([]any, bool, error) {
	// the bool: did the body END with a `break`? A break stays an Expr in
	// the body — the switch lowering splits it: a trailing one ends the
	// arm (no fallthrough), a GUARDED mid-arm one (`if (c) break;`) wraps
	// the remainder in the guard's else (a true guard skips the merged
	// rest — the C exit-switch semantics the old strip could not
	// express), and a bare mid one drops the unreachable rest. Nested-
	// loop breaks bind to their own while — never the switch.
	var out []any
	endedWithBreak := false
	for {
		t := p.peek()
		if t == nil {
			return nil, endedWithBreak, fmt.Errorf("unterminated switch case")
		}
		if t.kind == "id" && (t.text == "case" || t.text == "default") {
			break
		}
		if t.kind == "op" && t.text == "}" {
			break
		}
		if t.kind == "op" && t.text == "{" {
			inner, err := p.block()
			if err != nil {
				return nil, endedWithBreak, err
			}
			if len(inner) > 0 {
				out = append(out, inner...)
				endedWithBreak = false
			}
			continue
		}
		s, err := p.stmt()
		if err != nil {
			return nil, endedWithBreak, err
		}
		if s == nil {
			continue
		}
		if m, ok := s.(map[string]any); ok && (m["type"] == "Break" || m["type"] == "Expr") {
			if isBreakStmt(m) {
				out = append(out, s)
				endedWithBreak = true
				continue
			}
		}
		endedWithBreak = false
		out = append(out, s)
	}
	return out, endedWithBreak, nil
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
		// `struct Point p;` / `struct Node *list;` — a variable (a struct
		// POINTER global becomes a structPtrVars member; a VALUE var is
		// flattened to dotted scalars, so sizeof(p) knows its layout)
		isPtr := p.nextIf("*")
		vn := p.next()
		if vn == nil || vn.kind != "id" {
			return nil, fmt.Errorf("expected variable name after struct tag")
		}
		if isPtr {
			structPtrVars[vn.text] = tn.text
		}
		varStruct[vn.text] = tn.text
		if p.isOp("=") {
			// struct-pointer globals often seed with NULL: `= 0;`
			p.next()
			if _, err := p.expr(); err != nil {
				return nil, err
			}
			if err := p.expectOp(";"); err != nil {
				return nil, err
			}
			return nil, nil
		}
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
		// the BASE member type: `int` / `char *` / `struct Tag *`
		var base string
		if p.isId("struct") {
			p.next() // struct
			tag := p.next()
			if tag == nil || tag.kind != "id" {
				return nil, fmt.Errorf("expected struct tag in member type")
			}
			base = "struct " + tag.text
			for p.isOp("*") {
				p.next()
				base += "*"
			}
		} else {
			mt := p.next()
			if mt == nil || mt.kind != "id" {
				return nil, fmt.Errorf("expected member type at token %v", mt)
			}
			base = mt.text
		}
		// comma-separated names with per-name stars: `int a, b;` /
		// `char *x, *y;` — the `*` binds to the NAME in C
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
	// the layout registry: emit registerStruct("Tag-<fnv1a>", members)
	// so the runtime can introspect malloc'd boxes of this type
	// (nodeChild / nodeData — the generic-walk seam). Member byte
	// offsets accumulate in declaration order (LP64, matching
	// structSize / cTypeSize).
	reg := make([]any, 0, len(members))
	off := 0
	for _, m := range members {
		reg = append(reg, map[string]any{
			"type":     "Array",
			"elements": []any{st(m.name), st(strconv.Itoa(off)), st(m.ctype)},
		})
		if sz, ok := cTypeSize(m.ctype); ok {
			off += sz
		}
	}
	structRegs = append(structRegs, map[string]any{
		"type": "Expr",
		"expr": call("registerStruct", []any{st(structTag(tn.text)), map[string]any{"elements": reg, "type": "Array"}}),
	})
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
			out = append(out, s)
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
	case p.isId("int") || p.isId("char") || p.isId("double") || p.isId("float") || p.isId("va_list") || p.isId("long") || p.isId("unsigned") || p.isId("short") || p.isId("signed") || p.isId("size_t"):
		// a local declaration: `int s = 0;` / `va_list ap;` — and
		// comma-separated names: `int i, j, t;` (a "seq" of assigns)
		kw := p.next().text
		p.consumeTypeKeywords(kw)
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
		// pointer's tag so `n->member` resolves; the value is the handle).
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
	case p.isId("if2"): // never matches — debug marker
		return nil, nil
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
	default:
		if t.kind == "id" {
			nm := p.next()
			if p.isOp("++") || p.isOp("--") {
				// p++ / p-- — postfix pointer advance (a no-op for
				// non-pointer vars; the emit only advances ptr params)
				op := p.next().text
				if err := p.expectOp(";"); err != nil {
					return nil, err
				}
				return &uStmt{kind: "ptrinc", name: nm.text, op: op}, nil
			}
			if p.isAssignOp() {
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
			if p.isOp("->") {
				// p->member = v — a struct-pointer member write in a
				// function body (memStore through the handle)
				p.next() // ->
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
				if !p.isAssignOp() {
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
				p.isAssignOp() {
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
	arrayVars = map[string]bool{}
	scalarAliases = map[string]string{}
	ptrTargets = map[string]ptrTarget{}
	charPtrVars = map[string]bool{}
	userFuncs = map[string]*userFunc{}
	for _, m := range regexp.MustCompile(`&([A-Za-z_][A-Za-z0-9_]*)`).FindAllStringSubmatch(src, -1) {
		addrTaken[m[1]] = true
	}
	// per-run state (the binary parses one file per invocation, but the
	// worker may exec it repeatedly in-process via wrappers)
	heapPtrs = map[string]heapPtr{}
	ptrDecls = map[string]string{}
	charVars = map[string]bool{}
	funcPtrs = map[string]string{}
	structLayouts = map[string][]structMember{}
	structRegs = []any{}
	fnPtrParamNames = map[string]bool{}
	varStruct = map[string]string{}
	macros = map[string]macro{}
	preprocessDefines(src)
	ts, err := lex(src)
	if err != nil {
		return nil, fmt.Errorf("REFUSE: %w", err)
	}
	ts = expandMacros(ts)
	pr := &parser{ts: ts}
	stmts, err := pr.stmts()
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
		u := buildUserFnA1(name, fn)
		// store-route the function body too — a getline buffer (&b) is a
		// store var; a plain `b = ""` decl would lift to a native binding
		// and desync from getLine's store write
		if fb, ok := u["body"].([]any); ok {
			u["body"] = applyStoreRouting(fb)
		}
		userDefs = append(userDefs, u)
	}
	sort.Slice(userDefs, func(i, j int) bool {
		return userDefs[i].(map[string]any)["name"].(string) < userDefs[j].(map[string]any)["name"].(string)
	})
	stmts = append(append(append([]any{}, structRegs...), userDefs...), stmts...)
	prog := map[string]any{
		"type":             "Program",
		"contract_version": 1,
		"imports":          []any{},
		"requires":         []any{},
		"stmt_lines":       []any{},
		"stmts":            stmts,
		"subs":             []any{},
		"var_const":        []any{},
		"var_lengths":      []any{},
		"var_lifetimes":    []any{},
		"var_types":        []any{},
	}
	return json.Marshal(prog)
}
