// go-sh: Go source -> shIR JSON (A1 contract), hand-rolled Go frontend.
//
// WORKER REWRITE (2026-08-06): the v1 line-scanner stub is replaced by a
// real tokenizer + recursive-descent parser for the v2 Go subset, with a
// lowering pass that emits the EXACT A1 node shapes the core frontend
// produces for the equivalent shell construct (verified against
// `otranspilerl-cli file --shir` on the paired posix-sh-go testdata, which shares
// the t01..t52 corpus). The A1 contract (sh2perl/src/shir_json.rs +
// shir_json_in.rs) is the source of truth; the deserializer's ingress
// gate is the Makefile test's acceptance criterion.
//
// Subset (v2, corpus-defined): package/import/func-main boilerplate,
// fmt.Println/Print/Printf, os.Getenv/Setenv/WriteFile/Stat,
// exec.Command(...).Output()/.Run(), bufio.NewReader(os.Stdin)+ReadString,
// bufio.NewScanner(os.Stdin)+for sc.Scan()/sc.Text() (while-read),
// := / = / += / ++ / multi-assign, indexed assign a[1]=x, append(a, ...),
// strings.ReplaceAll (${s//o/n}) + strings.Contains (grep idiom),
// string-concat + arithmetic exprs, len(), slicing, indexing, array
// literals + range-for, if/else if/else, for cond, for init;cond;post
// (numeric header → the core's ForInit C-style shape), switch/case/default,
// TYPE SWITCH
// (`switch [v :=] x.(type) { case T: ... default: ... }` — lowered to the
// Case node with discriminant Call{func:"typeof", args:[x]} (sh2.typeOf:
// store strings -> "string", lifted numbers -> "int"/"float", bools ->
// "bool", arrays -> "array"), type-name clause patterns ("*" = default),
// guard var v bound to getVar x in every arm; case labels must be plain
// type names — core request go-sh-20260813-154009), func literals
// (params -> $1.., fresh vars -> `local`), go-func background,
// raw-string heredocs, comments, shebang.
// TYPE ASSERTION x.(T) and its comma-ok form (`v, ok := x.(T)`): the
// drop-in TypeAssert ext node (checked passthrough; kind vocabulary =
// the sh2.typeOf strings). The comma-ok BOOLEAN is the frontend's
// `typeof(x) == kind` comparison — ok stores "true"/"false" and a bare
// Bool var condition lowers to `"$ok" = true`. Unknown/named assertion
// types still refuse loudly (the dynamic kind is not knowable).
// ADDRESS-OF / DEREFERENCE &x / *p: the AddressOf/Deref ext-node pair
// (SNAPSHOT semantics on the value-only JS backend — reads pass the
// current value through; writes through a pointer refuse loudly).
// VARIADIC SPREAD f(args...): the Spread ext node, valid in direct
// call-argument position (array-typed vars only), rendered natively as
// an ESTree SpreadElement.
// COMPOSITE LITERALS IN EXPRESSION POSITION (`return map[K]V{…}`, an
// anonymous dict VALUE): the MapLiteral ext node (parallel keys/values),
// read back through ElementRead (computed coll[key]) — TRANSIENT values:
// assignment/return of a whole dict keeps refusing (named maps stay
// assocSet-based).//
// Top-level func decls `func name[typeParams](params) [ret] { body }`
// lower to the same Function subs as func literals. Go GENERICS (grammar
// typeParameters / typeArgs, core request go-sh-typeargs): a generic
// call `id[int](x)` carries typeArgs on the Call — the A1 deserializer
// validates the string array and ERASES it at ingress (documented
// erasure contract; no runtime form), and only type-INDEPENDENT generic
// bodies lower (type-dependent bodies would need compile-time
// substitution and stay Refuse > guess territory).
//
// Refuse > guess: anything outside the subset is a hard error (the gate
// reports FAIL), never a silent mis-lowering.
package golib

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	// NOTE (vendored busybox): upstream imports runtime/debug for a
	// PANICSTACK stack dump in run()'s panic recovery — the browser Go
	// toolchain's GOROOT bundle has no runtime/debug, so the vendored
	// copy drops that one diagnostic call (kept in sh2loop upstream).

	shiremit "github.com/gmatht/sh2loop/frontends/shir-emit-go"
)

// ─────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────

type tokKind int

const (
	tEOF tokKind = iota
	tNL
	tIdent
	tNum
	tStr  // "..."  (text = decoded, raw = verbatim between quotes)
	tChar // '...'  (a Go rune literal — an INTEGER in Go; the A1
	//         lowers it to its ASCII code in byte contexts)
	tRawStr // `...`  (text = verbatim content)
	tOp     // multi-char operator
	tPunct  // single char
)

type token struct {
	kind tokKind
	text string
	raw  string
	line int
}

// multiOps lives INSIDE lex (not top-level): top-level vars lower to
// native JS lets invisible to store reads, but lex's range needs the
// array store (self-host `:=` split without it).

func lex(src string) ([]token, error) {
	var toks []token
	// operator table (local so the range sees an array-store var)
	multiOps := []string{"...", ":=", "==", "!=", "<=", ">=", "&&", "||", "+=", "++", "--"}
	line := 1
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '\n':
			toks = append(toks, token{kind: tNL, line: line})
			line++
			i++
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				if src[i] == '\n' {
					line++
				}
				i++
			}
			if i+1 >= len(src) {
				return nil, fmt.Errorf("unterminated block comment")
			}
			i += 2
		case c == '"':
			start := i
			i++
			for i < len(src) && src[i] != '"' {
				if src[i] == '\\' && i+1 < len(src) {
					i += 2
				} else {
					i++
				}
			}
			if i >= len(src) {
				return nil, fmt.Errorf("unterminated string literal")
			}
			toks = append(toks, token{kind: tStr, raw: src[start+1 : i], text: src[start+1 : i], line: line})
			i++
		case c == '\'':
			// single-quoted char literal (e.g. ReadString('\n')) — a Go
			// RUNE literal (an integer); tokenized as tChar so the parser
			// can lower it to its ASCII code in byte contexts.
			start := i
			i++
			for i < len(src) && src[i] != '\'' {
				if src[i] == '\\' && i+1 < len(src) {
					i += 2
				} else {
					i++
				}
			}
			if i >= len(src) {
				return nil, fmt.Errorf("unterminated char literal")
			}
			toks = append(toks, token{kind: tChar, raw: src[start+1 : i], text: src[start+1 : i], line: line})
			i++
		case c == '`':
			start := i
			i++
			for i < len(src) && src[i] != '`' {
				if src[i] == '\n' {
					line++
				}
				i++
			}
			if i >= len(src) {
				return nil, fmt.Errorf("unterminated raw string literal")
			}
			toks = append(toks, token{kind: tRawStr, raw: src[start+1 : i], text: src[start+1 : i], line: line})
			i++
		case c >= '0' && c <= '9':
			start := i
			for i < len(src) {
				ch := src[i]
				if (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F') ||
					ch == 'o' || ch == 'x' || ch == 'X' || ch == '.' || ch == '_' {
					i++
				} else {
					break
				}
			}
			toks = append(toks, token{kind: tNum, text: src[start:i], line: line})
		case isIdentStart(c):
			start := i
			for i < len(src) && isIdentPart(src[i]) {
				i++
			}
			toks = append(toks, token{kind: tIdent, text: src[start:i], line: line})
		default:
			matched := false
			for _, op := range multiOps {
				if strings.HasPrefix(src[i:], op) {
					toks = append(toks, token{kind: tOp, text: op, line: line})
					i += len(op)
					matched = true
					break
				}
			}
			// NO `break` here: this default sits inside a switch, and
			// the ESTree backend lowers switches to if-chains where a
			// bare break would exit the enclosing WHILE (lex stopped
			// after the first multi-char op self-hosted). The for-break
			// above is safe (forLoopSync scopes it). Fall through to
			// punct only when nothing matched.
			if !matched {
				toks = append(toks, token{kind: tPunct, text: string(c), line: line})
				i++
			}
		}
	}
	toks = append(toks, token{kind: tEOF, line: line})
	return toks, nil
}

func isIdentStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
func isIdentPart(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}

// decodeGoStr unescapes a double-quoted Go string body (\\ \" \n \t \r;
// other \X kept as-is — printf formats keep their raw backslashes).
func decodeGoStr(raw string) string {
	var b strings.Builder
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c != '\\' || i+1 >= len(raw) {
			b.WriteByte(c)
			continue
		}
		i++
		switch raw[i] {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case '\\', '"':
			b.WriteByte(raw[i])
		default:
			b.WriteByte('\\')
			b.WriteByte(raw[i])
		}
	}
	return b.String()
}

// ─────────────────────────────────────────────────────────────────────
// A1 JSON builders (mirror shir_json.rs node shapes byte-for-byte)
// ─────────────────────────────────────────────────────────────────────

func strExpr(v string) map[string]any {
	return map[string]any{"type": "Str", "value": v, "style": "DoubleQuoted"}
}
func getVarExpr(name string) map[string]any {
	return map[string]any{
		"type": "Call", "func": "getVar",
		"args":   []any{strExpr(name)},
		"purity": "Emulable",
	}
}
func testCall(arg string) map[string]any {
	return map[string]any{
		"type": "Call", "func": "test",
		"args":   []any{strExpr(arg)},
		"purity": "Emulable",
	}
}
func interpLit(text string) map[string]any {
	return map[string]any{
		"type":  "Interpolate",
		"parts": []any{map[string]any{"kind": "lit", "text": text}},
	}
}
func interpParts(parts []any) map[string]any {
	return map[string]any{"type": "Interpolate", "parts": parts}
}
func partLit(text string) map[string]any { return map[string]any{"kind": "lit", "text": text} }
func partExpr(e map[string]any) map[string]any {
	return map[string]any{"kind": "expr", "expr": e}
}
func arithNum(n int) map[string]any { return map[string]any{"type": "Num", "value": n} }
func arithVar(name string) map[string]any {
	return map[string]any{"type": "Var", "name": name}
}
func arithBin(lhs map[string]any, op string, rhs map[string]any) map[string]any {
	// a BARE Bin node — the core's Arith ast tree has bare children
	// (`ast.Bin.lhs/rhs` are Num/Bin/Var nodes, not nested Arith
	// wrappers); the single top-level "Arith" wrapper is applied by
	// arithWrap at the expression boundary
	return map[string]any{"type": "Bin", "lhs": lhs, "op": op, "rhs": rhs}
}

// arithWrap: the one top-level wrapper the A1 contract expects
// (`{"type":"Arith","ast":<bare tree>}`) — deserializer rejects an
// "Arith" nested inside a Bin's lhs/rhs.
func arithWrap(ast map[string]any) map[string]any {
	return map[string]any{"type": "Arith", "ast": ast}
}
func paramCall(args ...string) map[string]any {
	a := make([]any, len(args))
	for i, s := range args {
		a[i] = strExpr(s)
	}
	return map[string]any{
		"type": "Call", "func": "param",
		"args":   a,
		"purity": "PureCpu",
	}
}
func joinCall(inner map[string]any) map[string]any {
	return map[string]any{
		"type": "Call", "func": "join",
		"args":   []any{inner},
		"purity": "PureCpu",
	}
}
func assignStmt(name string, expr map[string]any) map[string]any {
	return map[string]any{
		"type": "Assign",
		"targets": []any{map[string]any{
			"var": name, "sigil": nil, "indices": []any{},
		}},
		"expr": expr,
	}
}

// arithAssignStmt: the core's ForInit init shape (byte-identical to the
// `for ((i=N; ...))` lowering in shir.rs): Assign wrapping an Arith ast
// `Assign` node (`i = N`), NOT a plain Str assignment.
func arithAssignStmt(name string, n int) map[string]any {
	return map[string]any{
		"type": "Assign",
		"targets": []any{map[string]any{
			"var": name, "sigil": nil, "indices": []any{},
		}},
		"expr": map[string]any{
			"type": "Arith",
			"ast": map[string]any{
				"type": "Assign", "op": "=", "var": name, "rhs": arithNum(n),
			},
		},
	}
}

// arithIncDecStmt: the core's ForInit step shape (byte-identical to the
// `for ((...; i++))` lowering): Assign wrapping an Arith ast `IncDec`
// node (`i++`).
func arithIncDecStmt(name string) map[string]any {
	return map[string]any{
		"type": "Assign",
		"targets": []any{map[string]any{
			"var": name, "sigil": nil, "indices": []any{},
		}},
		"expr": map[string]any{
			"type": "Arith",
			"ast": map[string]any{
				"type": "IncDec", "var": name, "delta": 1, "prefix": false,
			},
		},
	}
}
func execStmt(cmd string, words []map[string]any, purity string) map[string]any {
	return execStmtTA(cmd, words, purity, nil)
}

// execStmtTA: execStmt with Go generic type arguments (grammar rule
// typeArgs, `Name[TypeList](args)`) attached to the Call. The A1
// erasure contract (core request go-sh-typeargs) validates them as a
// string array and drops them at ingress, so the runtime behavior is
// identical to execStmt — the type arguments are carried for fidelity,
// never executed.
func execStmtTA(cmd string, words []map[string]any, purity string, typeArgs []string) map[string]any {
	elems := make([]any, len(words))
	for i, w := range words {
		elems[i] = w
	}
	// NOTE: no `call` local — a mutated Go map materializes as a
	// named assoc whose var-read sees "" (self-host execStmtTA lost
	// its expr); inline both variants so nesting stays plain.
	if len(typeArgs) > 0 {
		ta := make([]any, len(typeArgs))
		for i, s := range typeArgs {
			ta[i] = s
		}
		return map[string]any{
			"type": "Expr",
			"expr": map[string]any{
				"type": "Call", "func": "exec",
				"args":     []any{strExpr(cmd), map[string]any{"type": "Array", "elements": elems}},
				"purity":   purity,
				"typeArgs": ta,
				},
			}
	}
	return map[string]any{
		"type": "Expr",
		"expr": map[string]any{
			"type": "Call", "func": "exec",
			"args":   []any{strExpr(cmd), map[string]any{"type": "Array", "elements": elems}},
			"purity": purity,
		},
	}
}

// execCond builds a Call(fn=exec) usable as an If/While cond (the
// `while read x` shape).
func execCond(cmd string, words []map[string]any) map[string]any {
	elems := make([]any, len(words))
	for i, w := range words {
		elems[i] = w
	}
	return map[string]any{
		"type": "Call", "func": "exec",
		"args":   []any{strExpr(cmd), map[string]any{"type": "Array", "elements": elems}},
		"purity": "Emulable",
	}
}

// ─────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────

// expr kinds: "str" "num" "rawstr" "var" "binop" (comparisons/logical)
// "not" "add" "mul" "neg" (arith-or-concat) "index" "slice" "strlen"
// "arrlen" "call" "func" — plus the drop-in-node kinds "addr" (AddressOf)
// "deref" (Deref) "assert" (TypeAssert) "maplit" (MapLiteral).
type expr struct {
	kind string
	// str/num
	text string
	raw  string // printf-format raw text
	// var
	name string
	// type assertion x.(T): raw assertion type text (goTypeKind maps it
	// to the generic kind vocabulary at lowering)
	typeName string
	// variadic spread f(args...): the arg carries the spread flag; the
	// lowering wraps its word in the Spread ext node
	spread bool
	// map[K]V{…} composite literal in expression position: parallel
	// key/value expression lists (MapLiteral node)
	keys []*expr
	vals []*expr
	// struct composite literal T{...} / address-of &T{...}: ordered
	// field values (zero-filled to the layout), OBJECT STORE model
	structType string
	fieldVals  []*expr
	isAddrOf   bool
	// []T{...} slice literal in expression position: pre-lowered words
	elems []map[string]any
	// arith / concat / binop
	op  string
	lhs *expr
	rhs *expr
	// binop comparisons
	BOp     string // "==" "!=" "<" "<=" ">" ">=" "&&" "||"
	BOpKind string // "cmp" | "and" | "or"
	// index/slice/strlen/arrlen
	target *expr
	idx1   string // literal bound (plain number)
	idx2   string
	idx1e  *expr // expression bound (Go computed indices)
	idx2e  *expr
	// call
	callee   string
	args     []*expr
	typeArgs []string // generic instantiation `Name[TypeList](args)` (typeArgs)
	// struct composite literal (`token{kind: tNL, line: line}`): the
	// type name in `name`, the field VALUES in `args`, and the NAMED
	// field names in `fieldNames` (empty for positional — resolved from
	// the tracked struct type's fields).
	fieldNames []string
	// member access on a non-var base (`p.tok().line` — the method
	// call's result field): the base expr (the name is ".field").
	memberTarget *expr
	// func literal (lowered body, params in args)
	body   []map[string]any
	params []string
	// raw A1 cond JSON (if-init forms lower their cond directly,
	// bypassing condTestString — the assign-Capture shape has no
	// test-string form)
	rawJSON map[string]any
	// make(...) in expression position (struct-field values): map vs
	// slice construction
	makeMap bool
}

// ─────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────

type parser struct {
	toks []token
	pos  int
	// semantic side-state (the Go subset's shell-shaped meanings)
	varTypes    map[string]string // name -> "Int" | "Str" | "Array" | "Map"
	consts      map[string]int    // evaluated int const values (const refs)
	constStrs   map[string]string // evaluated string const values
	arrays      map[string]arrayInfo
	anyLists    map[string]bool       // vars holding objStore list ids (struct/any elements)
	anyElem     map[string]string     // var -> list element struct type
	idxBase     string                // indexed-assign base (`out` in `out[i] = …`) — consumed by the maplit hook below
	idxKey      *expr                 // computed index expr (nil when the key is a literal)
	idxLit      string                // literal index text ("" when computed)
	maps        map[string]bool    // m := map[K]V{...} — assoc-array name
	bufs        map[string]string  // b := bytes.Buffer — accumulated contents
	runtimeBufs map[string]bool    // buffers with runtime-dependent contents (WriteByte of a runtime byte)
	cmds        map[string][]*expr // cmd := exec.Command(...) -> args
	stdinRdr    map[string]bool    // r := bufio.NewReader(os.Stdin)
	fnNames     map[string]bool    // f := func(...){...} — callable subs
	outer       map[string]bool    // vars assigned at top level
	fnParams    map[string]bool    // inside a func literal
	fnParamOrd  []string           // ordered param names -> $1..
	fnLocals    map[string]bool
	inFunc      bool
	// variadic decl param (`parts ...string`) — excluded from the fixed
	// $N positional mapping; the function-entry prelude splices the tail
	// positionals (${@:N}) into a real array var so reads/spreads work.
	variadicParam string
	// struct layouts (ARENA model): type name -> ordered field names.
	// Every struct instance is arena-allocated: `&T{...}` / `T{...}`
	// appends its field values flat to __arena_T and yields the 1-based
	// instance number; a *T / T value IS that number, so pointers ride
	// the existing echo/capture value-return protocol and field access
	// is a computed subscript (__arena_T[$p*N + off]).
	structs      map[string][]string   // type name -> ordered FIELDS
	structFT     map[string][]string   // type name -> field BASE type names
	structRaw    map[string][]string   // type name -> field RAW type texts
	varStruct    map[string]string     // var -> struct type name (pointer or value)
	bufDyn       map[string]bool       // buffers with DYNAMIC writes (obj model)
	fnSig        map[string][2]string  // func/method name -> [paramTypesCsv, retType]
	paramTypes   map[string]string     // (during decl parse) param -> base type
	curFn        string                // (during body parse) enclosing func name
	prescanRet   map[string]string     // func name -> raw return base (pre-decl)
	pkgNames     map[string]bool       // package clauses seen in the concatenated source (PACKAGE MODE)
	importAlias  map[string]string     // import alias -> path (`golib` -> "github.com/…"; bare "fmt" -> "fmt")
	boolFuncs    map[string]bool       // subs whose return is a bool expression (STATUS protocol)
	regexpVars   map[string]string     // var -> regex source (`re := regexp.MustCompile(pat)`)
	deferRecover string                // the current defer body's except as-name ("" outside)
	deferUsedRcv bool                  // the current defer body called recover()
	splitNVars   map[string]splitNInfo // var -> SplitN tracking (source var + separator)
	readDirVars  map[string]string     // var -> dir path (os.ReadDir tracking)
	cgoObjs      map[string]bool       // vars holding cgo-bound objects (CGO-PATH)
	lastTypeRaw  string                // (during capture) the raw type text
	paramSlice   map[string]bool       // params declared as slice types ([]T)
	lastSig      [2]string             // (during decl parse) captured signature
	lastRetIds   []string              // (during decl parse) per-position return bases
	fnRetIdents  map[string][]string   // func name -> per-POSITION return bases
	tmpN         int                   // fresh temp counter (newstruct preludes)
	// type-switch guard aliases: `switch v := x.(type)` binds v to x in
	// every arm (core request go-sh-20260813-154009) — reads of the guard
	// var resolve to the guarded var (getVar x), matching the contract's
	// "v binds to getVar(\"x\")" lowering.
	varAlias map[string]string
	// struct field names by type name (`type tok struct{ kind, text
	// string }` → ["kind", "text"]) — positional composite literals
	// `tok{"a", "b"}` lower by position (the go-sh self-hosting
	// contract: structs are JSON object strings).
	structFields map[string][]string
	// struct field ELEMENT types by type name (`toks []token` →
	// "token"; `pos int` → "int") — a struct-field index read
	// (`t := p.toks[p.pos]`) registers the target's type.
	structFieldTypes map[string]map[string]string
	// var → struct TYPE name (`p := &parser{...}` → "parser") — the
	// field-type lookup key for member/index reads.
	varStructTypes map[string]string
	// method receiver → struct TYPE name (`func (p *parser) ...` →
	// "parser").
	receiverTypes map[string]string
	// temp-var sequence for cond hoists (function-call conditions)
	tmpSeq int
}

type splitNInfo struct {
	src string
	sep string
}

type arrayInfo struct {
	elems []map[string]any
	typ   string // "Int" | "Str"
}

func (p *parser) tok() token { return p.toks[p.pos] }
func (p *parser) next() token {
	t := p.toks[p.pos]
	if t.kind != tEOF {
		p.pos++
	}
	return t
}
func (p *parser) failf(f string, args ...any) {
	panic(fmt.Sprintf("line %d: %s", p.tok().line, fmt.Sprintf(f, args...)))
}

func (p *parser) skipNL() {
	for p.tok().kind == tNL {
		p.pos++
	}
}

func (p *parser) expect(k tokKind, text string) token {
	t := p.tok()

	if text != "" {
		if t.text != text {
			p.failf("expected %q, got %q", text, t.text)
		}
	} else if t.kind != k {
		p.failf("expected %s token, got %q", tokKindName(k), t.text)
	}
	return p.next()
}

func tokKindName(k tokKind) string {
	switch k {
	case tIdent:
		return "ident"
	case tNum:
		return "number"
	case tStr:
		return "string"
	case tRawStr:
		return "raw string"
	}
	return "token"
}

func (p *parser) atIdent(s string) bool {
	t := p.tok()
	return t.kind == tIdent && t.text == s
}
func (p *parser) atPunct(s string) bool {
	t := p.tok()
	return (t.kind == tPunct || t.kind == tOp) && t.text == s
}
func (p *parser) acceptPunct(s string) bool {
	if p.atPunct(s) {
		p.pos++
		return true
	}
	return false
}

// ── expression parsing (precedence climbing) ────────────────────────

var exprBoundary = map[string]bool{
	",": true, ")": true, "}": true, "]": true, ";": true, ":": true, "{": true,
}

// nodeTemps marks compile-time node temps (`return map[string]any{...}`
// in builders — strExpr/assignStmt/...): freezeStmts resolves exactly
// these (by name) into plain objects at the stmt-list boundary; other
// assoc names are runtime refs and must stay names. A GLOBAL (not
// parser state) so plain-func bodies (no $1 parser) can mark too; the
// mark is an emitted assocSet (codegen-time Go writes would stay
// native-only). Materializes on first mark — no declaration emits.
var nodeTemps = map[string]bool{}

func (p *parser) parseExpr() *expr {
	e := p.parseOr()
	t := p.tok()
	if t.kind == tNL || t.kind == tEOF || exprBoundary[t.text] {
		return e
	}
	p.failf("unexpected token %q after expression", t.text)
	return nil
}

func (p *parser) parseOr() *expr {
	l := p.parseAnd()
	for p.atPunct("||") {
		p.pos++
		p.skipNL() // Go allows a newline after the operator
		l = &expr{kind: "binop", BOp: "||", BOpKind: "or", lhs: l, rhs: p.parseAnd()}
	}
	return l
}

func (p *parser) parseAnd() *expr {
	l := p.parseCmp()
	for p.atPunct("&&") {
		p.pos++
		p.skipNL() // Go allows a newline after the operator
		l = &expr{kind: "binop", BOp: "&&", BOpKind: "and", lhs: l, rhs: p.parseCmp()}
	}
	return l
}

func (p *parser) parseCmp() *expr {
	l := p.parseAdd()
	if t := p.tok(); (t.kind == tOp || t.kind == tPunct) &&
		(t.text == "==" || t.text == "!=" || t.text == "<" || t.text == "<=" || t.text == ">" || t.text == ">=") {
		p.pos++
		// BIND the operator text NOW — `t` is a global temp that
		// nested tok() calls clobber before rhs finishes (self-host
		// `i == 2` read BOp "{" from the post-rhs probe).
		cmpOp := t.text
		l = &expr{kind: "binop", BOp: cmpOp, BOpKind: "cmp", lhs: l, rhs: p.parseAdd()}
	}
	return l
}

func (p *parser) parseAdd() *expr {
	l := p.parseMul()
	for p.atPunct("+") || p.atPunct("-") {
		op := p.next().text
		l = &expr{kind: "add", op: op, lhs: l, rhs: p.parseMul()}
	}
	return l
}

func (p *parser) parseMul() *expr {
	l := p.parseUnary()
	for p.atPunct("*") || p.atPunct("/") {
		op := p.next().text
		l = &expr{kind: "mul", op: op, lhs: l, rhs: p.parseUnary()}
	}
	return l
}

func (p *parser) parseUnary() *expr {
	if p.atPunct("!") {
		p.pos++
		return &expr{kind: "not", lhs: p.parseUnary()}
	}
	if p.atPunct("-") {
		p.pos++
		return &expr{kind: "neg", lhs: p.parseUnary()}
	}
	// &x / *x — the AddressOf/Deref ext-node pair. The IR passes values;
	// reference-capable backends render true references, value-only
	// backends use snapshot semantics (reads pass through; WRITES
	// through a pointer refuse at the assignment site — parseAssignStmt).
	if p.atPunct("&") {
		p.pos++
		e := p.parseUnary()
		if e.kind == "structlit" {
			// &T{...} — arena ALLOCATION: lowers to counter increment +
			// flat field append; the address is the 1-based instance no.
			e.isAddrOf = true
		}
		return &expr{kind: "addr", lhs: e}
	}
	if p.atPunct("*") {
		p.pos++
		return &expr{kind: "deref", lhs: p.parseUnary()}
	}
	return p.parsePostfix()
}

func (p *parser) parsePostfix() *expr {
	e := p.parsePrimary()
	for {
		switch {
		case p.atPunct("{"):
			// composite literal: `token{kind: tNL, line: line}` (named) or
		// `tok{"a", "b"}` (positional) — a struct VALUE. Lowered to
		// the jsonNew helper (the go-sh self-hosting contract: structs
		// are JSON object strings). Only fires for a KNOWN struct type
		// (a `3 {` for-body brace must not parse as a literal).
			// PACKAGE MODE: `&shiremit.Program{...}` — a cross-package
		// type is qualified; the layout is keyed by the LAST segment
		// (the concatenated package's own type decls register bare
		// names).
			cname := callName(e)
			if _, ok := p.structFields[cname]; !ok {
				if dot := strings.LastIndex(cname, "."); dot >= 0 {
					if _, ok2 := p.structFields[cname[dot+1:]]; ok2 {
						cname = cname[dot+1:]
					}
				}
			}
			if _, ok := p.structFields[cname]; !ok {
				// DOTTED unknown type (`foo.Bar{...}`,
				// `&shiremit.Program{Stmts: stmts}` — the Shir entry):
				// a keyed composite with synthetic layout.
				// parseGenericStructLit refuses non-keyed forms via
				// its lookahead, so a following block brace stays a
				// block (plain vars never take a composite here).
				if e.kind == "member" {
					if e2 := p.parseGenericStructLit(callName(e)); e2 != nil {
						e = e2
						break
					}
				}
				return e
			}
			p.pos++
			p.skipNL()
			var fields []*expr
			var names []string
			for {
				p.skipNL()
				if p.atPunct("}") {
					p.pos++
					break
				}
				if p.tok().kind == tIdent && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == ":" {
					names = append(names, p.next().text)
					p.pos++ // :
					p.skipNL()
					fields = append(fields, p.parseExpr())
				} else {
					fields = append(fields, p.parseExpr())
				}
				if !p.acceptPunct(",") {
					p.skipNL()
					p.expect(tPunct, "}")
					break
				}
			}
			e = &expr{kind: "structlit", name: cname, args: fields, fieldNames: names}
		case p.atPunct("("):
			p.pos++
			args := p.parseArgs()
			e = &expr{kind: "call", callee: callName(e), args: args}
		case p.atPunct("["):
			// `map[K]V{…}` composite literal in EXPRESSION position (e.g.
			// `return map[string]any{…}`): a whole dict value has no A1
			// shape (maps exist only as named assoc-arrays mutated by
			// assocSet) — refuse loudly rather than mis-parse as indexing.
			if callName(e) == "map" {
				p.failf("unsupported map composite literal in expression position (v2)")
			}
			// generic instantiation call `Name[TypeList](args)` (grammar rule
			// typeArgs): the type arguments ride on the Call (A1 erasure
			// contract, core request go-sh-typeargs — validated string array,
			// dropped at ingress). Only DEFINED functions are instantiable in
			// the subset, so a non-function base falls through to index/slice.
			if p.isTypeArgsBracket(callName(e)) {
				tas := p.parseTypeArgs()
				p.skipNL()
				p.expect(tPunct, "(")
				args := p.parseArgs()
				e = &expr{kind: "call", callee: callName(e), args: args, typeArgs: tas}
				break
			}
			p.pos++
			p.skipNL()
			lo, hi := "", ""
			var loE, hiE *expr
			if !p.atPunct(":") {
				if p.tok().kind == tNum {
					lo = p.next().text
				} else {
					loE = p.parseExpr()
				}
			}
			if p.atPunct(":") {
				p.pos++
				p.skipNL()
				if !p.atPunct("]") {
					if p.tok().kind == tNum {
						hi = p.next().text
					} else {
						hiE = p.parseExpr()
					}
				}
				p.expect(tPunct, "]")
				e = &expr{kind: "slice", target: e, idx1: lo, idx2: hi, idx1e: loE, idx2e: hiE}
			} else {
				p.expect(tPunct, "]")
				e = &expr{kind: "index", target: e, idx1: lo, idx1e: loE}
			}
		case p.atPunct("."):
			// a variadic spread `args...` — the `...` is erased (the A1
			// subs bind the remaining args positionally); the base is the
			// value.
			if p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "." &&
				p.toks[p.pos+2].kind == tPunct && p.toks[p.pos+2].text == "." {
				p.pos += 3
				return e
			}
			p.pos++
			if p.atPunct("(") {
				// x.(T) type assertion — the drop-in TypeAssert ext node
				// (checked passthrough; kind vocabulary = sh2.typeOf).
				// x.(type) is the TYPE-SWITCH form: only legal as a switch
				// discriminant, where peekTypeSwitch consumes it textually —
				// reaching here means a stray form.
				p.pos++
				tn := p.parseAssertionType()
				p.expect(tPunct, ")")
				if tn == "type" {
					p.failf("x.(type) is only valid in a type switch (v2)")
				}
				e = &expr{kind: "assert", lhs: e, typeName: tn}
				continue
			}
			nm := p.expect(tIdent, "").text
			if e.kind == "call" || e.kind == "fieldof" || e.kind == "index" {
				// f(x).field / f(x).a.b / sl[i].f — member access on a
				// computed VALUE: a fieldof chain (objGet over the
				// returned reference id)
				e = &expr{kind: "fieldof", lhs: e, name: nm}
			} else if cn := callName(e); cn != "" {
				e = &expr{kind: "member", name: cn + "." + nm}
			} else {
				// member on a non-var base (`p.tok().line` — the method
				// call's result field): keep the base for the jsonGet
				// lowering.
				e = &expr{kind: "member", name: "." + nm, memberTarget: e}
			}
		case p.atPunct("..."):
			// f(args...) variadic spread — mark the arg expr; the call-site
			// word lowering wraps it in the Spread ext node (ESTree
			// SpreadElement; array-typed vars only — see argToWord).
			p.pos++
			e.spread = true
		case p.atPunct("++"):
			p.pos++
			e = &expr{kind: "incr", target: e}
		default:
			return e
		}
	}
}

func callName(e *expr) string {
	if e.kind == "member" || e.kind == "var" {
		return e.name
	}
	return ""
}

// parseAssertionType consumes the raw type text inside x.( T ) — a
// single-line Go type expression (idents, dots, pointer/slice marks).
// Balanced-bracket types ([]T, chan) ride on the same punct set.
func (p *parser) parseAssertionType() string {
	var b strings.Builder
	depth := 0
	for {
		t := p.tok()
		if t.kind == tEOF {
			p.failf("unterminated type assertion")
		}
		if t.kind == tPunct || t.kind == tOp {
			switch t.text {
			case "[", "{", "(":
				depth++
			case "]", "}", ")":
				if t.text == ")" && depth == 0 {
					return strings.TrimSpace(b.String())
				}
				depth--
			}
			b.WriteString(t.text)
			p.pos++
			continue
		}
		if t.kind == tIdent || t.kind == tNum {
			b.WriteString(t.text)
			p.pos++
			continue
		}
		p.failf("unexpected token %q in type assertion", t.text)
	}
}

// goTypeKind maps an assertion type's text to the GENERIC kind
// vocabulary the TypeAssert node carries (= the sh2.typeOf strings:
// string|int|float|bool|array). Pointer marks strip to the element;
// slice/variadic forms are arrays. A NAMED type (StrE, *sitter.Tree)
// has no knowable dynamic kind at this layer — refused loudly (Refuse >
// guess), not guessed.
func goTypeKind(tn string) string {
	t := strings.TrimSpace(tn)
	for {
		t = strings.TrimSpace(t)
		if strings.HasPrefix(t, "*") {
			t = t[1:]
			continue
		}
		if strings.HasPrefix(t, "[]") || strings.HasPrefix(t, "...") {
			return "array"
		}
		if strings.HasPrefix(t, "map[") {
			return "map"
		}
		break
	}
	base := t
	if i := strings.LastIndex(base, "."); i >= 0 {
		base = base[i+1:]
	}
	switch base {
	case "string":
		return "string"
	case "byte", "rune",
		"int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64", "uintptr":
		return "int"
	case "float32", "float64":
		return "float"
	case "bool":
		return "bool"
	}
	return ""
}

// isTypeArgsBracket: the token at pos is `[` and the bracketed contents
// are a Go typeList (`IDENT (. IDENT)* (, ...)*`) immediately followed
// by `(` — the generic-instantiation call shape `Name[TypeList](args)`
// (grammar rule typeArgs) — AND the base name is a defined function
// (generic decls lower to subs; only defined generic functions are
// instantiable in the subset — an array/map index followed by a call
// stays a plain index and refuses as unsupported). Everything else
// falls through to the index/slice parser.
func (p *parser) isTypeArgsBracket(base string) bool {
	if !p.fnNames[base] {
		return false
	}
	if p.tok().kind != tPunct || p.tok().text != "[" {
		return false
	}
	i := p.pos + 1
	wantItem := true
	for {
		if i >= len(p.toks) {
			return false
		}
		t := p.toks[i]
		if t.kind == tEOF {
			return false
		}
		if wantItem {
			if t.kind != tIdent {
				return false
			}
			wantItem = false
			i++
			continue
		}
		switch t.text {
		case ".":
			i++ // qualified type name (pkg.T)
		case ",":
			i++
			wantItem = true
		case "]":
			i++
			return i < len(p.toks) && p.toks[i].kind == tPunct && p.toks[i].text == "("
		default:
			return false
		}
	}
}

// parseTypeArgs: `[TypeList]` — collects the type-argument strings
// (IDENT, possibly qualified pkg.T, comma-separated) and consumes
// through the closing `]`. The A1 erasure contract (core request
// go-sh-typeargs) validates them (string array) on the Call and drops
// them at ingress — the runtime behavior is the plain call.
func (p *parser) parseTypeArgs() []string {
	p.expect(tPunct, "[")
	var tas []string
	p.skipNL()
	item := ""
	for {
		item += p.expect(tIdent, "").text
		if p.acceptPunct(".") {
			item += "."
			continue
		}
		tas = append(tas, item)
		item = ""
		if p.acceptPunct(",") {
			p.skipNL()
			continue
		}
		break
	}
	p.skipNL()
	p.expect(tPunct, "]")
	return tas
}

func (p *parser) parseArgs() []*expr {
	var args []*expr
	p.skipNL()
	for !p.atPunct(")") {
		args = append(args, p.parseExpr())
		// a variadic spread `args...` — the `...` is erased (the A1
		// subs bind the remaining args positionally).
		if p.tok().kind == tPunct && p.tok().text == "." &&
			p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "." &&
			p.toks[p.pos+2].kind == tPunct && p.toks[p.pos+2].text == "." {
			p.pos += 3
			p.skipNL()
		}
		if p.acceptPunct(",") {
			p.skipNL()
			continue
		}
		break
	}
	p.expect(tPunct, ")")
	return args
}

func (p *parser) parsePrimary() *expr {
	t := p.tok()
	switch t.kind {
	case tNum:
		p.pos++
		return &expr{kind: "num", text: t.text}
	case tStr:
		p.pos++
		return &expr{kind: "str", text: decodeGoStr(t.raw), raw: t.raw}
	case tChar:
		// a Go rune literal — an INTEGER (its ASCII code) in Go. The
		// expr keeps the decoded char; byte contexts lower it to the
		// code, string contexts to the char itself.
		p.pos++
		return &expr{kind: "char", text: decodeGoStr(t.raw), raw: t.raw}
	case tRawStr:
		p.pos++
		return &expr{kind: "rawstr", text: t.text}
	case tIdent:
		switch t.text {
		case "len":
			p.pos++
			p.expect(tPunct, "(")
			p.skipNL()
			arg := p.parseExpr()
			p.expect(tPunct, ")")
			if arg.kind == "var" && (p.varTypes[arg.name] == "Array" ||
				p.varTypes[p.resolveVar(arg.name)] == "ListRef" ||
				p.anyListVar(arg.name) != "" ||
				// SLICE params hold list ids (listLen, not string len)
				p.paramSlice[arg.name] || p.paramSlice[p.resolveVar(arg.name)]) {
				return &expr{kind: "arrlen", target: arg}
			}
			if arg.kind == "member" {
				// len(l.toks) over a LIST-object field
				if _, tag := p.structFieldWord(arg.name); tag == "list" {
					return &expr{kind: "arrlen", target: arg}
				}
			}
			return &expr{kind: "strlen", target: arg}
		case "make":
			// make(map[K]V) / make([]T, n) in EXPRESSION position
			// (struct-field values — the golib's own parser literal
			// `splitNVars: make(map[string]splitNInfo)`): the type
			// argument erases; map construction allocates an empty map
			// object, slice an empty list object
			p.pos++
			p.expect(tPunct, "(")
			p.skipNL()
			isMap := p.atIdent("map")
			p.skipType()
			for p.acceptPunct(",") {
				p.skipNL()
				p.parseExpr() // length / capacity — erased
				p.skipNL()
			}
			p.expect(tPunct, ")")
			return &expr{kind: "make", makeMap: isMap}
		case "string", "int", "int64", "int32", "float64", "uint8", "byte", "rune":
			// CONVERSION: int(x)/byte(x)/rune(x) on strings are no-ops
			// (numeric coercion at use); string(x) over an INT-family
			// value (byte/int var, byte read) is chr (Go rune semantics
			// — the lexer's `string(c)` punct text). Strings, byte
			// slices and unknowns stay identity (legacy).
			isStrConv := t.text == "string"
			p.pos++
			p.expect(tPunct, "(")
			p.skipNL()
			arg := p.parseExpr()
			p.expect(tPunct, ")")
			if isStrConv && p.isByteValued(arg) {
				return &expr{kind: "call", callee: "chr", args: []*expr{arg}}
			}
			return arg
		case "func":
			return p.parseFuncLit()
		case "true", "false", "nil":
			p.pos++
			return &expr{kind: "var", name: t.text}
		case "map":
			// map[K]V{ k: v, … } composite literal in EXPRESSION position
			// (e.g. `return map[string]any{…}`) — the drop-in MapLiteral
			// ext node (parallel keys/values; read back via ElementRead).
			// A TRANSIENT value: assigning/returning one to a named var
			// stays on the assocSet path (parseAssignStmt) — a whole-dict
			// anonymous value flowing through the string-typed capture
			// protocol is not representable (documented gap).
			if p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "[" {
				p.pos++      // map
				p.skipType() // [K]V — balanced type erasure, incl. map forms
				p.skipNL()
				p.expect(tPunct, "{")
				var keys, vals []*expr
				for {
					p.skipNL()
					if p.atPunct("}") {
						p.pos++
						break
					}
					k := p.parseExpr()
					p.skipNL()
					p.expect(tPunct, ":")
					p.skipNL()
					v := p.parseExpr()
					keys = append(keys, k)
					vals = append(vals, v)
					p.skipNL()
					if !p.acceptPunct(",") {
						p.skipNL()
						p.expect(tPunct, "}")
						break
					}
				}
				var keyNames []string
				for _, k := range keys {
					keyNames = append(keyNames, k.text)
				}
				return &expr{kind: "maplit", keys: keys, vals: vals, args: vals, fieldNames: keyNames}
			}
		}
		// T{...} struct composite literal — the ARENA model's
		// constructor (layout captured by the type declaration)
		if layout, ok := p.structs[t.text]; ok && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "{" {
			p.pos++
			return p.parseStructLit(t.text, layout)
		}
		p.pos++
		return &expr{kind: "var", name: t.text}
	case tPunct:
		if t.text == "(" {
			p.pos++
			p.skipNL()
			e := p.parseExpr()
			p.skipNL()
			p.expect(tPunct, ")")
			return e
		}
		// {k: v, ...} inferred-type MAP literal element (inside
		// []map[string]any{ {...} }) — same object allocation
		if t.text == "{" {
			e := p.parseBraceMapLit()
			if e != nil {
				return e
			}
		}
		// []T{...} slice literal in EXPRESSION POSITION (`return []any{...}`)
		if t.text == "[" && p.sliceLitAhead() {
			elems, _ := p.parseArrayLiteral()
			return &expr{kind: "arraylit", elems: elems}
		}
		// []byte(x) conversion (grammar conversion): identity — the A1
		// is strings-only, so the byte-slice conversion is a no-op
		// (mirrors the `string(x)` arm above).
		if t.text == "[" && p.byteConvAhead() {
			p.pos += 4 // [ ] byte (
			p.skipNL()
			e := p.parseExpr()
			p.skipNL()
			p.expect(tPunct, ")")
			return e
		}
		// []T(x) slice-type conversion ([]map[string]any(nil)) — identity
		if t.text == "[" && p.sliceConvAhead() {
			return p.parseSliceConv()
		}
	}
	p.failf("unexpected token %q in expression", t.text)
	return nil
}

// parseBraceMapLit parses an ANONYMOUS brace composite `{ ... }` —
// either a KEYED map literal ({k: v, ...}) or a POSITIONAL struct-style
// list ({v1, v2, ...}); the caller's context decides which applies, and
// both lower to an object allocation (keys synthetic for positional).
func (p *parser) parseBraceMapLit() *expr {
	p.expect(tPunct, "{")
	var keys, vals []*expr
	positional := false
	first := true
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			break
		}
		keyedHere := (p.tok().kind == tStr || p.tok().kind == tIdent) &&
			p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == ":"
		if first {
			positional = !keyedHere
		}
		first = false
		if keyedHere && !positional {
			var k *expr
			if p.tok().kind == tStr || p.tok().kind == tRawStr {
				tk := p.next()
				k = &expr{kind: "str", text: decodeGoStr(tk.raw)}
			} else {
				k = &expr{kind: "str", text: p.next().text}
			}
			p.skipNL()
			p.expect(tPunct, ":")
			p.skipNL()
			v := p.parseExpr()
			keys = append(keys, k)
			vals = append(vals, v)
		} else if positional {
			v := p.parseExpr()
			idx := len(vals)
			keys = append(keys, &expr{kind: "num", text: strconv.Itoa(idx)})
			vals = append(vals, v)
		} else {
			p.failf("mixed keyed/positional brace literal (v2)")
		}
		p.skipNL()
		if !p.acceptPunct(",") {
			p.skipNL()
			p.expect(tPunct, "}")
			break
		}
	}
	var keyNames []string
	for _, k := range keys {
		keyNames = append(keyNames, k.text)
	}
	return &expr{kind: "maplit", keys: keys, vals: vals, args: vals, fieldNames: keyNames}
}

// parseGenericStructLit parses `{ key: val, … }` on a DOTTED or
// unknown type name (`shiremit.Program{Stmts: stmts}` — shir-emit-go
// in the concatenated source): the layout comes from the literal's own
// key order (a synthetic type registered in p.structs), so the object
// store allocates the right field set. Refuses on positional forms.
func (p *parser) parseGenericStructLit(typeName string) *expr {
	if p.tok().kind != tPunct || p.tok().text != "{" {
		return nil
	}
	// KEYED-literal lookahead only: `{ ident : …` — a switch/if/for
	// BLOCK after a member discriminant (`switch t.text {`) must not be
	// misread as a composite
	i := p.pos + 1
	if !(i < len(p.toks) && p.toks[i].kind == tIdent &&
		i+1 < len(p.toks) && p.toks[i+1].kind == tPunct && p.toks[i+1].text == ":") {
		return nil
	}
	p.pos++
	var names []string
	var vals []*expr
	keyed := false
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			break
		}
		if p.tok().kind != tIdent {
			p.failf("unsupported composite on %q (v2) — expected keyed fields", typeName)
		}
		nm := p.next().text
		p.skipNL()
		if !p.acceptPunct(":") {
			p.failf("unsupported positional composite %q (v2)", typeName)
		}
		keyed = true
		p.skipNL()
		vals = append(vals, p.parseExpr())
		names = append(names, nm)
		p.skipNL()
		if !p.acceptPunct(",") {
			p.skipNL()
			p.expect(tPunct, "}")
			break
		}
	}
	if !keyed {
		p.failf("unsupported composite %q (v2)", typeName)
	}
	// a synthetic layout for unknown types (the literal's own keys)
	if _, ok := p.structs[typeName]; !ok {
		p.structs[typeName] = names
		p.structFT[typeName] = make([]string, len(names))
		p.structRaw[typeName] = make([]string, len(names))
	}
	fieldVals := make([]*expr, len(p.structs[typeName]))
	for i, n := range names {
		idx := -1
		for j, f := range p.structs[typeName] {
			if f == n {
				idx = j
				break
			}
		}
		if idx >= 0 {
			fieldVals[idx] = vals[i]
		}
	}
	return &expr{kind: "structlit", structType: typeName, fieldVals: fieldVals}
}

// parseStructLit parses the braces of T{...} (the type name already
// consumed) into ordered field values, zero-filled to the layout. Both
// keyed ({name: v}) and positional ({v1, v2}) forms lower; mixing is
// refused (Go allows it only after keyed, but the corpus never does).
func (p *parser) parseStructLit(typeName string, layout []string) *expr {
	p.expect(tPunct, "{")
	vals := make([]*expr, len(layout))
	keyed, first := false, true
	pos := 0
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			break
		}
		if first && p.tok().kind == tIdent && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == ":" {
			keyed = true
		}
		first = false
		if keyed {
			fn := p.expect(tIdent, "").text
			p.skipNL()
			p.expect(tPunct, ":")
			p.skipNL()
			v := p.parseExpr()
			idx := -1
			for i, f := range layout {
				if f == fn {
					idx = i
					break
				}
			}
			if idx < 0 {
				p.failf("unknown field %q in struct %q (v2)", fn, typeName)
			}
			vals[idx] = v
		} else {
			if pos >= len(layout) {
				p.failf("too many fields in struct %q literal (v2)", typeName)
			}
			vals[pos] = p.parseExpr()
			pos++
		}
		p.skipNL()
		if !p.acceptPunct(",") {
			p.skipNL()
			p.expect(tPunct, "}")
			break
		}
	}
	return &expr{kind: "structlit", structType: typeName, fieldVals: vals}
}

// structZeroWord: the zero value word for an unset field ("").
func structZeroWord() map[string]any { return strExpr("") }

// structFieldWords: the FLAT field words for a struct literal — one
// word per layout slot (zero-filled), the arena append's element list.
func (p *parser) structFieldWords(e *expr) []map[string]any {
	var out []map[string]any
	for _, fv := range e.fieldVals {
		if fv == nil {
			out = append(out, structZeroWord())
			continue
		}
		out = append(out, p.exprToWord(fv))
	}
	return out
}

// structArena: the per-type arena array name.
func structArena(typeName string) string { return "__arena_" + typeName }

// structCounter: the per-type allocation counter name.
func structCounter(typeName string) string { return "__cnt_" + typeName }

// structFieldIndex: layout position of a field (-1 when unknown).
func structFieldIndex(layout []string, field string) int {
	for i, f := range layout {
		if f == field {
			return i
		}
	}
	return -1
}

// structFieldWord resolves a dotted member name (`p.pos`, `e.lhs.rhs`,
// `l.toks`, `t.text`) whose base is a STRUCT-typed var: each segment is
// an objGet over the previous value (objects are reference IDs — true
// aliasing). Returns the word plus the FINAL field's container tag:
// "" (scalar/struct ptr), "list", or "map".
func (p *parser) structFieldWord(name string) (map[string]any, string) {
	parts := strings.Split(name, ".")
	if len(parts) < 2 {
		return nil, "none"
	}
	baseName := p.resolveVar(parts[0])
	typeName := p.varStruct[baseName]
	if typeName == "" && (len(p.cmds[baseName]) > 0 || p.bufs[baseName] != "" || p.stdinRdr[baseName]) {
		return nil, "none" // tracked specials keep their own handlers
	}
	if typeName == "" || len(p.structs[typeName]) == 0 {
		// OPTIMISTIC object read: the base has no known struct layout,
		// but Go forbids .field on non-composite values, so lower every
		// segment as objGet over whatever the base holds ("" when the
		// field is absent — matching nil-field reads)
		cur2 := p.structIDWord(parts[0])
		for si2 := 1; si2 < len(parts); si2++ {
			cur2 = map[string]any{
				"type": "Call", "func": "objGet",
				"args":   []any{cur2, strExpr(parts[si2])},
				"purity": "PureCpu",
			}
		}
		return cur2, "ref"
	}
	cur := p.structIDWord(parts[0])
	segs := parts[1:]
	for si, seg := range segs {
		layout := p.structs[typeName]
		off := structFieldIndex(layout, seg)
		if off < 0 {
			return nil, "none" // not a field — other handlers try next
		}
		raw := ""
		if raws := p.structRaw[typeName]; off < len(raws) {
			raw = raws[off]
		}
		cur = map[string]any{
			"type": "Call", "func": "objGet",
			"args":   []any{cur, strExpr(seg)},
			"purity": "PureCpu",
		}
		if si == len(segs)-1 {
			tag := "ref"
			if strings.HasPrefix(raw, "[]") {
				tag = "list"
			} else if strings.HasPrefix(raw, "map[") {
				tag = "map"
			}
			return cur, tag
		}
		ft := ""
		if ftypes := p.structFT[typeName]; off < len(ftypes) {
			ft = ftypes[off]
		}
		if !p.isStructType(ft) {
			return nil, "none"
		}
		typeName = ft
	}
	return nil, "none"
}

// structMemberWord: the scalar/reference read form.
// mapRefWord: the WORD for a map VALUE reached through a struct field
// (`p.m`) or a chained map read (`p.m[k]` → the inner mapGet's result).
// The A1 map model stores maps by NAME, so an objGet of a map-valued
// field yields the map's name and the inner mapGet call IS the map
// reference for the next mapGet. Tag "map" when the target is a
// map-typed field or a (recursively) map-typed index; "none" otherwise
// (the caller keeps its other handlers).
func (p *parser) mapRefWord(t *expr) (map[string]any, string) {
	switch t.kind {
	case "member":
		if w, tag := p.structFieldWord(t.name); tag == "map" {
			return w, "map"
		}
	case "index":
		if t.target == nil {
			return nil, "none"
		}
		if mw, tag := p.mapRefWord(t.target); tag == "map" {
			return map[string]any{
				"type": "Call", "func": "mapGet",
				"args":   []any{mw, p.exprToWord(t.idx1e)},
				"purity": "PureCpu",
			}, "map"
		}
	}
	return nil, "none"
}

func (p *parser) structMemberWord(name string) (map[string]any, bool) {
	w, tag := p.structFieldWord(name)
	if tag != "ref" {
	}
	if tag == "none" || tag == "list" || tag == "map" {
		return nil, false
	}
	return w, true
}

// resolveStructVals normalizes the two structlit shapes for the OBJECT
// STORE consumers (newstructStmts, objNewCall): the (structType,
// fieldVals) shape passes through untouched; the (name, args,
// fieldNames) shape the postfix `{` handler builds for known types is
// positioned against the registered layout (package qualifier stripped
// exactly like the handler strips it). Unresolvable (unknown type,
// overlong positional) → ("", nil): the historical empty allocation,
// never a guess. Pure read — the node is never mutated, so the
// name-shape consumers (interpLit) see identical input.
func (p *parser) resolveStructVals(e *expr) (string, []*expr) {
	if e.structType != "" {
		return e.structType, e.fieldVals
	}
	typeName := e.name
	if _, ok := p.structs[typeName]; !ok {
		if dot := strings.LastIndex(typeName, "."); dot >= 0 {
			typeName = typeName[dot+1:]
		}
	}
	layout, ok := p.structs[typeName]
	if !ok {
		return "", nil
	}
	if len(e.fieldNames) == 0 {
		// positional: source order IS layout order (Go requires it);
		// overlong is malformed — leave unresolved (historical empty).
		if len(e.args) > len(layout) {
			return "", nil
		}
		vals := make([]*expr, len(layout))
		copy(vals, e.args)
		return typeName, vals
	}
	vals := make([]*expr, len(layout))
	for i, n := range e.fieldNames {
		if i >= len(e.args) {
			break
		}
		for j, f := range layout {
			if f == n {
				vals[j] = e.args[i]
				break
			}
		}
	}
	return typeName, vals
}

// newstructStmts lowers `target = &T{...}` (or a temp for expression
// uses): ONE objNew call — the OBJECT STORE model. Nested &T{...}
// field values pre-lower into temps (statement boundary), then the
// field word is the temp's value; non-addressed struct fields inline
// their objNew directly.
func (p *parser) newstructStmts(target string, e *expr) []map[string]any {
	// unwrap the addr wrapper (the non-addr assignment path passes
	// &expr{kind:"addr", lhs: structlit} — reading structType/fieldVals
	// off the WRAPPER yields ""/nil, allocating a nameless empty object)
	if e.kind == "addr" && e.lhs != nil {
		e = e.lhs
	}
	stype, fvals := p.resolveStructVals(e)
	layout := p.structs[stype]
	prelude := []map[string]any{}
	fieldNames := []any{}
	fieldVals := []any{}
	for i, fv := range fvals {
		if i >= len(layout) {
			break
		}
		fieldNames = append(fieldNames, strExpr(layout[i]))
		if fv == nil {
			fieldVals = append(fieldVals, strExpr(""))
			continue
		}
		lit := fv
		if lit.kind == "addr" && lit.lhs != nil && lit.lhs.kind == "structlit" {
			lit = lit.lhs
		}
		if lit.kind == "structlit" {
			// a STRUCT-TYPED field: the value IS a reference, so an
			// inner literal allocates its own object INLINE
			fieldVals = append(fieldVals, p.objNewCall(lit))
			continue
		}
		// a MAP-TYPED field (`&xlator{arrays: map[string]string{}}`):
		// allocate the map OBJECT — exprToWord's MapLiteral word with
		// null keys/values is rejected by the shIR ingress
		if lit.kind == "maplit" {
			fieldVals = append(fieldVals, p.objNewCall(lit))
			continue
		}
		fieldVals = append(fieldVals, p.exprToWord(fv))
	}
	out := prelude
	out = append(out, assignStmt(target, p.objNewCallNamed(stype, fieldNames, fieldVals)))
	return out
}

// objNewCallNamed: the Call word allocating an object of typeName.
func (p *parser) objNewCallNamed(typeName string, names, vals []any) map[string]any {
	return map[string]any{
		"type": "Call", "func": "objNew",
		"args":   []any{strExpr(typeName), map[string]any{"type": "Array", "elements": names}, map[string]any{"type": "Array", "elements": vals}},
		"purity": "PureCpu",
	}
}

// objNewCall: allocate from a struct literal expression.
func (p *parser) objNewCall(e *expr) map[string]any {
	names := []any{}
	vals := []any{}
	if e.kind == "maplit" {
		for i, k := range e.keys {
			names = append(names, p.exprToWord(k))
			v := e.vals[i]
			lit := v
			for lit != nil && lit.kind == "addr" && lit.lhs != nil && lit.lhs.kind == "structlit" {
				lit = lit.lhs
			}
			switch {
			case lit != nil && lit.kind == "structlit":
				vals = append(vals, p.objNewCall(lit))
			case lit != nil && lit.kind == "maplit":
				vals = append(vals, p.objNewCall(lit))
			default:
				vals = append(vals, p.exprToWord(v))
			}
		}
		return p.objNewCallNamed("map", names, vals)
	}
	stype2, fvals2 := p.resolveStructVals(e)
	layout := p.structs[stype2]
	for i, fv := range fvals2 {
		if i >= len(layout) {
			break
		}
		names = append(names, strExpr(layout[i]))
		if fv == nil {
			vals = append(vals, strExpr(""))
			continue
		}
		lit := fv
		if lit.kind == "addr" && lit.lhs != nil && lit.lhs.kind == "structlit" {
			lit = lit.lhs
		}
		if lit.kind == "structlit" {
			vals = append(vals, p.objNewCall(lit))
			continue
		}
		// map FIELD VALUE (`&xlator{arrays: map[string]string{}}`):
		// allocate the map OBJECT and store its ref — exprToWord would
		// emit a degenerate MapLiteral word the ingress rejects
		if lit.kind == "maplit" {
			vals = append(vals, p.objNewCall(lit))
			continue
		}
		vals = append(vals, p.exprToWord(fv))
	}
	return p.objNewCallNamed(stype2, names, vals)
}

func wordsToAny(ws []map[string]any) []any {
	a := make([]any, len(ws))
	for i, w := range ws {
		a[i] = w
	}
	return a
}

// ── func literals ───────────────────────────────────────────────────

// parseFuncLit parses `func(params) [ret] { body }` with the function
// scope active (params -> $1.., fresh vars -> local) and returns an expr
// carrying the lowered body.
func (p *parser) parseFuncLit() *expr {
	p.expect(tIdent, "func")
	p.expect(tPunct, "(")
	params := p.parseFuncParams()
	if p.variadicParam != "" {
		p.variadicParam = ""
		p.failf("variadic func literal unsupported (v2) — use a top-level func decl")
	}
	// optional return type: T | pkg.T | []T | *T | (T, U) — erased
	p.skipReturnType()
	saveParams, saveOrd, saveLocals, saveIn := p.fnParams, p.fnParamOrd, p.fnLocals, p.inFunc
	p.fnParams = map[string]bool{}
	p.fnParamOrd = nil
	p.fnLocals = map[string]bool{}
	p.inFunc = true
	for _, prm := range params {
		p.fnParams[prm] = true
		p.fnParamOrd = append(p.fnParamOrd, prm)
	}
	body := p.parseBlockStmts()
	p.fnParams, p.fnParamOrd, p.fnLocals, p.inFunc = saveParams, saveOrd, saveLocals, saveIn
	return &expr{kind: "func", params: params, body: body}
}

// skipType consumes one Go type expression in its entirety (balanced):
// ident | pkg.T | *T | [N]T | []T | map[K]V | chan/<-chan/chan<- T |
// func(params) ret | (T) | interface{…} | struct{…} | …T. Newlines
// inside are consumed too (multi-line struct/param lists).
//
// This is the type-position ERASURE contract's workhorse: Go types are
// compile-time only and have zero runtime statements in the A1, so a
// parsed-and-dropped type IS the faithful lowering (the same rule the
// empty-interface/scalar-alias/type-param erasures already pin).
// captureTypeText consumes one Go type (same grammar as skipType) and
// returns its BASE type name — the final ident segment with pointer /
// slice / variadic / qualifier marks stripped (`[]*expr` -> "expr",
// `tokKind` -> "tokKind", `map[string]any` -> ""). The struct decl and
// signature capture use it to wire arena chains.
func (p *parser) captureTypeText() string {
	start := p.pos
	p.skipType()
	raw := ""
	for i := start; i < p.pos && i < len(p.toks); i++ {
		raw += p.toks[i].text
	}
	p.lastTypeRaw = strings.TrimSpace(raw)
	base := ""
	for i := start; i < p.pos && i < len(p.toks); i++ {
		if p.toks[i].kind == tIdent {
			base = p.toks[i].text
		}
	}
	// return the base even for still-unknown names: self-referential
	// struct fields (`lhs *expr` inside type expr) resolve later
	return base
}

func (p *parser) isStructType(name string) bool {
	// POINTER returns (`*expr` — parseUnary/parseExpr/parsePrimary):
	// the pointee is the struct type (the golib's own `e :=
	// p.parseUnary()` then `e.isAddrOf = true` field write).
	_, ok := p.structs[strings.TrimPrefix(name, "*")]
	return ok
}

// anyListVar: the resolved name when a var holds an objStore LIST id
// (struct/any elements ride lists, not shell arrays — shell arrays
// String-coerce object elements on write). "" when it's a plain
// array/scalar.
func (p *parser) anyListVar(name string) string {
	rn := p.resolveVar(name)
	if p.anyLists[name] || p.anyLists[rn] {
		return rn
	}
	return ""
}

// anyListReadWord: the word reading an any-list's id — a PARAM holds
// it positionally ($N), a plain var in the store. (anyListVar returns
// the NAME for map-key uses (anyElem); readers need this instead.)
func (p *parser) anyListReadWord(name string) map[string]any {
	if ln := p.anyListVar(name); ln != "" {
		rn := p.resolveVar(name)
		if n, ok := p.paramNumber(name); ok {
			return getVarExpr(strconv.Itoa(n))
		}
		if n, ok := p.paramNumber(rn); ok {
			return getVarExpr(strconv.Itoa(n))
		}
		return getVarExpr(ln)
	}
	return nil
}

// isAnyListElem: slice element types whose values ride objStore LIST
// ids (not shell arrays, which String-coerce elements on write —
// structs as object refs, `any` (may hold objects), maps (assoc refs
// or inline objects)). Pointers (`*`, `*T`) ride shell arrays as
// arena-id strings; scalars ride as items. "" never qualifies.
func (p *parser) isAnyListElem(elem string) bool {
	if elem == "" || elem == "*" || strings.HasPrefix(elem, "*") {
		return false
	}
	if elem == "any" || elem == "map" || strings.HasPrefix(elem, "map[") {
		return true
	}
	return p.isStructType(elem)
}

// peekSliceElem: the element type of a `[]T` / `[N]T` slice literal or
// make() at the current position (the token after `[`/`]`). "" when
// not a slice header.
func (p *parser) peekSliceElem() string {
	if p.tok().kind != tPunct || p.tok().text != "[" {
		return ""
	}
	j := p.pos + 1
	if j < len(p.toks) && p.toks[j].kind == tNum {
		j++
	}
	if j >= len(p.toks) || p.toks[j].kind != tPunct || p.toks[j].text != "]" {
		return ""
	}
	j++
	if j >= len(p.toks) {
		return ""
	}
	t := p.toks[j]
	if (t.kind == tPunct || t.kind == tOp) && t.text == "*" {
		return "*"
	}
	if t.kind == tIdent {
		if j+2 < len(p.toks) && p.toks[j+1].kind == tPunct && p.toks[j+1].text == "." && p.toks[j+2].kind == tIdent {
			return t.text + "." + p.toks[j+2].text
		}
		return t.text
	}
	// NESTED or exotic element shapes (`[][]byte`, `[]func()`) stay on
	// the shell-array path ("") — only plain ident/dotted/star
	// elements route to list storage via isAnyListElem.
	return ""
}

// callFirstListElem: element base when the callee's FIRST result slot
// is a NON-scalar slice (`[]token` → `token`); "" otherwise (scalars,
// pointers, non-slices, unknown). Scalar/pointer elements ride shell
// arrays (space-joined items); struct elements ride list ids, which bind
// directly through the generic positional path (no item split).
func (p *parser) callFirstListElem(callee string, retIds []string) string {
	// LIST-riding results are SLICE-typed first slots with non-scalar
	// elements (`[]token`, `[]any`, `[]map[string]any` — elements ride
	// a list id, not space-joined items). Scalar/pointer elements ride
	// shell arrays; plain (non-slice) struct/map values ride their own
	// assoc/object paths — so slice-ness gates every arm below (a
	// `(token, bool)` multi-return must NOT mark its target a list).
	sliceRet := false
	if sig, ok := p.fnSig[callee]; ok && len(sig) > 1 && strings.HasPrefix(sig[1], "[]") {
		sliceRet = true
	}
	if strings.HasPrefix(p.prescanRet[callee], "[]") {
		sliceRet = true
	}
	if !sliceRet {
		return ""
	}
	rt := ""
	if len(retIds) > 0 {
		rt = retIds[0]
		if i := strings.LastIndex(rt, "."); i >= 0 {
			rt = rt[i+1:]
		}
	} else {
		// forward ref with only raw text: element after the [] prefix
		// (`[]any` → `any`, `[]map[string]any` → `map`, `[]pkg.T` → T).
		rt = strings.TrimPrefix(p.prescanRet[callee], "[]")
		if i := strings.LastIndex(rt, "."); i >= 0 && !strings.HasPrefix(rt, "map[") {
			rt = rt[i+1:]
		}
		if strings.HasPrefix(rt, "map[") {
			rt = "map"
		}
	}
	if strings.HasPrefix(rt, "*") {
		// pointer elements (`[]*expr`) ride shell arrays as arena-id
		// strings — the items path, never the list-id path.
		return ""
	}
	if rt == "any" || rt == "map" {
		return rt
	}
	if rt == "" || !p.isStructType(rt) {
		return ""
	}
	return rt
}

func (p *parser) knownScalarType(name string) bool {
	switch name {
	case "", "string", "bool", "error", "byte", "rune", "any":
		return true
	}
	if strings.HasPrefix(name, "int") || strings.HasPrefix(name, "uint") ||
		strings.HasPrefix(name, "float") {
		return true
	}
	return false
}

func (p *parser) skipType() {
	p.skipNL()
	switch {
	case p.atPunct("*"): // pointer type *T
		p.pos++
		p.skipType()
	case p.atPunct("..."): // variadic ...T
		p.pos++
		p.skipType()
	case p.atPunct("<-"): // <-chan T
		p.pos++
		p.skipNL()
		if p.atIdent("chan") {
			p.pos++
			p.skipNL()
			if !p.atPunct("(") && !p.atPunct("{") && !p.atPunct(",") &&
				!p.atPunct(")") && !p.atPunct("]") && !p.atPunct("}") &&
				p.tok().kind != tNL && p.tok().kind != tEOF {
				p.skipType()
			}
		} else {
			p.skipType()
		}
	case p.atPunct("("): // parenthesized type / multi-value return list
		p.skipBalanced("(", ")")
	case p.atPunct("["): // []T | [N]T | [...]T
		p.skipBalanced("[", "]")
		p.skipNL()
		// an element type follows unless we're at an expr boundary
		if !p.atBoundary() {
			p.skipType()
		}
	case p.tok().kind == tIdent:
		switch p.tok().text {
		case "map": // map[K]V
			p.pos++
			p.skipNL()
			p.skipBalanced("[", "]")
			p.skipNL()
			p.skipType()
		case "chan": // chan T | chan<- T
			p.pos++
			p.skipNL()
			if p.atPunct("<-") {
				p.pos++
				p.skipNL()
			}
			if !p.atBoundary() {
				p.skipType()
			}
		case "interface", "struct": // interface{…} | struct{…}
			p.pos++
			p.skipNL()
			p.skipBalanced("{", "}")
		case "func": // func(params) ret
			p.pos++
			p.skipNL()
			if p.atPunct("(") {
				p.skipBalanced("(", ")")
			}
			p.skipNL()
			// optional result type
			if !p.atBoundary() {
				p.skipType()
			}
		default: // ident | pkg.T | pkg.T[T]
			p.next()
			p.skipNL()
			for p.atPunct(".") && p.toks[p.pos+1].kind == tIdent {
				p.pos += 2
				p.skipNL()
			}
			if p.atPunct("[") {
				p.skipBalanced("[", "]")
			}
		}
	default:
		p.failf("expected a type, got %q", p.tok().text)
	}
}

// atBoundary reports whether the cursor sits where a type cannot start
// (statement/expression boundaries after a complete type or receiver).
func (p *parser) atBoundary() bool {
	t := p.tok()
	if t.kind == tNL || t.kind == tEOF {
		return true
	}
	switch t.text {
	case "{", "}", ")", "]", ",", ";", ":", "=", ":=":
		return true
	}
	return false
}

// skipBalanced consumes from the opening punct through its matching
// close (nesting-aware over () [] {}).
func (p *parser) skipBalanced(open, close string) {
	p.skipNL()
	if !p.acceptPunct(open) {
		p.failf("expected %q, got %q", open, p.tok().text)
	}
	depth := 1
	for depth > 0 {
		t := p.next()
		if t.kind == tEOF {
			p.failf("unterminated %q…%q group", open, close)
		}
		if t.kind == tPunct {
			switch t.text {
			case "(", "[", "{":
				depth++
			case ")", "]", "}":
				depth--
			}
		}
	}
}

// skipReturnType consumes an optional Go result type in return position
// (after a parameter list): none | T | (T, U) | ([]byte, error) etc.
func (p *parser) skipReturnType() {
	p.skipNL()
	if p.atPunct("{") || p.atBoundary() {
		return
	}
	p.skipType()
}

// parseFuncParamsWithTypes: parseFuncParams plus signature capture —
// each param's base type text is recorded (struct-typed params register
// in varStruct so field access resolves), and the return type lands in
// p.lastSig for call-site var typing. The receiver (methods) becomes
// the FIRST param.
func (p *parser) parseFuncParamsWithTypes(recvName, recvType string) []string {
	savePT := p.paramTypes
	p.paramTypes = map[string]string{}
	params := p.parseFuncParams()
	// receiver first
	if recvType != "" {
		base := recvType
		for i := len(recvType) - 1; i >= 0; i-- {
			if recvType[i] == '*' || recvType[i] == ']' {
				base = recvType[i+1:]
				break
			}
		}
		params = append([]string{recvName}, params...)
		p.paramTypes[recvName] = base
	}
	ret := p.captureReturnTypeText()
	p.lastSig = [2]string{paramsCSV(params), ret}
	// paramTypes stays set for the decl-site registration loop; the
	// caller restores it.
	_ = savePT
	return params
}

func paramsCSV(ps []string) string {
	out := ""
	for _, s := range ps {
		if out != "" {
			out += ","
		}
		out += s
	}
	return out
}

func (p *parser) captureReturnTypeText() string {
	start := p.pos
	p.skipReturnType()
	var ids []string
	slice := false
	// a MAP return (`map[string]any` — the golib's word builders):
	// return the full raw text so call sites bind the target as a
	// NAMED ASSOC array (the `[` in map[ must NOT trip the slice flag)
	if start < len(p.toks) && p.toks[start].kind == tIdent && p.toks[start].text == "map" &&
		start+1 < len(p.toks) && p.toks[start+1].kind == tPunct && p.toks[start+1].text == "[" {
		var b strings.Builder
		for i := start; i < p.pos && i < len(p.toks); i++ {
			b.WriteString(p.toks[i].text)
		}
		return b.String()
	}
	for i := start; i < p.pos && i < len(p.toks); i++ {
		if p.toks[i].kind == tIdent {
			id := p.toks[i].text
			// a POINTER element (`[]*expr`) keeps its `*` so
			// callFirstListElem returns "" (pointer elements ride shell
			// arrays as arena-id strings, never the list-id path) —
			// without it `[]*expr` is misread as a struct-slice.
			if i > 0 && p.toks[i-1].kind == tPunct && p.toks[i-1].text == "*" {
				id = "*" + id
			}
			ids = append(ids, id)
		}
		if (p.toks[i].kind == tPunct || p.toks[i].kind == tOp) && p.toks[i].text == "[" {
			slice = true
		}
	}
	if len(ids) > 0 {
		// per-POSITION bases recorded for call-site typing (`(T, bool)`
		// arms the comma-ok target Bool; struct bases arm dotted paths)
		p.lastRetIds = ids
	}
	base := ""
	if len(ids) > 0 {
		base = ids[len(ids)-1]
	}
	if slice {
		// a SLICE return ([]T): keep the prefix — call-site var typing
		// routes []T results to Array store vars so ranging/slicing
		// lowers through param("slice", …)
		return "[]" + base
	}
	return base
}

func (p *parser) parseFuncParams() []string {
	var params []string
	p.skipNL()
	for !p.atPunct(")") {
		if p.tok().kind == tEOF {
			p.failf("unterminated parameter list")
		}
		if p.atPunct("(") {
			p.pos++
			params = append(params, p.parseFuncParams()...)
			p.skipNL()
			continue
		}
		// Grouped spec `a, b string` and unnamed types (*T, []any,
		// ...any): collect leading idents, then erase one shared type.
		names := []string{}
		for {
			if p.tok().kind == tIdent {
				names = append(names, p.next().text)
				p.skipNL()
				if p.atPunct("...") {
					// `name ...T` variadic marker — the name is NOT a fixed
					// $N positional; the type still erases below ("..." rides
					// into skipType's variadic form).
					p.variadicParam = names[len(names)-1]
					names = names[:len(names)-1]
				}
				if !p.acceptPunct(",") {
					break
				}
				p.skipNL()
				continue
			}
			break
		}
		if len(names) > 0 && (p.atPunct(")") || p.atPunct(",")) {
			// bare idents with no following type (e.g. `(a, b)` style)
			if p.acceptPunct(",") {
				p.skipNL()
				for _, nm := range names {
					params = append(params, nm)
				}
				continue
			}
			for _, nm := range names {
				params = append(params, nm)
			}
			break
		}
		// the (possibly shared) type — erased under the A1 erasure
		// contract; only the NAMES become $N params. The BASE type name
		// is recorded so struct-typed params resolve field access.
		ft := p.captureTypeText()
		for _, nm2 := range names {
			if p.paramTypes != nil {
				p.paramTypes[nm2] = ft
			}
			// a map[...] parameter indexes through the associative store —
			// register it so m["key"] reads lower to assocGet (c-sh-go's
			// `func isBreakStmt(m map[string]any)`). lastTypeRaw carries
			// the full `map[K]V` text (captureTypeText returns only the
			// base ident)
			if strings.HasPrefix(p.lastTypeRaw, "map[") {
				p.maps[nm2] = true
			}
			// a SLICE param (`args []*expr` — the golib's own
			// execFromArgs) ranges over an array store
			if p.lastTypeRaw != "" && strings.HasPrefix(p.lastTypeRaw, "[]") && p.paramSlice != nil {
				p.paramSlice[nm2] = true
				// LIST-element slice params (`[]any`,
				// `[]map[string]any`, `[]tok` — toAnyStmts): the arg
				// rides a list id — mark it so len/index/range
				// lower through listGet.
				pelem := strings.TrimPrefix(p.lastTypeRaw, "[]")
				if strings.HasPrefix(pelem, "map[") {
					pelem = "map"
				}
				if p.isAnyListElem(pelem) {
					p.anyLists[nm2] = true
					p.anyElem[nm2] = pelem
				} else {
					// a shadowing param rebinds storage (see
					// parseVarDecl).
					delete(p.anyLists, nm2)
					delete(p.anyElem, nm2)
				}
			}
		}
		params = append(params, names...)
		p.skipNL()
		if !p.acceptPunct(",") {
			break
		}
		p.skipNL()
	}
	p.expect(tPunct, ")")
	return params
}

// paramNumber maps a param name to its $N position.
func (p *parser) paramNumber(name string) (int, bool) {
	if !p.fnParams[name] {
		return 0, false
	}
	for i, prm := range p.fnParamOrd {
		if prm == name {
			return i + 1, true
		}
	}
	return 0, false
}

// paramName: the store name a var read should use — a param maps to
// its $N positional (the exec-arg protocol), everything else to the
// resolved name. Every var-read lowering must go through this so a
// param read inside a function body sees the caller's argument, not a
// never-written store var.
func (p *parser) paramName(name string) string {
	rn := p.resolveVar(name)
	if n, ok := p.paramNumber(rn); ok {
		return strconv.Itoa(n)
	}
	return rn
}

// condVarRef: the quoted shell read of a condition variable —
// FUNCTION PARAMS ride as positionals ($1/$2, the exec-arg protocol;
// a named $ok read would fold to "" under never-written analysis and
// never see the caller's value), named store vars as $name.
func (p *parser) condVarRef(name string) string {
	rn := p.resolveVar(name)
	if n, ok := p.paramNumber(rn); ok {
		return "$" + strconv.Itoa(n)
	}
	return "$" + rn
}

// ── statement parsing ───────────────────────────────────────────────

// parseImportSpec: one import spec — `[alias] "path"` (`_` blank and
// `.` dot imports bind no name and are not recorded). The default alias
// is the path's last segment (`"fmt"` -> `fmt`).
func (p *parser) parseImportSpec() {
	alias := ""
	dot := false
	t := p.tok()
	if t.kind == tIdent {
		alias = t.text
		p.pos++
	} else if t.kind == tPunct && t.text == "." {
		dot = true
		p.pos++
	}
	t = p.tok()
	if t.kind != tStr && t.kind != tRawStr {
		// not an import spec — leave it for the surrounding parse
		// (Refuse > guess at the use site).
		return
	}
	path := t.text
	p.pos++
	if dot || alias == "_" {
		// `.` dot imports bind no qualifier; `_` blank imports are
		// side-effect only — neither introduces a callable name.
		return
	}
	if alias == "" {
		alias = path
		if i := strings.LastIndex(alias, "/"); i >= 0 {
			alias = alias[i+1:]
		}
	}
	if alias != "" {
		p.importAlias[alias] = path
	}
}

// isExternalAlias: base is an import alias for a NON-stdlib path — a
// dot in the first path segment (`github.com/…`, not `fmt`/`os`/
// `strings`). A call `alias.F(args)` targets a function in ANOTHER
// compilation unit whose body is not in this input.
func (p *parser) isExternalAlias(base string) bool {
	path, ok := p.importAlias[base]
	if !ok || path == "" {
		return false
	}
	seg := path
	if i := strings.Index(seg, "/"); i >= 0 {
		seg = seg[:i]
	}
	return strings.Contains(seg, ".")
}

func (p *parser) parseTopLevel() []map[string]any {
	var __ptlOut []map[string]any
	var __ptlFunc []map[string]any
	var __ptlDecl []map[string]any
	// STMT-LIST accumulators (reserved __ptl prefix — no user collision):
	// mark any-list so `return append(...)` routes through returnAppendList
	// (list ids + freeze) instead of legacy scalar capture (strands).
	p.anyLists["__ptlOut"] = true
	p.anyLists["__ptlFunc"] = true
	p.anyLists["__ptlDecl"] = true
	for {
		p.skipNL()
		t := p.tok()
		if t.kind == tEOF {
			// ORDER: top-level const/var DECLS first (the core's lift
			// folds a pure decl into the module binding's init — a
			// const read at load must see its value, not the empty
			// store), then every Function (the CLI's main body runs
			// before the package functions in source order when files
			// are concatenated — main.go first — and the runtime
			// registers subs at their Function statement, so a call
			// before registration is "command not found"), then the
			// entry statements (main's body).
			return append(append(__ptlDecl, __ptlFunc...), __ptlOut...)
		}
		switch {
		case p.atPunct("{") || p.atPunct("}"):
			p.pos++ // func main's braces / bare blocks
		case p.atIdent("package"):
			p.pos++
			p.skipToLineEnd()
		case p.atIdent("import"):
			// import "fmt" / import ( "fmt" \n "strings" ) /
			// import golib "github.com/…" — record alias -> path
			// (the EXTERNAL-UNIT call lowering needs the alias; the
			// clause itself emits nothing — t71).
			p.pos++
			p.skipNL()
			if p.atPunct("(") {
				p.pos++
				for {
					p.skipNL()
					if p.atPunct(")") || p.tok().kind == tEOF {
						break
					}
					p.parseImportSpec()
					p.skipToLineEnd()
				}
				p.expect(tPunct, ")")
			} else {
				p.parseImportSpec()
				p.skipToLineEnd()
			}
		case p.atIdent("func"):
			// IIFE statement inside main's body (`func() { ... }()`):
			// main's body shares this dispatch loop, and a bare `func`
			// here would misread as a decl (the `(` as a receiver
			// list). A `(` group followed by `{` is a literal —
			// named decls can't nest in a body (illegal Go), so
			// this is unambiguous. (Nested bodies route through
			// parseStmt's own `func` case.)
			if p.funcLitAhead() {
				__ptlOut = append(__ptlOut, p.parseIIFEStmt()...)
				// `continue` (not `break`): this is a switch case inside
				// the top-level for loop — `break` would break the
				// LOOP (the frontend lowers it as an A1 Break), but Go's
				// switch-break only exits the case. `continue` continues
				// the for loop, which is the same effect.
				continue
			}
			// top-level func decl `func name[typeParams](params) [ret] { body }`
			// — lowers to the same Function sub as the t22/t23 func
			// literals. Generic decls (grammar typeParameters, call-site
			// typeArgs — core request go-sh-typeargs): type parameters are
			// erased under the A1 erasure contract, which only lowers
			// type-INDEPENDENT bodies (erasure is faithful there). `main`
			// stays the entry: its body parses as top-level statements
			// Method decls `func (r T) m(...)`: lowered as a plain sub
			// whose FIRST param is the receiver (an arena index for
			// struct types — pointer semantics come free, since field
			// reads/writes go through the receiver's subscript). Call
			// sites pass the receiver explicitly.
			p.pos++
			p.skipNL()
			recvName, recvType := "", ""
			if p.atPunct("(") {
				p.pos++
				p.skipNL()
				if p.atPunct("*") {
					// pointer receiver: `(p *Parser)` — the * rides
					// before the type name
					p.pos++
				}
				recvName = p.expect(tIdent, "").text
				p.skipNL()
				recvType = p.captureTypeText()
				p.expect(tPunct, ")")
				p.skipNL()
			}
			nm := p.expect(tIdent, "").text
			if nm == "main" {
				p.skipToLineEnd()
				// `continue` (not `break`): see the funcLitAhead case —
				// a switch-break must not break the top-level loop.
				continue
			}
			// type parameters [T any] — erased (no runtime form)
			if p.atPunct("[") {
				p.pos++ // [
				p.skipNL()
				for !p.atPunct("]") {
					if p.tok().kind == tEOF {
						p.failf("unterminated type parameter list (v2)")
					}
					p.pos++
				}
				p.expect(tPunct, "]")
				p.skipNL()
			}
			p.expect(tPunct, "(")
			params := p.parseFuncParamsWithTypes(recvName, recvType)
			// commit the signature BEFORE body parse so recursive
			// self-calls (`e := p.parseUnary()` inside parseUnary) type
			// their results
			p.fnSig[nm] = p.lastSig
			// lastRetIds owns its backing array (built fresh per decl
			// parse), so a direct share is safe — and avoids the
			// append-spread form the dotted/word paths refuse
			p.fnRetIdents[nm] = p.lastRetIds
			saveCur := p.curFn
			p.curFn = nm
			// variadic tail param (`parts ...string`): splice the remaining
			// positionals into a real array var at function entry so reads,
			// len(), indexing and f(parts...) spreads all see a genuine
			// array (the ${@:N} positional slice)
			vari := ""
			if p.variadicParam != "" {
				vari = p.variadicParam
				p.variadicParam = ""
			}
			// optional return type: T | []T | *T | (T, error) — erased
			// under the same type-position contract as the params
			// (WithTypes already captured it into p.lastSig)
			p.skipReturnType()
			p.skipNL()
			// function scope (mirrors parseFuncLit)
			saveParams, saveOrd, saveLocals, saveIn := p.fnParams, p.fnParamOrd, p.fnLocals, p.inFunc
			saveVarTypes := p.varTypes
			p.fnParams = map[string]bool{}
			p.fnParamOrd = nil
			p.fnLocals = map[string]bool{}
			p.varTypes = map[string]string{}
			p.inFunc = true
			for _, prm := range params {
				p.fnParams[prm] = true
				p.fnParamOrd = append(p.fnParamOrd, prm)
				if pt := p.paramTypes[prm]; pt != "" {
					if p.isStructType(pt) {
						rn := p.resolveVar(prm)
						p.varStruct[rn] = pt
					}
					// SCALAR param typing drives the condition lowerings
					// (`if ok {` on a bool param tests "$1"=="true",
					// not non-emptiness) and arith operand shapes
					switch {
					case pt == "bool":
						p.registerVar(prm, "Bool")
					case strings.HasPrefix(pt, "int"), strings.HasPrefix(pt, "uint"),
						strings.HasPrefix(pt, "float"),
						pt == "byte", pt == "rune":
						// byte/rune ARE integers (Go) — Int, so
						// arith/char-compare/string() lowerings treat
						// them numerically (the lexer's isIdentStart
						// byte param was untyped → lexicographic).
						p.registerVar(prm, "Int")
					case pt == "string", pt == "error":
						p.registerVar(prm, "Str")
					}
				}
				// a SLICE param (`args []*expr`) is an Array store var —
				// ranges, len() and appends lower through the array shapes
				if p.paramSlice[prm] {
					p.registerVar(prm, "Array")
				}
			}
			body := []map[string]any{}
			if vari != "" {
				p.registerVar(vari, "Array")
				body = append(body, assignStmt(vari, map[string]any{
					"type": "Call", "func": "setArray",
					"args": []any{strExpr(vari), map[string]any{
						"type":     "Array",
						"elements": []any{paramCall("slice", "@", strconv.Itoa(len(params)+1), "")},
					}},
					"purity": "Emulable",
				}))
			}
			body = append(body, p.parseBlockStmts()...)
			p.curFn = saveCur
			p.fnParams, p.fnParamOrd, p.fnLocals, p.inFunc = saveParams, saveOrd, saveLocals, saveIn
			p.varTypes = saveVarTypes
			p.fnNames[nm] = true
			__ptlFunc = append(__ptlFunc, map[string]any{"type": "Function", "name": nm, "params": params, "body": body})
		case p.atIdent("type"):
			// [see parseTypeDecl for the erasure contract]
			p.parseTypeDecl()
		case p.atIdent("const"):
			// `const x = expr` / `const ( specs )` — Go compile-time
			// constants (FRONTEND-GAP: the old path fell through to
			// parseStmt and died on `tEOF tokKind = iota` → "unexpected
			// token tokKind after expression"). Each name lowers to an
			// Assign of its evaluated value — see parseConstDecl. These
			// go to __ptlDecl (emitted FIRST — the core's lift folds a
			// pure decl into the module binding's init).
			__ptlDecl = append(__ptlDecl, p.parseConstDecl()...)
		case p.atIdent("var"):
			// top-level var decls — same decl-first ordering (the
			// golib's `var debugNoRecover string` etc.)
			__ptlDecl = append(__ptlDecl, p.parseVarDecl()...)
		default:
			__ptlOut = append(__ptlOut, p.parseStmt()...)
		}
	}
}

// isByteValued: the expression carries a Go byte/int code (not a
// string) — string(X) over it is chr, not identity. Conservative:
// known Int/Byte vars+params, byteAt reads, char codes are NOT strings
// (char text IS the char — identity there); strings/slices/unknowns
// are not byte-valued (legacy identity).
func (p *parser) isByteValued(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "num":
		// string(65) is Go-legal (vets warn) — chr per rune semantics.
		return true
	case "var":
		rn := p.resolveVar(e.name)
		tt := p.varTypes[rn]
		if tt == "" {
			tt = p.varTypes[e.name]
		}
		if tt == "" {
			// unregistered param — fall back to the declared type
			// (byte/rune params missed registration before it
			// covered them; `string(c)` must still be chr).
			if pt := p.paramTypes[rn]; pt == "byte" || pt == "rune" ||
				strings.HasPrefix(pt, "int") || strings.HasPrefix(pt, "uint") {
				return true
			}
			if pt := p.paramTypes[e.name]; pt == "byte" || pt == "rune" ||
				strings.HasPrefix(pt, "int") || strings.HasPrefix(pt, "uint") {
				return true
			}
		}
		return tt == "Int" || tt == "Byte"
	case "index":
		// byte read: index into a string var/param. Array elements
		// are strings (identity); unknowns stay legacy.
		if e.target != nil && e.target.kind == "var" {
			rn := p.resolveVar(e.target.name)
			tt := p.varTypes[rn]
			if tt == "" {
				tt = p.varTypes[e.target.name]
			}
			if tt == "Str" {
				return true
			}
		}
		return false
	default:
		return false
	}
}

// parseTypeDecl — `type Name <underlying>`: a TYPE DECLARATION:
// compile-time only, zero runtime statements. The faithful A1 lowering
// is ERASURE (parse the full underlying type, emit nothing) — the same
// contract already pinned for empty interfaces (t80/t82/t84/t85),
// scalar aliases (`type tokKind int`) and generic type parameters.
// Supported underlying forms:
//
//	interface{…}   — empty OR method-set body (a method SPEC is
//	                 itself compile-time only; method DISPATCH on
//	                 values stays refused at its use sites)
//	struct{…}      — field list, erased field by field
//	T | pkg.T      — scalar/named alias
//
// Composite value-shapes (map/[]/*/func/chan underlying types) also
// erase here — the DECLARATION is inert; only a VALUE of such a type
// needs a runtime shape, and those stay gated at their use sites
// (Refuse > guess). Also `type ( … )` groups. Valid in BOTH top-level
// and STATEMENT position (`type dotTgt struct{…}` local to a func —
// go-sh.go's own multi-target restore); the layout registers globally
// either way.
func (p *parser) parseTypeDecl() []map[string]any {
	p.pos++
	p.skipNL()
	if p.atPunct("(") { // grouped decls: every spec erases
		p.skipBalanced("(", ")")
		return nil
	}
	p.expect(tIdent, "") // Name
	nm := p.toks[p.pos-1].text
	p.skipNL()
	if p.atIdent("struct") {
		// `type Name struct { f1, f2 T; f3 U }` — capture the
		// FIELD ORDER: the layout drives the arena encoding
		// (field i lives at slot (inst-1)*len(fields)+i).
		p.pos++
		p.skipNL()
		p.expect(tPunct, "{")
		fields, ftypes, fraws := []string{}, []string{}, []string{}
		for {
			p.skipNL()
			if p.atPunct("}") {
				p.pos++
				break
			}
			names := []string{}
			for p.tok().kind == tIdent {
				names = append(names, p.next().text)
				p.skipNL()
				if !p.acceptPunct(",") {
					break
				}
				p.skipNL()
			}
			if len(names) == 0 {
				p.failf("unsupported struct field (v2)")
			}
			ft := p.captureTypeText() // base type name drives chains
			fr := p.lastTypeRaw       // raw text drives list/map dispatch
			// struct TAG (encoding/json backquoted metadata): compile-time
			// only — skip it (shir-emit-go's exported Program fields)
			if p.tok().kind == tRawStr {
				p.pos++
			}
			fields = append(fields, names...)
			for range names {
				ftypes = append(ftypes, ft)
				fraws = append(fraws, fr)
			}
		}
		if nm != "_" {
			p.structs[nm] = fields
			p.structFT[nm] = ftypes
			p.structRaw[nm] = fraws
			// the self-hosting contract's maps: positional composite
			// literals read structFields (name→field order); element
			// index-reads read structFieldTypes (field→element type)
			p.structFields[nm] = fields
			ftm := map[string]string{}
			for i, f := range fields {
				ftm[f] = ftypes[i]
			}
			p.structFieldTypes[nm] = ftm
		}
		return nil
	}
	if p.tok().kind == tIdent {
		// scalar/named alias: if it aliases a KNOWN struct, the
		// name inherits that layout (type tokKind int-style
		// aliases stay plain erasure)
		if base, ok := p.structs[p.tok().text]; ok {
			p.structs[nm] = base
		}
		p.skipType()
		return nil
	}
	p.failf("unsupported type declaration (v2) — expected a type after %q", "name")
	return nil
}

func (p *parser) skipToLineEnd() {
	for p.tok().kind != tNL && p.tok().kind != tEOF {
		p.pos++
	}
}

func (p *parser) parseStmt() []map[string]any {
	p.skipNL()
	t := p.tok()

	if t.line >= 1500 && t.line <= 1525 {
	}
	if t.line >= 1300 && t.line <= 1345 {
	}
	if t.kind == tPunct && t.text == ";" {
		p.pos++ // empty statement
		return nil
	}
	if t.kind != tIdent {
		// `*p = v` / `*out = ...` pointer writes: the OBJECT STORE could
		// model them (objSet over the id) — support the common
		// slice-append form `*x = append(*x, ...)` and refuse the rest
		// POINTER WRITE: `*p = v` / `*p = append(*p, ...)` — the ref id
		// in p names the aliased store slot; derefSet/appendTo mutate it
		if (t.kind == tPunct || t.kind == tOp) && t.text == "*" {
			p.pos++
			ptrName := p.resolveVar(p.expect(tIdent, "").text)
			idWord := getVarExpr(ptrName)
			p.skipNL()
			p.expect(tPunct, "=")
			p.skipNL()
			rhs := p.parseExpr()
			if rhs.kind == "call" && rhs.callee == "append" && len(rhs.args) >= 1 &&
				rhs.args[0].kind == "deref" && rhs.args[0].lhs != nil &&
				rhs.args[0].lhs.kind == "var" &&
				p.resolveVar(rhs.args[0].lhs.name) == ptrName {
				var elems []any
				var pre []map[string]any
				for _, a := range rhs.args[1:] {
					switch a.kind {
					case "maplit", "arraylit":
						tmpC, allocStmts := p.allocComposite(a)
						pre = append(pre, allocStmts...)
						elems = append(elems, getVarExpr(tmpC))
					default:
						elems = append(elems, p.exprToWord(a))
					}
				}
				args2 := []any{idWord}
				args2 = append(args2, elems...)
				out3 := pre
				out3 = append(out3, map[string]any{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": "appendTo",
						"args":   args2,
						"purity": "PureCpu",
					},
				})
				return out3
			}
			w2 := p.exprToWord(rhs)
			return []map[string]any{{
				"type": "Expr",
				"expr": map[string]any{
					"type": "Call", "func": "derefSet",
					"args":   []any{idWord, w2},
					"purity": "PureCpu",
				},
			}}
		}
		p.failf("unsupported statement starting with %q (v2)", t.text)
	}
	switch t.text {
	case "if":
		return p.parseIf()
	case "for":
		return p.parseFor()
	case "switch":
		return p.parseSwitch()
	case "return":
		p.pos++
		// BARE return check FIRST — before skipNL: a bare `return` that
		// ends a switch-case body is followed by NL + `case`, and eating
		// the newline here made the parser swallow the next case's cond
		// as an expression ("unexpected token c after expression")
		if p.atPunct(";") || p.atPunct("}") || p.tok().kind == tNL || p.tok().kind == tEOF {
			p.skipNL()
			// BARE return (always void — the subset has no named
				// results): STOP the sub with no value echo. (An echo
				// "" here leaked into enclosing captures, and the
				// missing stop fell through — self-host
				// skipReturnType ran skipType past `func f() {`.)
			return []map[string]any{map[string]any{
				"type": "Expr",
				"expr": map[string]any{
					"type": "Call", "func": "return",
					"args":   []any{},
					"purity": "Spawn",
				},
			}}
		}
		p.skipNL()
		// `return w1[, w2…]` — the A1 lowers return to echo (a shell sub
		// returns via stdout), so multiple result values map to multiple
		// echo WORDS — the same channel a shell function uses to hand
		// back several values. TRAILING empty results (the idiomatic
		// `, nil` error return) drop entirely: an echoed empty word would
		// leave a stray blank inside a capture (`q=$(f …)` diverging from
		// native stdout byte-for-byte).
		var rexprs []*expr
		for {
			rexprs = append(rexprs, p.parseExpr())
			if !p.acceptPunct(",") {
				break
			}
			p.skipNL()
		}
		for len(rexprs) > 1 {
			last := rexprs[len(rexprs)-1]
			empty := (last.kind == "var" && last.name == "nil") ||
				((last.kind == "str" || last.kind == "rawstr") && last.text == "")
			if !empty {
				break
			}
			rexprs = rexprs[:len(rexprs)-1]
		}
		// PREDICATE returns (`return c == '_' || ...`, `return true`) —
		// a bool-returning sub signals via EXIT STATUS (sh2.return 0/1):
		// callers in condition position exec the sub and branch on $?
		if len(rexprs) == 1 && p.inFunc && (p.isPredicateExpr(rexprs[0]) || p.isBoolLitReturn(rexprs[0])) {
			// STATUS-ONLY predicate return: the sub signals via exit
			// status (Return 0/1). Value-position callers wrap the exec
			// with a $?→"true"/"false" echo (userCallWord), so nested
			// predicate calls compose without stdout pollution. The sub
			// registers in p.boolFuncs for that call-site rewrite.
			if p.curFn != "" {
				p.boolFuncs[p.curFn] = true
			}
			flag := "__bt_" + strconv.Itoa(p.tmpN)
			p.tmpN++
			p.registerVar(flag, "Str")
			stmts := p.boolTreeStmts(rexprs[0], flag)
			stmts = append(stmts, []map[string]any{{
				"type":   "If",
				"cond":   testCall("\"$" + flag + "\"==\"true\""),
				"then":   []map[string]any{{"type": "Return", "value": strExpr("0")}},
				"elsifs": []any{},
				"else":   []map[string]any{{"type": "Return", "value": strExpr("1")}},
			}}...)
			return stmts
		}
		var words []map[string]any
		var preEcho []map[string]any
		for _, e := range rexprs {
			// unwrap the addr wrapper (`return &T{...}` — parseUnary
			// always wraps; newstructStmts unwraps the same way).
			lit := e
			if lit.kind == "addr" && lit.lhs != nil {
				lit = lit.lhs
			}
			if lit != nil && lit.kind == "structlit" && lit.structType != "" {
				// ARENA-shape struct value (parsePrimary T{...} —
				// every `return &expr{...}` in self-host): allocate
				// the object via the store, exactly like the assign
				// path, into a temp and echo its id — the caller
				// reads fields via objGet, identical to `p := T{}`.
				tmpS := "__tmp_s" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.registerVar(tmpS, "Str")
				preEcho = append(preEcho, p.newstructStmts(tmpS, lit)...)
				words = append(words, getVarExpr(tmpS))
				continue
			}
			if e.kind == "maplit" {
				// a map literal as a return VALUE (shir-emit-go's
				// EmitToMap): allocate a temp assoc array (one assocSet
				// per pair) and echo its NAME — the A1 map model.
				// MapLiteral is a Perl-only ext node; the JS ingress
				// rejects it.
				tmpM := "__tmp_m" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.maps[tmpM] = true
				// MARK the temp as a compile-time node (an EMITTED
				// assocSet — a codegen-time Go write would stay
				// native-only and never reach the self-hosted
				// store). Runs in any body (methods + plain funcs)
				// since the set is global.
				preEcho = append(preEcho, map[string]any{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": "assocSet",
						"args":   []any{strExpr("nodeTemps"), strExpr(tmpM), strExpr("true")},
						"purity": "Emulable",
					},
				})
				p.registerVar(tmpM, "Map")
				for i, k := range e.keys {
					kw := strExpr(strings.Trim(strings.TrimSpace(k.text), "\""))
					preEcho = append(preEcho, map[string]any{
						"type": "Expr",
						"expr": map[string]any{
							"type": "Call", "func": "assocSet",
							"args":   []any{strExpr(tmpM), kw, p.exprToWord(e.vals[i])},
							"purity": "Emulable",
						},
					})
				}
				// SNAPSHOT the finished node (immune to temp reuse:
				// later builds overwrite tmpM before end-freeze).
				// Stored raw (objects survive assocSet).
				preEcho = append(preEcho, map[string]any{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": "assocSet",
						"args": []any{strExpr("__nodeSnaps"), strExpr(tmpM), map[string]any{
							"type": "Call", "func": "snapshotTemp",
							"args":   []any{strExpr(tmpM), strExpr("nodeTemps"), strExpr("sigil,params")},
							"purity": "PureCpu",
						}},
						"purity": "Emulable",
					},
				})
				words = append(words, strExpr(tmpM))
				continue
			}
			if e.kind == "var" && p.varTypes[p.resolveVar(e.name)] == "Array" {
				// returning an ARRAY var (`return out` — the golib's
				// toAnySlice/toAnyStmts): echo the array ITEMS (the
				// var-store read is empty; the array lives in the array
				// store) — the caller's capture+strSplit rebuilds it.
				// Any-list var: echo the LIST ID itself (the id is a
				// plain string — capture-safe; the caller keeps the
				// id and listGet resolves it; echoing items would
				// String-flatten objects).
				if p.anyListVar(e.name) != "" {
					words = append(words, p.exprToWord(e))
					continue
				}
				words = append(words, paramCall("slice", p.resolveVar(e.name), "@", ""))
				continue
			}
			if e.kind == "call" && e.callee == "append" {
				// `return append(...)` over an any-list base
				// (parseTopLevel's decl/func/out assembly): list
				// concatenation into a temp whose id echoes (the
				// legacy array-flatten would String-coerce objects).
				if pre, tmp, ok := p.returnAppendList(e); ok {
					preEcho = append(preEcho, pre...)
					words = append(words, getVarExpr(tmp))
					continue
				}
			}
			words = append(words, p.exprToWord(e))
		}
		// MULTI-slot return (`return a, b`): the value channel is ONE
		// capture stream, so slots join with the RS separator (\036)
		// into a single word — a space join shreds space-bearing values
		// (the golib's Shir JSON document) and shifts every later slot.
		// The caller splits on the same separator (the __mr
		// distribution). Single-slot returns echo plain (unchanged).
		if len(words) > 1 {
			parts := []any{}
			for i, wd := range words {
				if i > 0 {
					parts = append(parts, map[string]any{"kind": "lit", "text": "\036"})
				}
				parts = append(parts, map[string]any{"kind": "expr", "expr": wd})
			}
			words = []map[string]any{{"type": "Interpolate", "parts": parts}}
		}
		out := append(preEcho, execStmt("echo", words, "Emulable"))
		if p.inFunc {
			// EARLY return inside a conditional: the echo writes the
			// value channel (the sub-stdout convention), the bare
			// return-call STOPS the sub — Go's `return` exits even when
			// more statements follow (a tail return just ends anyway,
			// so the extra stop is a no-op there). Without it an
			// `if c { return x }` fell through to the tail code.
			out = append(out, map[string]any{
				"type": "Expr",
				"expr": map[string]any{
					"type": "Call", "func": "return",
					"args":   []any{},
					"purity": "Spawn",
				},
			})
		}
		return out
	case "continue":
		// A1 Continue node (mirrors Command::Continue(None) in the core):
		// a bare `continue` inside a loop body. Labeled `continue L` is
		// refused (the A1 node has no label/level field).
		p.pos++
		if p.tok().kind == tIdent {
			p.failf("labeled continue unsupported (v2)")
		}
		return []map[string]any{{"type": "Continue"}}
	case "type":
		// local type declaration — same parse-and-erase contract as the
		// top-level form (compile-time only, registers the layout)
		return p.parseTypeDecl()
	case "goto":
		// A1 Goto node (the core contract has it; estree renders native
		// JS labeled continue semantics via the runtime's goto support)
		p.pos++
		lbl := p.expect(tIdent, "").text
		return []map[string]any{map[string]any{"type": "Goto", "name": lbl}}
	case "break":
		// A1 Break node; labeled break lowers to Goto when a matching
		// label exists (goto/Label contract)
		p.pos++
		if p.tok().kind == tIdent {
			lbl := p.next().text
			return []map[string]any{map[string]any{"type": "Goto", "name": lbl}}
		}
		return []map[string]any{{"type": "Break"}}
	case "__break_legacy__":
		// A1 Break node (shir_json_in "Break" -> IrStmt::Break — the
		// core contract already has it; the estree/C renderers emit
		// `break;`). Labeled `break L` is refused, like continue.
		p.pos++
		if p.tok().kind == tIdent {
			p.failf("labeled break unsupported (v2)")
		}
		return []map[string]any{{"type": "Break"}}
	case "go":
		return p.parseGo()
	case "func":
		// immediately-invoked func literal `func(...) {...}(args)` —
		// the IIFE statement form: a private sub + synchronous call.
		// Subs share the store, so captures read/write outer vars;
		// return scopes to the sub (Go semantics). A bare
		// non-invoked literal is not a statement — refuse.
		return p.parseIIFEStmt()
	case "var":
		return p.parseVarDecl()
	case "const":
		return p.parseConstDecl()
	case "case", "default":
		p.failf("'%s' outside switch", t.text)
	}
	// LABELED statement `name:` (goto target) → A1 Label node
	if p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == ":" {
		lbl := p.next().text
		p.pos++ // :
		out := []map[string]any{map[string]any{"type": "Label", "name": lbl}}
		if !p.atBoundary() && !p.atPunct("}") {
			out = append(out, p.parseStmt()...)
		}
		return out
	}
	if p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "." {
		return p.parseDottedStmt()
	}
	return p.parseAssignStmt()
}

// parseConstDecl: `const x = expr` / `const ( specs )` — Go compile-time
// constants. The A1 contract has no const/iota node, so each name lowers
// to an Assign of its EVALUATED value — the same shape as `var x =
// literal` (the A1 is dynamically typed; a tokKind value is a plain
// scalar). iota counts specs inside the ConstDecl starting at 0; a spec
// without an expression repeats the previous spec's expression with the
// current iota substituted (Go ConstSpec semantics). Supported RHS:
// iota, integer literals (with unary - and + - * / folding), and string
// literals — anything else refuses loudly (Refuse > guess).
func (p *parser) parseConstDecl() []map[string]any {
	p.expect(tIdent, "const")
	var out []map[string]any
	if p.atPunct("(") {
		p.pos++
		var prev *expr
		for iotaIdx := 0; ; iotaIdx++ {
			p.skipNL()
			if p.atPunct(")") {
				p.pos++
				return out
			}
			if p.tok().kind == tEOF {
				p.failf("unterminated const block")
			}
			if p.atPunct(";") {
				p.pos++ // empty spec separator
				continue
			}
			prev = p.parseConstSpec(iotaIdx, prev, &out)
		}
	}
	// single spec: `const x = expr` (iota is 0; nothing to repeat)
	p.parseConstSpec(0, nil, &out)
	return out
}

// parseConstSpec: one `Name [Type] [= expr]` spec. The optional type
// position is erased (like every type position); the expression is
// evaluated via constWord and emitted as an Assign. Returns the spec's
// expression so a following `Name` (no `=`) can repeat it with iota.
func (p *parser) parseConstSpec(iotaIdx int, prev *expr, out *[]map[string]any) *expr {
	name := p.expect(tIdent, "").text
	if p.atPunct(",") {
		p.failf("const spec with multiple names (v2)")
	}
	// optional type: pkg.Ident | plain ident | []T | *T — the same sweep
	// as parseVarDecl (the erasure contract: a tokKind VALUE is untyped
	// in the A1, so the type position is dropped).
	for {
		t := p.tok()
		if t.kind == tIdent && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "." {
			p.next() // pkg
			p.next() // .
			p.expect(tIdent, "")
			continue
		}
		if t.kind == tIdent && (p.toks[p.pos+1].kind != tPunct || p.toks[p.pos+1].text == "=") {
			p.pos++ // plain type ident
			continue
		}
		if t.kind == tPunct && (t.text == "[" || t.text == "*") {
			p.pos++
			p.skipNL()
			if t.text == "[" {
				// []T / [N]T — consume through the closing bracket, then
				// the element type (the old sweep only handled `[` followed
				// directly by an ident, so `[]tok` broke at the empty pair)
				for !p.atPunct("]") {
					if p.tok().kind == tEOF {
						p.failf("unterminated array type (v2)")
					}
					p.pos++
				}
				p.pos++ // ]
				p.skipNL()
			}
			for p.tok().kind == tIdent {
				p.next()
			}
			// NO skipNL here: the newline terminates the type — skipping
			// it would let the sweep's `continue` consume the NEXT line's
			// identifier as a plain type (`const x []string` followed by
			// `line = 1` ate `line`)
			continue
		}
		break
	}
	p.skipNL()
	if p.atPunct("=") {
		p.pos++
		p.skipNL()
		prev = p.parseExpr()
	} else if prev == nil {
		p.failf("const %q has no expression and nothing to repeat (v2)", name)
	}
	w, typ := p.constWord(prev, iotaIdx)
	p.registerVar(name, typ)
	// record the evaluated value so a later spec can reference the const
	// (`e = c + 1` — Go resolves consts in declaration order).
	if v := p.constValue(prev, iotaIdx); v.ok {
		if v.isStr {
			p.constStrs[name] = v.s
		} else {
			p.consts[name] = v.n
		}
	}
	*out = append(*out, assignStmt(name, w))
	return prev
}

// constWord: compile-time evaluation of a const RHS (Go consts are
// compile-time). `iota` → the spec's index; integer literals (with unary
// - and + - * / folding); string literals; and references to earlier
// consts in the same program. Anything else refuses loudly — an
// un-evaluated const would silently mis-lower (Refuse > guess).
func (p *parser) constWord(e *expr, iotaVal int) (map[string]any, string) {
	v := p.constValue(e, iotaVal)
	if !v.ok {
		p.failf("unsupported const expression (v2): %s", p.constExprDesc(e))
	}
	if v.isStr {
		return interpLit(v.s), "Str"
	}
	return strExpr(strconv.Itoa(v.n)), "Int"
}

// constVal: an evaluated const value — an int (n) or a string (s).
// ok=false means the expression is outside the const subset.
type constVal struct {
	n     int
	s     string
	isStr bool
	ok    bool
}

// constValue: fold a const RHS to its value.
func (p *parser) constValue(e *expr, iotaVal int) constVal {
	switch e.kind {
	case "var":
		if e.name == "iota" {
			return constVal{n: iotaVal, ok: true}
		}
		if n, ok := p.consts[e.name]; ok {
			return constVal{n: n, ok: true}
		}
		if s, ok := p.constStrs[e.name]; ok {
			return constVal{s: s, isStr: true, ok: true}
		}
	case "num":
		if n, err := strconv.ParseInt(e.text, 0, 64); err == nil {
			return constVal{n: int(n), ok: true}
		}
	case "str":
		return constVal{s: e.text, isStr: true, ok: true}
	case "rawstr":
		return constVal{s: e.text, isStr: true, ok: true}
	case "neg":
		if l := p.constValue(e.lhs, iotaVal); l.ok && !l.isStr {
			return constVal{n: -l.n, ok: true}
		}
	case "add", "mul":
		l := p.constValue(e.lhs, iotaVal)
		r := p.constValue(e.rhs, iotaVal)
		if !l.ok || !r.ok || l.isStr || r.isStr {
			return constVal{}
		}
		switch e.op {
		case "+":
			return constVal{n: l.n + r.n, ok: true}
		case "-":
			return constVal{n: l.n - r.n, ok: true}
		case "*":
			return constVal{n: l.n * r.n, ok: true}
		case "/":
			if r.n != 0 {
				return constVal{n: l.n / r.n, ok: true}
			}
		}
	}
	return constVal{}
}

// constExprDesc: a human-readable description of an expression, for
// refusal messages.
func (p *parser) constExprDesc(e *expr) string {
	if e == nil {
		return "<nil>"
	}
	switch e.kind {
	case "var":
		return e.name
	case "num", "str", "rawstr":
		return e.text
	case "neg":
		return "-" + p.constExprDesc(e.lhs)
	case "add", "mul":
		return p.constExprDesc(e.lhs) + " " + e.op + " " + p.constExprDesc(e.rhs)
	}
	return e.kind
}

// parseVarDecl: `var a, b [type] [= init]` — bare declarations register
// the names (""), bytes.Buffer registers a buffer accumulator (t56).
func (p *parser) parseVarDecl() []map[string]any {
	p.expect(tIdent, "var")
	p.skipNL()
	// var group: `var ( \n x int \n s = "hi" \n )` — each spec is a
	// full var decl; the type position still erases.
	if p.atPunct("(") {
		p.pos++
		var out []map[string]any
		for {
			p.skipNL()
			if p.atPunct(")") {
				p.pos++
				return out
			}
			if p.tok().kind == tEOF {
				p.failf("unterminated var group")
			}
			out = append(out, p.parseVarSpec()...)
		}
	}
	return p.parseVarSpec()
}

// parseVarSpec parses one `name[, name…] [type] [= expr]` spec (the
// shared body of single and grouped var decls). The optional type is
// erased under the A1 erasure contract; the initializer lowers as an
// ordinary assignment. Composite-literal initializers reuse the array/
// map literal lowerings from the := path.
func (p *parser) parseVarSpec() []map[string]any {
	var names []string
	for {
		names = append(names, p.expect(tIdent, "").text)
		if !p.acceptPunct(",") {
			break
		}
		p.skipNL()
	}
	// optional type: pkg.Ident (bytes.Buffer) | plain ident | []T | *T
	// | map[K]V | interface{…} — ERASED under the A1 type-position
	// contract (same rule as params/returns). bytes.Buffer /
	// strings.Builder additionally arm the buffer side-state.
	p.skipNL()
	isBuf := false
	if len(names) > 0 && names[0] == "f" {
	}
	for {
		t := p.tok()
		if t.kind == tIdent && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "." {
			pkg := p.next().text
			p.next() // .
			typ := p.expect(tIdent, "").text
			if (pkg == "bytes" && typ == "Buffer") || (pkg == "strings" && typ == "Builder") {
				isBuf = true
			}
			continue
		}
		break
	}
	isSliceDecl := false
	sliceElem := ""
	if p.tok().kind == tPunct && p.tok().text == "[" {
		isSliceDecl = true
		sliceElem = p.peekSliceElem()
	}
	// a `var x map[K]V` declaration binds x as a NAMED ASSOC array so
	// x["key"] reads lower to assocGet (the golib's own `var w
	// map[string]any` word locals)
	isMapDecl := false
	if p.tok().kind == tIdent && p.tok().text == "map" &&
		p.pos+1 < len(p.toks) && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "[" {
		isMapDecl = true
	}
	if t := p.tok(); !(t.kind == tNL || t.kind == tEOF ||
		(t.kind == tPunct && (t.text == "=" || t.text == ")"))) {
		p.skipType()
	}
	var out []map[string]any
	for _, n := range names {
		// a fresh declaration ESTABLISHES storage: clear any stale
		// list marking from another function's same-named local (the
		// parser's maps are global — objNewCall's `names := []any{}`
		// poisoned parseVarSpec's `var names []string` into listPush).
		// Branches below re-mark genuine lists.
		delete(p.anyLists, n)
		delete(p.anyElem, n)
		if isSliceDecl {
			p.registerVar(n, "Array")
		} else if isMapDecl {
			p.maps[n] = true
			p.registerVar(n, "Map")
		} else {
			p.registerVar(n, "Str")
		}
		if isBuf {
			p.bufs[n] = ""
			out = append(out, assignStmt(n, p.objNewCallNamed("bytes.Buffer",
				[]any{strExpr("buf")}, []any{strExpr("")})))
			continue
		}
		if isSliceDecl {
			if p.isAnyListElem(sliceElem) {
				// LIST-element slice (`var out []tok`, `var out []any`,
				// `var out []map[string]any`): elements ride a LIST id
				// (shell arrays String-coerce object elements).
				p.anyLists[n] = true
				p.anyElem[n] = sliceElem
				out = append(out, assignStmt(n,
					map[string]any{"type": "Call", "func": "listNew", "args": []any{}, "purity": "PureCpu"}))
				continue
			}
			// a `var x []T` declaration initializes the ARRAY store (the
			// appends/reads use the array store — a var-store "" would
			// lose every appended item; the dogfood app's own
			// `var out []map[string]any` in parseTopLevel)
			out = append(out, assignStmt(n, map[string]any{
				"type": "Call", "func": "setArray",
				"args":   []any{strExpr(n), map[string]any{"type": "Array", "elements": []any{}}},
				"purity": "Emulable",
			}))
			continue
		}
		out = append(out, assignStmt(n, strExpr("")))
	}
	// optional initializer: var b = expr — composite-literal forms
	// reuse the same drop-in lowerings as the := path (assocSet pairs
	// for maps, setArray for slices).
	p.skipNL()
	if p.atPunct("=") {
		p.pos++
		p.skipNL()
		if len(names) != 1 {
			p.failf("var decl initializer with multiple targets (v2)")
		}
		if p.atIdent("map") {
			// consume the map[K]V header, then share the assocSet body
			p.pos++ // map
			p.skipNL()
			p.skipBalanced("[", "]")
			for p.tok().kind == tIdent {
				p.next() // value type
			}
			return p.parseMapLiteralBody(names[0])
		}
		if p.atPunct("[") && !p.byteSliceLitAhead() {
			elems, typ := p.parseArrayLiteral()
			p.arrays[names[0]] = arrayInfo{elems: elems, typ: typ}
			p.registerVar(names[0], "Array")
			return []map[string]any{assignStmt(names[0],
				map[string]any{
					"type": "Call", "func": "setArray",
					"args":   []any{strExpr(names[0]), map[string]any{"type": "Array", "elements": elems}},
					"purity": "Emulable",
				})}
		}
		rhs := p.parseExpr()
		// re := regexp.MustCompile(`pat`) — track the pattern so
		// FindString/MatchString methods lower to RegexpFind/regexMatch
		if rhs.kind == "call" &&
			(rhs.callee == "regexp.MustCompile" || rhs.callee == "regexp.Compile") {
			if len(rhs.args) == 1 && (rhs.args[0].kind == "rawstr" || rhs.args[0].kind == "str") {
				p.regexpVars[names[0]] = rhs.args[0].text
				p.registerVar(names[0], "Str")
				// the var holds the pattern TEXT (Go's compiled object
				// has no A1 twin; FindString/MatchString lower from the
				// tracked pattern, so the stored value is inert)
				return []map[string]any{assignStmt(names[0], strExpr(rhs.args[0].text))}
			}
		}
		w := p.exprToWord(rhs)
		p.registerVar(names[0], p.wordType(w))
		if rhs.kind == "call" && p.isCgoCallee(rhs.callee) {
			p.cgoObjs[names[0]] = true // the var holds a native object id
		}
		return []map[string]any{assignStmt(names[0], w)}
	}
	return out
}

func (p *parser) parseBlockStmts() []map[string]any {
	p.expect(tPunct, "{")
	return p.parseBlockStmtsRest()
}

// parseBlockStmtsRest parses statements until the block's closing `}`
// (the `{` already consumed). Handles `defer func(){…}()`: Go's defer
// lowers to an A1 Try wrapping the block's REMAINING statements — the
// defer body is the except clause when it calls recover() (the golib's
// panic-recovery idioms: run's err capture, safeCondTestString's named
// return reset), else the finally clause (the alias-restore cleanup in
// parseTypeSwitchBody). recover() inside the deferred body reads the
// caught value via the except's `as` binding (the core renders it as
// sh2.setVar into the store).
func (p *parser) parseBlockStmtsRest() []map[string]any {
	out := []map[string]any{}
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			return out
		}
		if p.atPunct(";") {
			p.pos++ // a `;` statement separator (the golib's one-line bodies)
			continue
		}
		if p.tok().kind == tEOF {
			p.failf("unterminated block")
		}
		if p.atIdent("defer") {
			p.pos++
			p.skipNL()
			if !p.atIdent("func") {
				p.failf("defer needs a func literal (v2)")
			}
			asName := "__dfr_" + strconv.Itoa(p.tmpN)
			p.tmpN++
			saveRcv, saveUsed := p.deferRecover, p.deferUsedRcv
			p.deferRecover = asName
			p.deferUsedRcv = false
			fn := p.parseFuncLit()
			usedRcv := p.deferUsedRcv
			p.deferRecover, p.deferUsedRcv = saveRcv, saveUsed
			p.skipNL()
			p.expect(tPunct, "(")
			p.skipNL()
			p.expect(tPunct, ")")
			// the block's remaining statements become the Try body
			rest := p.parseBlockStmtsRest()
			if usedRcv {
				out = append(out, map[string]any{
					"type": "Try",
					"body": rest,
					"excepts": []any{map[string]any{
						"type":  "TryExcept",
						"match": nil,
						"as":    asName,
						"body":  fn.body,
					}},
					"else":    []any{},
					"finally": []any{},
				})
			} else {
				out = append(out, map[string]any{
					"type":    "Try",
					"body":    rest,
					"excepts": []any{},
					"else":    []any{},
					"finally": fn.body,
				})
			}
			return out
		}
		out = append(out, p.parseStmt()...)
	}
}

// ── dotted-callee statements ────────────────────────────────────────

func (p *parser) parseDottedStmt() []map[string]any {
	first := p.next().text
	p.expect(tPunct, ".")
	method := p.expect(tIdent, "").text
	// p.pos++ — a member INCREMENT (the golib's 91 `p.pos++`): the
	// jsonSet write-back, NOT a method call.
	if p.atPunct("++") {
		p.pos++
		p.registerVar(first, "Struct")
		// STRUCT-typed base with a KNOWN field (`r.n++`, the golib's
		// `p.pos++`): the field lives in the OBJECT STORE
		// (objNew-allocated) — objAdd reads the field, adds 1, writes
		// back. The jsonSet write-back below targets JSON-string
		// structs; on a store id it JSON-parses "" and clobbers the
		// binding to "" (self-host infinite loop).
		if rn := p.resolveVar(first); p.varStruct[rn] != "" {
			if off := structFieldIndex(p.structs[p.varStruct[rn]], method); off >= 0 {
				return []map[string]any{{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": "objAdd",
						"args":   []any{p.structIDWord(first), strExpr(method), strExpr("1")},
						"purity": "PureCpu",
					},
				}}
			}
		}
		return []map[string]any{assignStmt(first, map[string]any{
			"type": "Call", "func": "jsonSet",
			"args": []any{
				strExpr(p.resolveVar(first)), strExpr(method),
				arithWrap(arithBin(arithVar(first), "+", arithNum(1))),
			},
			"purity": "PureCpu",
		})}
	}
	// p.parseExpr() — a METHOD call on a struct (the go-sh self-hosting
	// contract): the receiver rides BY VALUE (structIDWord — the
	// method body's field accesses use positional[0] as the object id
	// directly; 1546 such uses vs zero name-resolutions).
	// The `(` is REQUIRED: without it the statement is a field WRITE
	// (`p.pos += 3`, `p.f = v`) on a registered receiver — after any
	// `p.x++` the receiver's varTypes entry is "Struct", and letting
	// this branch hijack the write made the lexer's `p.pos += 3` die
	// with `expected "(", got "+="` (the objAdd lowering lives further
	// down in the struct-write block, which this branch shadowed).
	if p.varTypes[p.resolveVar(first)] == "Struct" && p.atPunct("(") {
		p.expect(tPunct, "(")
		args := p.parseArgs()
		var words []map[string]any
		words = append(words, p.structIDWord(first))
		for _, a := range args {
			words = append(words, p.exprToWord(a))
		}
		stmt := execStmt(method, words, "Spawn")
		if p.methodReturnsValue(method) {
			// BARE call to a value-returning method (Go discards
			// the value): swallow the callee's stdout echo (its
			// return channel) in a capture, else it leaks into an
			// enclosing capture (self-host: `p.expect(tIdent,
			// "var")` echoed the var token into declStmts,
			// corrupting the Program stmts).
			stmt = map[string]any{
				"type": "Expr",
				"expr": map[string]any{
					"type": "Call", "func": "capture",
					"args":   []any{map[string]any{"type": "Arrow", "body": []any{stmt}}},
					"purity": "Spawn",
				},
			}
		}
		return []map[string]any{stmt}
	}
	switch first + "." + method {
	case "fmt.Println", "fmt.Print":
		return p.printlnStmt()
	case "fmt.Fprintln":
		return p.fprintlnStmt()
	case "fmt.Fprintf":
		return p.fprintfStmt()
	case "fmt.Printf":
		return p.printfStmt()
	case "os.WriteFile":
		return p.writeFileStmt()
	case "os.Setenv":
		return p.setenvStmt()
	case "os.Exit":
		return p.exitStmt()
	case "os.ReadDir":
		// os.ReadDir(dir) → capture of `ls -1 dir` (the "captured
		// multi-line return" convention; names-only listing)
		p.expect(tPunct, "(")
		p.skipNL()
		dirW := p.exprToWord(p.parseExpr())
		p.skipNL()
		p.expect(tPunct, ")")
		return []map[string]any{execStmt("ls", []map[string]any{strExpr("-1"), dirW}, "Spawn")}
	case "debug.PrintStack":
		// debug.PrintStack() — the runtime/debug stack dump in run()'s
		// panic recovery: a no-op in the transpiled program (the stack
		// trace is a debugging aid, not observable output)
		p.expect(tPunct, "(")
		p.skipNL()
		p.expect(tPunct, ")")
		return nil
	case "sort.Strings":
		// sort.Strings(s) — sort an array in place (shir-emit-go's
		// SortedKeys): the runtime sortStrings on the array-store var
		p.expect(tPunct, "(")
		p.skipNL()
		arg := p.parseExpr()
		p.skipNL()
		p.expect(tPunct, ")")
		return []map[string]any{{
			"type": "Expr",
			"expr": map[string]any{
				"type": "Call", "func": "sortStrings",
				"args":   []any{p.exprToWord(arg)},
				"purity": "PureCpu",
			},
		}}
	}
	// x.Do(func() { … }) on a sync.Once — run ONCE per process: the
	// guard-var idiom (`"$__once_x" != "1"` gates an assignment+body;
	// powershell-sh-go's langOnce lazy grammar load)
	if method == "Do" && p.atPunct("(") {
		p.pos++ // (
		p.skipNL()
		if p.atIdent("func") {
			fl := p.parseFuncLit()
			p.expect(tPunct, ")") // close Do(
			flag := "__once_" + p.resolveVar(first)
			p.registerVar(flag, "Str")
			body := []map[string]any{assignStmt(flag, strExpr("1"))}
			body = append(body, fl.body...)
			return []map[string]any{{
				"type":   "If",
				"cond":   testCall("\"${" + flag + "}\"!=\"1\""),
				"then":   []any{map[string]any{"type": "Block", "body": body}},
				"elsifs": []any{},
				"else":   []any{},
			}}
		}
		p.failf("sync.Once.Do needs a func literal (v2)")
	}
	// os.Stdout.Write(x) — raw bytes to stdout, no trailing newline:
	// the `printf '%s' x` shape (byte-faithful for the corpus;
	// os.Stdout.Write([]byte{'\n'}) emits the bare newline)
	if first == "os" && method == "Stdout" && p.atPunct(".") {
		p.pos++ // .
		m2 := p.expect(tIdent, "").text
		if m2 == "Write" {
			// the byte-slice literal form ([]byte{"there"}, []byte{'\n'})
			// decodes the elements to the RAW bytes (a char element is the
			// CHARACTER, not its code — the newline terminator writes a
			// newline); other args ride the word channel (the var form:
			// []byte(s))
			return p.stdoutWriteStmt()
		}
		p.failf("unsupported os.Stdout.%s (v2)", m2)
	}
	// b.WriteString(...) on a bytes.Buffer → append to the accumulator
	// (the literal-only contract keeps the contents statically known).
	if _, ok := p.bufs[first]; ok {
		switch method {
		case "WriteString", "Write", "WriteByte":
			p.expect(tPunct, "(")
			p.skipNL()
			a := p.parseExpr()
			p.skipNL()
			p.expect(tPunct, ")")
			if a.kind == "str" || a.kind == "num" || a.kind == "rawstr" {
				// literal write keeps the compile-time accumulator
				p.bufs[first] += a.text
				return nil
			}
			// DYNAMIC writes (WriteByte(c)): the buffer is an OBJECT
			// whose buf field concatenates at runtime (Interpolate =
			// native template literal; WriteByte of a byte value prints
			// the character — Go string(byte) equivalence for ASCII).
			// WriteByte takes a byte BY CONSTRUCTION, so chr() the
			// word unconditionally (byteAt yields codes; appending the
			// code built "104104…" for "hi" self-hosted). WriteString
			// appends text (no chr).
			p.bufDyn[first] = true
			idw := getVarExpr(p.resolveVar(first))
			cur := map[string]any{
				"type": "Call", "func": "objGet",
				"args":   []any{idw, strExpr("buf")},
				"purity": "PureCpu",
			}
			av := p.exprToWord(a)
			if method == "WriteByte" {
				av = map[string]any{
					"type": "Call", "func": "chr",
					"args":   []any{av},
					"purity": "PureCpu",
				}
			}
			cat := interpParts([]any{
				map[string]any{"kind": "expr", "expr": cur},
				map[string]any{"kind": "expr", "expr": av},
			})
			return []map[string]any{{
				"type": "Expr",
				"expr": map[string]any{
					"type": "Call", "func": "objSet",
					"args":   []any{idw, strExpr("buf"), cat},
					"purity": "PureCpu",
				},
			}}
		}
		p.failf("unsupported bytes.Buffer.%s (v2)", method)
	}
	// cmd := exec.Command(...) handles: Start → (…) & , Wait → wait
	// (t44: the deterministic background idiom, mirroring the posix
	// `(echo bg) & wait; echo main` shape node-for-node).
	if args, ok := p.cmds[first]; ok {
		switch method {
		case "Start":
			p.expect(tPunct, "(")
			p.skipNL()
			p.expect(tPunct, ")")
			return []map[string]any{{
				"type": "Background",
				"body": []any{map[string]any{
					"type": "Subshell",
					"body": []any{p.execFromArgs(args)},
				}},
			}}
		case "Wait":
			p.expect(tPunct, "(")
			p.skipNL()
			p.expect(tPunct, ")")
			return []map[string]any{execStmt("wait", []map[string]any{}, "Spawn")}
		case "Stdout":
			// cmd.Stdout = os.Stdout — Go children discard stdout unless
			// wired up; shell commands INHERIT stdout by default, so the
			// assignment is a no-op for the lowering (t44).
			p.skipNL()
			p.expect(tPunct, "=")
			p.skipNL()
			p.expect(tIdent, "os")
			p.expect(tPunct, ".")
			p.expect(tIdent, "Stdout")
			return nil
		}
	}
	// STRUCT RECEIVER: method call `p.m(args)` — the receiver rides as
	// $1 (an arena index; field mutation through it is the pointer
	// semantics), the method is a plain sub.
	if rn := p.resolveVar(first); p.varStruct[rn] != "" && p.fnNames[method] {
		p.expect(tPunct, "(")
		args := p.parseArgs()
		var words []map[string]any
		words = append(words, p.structIDWord(first))
		for _, a := range args {
			words = append(words, p.argToWord(a))
		}
		stmt := execStmt(method, words, "Spawn")
		if p.methodReturnsValue(method) {
			// BARE call to a value-returning method (Go discards
			// the value): swallow the callee's stdout echo (its
			// return channel) in a capture, else it leaks into an
			// enclosing capture (self-host: `p.expect(tIdent,
			// "var")` echoed the var token into declStmts,
			// corrupting the Program stmts).
			stmt = map[string]any{
				"type": "Expr",
				"expr": map[string]any{
					"type": "Call", "func": "capture",
					"args":   []any{map[string]any{"type": "Arrow", "body": []any{stmt}}},
					"purity": "Spawn",
				},
			}
		}
		return []map[string]any{stmt}
	}
	// struct field WRITE forms: `p.f = v` / `p.f++` / `p.f += n` /
	// `l.toks = append(l.toks, ...)` — the OBJECT STORE model: one
	// objSet / objAdd / listPush call per write.
	if rn := p.resolveVar(first); p.varStruct[rn] != "" {
		typeName := p.varStruct[rn]
		layout := p.structs[typeName]
		if off := structFieldIndex(layout, method); off >= 0 {
			idWord := p.structIDWord(first)
			fieldWord := strExpr(method)
			objSetStmt := func(valWord map[string]any) map[string]any {
				return map[string]any{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": "objSet",
						"args":   []any{idWord, fieldWord, valWord},
						"purity": "PureCpu",
					},
				}
			}
			// MULTI dotted-target restore: `p.a, p.b, p.c = v1, v2, v3`
			if p.atPunct(",") {
				type dotTgt struct {
					idw map[string]any
					fld map[string]any
				}
				tgts := []dotTgt{{idWord, fieldWord}}
				for p.acceptPunct(",") {
					p.skipNL()
					b2 := p.expect(tIdent, "").text
					p.expect(tPunct, ".")
					m2 := p.expect(tIdent, "").text
					tgts = append(tgts, dotTgt{p.structIDWord(b2), strExpr(m2)})
				}
				if !p.atPunct("=") {
					p.failf("expected = in multi field write (v2)")
				}
				p.pos++
				out2 := []map[string]any{}
				for i := range tgts {
					p.skipNL()
					vw := p.exprToWord(p.parseExpr())
					st := tgts[i]
					out2 = append(out2, map[string]any{
						"type": "Expr",
						"expr": map[string]any{
							"type": "Call", "func": "objSet",
							"args":   []any{st.idw, st.fld, vw},
							"purity": "PureCpu",
						},
					})
					if i < len(tgts)-1 {
						p.acceptPunct(",")
						p.skipNL()
					}
				}
				return out2
			}
			switch {
			case p.atPunct("["):
				// element write on a field container (`m.f[k] = v`)
				p.pos++
				kw := p.parseExpr()
				// the key rides as a lowered WORD (exprToWord): the raw
				// expr node serializes as its Go struct ({"BOp":"",…}),
				// which the ingress rejects
				kwW := p.exprToWord(kw)
				p.skipNL()
				p.expect(tPunct, "]")
				// NESTED field write: `l[i].Lit += v` — element-of-list
				// field compound assign (zsh-sh-go mergeFragments)
				if p.atPunct(".") {
					save := p.pos
					p.pos++
					if f2 := p.tok(); f2.kind == tIdent {
						nest := f2.text
						p.pos++
						p.skipNL()
						if p.atPunct("+=") || p.atPunct("=") {
							compound := p.tok().text == "+="
							p.pos++
							p.skipNL()
							rhsW := p.exprToWord(p.parseExpr())
							elem := objGetField(idWord, method)
							elem = map[string]any{
								"type": "Call", "func": "listGet",
								"args":   []any{elem, kwW},
								"purity": "PureCpu",
							}
							if compound {
								cur := map[string]any{
									"type": "Call", "func": "objGet",
									"args":   []any{elem, strExpr(nest)},
									"purity": "PureCpu",
								}
								rhsW = interpParts([]any{
									map[string]any{"kind": "expr", "expr": cur},
									map[string]any{"kind": "expr", "expr": rhsW},
								})
							}
							return []map[string]any{{"type": "Expr", "expr": map[string]any{
								"type": "Call", "func": "objSet",
								"args":   []any{elem, strExpr(nest), rhsW},
								"purity": "PureCpu",
							}}}
						}
						p.pos = save
					}
				}
				p.skipNL()
				// DOUBLE-INDEX container (`m.f[i][j] = v`): the second
				// bracket pair refines the element; a PLAIN element write
				// (`m.f[k] = v`, `l[i] = v`) has no second bracket — the
				// unconditional expect here refused every simple write
				// with "expected ], got =" (the zig-sh-go x.arrays[k]
				// frontier). Parse the optional second key instead.
				if p.atPunct("[") {
					p.pos++
					kw = p.parseExpr()
					kwW = p.exprToWord(kw)
					p.skipNL()
					p.expect(tPunct, "]")
				}
				container := objGetField(idWord, method)
				fn := "mapSet"
				elemStr := false
				if raws := p.structRaw[typeName]; off < len(raws) && strings.HasPrefix(raws[off], "[]") {
					fn = "listSet"
					elemStr = strings.HasPrefix(strings.TrimPrefix(raws[off], "[]"), "string")
				} else if raws := p.structRaw[typeName]; off < len(raws) {
					// map[K]V — the VALUE type decides the += semantics
					if vi := strings.LastIndex(raws[off], "]"); vi >= 0 {
						elemStr = strings.HasPrefix(strings.TrimPrefix(raws[off][vi+1:], "*"), "string")
					}
				}
				var rhsW map[string]any
				if p.atPunct("+=") || p.atPunct("=") {
					compound := p.tok().text == "+="
					p.pos++
					p.skipNL()
					rhsW = p.exprToWord(p.parseExpr())
					if compound {
						// m.f[k] += v ≡ m.f[k] = m.f[k] + v — only a
						// STRING-valued container concatenates faithfully
						// (interpParts); numeric elements would string-glue,
						// so they refuse (Refuse > guess)
						if !elemStr {
							p.failf("+= on non-string container elements unsupported (v2)")
						}
						getFn := "mapGet"
						if fn == "listSet" {
							getFn = "listGet"
						}
						rhsW = interpParts([]any{
							map[string]any{"kind": "expr", "expr": map[string]any{
								"type": "Call", "func": getFn,
								"args":   []any{container, kwW},
								"purity": "PureCpu",
							}},
							map[string]any{"kind": "expr", "expr": rhsW},
						})
					}
				} else if p.atPunct("+=") {
					// m.f[k] += v for a STRING-valued container:
					// listGet/mapGet the current element, concatenate,
					// set back (`w.Parts[n-1].Lit += frag` shape)
					if !elemStr {
						p.failf("+= on non-string container elements unsupported (v2)")
					}
					p.pos++
					p.skipNL()
					vw := p.exprToWord(p.parseExpr())
					getFn := "mapGet"
					if fn == "listSet" {
						getFn = "listGet"
					}
					rhsW = interpParts([]any{
						map[string]any{"kind": "expr", "expr": map[string]any{
							"type": "Call", "func": getFn,
							"args":   []any{container, kw},
							"purity": "PureCpu",
						}},
						map[string]any{"kind": "expr", "expr": vw},
					})
				} else {
					p.failf("expected = in element write (v2)")
				}
				return []map[string]any{{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": fn,
						"args":   []any{objGetField(idWord, method), kwW, rhsW},
						"purity": "PureCpu",
					},
				}}
			case p.atPunct("("):
				p.failf("unknown method %q on %q (v2)", method, typeName)
			case p.atPunct("++") || p.atPunct("--"):
				op := p.next().text
				delta := "1"
				if op == "--" {
					delta = "-1"
				}
				return []map[string]any{{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": "objAdd",
						"args":   []any{idWord, fieldWord, strExpr(delta)},
						"purity": "PureCpu",
					},
				}}
			case p.atPunct("=") && p.peekIsAppendCall():
				stmt := p.parseAppendIntoList(idWord, fieldWord, typeName, method)
				return []map[string]any{stmt}
			case p.atPunct("=") || p.atPunct("+=") || p.atPunct("-="):
				op := p.next().text
				p.skipNL()
				rhs := p.parseExpr()
				if op != "=" {
					aw := p.exprToArith(rhs)
					if n, ok := p.arithConstInt(aw); ok {
						d := strconv.Itoa(n)
						if op == "-=" {
							d = "-" + d
						}
						return []map[string]any{{
							"type": "Expr",
							"expr": map[string]any{
								"type": "Call", "func": "objAdd",
								"args":   []any{idWord, fieldWord, strExpr(d)},
								"purity": "PureCpu",
							},
						}}
					}
					// STRING += on a struct field (`w.Text += frag` —
					// appendPlainText): objGet the current value,
					// Interpolate-concatenate, objSet back
					if op == "+=" {
						cur := map[string]any{
							"type": "Call", "func": "objGet",
							"args":   []any{idWord, fieldWord},
							"purity": "PureCpu",
						}
						cat := interpParts([]any{
							map[string]any{"kind": "expr", "expr": cur},
							map[string]any{"kind": "expr", "expr": p.exprToWord(rhs)},
						})
						return []map[string]any{objSetStmt(cat)}
					}
					p.failf("unsupported %s on struct field %s (v2)", op, method)
				}
				return []map[string]any{objSetStmt(p.exprToWord(rhs))}
			}
		}
	}
	ctx := ""
	for k := p.pos - 6; k < p.pos+4 && k >= 0 && k < len(p.toks); k++ {
		if p.toks[k].kind == tNL {
			ctx += "¶"
		} else {
			ctx += p.toks[k].text + " "
		}
	}
	// CGO-PATH: `parser.SetLanguage(lang)` / `tree.RootNode()` on a
	// tracked native object — CgoCall expr stmt (C frontend execution)
	if p.atPunct("(") && p.isCgoCallee(first+"."+method) {
		p.expect(tPunct, "(")
		argsW := []any{strExpr(first + "." + method)}
		if !p.atPunct(")") {
			for {
				p.skipNL()
				argsW = append(argsW, p.exprToWord(p.parseExpr()))
				if !p.acceptPunct(",") {
					break
				}
				p.skipNL()
			}
		}
		p.skipNL()
		p.expect(tPunct, ")")
		return []map[string]any{{"type": "Expr", "expr": map[string]any{
			"type":   "CgoCall",
			"target": strExpr(first + "." + method),
			"args":   argsW,
		}}}
	}
	p.failf("unsupported call %s.%s (v2)", first, method)
	return nil
}

// structIDWord: the reference-id word for a struct-typed variable —
// function params are POSITIONAL ($1..$N), so the name resolves through
// paramNumber exactly like any other read.
func (p *parser) structIDWord(name string) map[string]any {
	rn := p.resolveVar(name)
	if n, ok := p.paramNumber(rn); ok {
		return getVarExpr(strconv.Itoa(n))
	}
	return getVarExpr(rn)
}

// methodReturnsValue: the method declares a Go return value (fnSig
// return text, prescan for forward refs) — a bare statement call
// discards it, so the frontend must swallow the callee's stdout echo.
func (p *parser) methodReturnsValue(meth string) bool {
	if sig, ok := p.fnSig[meth]; ok {
		return sig[1] != ""
	}
	if r, ok := p.prescanRet[meth]; ok {
		return r != ""
	}
	return false
}

// callTargetName: the sub a call expression resolves to ("l.cur" ->
// "cur") when its base is a struct-typed var or the name is a defined
// function directly; "" when this call is not a known target.
func (p *parser) callTargetName(callee string) string {
	if p.fnNames[callee] {
		return callee
	}
	if strings.Contains(callee, ".") {
		dot := strings.LastIndex(callee, ".")
		baseName, meth := callee[:dot], callee[dot+1:]
		if p.varStruct[p.resolveVar(baseName)] != "" && p.fnNames[meth] {
			return meth
		}
		// PACKAGE MODE: `pkg.F` where pkg is a package clause in the
		// concatenated source — the call targets THIS multi-file
		// package's F (cppshgo.Shir with cmd/main.go+main.go+parser.go)
		if p.pkgNames[baseName] && p.fnNames[meth] {
			return meth
		}
		// EXTERNAL-UNIT: `alias.F` where alias imports a non-stdlib
		// package (golib.Shir — the CLI calling the golib in another
		// compilation unit). The body is not in this input, so no
		// signature is known; the call lowers to the bare sub name
		// with the multi-return positional distribution below.
		// DOCUMENTED APPROXIMATION: the emitted sub call resolves
		// only when the callee's unit is linked in (PACKAGE MODE
		// concat); executed paths calling an absent sub fail at
		// runtime — Refuse would be stricter, but the app's no-args
		// path (usage exit before the call) never executes it, and
		// the gate verifies parse + valid A1 + dead code there.
		if p.isExternalAlias(baseName) {
			return meth
		}
	}
	return ""
}

func (p *parser) operandDesc(e *expr) string {
	if e == nil {
		return "<nil>"
	}
	return e.kind
}

// foldAtoi: strconv.Atoi over a literal at emit time.
func foldAtoi(s string) string {
	t := strings.TrimSpace(s)
	if n, err := strconv.ParseInt(t, 10, 64); err == nil {
		return strconv.FormatInt(n, 10)
	}
	return "0"
}

// dirTestPath: the os.ReadDir dir word as a [ ]-test path fragment
// ("$var" for runtime dirs, the literal text for Str words) — the
// fragment used to lower DirEntry.IsDir() to the `-d dir/name` test.
// "" when the dir is not a plain var or literal (Refuse > guess at
// the use site).
func dirTestPath(dirW map[string]any) string {
	if v, ok := dirW["value"].(string); ok && dirW["type"] == "Str" {
		return v
	}
	if a, ok := dirW["args"].([]any); ok && len(a) >= 1 {
		if t, ok2 := dirW["func"].(string); ok2 && t == "getVar" {
			if lit, ok3 := a[0].(map[string]any); ok3 {
				if v, ok4 := lit["value"].(string); ok4 {
					return "$" + v
				}
			}
		}
	}
	return ""
}

// objGetField: objGet word for an object id word + field name.
func objGetField(idWord map[string]any, field string) map[string]any {
	return map[string]any{
		"type": "Call", "func": "objGet",
		"args":   []any{idWord, strExpr(field)},
		"purity": "PureCpu",
	}
}

// peekIsAppendCall: at `=` with `append(` immediately after.
func (p *parser) peekIsAppendCall() bool {
	i := p.pos + 1
	for i < len(p.toks) && p.toks[i].kind == tNL {
		i++
	}
	return i+1 < len(p.toks) &&
		p.toks[i].kind == tIdent && p.toks[i].text == "append" &&
		p.toks[i+1].kind == tPunct && p.toks[i+1].text == "("
}

// parseAppendIntoList: `field = append(field, elems...)` on a
// list-object field — ONE listPush over the CURRENT slice value;
// struct-typed elements ride as reference ids, inner literals allocate
// inline (objNew is an expression).
func (p *parser) parseAppendIntoList(idWord, fieldWord map[string]any, typeName, method string) map[string]any {
	p.expect(tPunct, "=")
	p.skipNL()
	p.expect(tIdent, "append")
	p.expect(tPunct, "(")
	args := p.parseArgs()
	elemType := ""
	for i, f := range p.structs[typeName] {
		if f == method {
			if fts := p.structFT[typeName]; i < len(fts) {
				elemType = fts[i]
			}
		}
	}
	cur := map[string]any{
		"type": "Call", "func": "objGet",
		"args":   []any{idWord, fieldWord},
		"purity": "PureCpu",
	}
	elems := []any{cur}
	var spreads []map[string]any
	for _, a := range args[1:] {
		// variadic spread of a MEMBER list (`x.out = append(x.out,
		// update...)`): listExtend pushes the SOURCE LIST'S ITEMS
		// (a plain listPush would store the ref as one element).
		if a.spread && a.kind == "slice" && a.target != nil && p.memberListType(a.target) != "" {
			spreads = append(spreads, p.memberSliceWord(a))
			continue
		}
		// variadic spread of a VAR holding a list ref (the value came
		// from a member-slice/copy lowering): listExtend resolves the
		// ref and pushes its items.
		if a.spread && a.kind == "var" {
			spreads = append(spreads, p.exprToWord(a))
			continue
		}
		elems = append(elems, p.elemWord(a, elemType))
	}
	pushExpr := map[string]any{
		"type": "Call", "func": "listPush",
		"args":   elems,
		"purity": "PureCpu",
	}
	for _, sw := range spreads {
		pushExpr = map[string]any{
			"type": "Call", "func": "listExtend",
			"args":   []any{pushExpr, sw},
			"purity": "PureCpu",
		}
	}
	// objSet(l, f, listExtend(listPush(objGet(l, f), ...), …)) —
	// listPush returns the (possibly freshly vivified) list id, each
	// listExtend absorbs one spread source, the objSet stores it back
	return map[string]any{
		"type": "Expr",
		"expr": map[string]any{
			"type": "Call", "func": "objSet",
			"args":   []any{idWord, fieldWord, pushExpr},
			"purity": "PureCpu",
		},
	}
}

// allocComposite: lower an anonymous composite (map/slice literal) into
// a temp object/list allocation + population statements. Returns the
// temp name and the statements (empty when not a composite).
func (p *parser) allocComposite(val *expr) (string, []map[string]any) {
	if val.kind == "maplit" {
		tmp := "__tmp_m" + strconv.Itoa(p.tmpN)
		p.tmpN++
		stmts := []map[string]any{assignStmt(tmp, p.objNewCallNamed("map", []any{}, []any{}))}
		for i, k := range val.keys {
			kw := strExpr(strings.Trim(k.text, "\""))
			vw := p.compositeValueWord(val.vals[i], &stmts)
			stmts = append(stmts, map[string]any{
				"type": "Expr",
				"expr": map[string]any{
					"type": "Call", "func": "mapSet",
					"args":   []any{getVarExpr(tmp), kw, vw},
					"purity": "PureCpu",
				},
			})
		}
		return tmp, stmts
	}
	if val.kind == "arraylit" {
		tmp := "__tmp_l" + strconv.Itoa(p.tmpN)
		p.tmpN++
		stmts := []map[string]any{assignStmt(tmp, p.objNewCallNamed("list", []any{}, []any{}))}
		for _, el := range val.elems {
			stmts = append(stmts, map[string]any{
				"type": "Expr",
				"expr": map[string]any{
					"type": "Call", "func": "listPush",
					"args":   []any{getVarExpr(tmp), el},
					"purity": "PureCpu",
				},
			})
		}
		return tmp, stmts
	}
	return "", nil
}

// compositeValueWord: a value INSIDE a composite — words pass through;
// nested composites allocate their own temps (statements appended to
// the prelude).
func (p *parser) compositeValueWord(v *expr, prelude *[]map[string]any) map[string]any {
	switch v.kind {
	case "maplit", "arraylit":
		tmp, stmts := p.allocComposite(v)
		*prelude = append(*prelude, stmts...)
		return getVarExpr(tmp)
	}
	return p.exprToWord(v)
}

// elemWord: a slice-append element — struct-typed vars/objects pass as
// reference ids; inner literals allocate inline.
// memberListType: for `x.f` (member/fieldof), the declared field type
// when the base var's struct declares f as a SLICE ([]…); "" when the
// shape isn't a known struct-field list.
func (p *parser) memberListType(t *expr) string {
	if t == nil || (t.kind != "member" && t.kind != "fieldof") {
		return ""
	}
	parts := strings.Split(t.name, ".")
	if len(parts) != 2 {
		return ""
	}
	tn := p.varStruct[p.resolveVar(parts[0])]
	if tn == "" {
		return ""
	}
	for i, f := range p.structs[tn] {
		if f == parts[1] {
			// structFT stores the BASE ident (captureTypeText strips
			// "[]"/"*"); the RAW text keeps the slice prefix — use it
			// for list dispatch (the field's raw is "[]string" etc.)
			if raws := p.structRaw[tn]; i < len(raws) {
				if strings.HasPrefix(raws[i], "[]") {
					return raws[i]
				}
			}
			if fts := p.structFT[tn]; i < len(fts) {
				if strings.HasPrefix(fts[i], "[]") {
					return fts[i]
				}
			}
		}
	}
	return ""
}

// memberSliceWord: x.f[lo:hi] over a []T struct field — listSlice over
// the field's list ref; a NEW list (Go slice expressions copy).
func (p *parser) memberSliceWord(e *expr) map[string]any {
	parts := strings.Split(e.target.name, ".")
	refW := map[string]any{
		"type": "Call", "func": "objGet",
		"args":   []any{p.structIDWord(parts[0]), strExpr(parts[1])},
		"purity": "PureCpu",
	}
	loW := strExpr("0")
	if e.idx1e != nil {
		loW = p.exprToWord(e.idx1e)
	} else if e.idx1 != "" {
		loW = strExpr(e.idx1)
	}
	hiW := map[string]any{"type": "Call", "func": "listLen", "args": []any{refW}, "purity": "PureCpu"}
	if e.idx2e != nil {
		hiW = p.exprToWord(e.idx2e)
	} else if e.idx2 != "" {
		hiW = strExpr(e.idx2)
	}
	return map[string]any{
		"type": "Call", "func": "listSlice",
		"args":   []any{refW, loW, hiW},
		"purity": "PureCpu",
	}
}

func (p *parser) elemWord(a *expr, elemType string) any {
	lit := a
	if lit.kind == "addr" && lit.lhs != nil && lit.lhs.kind == "structlit" {
		lit = lit.lhs
	}
	if lit.kind == "structlit" {
		return p.objNewCall(lit)
	}
	if lit.kind == "var" && elemType != "" {
		rn := p.resolveVar(lit.name)
		if p.isStructType(elemType) && p.varStruct[rn] != "" {
			return p.structIDWord(lit.name)
		}
	}
	return p.argToWord(a)
}

// inferElemStructType: `x := slice[i]` where slice is a STRUCT-slice
// field/var — x holds that struct's reference id.
func (p *parser) inferElemStructType(rhs *expr) string {
	if rhs == nil || rhs.kind != "index" || rhs.target == nil {
		return ""
	}
	var raw string
	switch rhs.target.kind {
	case "member":
		parts := strings.Split(rhs.target.name, ".")
		baseName := p.resolveVar(parts[0])
		typeName := p.varStruct[baseName]
		if typeName == "" {
			return ""
		}
		field := parts[len(parts)-1]
		raws := p.structRaw[typeName]
		layout := p.structs[typeName]
		for i, f := range layout {
			if f == field && i < len(raws) {
				raw = raws[i]
			}
		}
	case "var":
		_ = raw
	}
	if strings.HasPrefix(raw, "[]") {
		cand := strings.TrimPrefix(raw, "[]")
		cand = strings.TrimPrefix(cand, "*")
		if p.isStructType(cand) {
			return cand
		}
	}
	return ""
}

// hasObjectRead: does this arith chain read an OBJECT field / list /
// map element (values that live outside the store-var world)?
func (p *parser) hasObjectRead(e *expr) bool {
	switch e.kind {
	case "member":
		_, tag := p.structFieldWord(e.name)
		return tag != "none"
	case "index":
		if e.target != nil && e.target.kind == "member" {
			if _, tag := p.structFieldWord(e.target.name); tag == "list" || tag == "map" {
				return true
			}
		}
		return false
	case "fieldof":
		return true
	case "arrlen", "strlen":
		// len(struct.field) is an object read (listLen/objGet chain) —
		// route the enclosing arithmetic through arithNumCalls
		if e.target != nil && e.target.kind == "member" {
			_, tag := p.structFieldWord(e.target.name)
			return tag != "none"
		}
		return false
	case "add", "mul", "neg":
		lhs, rhs := e.lhs, e.rhs
		if p.hasObjectRead(lhs) || (rhs != nil && p.hasObjectRead(rhs)) {
			return true
		}
		return false
	}
	return false
}

// arithNumCalls: arithmetic lowered to runtime num_* calls so object
// reads compose (`i := p.pos + 1`).
func (p *parser) arithNumCalls(e *expr) map[string]any {
	switch e.kind {
	case "num":
		return strExpr(e.text)
	case "var":
		return p.exprToWord(e)
	case "member", "index", "fieldof":
		return p.exprToWord(e)
	case "arrlen", "strlen", "call":
		// len(x)/<buf>.String() inside num_* arithmetic: the word path
		// already handles var targets, member targets and tracked-buffer
		// String() reads — the num_* call coerces the word to a number
		return p.exprToWord(e)
	case "add":
		return map[string]any{"type": "Call", "func": "num_add",
			"args": []any{p.arithNumCalls(e.lhs), p.arithNumCalls(e.rhs)}, "purity": "PureCpu"}
	case "mul":
		return map[string]any{"type": "Call", "func": "num_mul",
			"args": []any{p.arithNumCalls(e.lhs), p.arithNumCalls(e.rhs)}, "purity": "PureCpu"}
	case "neg":
		return map[string]any{"type": "Call", "func": "num_sub",
			"args": []any{strExpr("0"), p.arithNumCalls(e.lhs)}, "purity": "PureCpu"}
	}
	p.failf("non-numeric operand in arithmetic (v2): %s", e.kind)
	return nil
}

// numericWord: a comparison operand lowered to a NUMERIC word — the
// arith node (renders as Number(...)) for arithmetic-lowerable
// operands, the num_* call chain for object reads (member arrlen etc.).
// Go's < <= > >= are always numeric, so the native BinOp Lt/Gt/Le/Ge
// must compare NUMBERS — a plain word comparison would be a JS STRING
// comparison (`"2" < "112"` is false lexicographically).
func (p *parser) numericWord(e *expr) map[string]any {
	switch e.kind {
	case "num", "var", "str":
		// params stay WORDS (getVar("N") reads the positional) —
		// the core wraps BinOp operands in Number(). An Arith Var
		// would read a store var literally ("1" is never written
		// — the lexer's `c >= 'a'` on byte params never matched).
		if e.kind == "var" {
			rn := p.resolveVar(e.name)
			if n, ok := p.paramNumber(rn); ok {
				return getVarExpr(strconv.Itoa(n))
			}
		}
		return arithWrap(p.exprToArith(e))
	case "char":
		// a Go rune literal IS an integer (its code) — numeric.
		if n, err := strconv.Atoi(charCode(e)); err == nil {
			return arithWrap(arithNum(n))
		}
		return arithWrap(p.exprToArith(e))
	case "add", "mul", "neg":
		if p.hasObjectRead(e) {
			// arithmetic over object reads (`p.pos+1`): the num_* call
			// chain (numbers)
			return p.arithNumCalls(e)
		}
		return arithWrap(p.exprToArith(e))
	case "strlen", "arrlen":
		if e.target != nil && e.target.kind == "var" {
			return arithWrap(p.exprToArith(e))
		}
		// member/index/fieldof targets: the condOperandA1Word word
		// (strLen/listLen — numbers)
		if w, ok := p.condOperandA1Word(e); ok {
			return w
		}
		return p.arithNumCalls(e)
	default:
		if w, ok := p.condOperandA1Word(e); ok {
			return w
		}
		return p.arithNumCalls(e)
	}
}

// isNumericCmpOperand: is this comparison operand NUMERIC (so the
// native Lt/Gt/Le/Ge must compare numbers, not strings)? Int-typed
// vars, lengths, numeric literals and arithmetic are numeric; Str-typed
// vars and non-numeric string literals are not (a char comparison like
// `ch >= '0'` compares single ASCII chars by code point — the string
// comparison is exactly Go's byte semantics there).
func (p *parser) isNumericCmpOperand(e *expr) bool {
	switch e.kind {
	case "num":
		return true
	case "var":
		return p.varTypes[p.resolveVar(e.name)] != "Str"
	case "char":
		// a Go rune literal IS an integer — numeric (lexer's
		// `c >= 'a'` must compare codes, not lexicographic text).
		return true
	case "str", "rawstr":
		// a STRING literal is never a numeric comparison operand — Go's
		// `s > "5"` is lexicographic, and a char comparison (`ch >= '0'`)
		// compares single ASCII chars by code point, which the string
		// comparison matches exactly. Treating "0" as the number 0
		// (Atoi) mis-lowered the dogfood lexer's `c >= '0'` to `c >= 0`
		// (the char '0' is 48), and "a" as a numeric `-ge` operand
		// (intCmp on a non-numeric string).
		return false
	case "strlen", "arrlen", "add", "mul", "neg", "member", "index", "fieldof":
		return true
	default:
		return false
	}
}

// listElemStructType: for a LIST field (`e.fieldVals []*expr`) the
// element's STRUCT type ("" when not a struct slice).
func (p *parser) listElemStructType(fieldName string) string {
	parts := strings.Split(fieldName, ".")
	if len(parts) < 2 {
		return ""
	}
	baseName := p.resolveVar(parts[0])
	typeName := p.varStruct[baseName]
	if typeName == "" {
		return ""
	}
	field := parts[len(parts)-1]
	layout := p.structs[typeName]
	raws := p.structRaw[typeName]
	for i, f := range layout {
		if f == field && i < len(raws) {
			cand := strings.TrimPrefix(strings.TrimPrefix(raws[i], "[]"), "*")
			if p.isStructType(cand) {
				return cand
			}
		}
	}
	return ""
}

// arithConstInt: fold an arith ast to a constant int when possible.
func (p *parser) arithConstInt(a map[string]any) (int, bool) {
	switch a["type"] {
	case "Num":
		if n, ok := a["value"].(int); ok {
			return n, true
		}
	case "Var":
		if nm, ok := a["name"].(string); ok {
			if n, ok := p.consts[nm]; ok {
				return n, true
			}
		}
	}
	return 0, false
}

func (p *parser) printlnStmt() []map[string]any {
	p.expect(tPunct, "(")
	args := p.parseArgs()
	if len(args) == 0 {
		p.failf("Println/Print with no args (v2)")
	}
	// heredoc: Println(`...`) → Redirect(cat <<EOF ...)
	if len(args) == 1 && args[0].kind == "rawstr" {
		return []map[string]any{p.heredocStmt(args[0].text)}
	}
	// function call in Println: fmt.Println(f(x)) — Go EVALUATES f and
	// prints its RETURN VALUE, so the sub runs inside a CAPTURE (`echo
	// "$(f x)"`); a bare exec would interleave the sub's own stdout
	// (its return echo) with Println's, doubling the line. The trailing
	// newline: the capture strips it, echo re-adds one — exactly
	// Println's byte contract. Bool-verdict subs print their verdict
	// (t109 `fmt.Println(isYes("y"))` → true), not an empty capture.
	if len(args) == 1 && args[0].kind == "call" {
		if bw, ok := p.verdictDisplayWord(args[0]); ok {
			return []map[string]any{execStmt("echo", []map[string]any{bw}, "Emulable")}
		}
	}
	if len(args) == 1 && args[0].kind == "call" && p.fnNames[args[0].callee] {
		var words []map[string]any
		for _, a := range args[0].args {
			words = append(words, p.argToWord(a))
		}
		capW := map[string]any{
			"type": "Call", "func": "capture",
			"args": []any{map[string]any{
				"type": "Arrow", "body": []any{
					execStmtTA(args[0].callee, words, "Spawn", args[0].typeArgs),
				},
			}},
			"purity": "Spawn",
		}
		// a multi-slot callee's capture is RS-joined for the value
		// channel — display-join for stdout (t94). Single-slot is
		// identity.
		return []map[string]any{execStmt("echo", []map[string]any{p.displayCallWord(capW)}, "Emulable")}
	}
	return []map[string]any{execStmt("echo", p.printlnWords(args...), "Emulable")}
}

// printlnWords: Println/Print/Fprintln operand separation — Go separates
// operands with a space, which IS shell word separation — one word per
// operand (t40 fixes the old interpParts concat that printed "$i$j").
func (p *parser) printlnWords(args ...*expr) []map[string]any {
	var words []map[string]any
	if len(args) > 1 {
		allStr := true
		for _, a := range args {
			if a.kind != "str" {
				allStr = false
			}
		}
		if allStr {
			// echo a b c — separate Str words (matches the core's shape)
			for _, a := range args {
				words = append(words, strExpr(a.text))
			}
		} else {
			for _, a := range args {
				w := p.argToWord(a)
				if a.kind == "call" && !a.spread {
					// a multi-slot call PRINTED directly: its
					// capture is RS-joined for the value channel —
					// display-join for stdout (t94). Bool-verdict
					// subs print their verdict instead (t109).
					if bw, ok := p.verdictDisplayWord(a); ok {
						w = bw
					} else {
						w = p.displayCallWord(w)
					}
				}
				words = append(words, w)
			}
		}
	} else {
		w := p.exprToWord(args[0])
		if args[0].kind == "call" && !args[0].spread {
			if bw, ok := p.verdictDisplayWord(args[0]); ok {
				w = bw
			} else {
				w = p.displayCallWord(w)
			}
		}
		words = []map[string]any{w}
	}
	return words
}

// fprintlnStmt: fmt.Fprintln(os.Stderr, args...) → the `echo … >&2` shape
// (the CLI's usage message, cmd/go-sh/main.go:24 — the dogfood frontier).
// Fprintln writes space-separated operands + "\n" to fd 2 — exactly
// `echo "$a" "$b" >&2`. The A1 redirect is the fd-dup form the core
// emits for `>&2` (Redirect{fd:1, mode:"w", target:"&2"}): the runtime
// dups fd 1 onto fd 2, so echo's stdout writes land on stderr. The first
// arg must be os.Stderr — any other writer refuses loudly (Refuse >
// guess); the trailing newline comes from echo itself.
func (p *parser) fprintlnStmt() []map[string]any {
	p.expect(tPunct, "(")
	p.skipNL()
	p.expect(tIdent, "os")
	p.expect(tPunct, ".")
	p.expect(tIdent, "Stderr")
	if !p.acceptPunct(",") {
		p.failf("Fprintln needs os.Stderr as the first arg (v2)")
	}
	p.skipNL()
	args := p.parseArgs()
	if len(args) == 0 {
		p.failf("Fprintln with no args (v2)")
	}
	echo := execStmt("echo", p.printlnWords(args...), "Emulable")
	return []map[string]any{{
		"type":  "Redirect",
		"inner": []any{echo},
		"redirects": []any{map[string]any{
			"fd":          1,
			"mode":        "w",
			"interpolate": true,
			"target":      strExpr("&2"),
		}},
	}}
}

// fprintfStmt: fmt.Fprintf(w, format, args...) — the writer is
// compile-time-known: os.Stderr lowers as the printf statement wrapped
// in the same fd-dup Redirect Fprintln uses (other writers refuse).
func (p *parser) fprintfStmt() []map[string]any {
	p.expect(tPunct, "(")
	p.skipNL()
	p.expect(tIdent, "os")
	p.expect(tPunct, ".")
	p.expect(tIdent, "Stderr")
	if !p.acceptPunct(",") {
		p.failf("Fprintf needs os.Stderr as the first arg (v2)")
	}
	p.skipNL()
	body := p.printfStmtRest()
	return []map[string]any{{
		"type":  "Redirect",
		"inner": []any{body[0]},
		"redirects": []any{map[string]any{
			"fd":          1,
			"mode":        "w",
			"interpolate": true,
			"target":      strExpr("&2"),
		}},
	}}
}

// printfStmt: one %s + trailing \n → the echo-interpolation shape
// (`echo "hi $NAME"`); otherwise printf with the RAW format text
// (`printf "%s-%s\n" a b`).
func (p *parser) printfStmt() []map[string]any {
	p.expect(tPunct, "(")
	p.skipNL()
	return p.printfStmtRest()
}

// printfStmtRest: the body AFTER the opening paren (shared with
// fprintfStmt, whose writer operand was already consumed)
func (p *parser) printfStmtRest() []map[string]any {
	fmtTok := p.expect(tStr, "")
	var args []*expr
	if p.acceptPunct(",") {
		p.skipNL()
		args = p.parseArgs()
	}
	decoded := decodeGoStr(fmtTok.raw)
	if len(args) == 1 && strings.Count(decoded, "%s") == 1 && strings.HasSuffix(decoded, "\n") {
		before := strings.TrimSuffix(decoded, "\n")
		before = strings.Replace(before, "%s", "", 1)
		parts := []any{partLit(before), partExpr(p.exprToWord(args[0]))}
		return []map[string]any{execStmt("echo", []map[string]any{interpParts(parts)}, "Emulable")}
	}
	// one %d + trailing \n → echo-interpolation (the `count=${#a[@]}` shape)
	if len(args) == 1 && strings.Count(decoded, "%d") == 1 &&
		strings.Count(decoded, "%s") == 0 && strings.HasSuffix(decoded, "\n") {
		before := strings.TrimSuffix(decoded, "\n")
		before = strings.Replace(before, "%d", "", 1)
		parts := []any{partLit(before), partExpr(p.exprToWord(args[0]))}
		return []map[string]any{execStmt("echo", []map[string]any{interpParts(parts)}, "Emulable")}
	}
	var words []map[string]any
	// %v → %s: the runtime printf has no %v; error/string operands
	// render identically under %s (the err value IS its message text)
	fmtText := strings.ReplaceAll(fmtTok.raw, "%v", "%s")
	words = append(words, interpLit(fmtText))
	for _, a := range args {
		words = append(words, p.exprToWord(a))
	}
	return []map[string]any{execStmt("printf", words, "Emulable")}
}

// writeFileStmt: os.WriteFile(path, []byte("data\n"), perm) → the
// Redirect shape of `echo data > path`.
func (p *parser) writeFileStmt() []map[string]any {
	p.expect(tPunct, "(")
	p.skipNL()
	pathTok := p.expect(tStr, "")
	p.expect(tPunct, ",")
	p.skipNL()
	p.expect(tPunct, "[")
	p.expect(tPunct, "]")
	p.expect(tIdent, "byte")
	p.expect(tPunct, "(")
	contentTok := p.expect(tStr, "")
	p.expect(tPunct, ")")
	p.expect(tPunct, ",")
	p.skipNL()
	p.parseExpr() // perm literal (0o644 etc.)
	p.expect(tPunct, ")")
	content := strings.TrimSuffix(decodeGoStr(contentTok.raw), "\n")
	echo := execStmt("echo", []map[string]any{strExpr(content)}, "Emulable")
	return []map[string]any{{
		"type":  "Redirect",
		"inner": []any{echo},
		"redirects": []any{map[string]any{
			"fd":          1,
			"mode":        "w",
			"interpolate": true,
			"target":      strExpr(decodeGoStr(pathTok.raw)),
		}},
	}}
}

// heredocStmt: a multi-line raw-string Println → the heredoc Redirect
// shape (`cat <<EOF ... EOF`).
func (p *parser) heredocStmt(content string) map[string]any {
	cat := execStmt("cat", []map[string]any{}, "Emulable")
	return map[string]any{
		"type":  "Redirect",
		"inner": []any{cat},
		"redirects": []any{map[string]any{
			"fd":          0,
			"mode":        "heredoc",
			"interpolate": true,
			"target":      strExpr(content + "\n"),
		}},
	}
}

// setenvStmt: os.Setenv("K", "v") → the export shape (`X=v` + `export X`).
// stdoutWriteStmt: os.Stdout.Write(x) → printf "%s" "$x" — the raw
// byte write WITHOUT the trailing newline echo adds (the A1 has no
// raw-write node; printf with a %s format is the faithful shape). The
// arg may be a []byte{...} byte-slice literal (the CLI's
// os.Stdout.Write([]byte{'\n'}) — the newline terminator), whose char
// elements decode to the literal bytes.
func (p *parser) stdoutWriteStmt() []map[string]any {
	p.expect(tPunct, "(")
	p.skipNL()
	var words []map[string]any
	if p.atPunct("[") && p.byteSliceLitAhead() {
		p.pos += 4 // [ ] byte {
		content := ""
		for {
			p.skipNL()
			if p.atPunct("}") {
				p.pos++
				break
			}
			t := p.tok()
			if t.kind != tStr && t.kind != tChar {
				p.failf("byte-slice elements must be char/string literals (v2)")
			}
			p.pos++
			content += decodeGoStr(t.raw)
			if !p.acceptPunct(",") {
				p.skipNL()
				p.expect(tPunct, "}")
				break
			}
		}
		words = append(words, interpLit(content))
	} else {
		arg := p.parseExpr()
		words = append(words, p.exprToWord(arg))
	}
	p.skipNL()
	p.expect(tPunct, ")")
	return []map[string]any{execStmt("printf", words, "Emulable")}
}

// exitStmt: os.Exit(N) → the A1 Exit statement ({"type":"Exit","value":N})
// — the `exit` builtin's shape, so all backends terminate with bash's
// exit code semantics (the CLI's `os.Exit(2)` on usage errors).
func (p *parser) exitStmt() []map[string]any {
	p.expect(tPunct, "(")
	p.skipNL()
	var value map[string]any
	switch p.tok().kind {
	case tNum:
		n, _ := strconv.Atoi(p.next().text)
		value = map[string]any{"type": "Int", "value": n}
	case tIdent:
		name := p.next().text
		if n, ok := p.paramNumber(name); ok {
			value = map[string]any{"type": "Int", "value": n}
		} else {
			value = getVarExpr(name)
		}
	default:
		value = map[string]any{"type": "Int", "value": 0}
	}
	p.skipNL()
	p.expect(tPunct, ")")
	return []map[string]any{{"type": "Exit", "value": value}}
}

func (p *parser) setenvStmt() []map[string]any {
	p.expect(tPunct, "(")
	p.skipNL()
	k := p.expect(tStr, "")
	p.expect(tPunct, ",")
	p.skipNL()
	v := p.expect(tStr, "")
	p.expect(tPunct, ")")
	name := decodeGoStr(k.raw)
	p.registerVar(name, "Str")
	return []map[string]any{
		assignStmt(name, interpLit(decodeGoStr(v.raw))),
		execStmt("export", []map[string]any{strExpr(name)}, "Emulable"),
	}
}

// ── assignments and calls ───────────────────────────────────────────

// parseMapLiteralBody parses `map[K]V{ k: v, … }` (the `map` keyword
// and key/value type already consumed by the caller) for target `name`,
// lowering each pair to an assocSet Call (the drop-in A1 shape; t54).
// mapPairWord: the assocSet value word for one map-literal pair —
// shared by the token-parsing parseMapLiteralBody and the
// already-parsed me shape in parseAssignStmt (non-literal values:
// calls, vars, nested composites). Allocation preludes append to
// *prelude so temps exist before the pair references them.
func (p *parser) mapPairWord(val *expr, prelude *[]map[string]any) map[string]any {
	// GENERAL values: any word-lowerable expression rides assocSet;
	// nested composites (map/slice literals) pre-allocate into temps
	// whose REFERENCE ID becomes the stored value (object-store model)
	var valWord map[string]any
	if val.kind == "maplit" || val.kind == "arraylit" {
		tmp, alloc := p.allocComposite(val)
		*prelude = append(*prelude, alloc...)
		valWord = getVarExpr(tmp)
	} else if val.kind == "var" && p.varTypes[p.resolveVar(val.name)] == "Array" {
		// an ARRAY-typed var as a map value (`"imports": imports`
		// — shir-emit-go's Emit): the param-slice word returns a JS
		// ARRAY (the var-store read is empty; the array lives in
		// the array store) — assocSet stores it as-is and
		// jsonMarshal serializes it as a JSON array
		valWord = paramCall("slice", p.resolveVar(val.name), "@", "")
	} else if val.kind == "call" && p.callTargetName(val.callee) != "" {
		// a SLICE-returning call as a map value (`"stmts":
		// toAnyStmts(...)` — shir-emit-go's Emit): the capture
		// returns the echoed items as a string — strSplit back into
		// an ARRAY so jsonMarshal emits a JSON array
		w := p.exprToWord(val)
		tn := p.callTargetName(val.callee)
		ret := ""
		if sig, ok := p.fnSig[tn]; ok {
			ret = sig[1]
		} else {
			ret = p.prescanRet[tn]
		}
		if strings.HasPrefix(ret, "[]") {
			// LIST-id echo (struct/any slice calls) rides as-is —
			// the id is a plain string and jsonMarshal resolves
			// it structurally. Only space-joined ARRAY echoes
			// need the strSplit rebuild (which would double-nest
			// an id: [[items]]).
			if le := p.callFirstListElem(tn, p.fnRetIdents[tn]); le != "" {
				valWord = w
			} else {
				valWord = map[string]any{
					"type": "Call", "func": "strSplit",
					"args":   []any{w, strExpr(" ")},
					"purity": "PureCpu",
				}
			}
		} else {
			valWord = w
		}
	} else {
		valWord = p.exprToWord(val)
	}
	return valWord
}

func (p *parser) parseMapLiteralBody(name string) []map[string]any {
	p.skipNL()
	p.expect(tPunct, "{")
	p.maps[name] = true
	p.registerVar(name, "Map")
	// non-nil init: an EMPTY literal must marshal body as [],
		// never null (the ingress rejects Block.body: not an array)
		body := []map[string]any{}
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			break
		}
		key := p.parseExpr()
		if key.kind != "str" && key.kind != "num" && key.kind != "rawstr" {
			p.failf("unsupported map key %q (v2) — keys must be literals", key.text)
		}
		p.expect(tPunct, ":")
		p.skipNL()
		if p.atPunct("{") {
			p.failf("unsupported composite literal value in map literal (v2)")
		}
		val := p.parseExpr()
		if val.kind == "var" && (val.name == "true" || val.name == "false") {
			val = &expr{kind: "str", text: val.name}
		}
		valWord := p.mapPairWord(val, &body)
		body = append(body, map[string]any{
			"type": "Expr",
			"expr": map[string]any{
				"type": "Call", "func": "assocSet",
				"args":   []any{strExpr(name), strExpr(key.text), valWord},
				"purity": "Emulable",
			},
		})
		if !p.acceptPunct(",") {
			p.skipNL()
			p.expect(tPunct, "}")
			break
		}
	}
	return []map[string]any{{"type": "Block", "body": body}}
}

func (p *parser) parseAssignStmt() []map[string]any {
	// indexed-target parts from the previous statement must not leak:
	// the maplit hook below consumes them within this call only.
	p.idxBase, p.idxKey, p.idxLit = "", nil, ""
	if p.tok().kind == tIdent && p.tok().text == "be" {
	}
	// writes through a reference (*p = v / &x = …) have no snapshot-
	// semantics lowering — refuse loudly instead of silently assigning
	// to the wrong storage (the AddressOf/Deref contract, address_of.node).
	if (p.tok().kind == tPunct || p.tok().kind == tOp) &&
		(p.tok().text == "*" || p.tok().text == "&") {
		p.failf("unsupported write through %q (v2) — references are read-only snapshots", p.tok().text)
	}
	var targets []string
	targets = append(targets, p.next().text)
	for p.acceptPunct(",") {
		p.skipNL()
		if p.atIdent("_") {
			p.pos++
			targets = append(targets, "_")
		} else {
			targets = append(targets, p.expect(tIdent, "").text)
		}
	}
	// a type-switch guard var is bound to the guarded value — writing to
	// it would need a shadow (Refuse > guess; reads alias via resolveVar)
	if _, ok := p.varAlias[targets[0]]; ok {
		p.failf("cannot assign to type-switch guard %q (v2)", targets[0])
	}
	// indexed assign: a[1] = "X" → target var "a[1]" (the `arr[1]=X` shape);
	// a computed key (`a[i] = x`, `toks[p.pos] = t`) renders the key as
	// arithmetic text — the runtime evaluates subscripts with evalArith.
	if p.atPunct("[") {
		if len(targets) != 1 {
			p.failf("indexed assign with multiple targets (v2)")
		}
		p.pos++
		var keyE *expr
		idx := ""
		if !p.atPunct("]") {
			if p.tok().kind == tNum {
				idx = p.next().text
			} else if p.tok().kind == tStr {
				// a map-keyed assign: call["typeArgs"] = ta — the runtime's
				// setVar("call[typeArgs]") assoc-store write (the key is a
				// string even when the target is a jsonNew struct, not a
				// registered assoc map)
				idx = decodeGoStr(p.next().raw)
			} else {
				keyE = p.parseExpr()
			}
		}
		p.expect(tPunct, "]")
		if keyE != nil {
			if keyE.kind == "str" && p.maps[targets[0]] {
				// ASSOC store with a literal string key — the raw text is
				// the subscript (the runtime routes name[key] to the
				// associative store once assocSet registered the name)
				idx = keyE.text
			} else {
				// plain arithmetic with $vars — the runtime evaluates
				// the subscript text with evalArith
				idx = p.arithKeyText(keyE)
			}
		}
		// stash the structural parts for the maplit hook below (an
		// indexed write of a map literal onto an any-list lowers to
		// listSet, not assocSet). The base is targets[0] as-is here.
		p.idxBase, p.idxKey, p.idxLit = targets[0], keyE, idx
		targets[0] = targets[0] + "[" + idx + "]"
	}
	// member assign: p.pos = 5 → p = jsonSet("p", "pos", 5) (the go-sh
	// self-hosting contract: structs are JSON object strings; the write
	// lands on the resolved var).
	memberBase, memberField := "", ""
	memberIndex := "" // p.varTypes[name] — the map-field key
	if p.atPunct(".") {
		// a member write (`a[i].f = …`) supersedes any indexed-target
		// parts stashed above — the maplit hook below must not fire.
		p.idxBase, p.idxKey, p.idxLit = "", nil, ""
		if len(targets) != 1 {
			p.failf("member assign with multiple targets (v2)")
		}
		p.pos++
		memberField = p.expect(tIdent, "").text
		memberBase = targets[0]
		targets[0] = memberBase + "." + memberField
		if p.atPunct("[") {
			p.pos++
			p.skipNL()
			if p.tok().kind == tNum {
				memberIndex = p.next().text
			} else {
				ie := p.parseExpr()
				if off := p.indexArithText(ie); off != "" {
					memberIndex = off
				} else {
					p.failf("struct field index must be literal or arith (v2)")
				}
			}
			p.expect(tPunct, "]")
			targets[0] = memberBase + "." + memberField + "[" + memberIndex + "]"
		}
	}
	// function call statement: f(args)
	if p.atPunct("(") {
		p.pos++
		args := p.parseArgs()
		var words []map[string]any
		for _, a := range args {
			words = append(words, p.argToWord(a))
		}
		return []map[string]any{execStmt(targets[0], words, "Spawn")}
	}
	// x++ / x-- (arith IncDec; delta carries the direction)
	if p.atPunct("++") || p.atPunct("--") {
		op := p.next().text
		if len(targets) != 1 {
			p.failf("%s needs one target", op)
		}
		delta := 1
		arithOp := "+"
		if op == "--" {
			delta = -1
			arithOp = "-"
		}
		if memberBase != "" {
			// p.pos++ → p = jsonSet("p", "pos", p.pos + 1) — the
			// go-sh self-hosting contract (the golib's 91 `p.pos++`).
			p.registerVar(memberBase, "Struct")
			// STRUCT-typed base with a KNOWN field: the object-store
			// objAdd (delta carries --'s direction; the jsonSet
			// below always adds and clobbers store ids to "").
			if rn := p.resolveVar(memberBase); p.varStruct[rn] != "" {
				if off := structFieldIndex(p.structs[p.varStruct[rn]], memberField); off >= 0 {
					d := "1"
					if op == "--" {
						d = "-1"
					}
					return []map[string]any{{
						"type": "Expr",
						"expr": map[string]any{
							"type": "Call", "func": "objAdd",
							"args":   []any{p.structIDWord(memberBase), strExpr(memberField), strExpr(d)},
							"purity": "PureCpu",
						},
					}}
				}
			}
			return []map[string]any{assignStmt(memberBase, map[string]any{
				"type": "Call", "func": "jsonSet",
				"args": []any{
					strExpr(p.resolveVar(memberBase)), strExpr(memberField),
					arithWrap(arithBin(arithVar(memberBase), "+", arithNum(1))),
				},
				"purity": "PureCpu",
			})}
		}
		p.registerVar(targets[0], "Int")
		return []map[string]any{assignStmt(targets[0],
			arithWrap(arithBin(arithVar(targets[0]), arithOp, arithNum(delta))))}
	}
	op := ""
	switch {
	case p.atPunct(":="):
		op = ":="
	case p.atPunct("="):
		op = "="
	case p.atPunct("+="):
		op = "+="
	default:
		p.failf("expected assignment operator, got %q", p.tok().text)
	}
	p.pos++
	p.skipNL()
	// make([]T, n) / make(map[K]V) — composite construction: an EMPTY
	// array store (append/indexed-writes grow it) or an inert scalar
	// placeholder for map-object ids
	if p.atIdent("make") && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "(" {
		p.pos += 2 // make (
		p.skipNL()
		isMap := false
		if p.atIdent("map") || (p.atPunct("[") && false) {
			isMap = true
		}
		if p.atPunct("[") {
			// []T slice form (map[K]V starts with "map")
			isMap = false
		}
		// LIST-element slice (`make([]any, n)`, `make([]tok, n)`):
		// elements ride a LIST id — peek before skipType consumes it.
		makeElem := ""
		if p.atPunct("[") {
			makeElem = p.peekSliceElem()
		}
		p.skipType() // the full type argument
		for p.acceptPunct(",") {
			p.skipNL()
			p.parseExpr() // length / capacity — erased (append grows)
			p.skipNL()
		}
		p.expect(tPunct, ")")
		_ = isMap
		if len(targets) != 1 {
			p.failf("make with multiple targets (v2)")
		}
		if isMap {
			p.registerVar(targets[0], "Str")
			return []map[string]any{assignStmt(targets[0], strExpr(""))}
		}
		if p.isAnyListElem(makeElem) {
			p.anyLists[targets[0]] = true
			p.anyElem[targets[0]] = makeElem
			return []map[string]any{assignStmt(targets[0],
				map[string]any{"type": "Call", "func": "listNew", "args": []any{}, "purity": "PureCpu"})}
		}
		// rebinding clears stale list marks (see parseVarDecl).
		delete(p.anyLists, targets[0])
		delete(p.anyElem, targets[0])
		p.registerVar(targets[0], "Array")
		return []map[string]any{assignStmt(targets[0], map[string]any{
			"type": "Call", "func": "setArray",
			"args":   []any{strExpr(targets[0]), map[string]any{"type": "Array", "elements": []any{}}},
			"purity": "Emulable",
		})}
	}

	// func literal: name := func(...) { ... } → Function stmt
	if p.atIdent("func") {
		fn := p.parseFuncLit()
		p.fnNames[targets[0]] = true
		return []map[string]any{{
			"type": "Function",
			"name": targets[0],
			"body": fn.body,
		}}
	}
	// []byte(x) conversion → identity (strings ARE bytes in the A1 —
	// the `string(x)` twin already lowers as identity; the A1 has no
	// byte type, so the conversion is a parse-level no-op).
	if p.atPunct("[") && p.byteConvAhead() {
		if len(targets) > 1 {
			p.failf("[]byte conversion with multiple targets (v2)")
		}
		p.pos += 4 // [ ] byte (
		p.skipNL()
		arg := p.parseExpr()
		p.skipNL()
		p.expect(tPunct, ")")
		w := p.exprToWord(arg)
		p.registerVar(targets[0], p.wordType(w))
		return []map[string]any{assignStmt(targets[0], w)}
	}
	// []byte{...} byte-slice COMPOSITE literal: refused (Refuse >
	// guess) — an escaped char element ('\n') would silently lower as
	// its raw two-char text, and the shell-flavored A1 has no byte
	// array; the conversion form above is the supported shape.
	if p.atPunct("[") && p.byteSliceLitAhead() {
		p.failf("[]byte{...} byte-slice literal unsupported (v2) — use []byte(\"...\") conversion")
	}
	// []T(x) slice-TYPE conversion ([]map[string]any(nil), []any(x)) —
	// identity under the A1's strings-only model (the golib's own
	// `body := []map[string]any(nil)` slice decls)
	if p.atPunct("[") && p.sliceConvAhead() {
		if len(targets) > 1 {
			p.failf("slice conversion with multiple targets (v2)")
		}
		arg := p.parseSliceConv()
		w := p.exprToWord(arg)
		p.registerVar(targets[0], p.wordType(w))
		return []map[string]any{assignStmt(targets[0], w)}
	}
	// array literal: name := []T{...} (multi-target `a, b := []T{}, []T{}`
	// supported — each target gets its own literal)
	if p.atPunct("[") {
		var out []map[string]any
		for i := 0; ; i++ {
			if i >= len(targets) {
				p.failf("array literal with more targets than values (v2)")
			}
			litElem := p.peekSliceElem()
			elems, typ := p.parseArrayLiteral()
			p.arrays[targets[i]] = arrayInfo{elems: elems, typ: typ}
			p.registerVar(targets[i], "Array")
			// rebinding clears stale list marks (see parseVarDecl).
			delete(p.anyLists, targets[i])
			delete(p.anyElem, targets[i])
			if p.isAnyListElem(litElem) {
				// LIST-element slice (`[]tok{...}`, `[]any{...}`): elements
				// ride a LIST id (shell arrays String-coerce objects).
				p.anyLists[targets[i]] = true
				p.anyElem[targets[i]] = litElem
				pushes := []map[string]any{assignStmt(targets[i],
					map[string]any{"type": "Call", "func": "listNew", "args": []any{}, "purity": "PureCpu"})}
				for _, el := range elems {
					pushes = append(pushes, map[string]any{
						"type": "Expr",
						"expr": map[string]any{
							"type": "Call", "func": "listPush",
							"args":   []any{getVarExpr(targets[i]), el},
							"purity": "PureCpu",
						},
					})
				}
				out = append(out, pushes...)
			} else {
				out = append(out, assignStmt(targets[i],
					map[string]any{
						"type": "Call", "func": "setArray",
						"args":   []any{strExpr(targets[i]), map[string]any{"type": "Array", "elements": elems}},
						"purity": "Emulable",
					}))
			}
			if !p.acceptPunct(",") {
				break
			}
			p.skipNL()
			if !p.atPunct("[") {
				p.failf("expected array literal after comma (v2)")
			}
		}
		return out
	}
	// map literal: name := map[K]V{ k: v, ... } → one assocSet per pair
	// (the runtime's by-name associative-array store; t54). The body
	// parser is shared with the `var m = map[K]V{…}` initializer path.
	// TYPED NIL conversion `map[K]V(nil)` (the golib's
	// `keyWord := map[string]any(nil)` placeholder): not a literal — a
	// zero-value map. The A1 map model has no empty-map object; an inert
	// "" placeholder reads like an absent key (mapGet of a missing key
	// is "" — faithful). A non-nil inner expr needs a real composite
	// (Refuse > guess).
	if p.atIdent("map") && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "[" {
		// scan past the balanced [K]V type text; a `(` there = conversion.
		// (No labeled break — the frontend parses itself, and labels are
		// outside its Go subset.)
		done := false
		depth, j := 0, p.pos+1
		for j < len(p.toks) && !done {
			if p.toks[j].kind == tPunct {
				switch p.toks[j].text {
				case "[":
					depth++
				case "]":
					depth--
					if depth == 0 {
						// the VALUE type rides after [K]: map[string]any( —
						// skip the V ident/selector before the paren
						for j+1 < len(p.toks) && (p.toks[j+1].kind == tIdent ||
							(p.toks[j+1].kind == tPunct && (p.toks[j+1].text == "." || p.toks[j+1].text == "*"))) {
							j++
						}
						j++
						if j < len(p.toks) && p.toks[j].kind == tPunct && p.toks[j].text == "(" {
							p.pos = j + 1
							p.skipNL()
							if !(p.atIdent("nil")) {
								p.failf("map conversion of a non-nil expr unsupported (v2)")
							}
							p.pos++
							p.skipNL()
							p.expect(tPunct, ")")
							if len(targets) > 1 {
								p.failf("map conversion with multiple targets (v2)")
							}
							p.registerVar(targets[0], "Map")
							return []map[string]any{assignStmt(targets[0], strExpr(""))}
						}
						done = true // a literal follows — the maplit path below
					}
				}
			}
			j++
		}
	}
	if p.atIdent("map") {
		me := p.parsePrimary() // the structlit expr (parsePrimary's map case)
		// INDEXED any-list element write (`out[i] = map[string]any{...}`
		// — toAnySlice's indexed fill): the maplit lowers to a
		// jsonObject word (a plain JS object, serialization-safe) and
		// listSet grows/sets the slot. The assocSet paths below would
		// strand the target text ("out[0]") as a map NAME.
		if me.kind == "maplit" && len(targets) == 1 && p.idxBase != "" {
			if ln := p.anyListVar(p.idxBase); ln != "" {
				var idxW map[string]any
				if p.idxKey != nil {
					idxW = p.exprToWord(p.idxKey)
				} else if _, err := strconv.Atoi(p.idxLit); err == nil {
					idxW = strExpr(p.idxLit)
				}
				if idxW != nil {
					return []map[string]any{{
						"type": "Expr",
						"expr": map[string]any{
							"type": "Call", "func": "listSet",
							"args":   []any{getVarExpr(ln), idxW, p.exprToWord(me)},
							"purity": "PureCpu",
						},
					}}
				}
			}
		}
		allLit := true
		for _, f := range me.args {
			if f.kind != "str" && f.kind != "num" && f.kind != "rawstr" &&
				!(f.kind == "var" && (f.name == "true" || f.name == "false")) {
				allLit = false
				break
			}
		}
		if allLit {
			// the assocSet lowering (t54) — reuse parseMapLiteral's body
			// by re-parsing: the tokens are already consumed, so emit the
			// assocSet calls directly.
			// INLINE INDEX suffix (`op := map[string]string{…}[e.BOp]` —
			// the golib's own op-table lookups): the map is TRANSIENT —
			// allocate a temp name, emit its assocSets as pre-stmts, and
			// the assign target gets mapGet(temp, key) (a missing key is
			// "", Go's zero value for map[string]string — faithful).
			if p.atPunct("[") {
				if len(targets) > 1 {
					p.failf("indexed map literal with multiple targets (v2)")
				}
				p.pos++
				p.skipNL()
				keyE := p.parseExpr()
				p.skipNL()
				p.expect(tPunct, "]")
				tmp := "__tmp_map" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.maps[tmp] = true
				p.registerVar(tmp, "Map")
				// non-nil init: an EMPTY literal must marshal body as [],
				// never null (the ingress rejects Block.body: not an array)
				body := []map[string]any{}
				for i, f := range me.args {
					valText := f.text
					if f.kind == "var" {
						valText = f.name
					}
					body = append(body, map[string]any{
						"type": "Expr",
						"expr": map[string]any{
							"type": "Call", "func": "assocSet",
							"args":   []any{strExpr(tmp), strExpr(me.fieldNames[i]), strExpr(valText)},
							"purity": "Emulable",
						},
					})
				}
				body = append(body, assignStmt(targets[0], map[string]any{
					// assocGet — NOT mapGet: the temp map lives in the
					// ASSOC store (the assocSet writes above read through
					// the named assoc array; mapGet reads the object
					// store and would always yield "" — the established
					// m[k] convention, verified by the word-position read
					"type": "Call", "func": "assocGet",
					"args":   []any{strExpr(tmp), p.exprToWord(keyE)},
					"purity": "PureCpu",
				}))
				p.registerVar(targets[0], "Str")
				return []map[string]any{{"type": "Block", "body": body}}
			}
			if len(targets) > 1 {
				p.failf("map literal with multiple targets (v2)")
			}
			p.maps[targets[0]] = true
			p.registerVar(targets[0], "Map")
			// non-nil init: an EMPTY literal must marshal body as [],
			// never null (the ingress rejects Block.body: not an array)
			body := []map[string]any{}
			for i, f := range me.args {
				valText := f.text
				if f.kind == "var" {
					valText = f.name
				}
				body = append(body, map[string]any{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": "assocSet",
						"args":   []any{strExpr(targets[0]), strExpr(me.fieldNames[i]), strExpr(valText)},
						"purity": "Emulable",
					},
				})
			}
			return []map[string]any{{"type": "Block", "body": body}}
		}
		// DYNAMIC values (calls, vars — shir-emit-go's Emit map with
		// toAnyStmts/toAnySlice call values): assoc pairs with word
		// values via the shared mapPairWord (calls ride captures or
		// list ids; nested composites pre-allocate). Plain targets
		// only — dotted/indexed targets keep the legacy jsonObject
		// value lowering below.
		if !strings.ContainsAny(targets[0], ".[") {
			p.maps[targets[0]] = true
			p.registerVar(targets[0], "Map")
			body := []map[string]any{}
			for i, k := range me.keys {
				if k.kind != "str" && k.kind != "num" && k.kind != "rawstr" {
					p.failf("unsupported map key %q (v2) — keys must be literals", k.text)
				}
				valWord := p.mapPairWord(me.vals[i], &body)
				body = append(body, map[string]any{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": "assocSet",
						"args":   []any{strExpr(targets[0]), strExpr(k.text), valWord},
						"purity": "Emulable",
					},
				})
			}
			return []map[string]any{{"type": "Block", "body": body}}
		}
		// expression values — the jsonNew lowering (the golib's A1
		// fragments).
		p.registerVar(targets[0], "Map")
		return []map[string]any{assignStmt(targets[0], p.exprToWord(me))}
	}
	// a := make([]T, n) — the make builtin: an empty array (the golib's
	// `a := make([]any, len(args))` + indexed-fill pattern; the runtime's
	// array store grows on the indexed assigns).
	if p.atIdent("make") {
		p.pos++
		p.expect(tPunct, "(")
		p.skipNL()
		p.expect(tPunct, "[")
		p.expect(tPunct, "]")
		for p.tok().kind == tIdent {
			p.next()
		}
		if p.atPunct(",") {
			// make([]T, n) — the length arg (the golib's
			// `make([]any, len(args))` + indexed-fill pattern); the
			// runtime's array store grows on the indexed assigns, so
			// the length only needs consuming
			p.pos++
			p.skipNL()
			p.parseExpr() // the length
			p.expect(tPunct, ")")
			if len(targets) > 1 {
				p.failf("make with multiple targets (v2)")
			}
			p.arrays[targets[0]] = arrayInfo{elems: []map[string]any{}, typ: "Str"}
			p.registerVar(targets[0], "Array")
			return []map[string]any{assignStmt(targets[0],
				map[string]any{
					"type": "Call", "func": "setArray",
					"args":   []any{strExpr(targets[0]), map[string]any{"type": "Array", "elements": []any{}}},
					"purity": "Emulable",
				})}
		}
		if len(targets) > 1 {
			p.failf("map literal with multiple targets (v2)")
		}
		// map-TYPE CONVERSION (`keyWord := map[string]any(nil)` — the
		// golib's own nil-map word locals): identity under the A1's
		// strings-only model (the []T(x) twin)
		if p.atPunct("(") {
			p.pos++
			p.skipNL()
			arg := p.parseExpr()
			p.skipNL()
			p.expect(tPunct, ")")
			w := p.exprToWord(arg)
			p.maps[targets[0]] = true
			p.registerVar(targets[0], "Map")
			return []map[string]any{assignStmt(targets[0], w)}
		}
		body := p.parseMapLiteralBody(targets[0])
		// INLINE INDEX: `op := map[string]string{...}[key]` — the
		// lookup rides assocGet over the just-populated assoc array
		// (the golib's own op-map dispatch in condWordAny/condToJSON)
		if p.toks[p.pos].kind == tPunct && p.toks[p.pos].text == "[" {
			p.pos++ // [
			p.skipNL()
			keyE := p.parseExpr()
			p.skipNL()
			p.expect(tPunct, "]")
			body = append(body, assignStmt(targets[0], map[string]any{
				"type": "Call", "func": "assocGet",
				"args":   []any{strExpr(targets[0]), p.exprToWord(keyE)},
				"purity": "PureCpu",
			}))
			p.registerVar(targets[0], "Str")
		}
		return body
	}
	// cmd := exec.Command(a, b) [.Output()|.Run()]  /  x, _ := ....Output()
	if p.atIdent("exec") {
		p.next()
		p.expect(tPunct, ".")
		p.expect(tIdent, "Command")
		p.expect(tPunct, "(")
		args := p.parseArgs()
		if !p.atPunct(".") {
			// bare Command — store for a later .Run()
			if len(targets) == 1 && targets[0] != "_" {
				p.cmds[targets[0]] = args
			}
			return nil
		}
		p.pos++
		m := p.expect(tIdent, "").text
		p.expect(tPunct, "(")
		p.skipNL()
		p.expect(tPunct, ")")
		if m == "Run" {
			return []map[string]any{p.execFromArgs(args)}
		}
		return []map[string]any{p.captureAssign(targets, args)}
	}
	// r := bufio.NewReader(os.Stdin)  /  sc := bufio.NewScanner(os.Stdin)
	if p.atIdent("bufio") {
		p.next()
		p.expect(tPunct, ".")
		m := p.expect(tIdent, "").text
		if m != "NewReader" && m != "NewScanner" {
			p.failf("unsupported bufio.%s (v2)", m)
		}
		p.expect(tPunct, "(")
		p.skipNL()
		p.expect(tIdent, "os")
		p.expect(tPunct, ".")
		p.expect(tIdent, "Stdin")
		p.expect(tPunct, ")")
		if len(targets) == 1 && targets[0] != "_" {
			p.stdinRdr[targets[0]] = true
		}
		return nil
	}
	// line, _ := reader.ReadString('\n')
	if p.tok().kind == tIdent && p.stdinRdr[p.tok().text] {
		p.next()
		p.expect(tPunct, ".")
		p.expect(tIdent, "ReadString")
		p.expect(tPunct, "(")
		p.skipNL()
		p.parseExpr() // delimiter literal — ignored
		p.expect(tPunct, ")")
		readVar := ""
		for _, tg := range targets {
			if tg != "_" {
				readVar = tg
				break
			}
		}
		return []map[string]any{execStmt("read",
			[]map[string]any{strExpr("-r"), strExpr(readVar)}, "Emulable")}
	}

	// n, _ := strconv.Atoi("42") → n = "42" — the error return is
	// dropped, and Atoi over a literal folds at emit time (t72).
	// The ParseInt/ParseFloat/ParseBool family lowers the same shape: over
	// a LITERAL it folds only for Atoi (base 10 — ParseInt's base argument
	// can reinterpret the digits, so it never folds); over a runtime
	// expression it assigns the strAtoi call word (the same lowering the
	// expression-position path pins at the call case below).
	// strconv.Itoa / FormatInt(n, 10) are the INVERSE: assign strItoa(word).
	if p.atIdent("strconv") {
		p.next()
		p.expect(tPunct, ".")
		fnName := p.tok().text
		if fnName != "Atoi" && fnName != "ParseInt" && fnName != "ParseFloat" && fnName != "ParseBool" &&
			fnName != "Itoa" && fnName != "FormatInt" {
			p.failf("unsupported strconv.%s (v2)", fnName)
		}
		p.next()
		p.expect(tPunct, "(")
		p.skipNL()
		arg := p.parseExpr()
		// ParseInt(s, base, bitSize) / ParseFloat(s, bitSize) carry
		// trailing conversion arguments — consume them (only args[0],
		// the string, reaches the lowering)
		for p.atPunct(",") {
			p.next()
			p.skipNL()
			_ = p.parseExpr()
			p.skipNL()
		}
		p.expect(tPunct, ")")
		// (value, error) shape: the FIRST non-_ target binds the value;
		// every remaining target is an error return under an ARBITRARY
		// name (err, err1, e2 — real code names them freely), dropped
		// like Atoi's
		name := ""
		for _, tg := range targets {
			if tg == "_" {
				continue
			}
			if name == "" {
				name = tg
			}
		}
		if name == "" {
			p.failf("strconv.%s needs a target var (v2)", fnName)
		}
		p.registerVar(name, "Int")
		if fnName == "Itoa" || fnName == "FormatInt" {
			// n := strconv.Itoa(x) → n = strItoa(x-word); FormatInt's
			// trailing base argument is consumed above and ignored (only
			// base 10 reaches here — other bases refuse at the fold)
			return []map[string]any{assignStmt(name, map[string]any{
				"type": "Call", "func": "strItoa",
				"args":   []any{p.exprToWord(arg)},
				"purity": "PureCpu",
			})}
		}
		if fnName == "Atoi" && (arg.kind == "str" || arg.kind == "num") {
			return []map[string]any{assignStmt(name, strExpr(arg.text))}
		}
		// runtime conversion: strAtoi(word) — the pinned expression-
		// position shape (ParseInt/ParseFloat fold into it too; the
		// err return is dropped like Atoi's)
		return []map[string]any{assignStmt(name, map[string]any{
			"type": "Call", "func": "strAtoi",
			"args":   []any{p.exprToWord(arg)},
			"purity": "PureCpu",
		})}
	}

	// os.ReadDir(dir) with multi-target (`entries, err2 := os.ReadDir(d)`)
	// → entries gets the captured `ls -1 dir` listing (names-only; the
	// "captured multi-line return" convention), err2 = "" (always succeeds)
	// Ranging over entries uses the strSplit("\n") path for untyped vars.
	// b, _ := os.ReadFile(path) → b = $(cat path) — the whole-file-read
	// cmdsub shape (t34's capture; cat is an Emulable sync builtin; the
	// []byte result is a string in the A1's strings-are-bytes model).
	// The error return is dropped like strconv.Atoi's. The if-init form
	// (`if b, err := os.ReadFile(p); err == nil {`) stays REFUSED: its
	// cond is a read-status test, and the A1 If cond is a `test` call,
	// not a command status (Refuse > guess). Other os.* RHS calls
	// (Getenv etc.) fall through to the generic expression RHS.
	// os.ReadDir(dir) with multi-target (`entries, err2 := os.ReadDir(d)`)
	// → entries gets the captured `ls -1 dir` listing (names-only; the
	// "captured multi-line return" convention), err2 = "" (always succeeds)
	if len(targets) >= 1 && p.atIdent("os") && p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "." &&
		p.toks[p.pos+2].kind == tIdent && p.toks[p.pos+2].text == "ReadDir" {
		p.next() // os
		p.expect(tPunct, ".")
		p.expect(tIdent, "ReadDir")
		p.expect(tPunct, "(")
		p.skipNL()
		dirW := p.exprToWord(p.parseExpr())
		p.skipNL()
		p.expect(tPunct, ")")
		for _, tg := range targets {
			p.registerVar(tg, "Array")
			if dt := dirTestPath(dirW); dt != "" {
				p.readDirVars[tg] = dt
			}
		}
		capWr := map[string]any{
			"type": "Call", "func": "capture",
			"args": []any{map[string]any{
				"type": "Arrow", "body": []any{
					execStmt("ls", []map[string]any{strExpr("-1"), dirW}, "Spawn"),
				},
			}},
			"purity": "Spawn",
		}
		var rdOut []map[string]any
		rdOut = append(rdOut, assignStmt(targets[0], capWr))
		return rdOut
	}

	if p.atIdent("os") && p.pos+2 < len(p.toks) &&
		p.toks[p.pos+1].text == "." && p.toks[p.pos+2].text == "ReadFile" {
		p.next()
		p.expect(tPunct, ".")
		p.expect(tIdent, "ReadFile")
		p.expect(tPunct, "(")
		p.skipNL()
		arg := p.parseExpr()
		p.skipNL()
		p.expect(tPunct, ")")
		name := ""
		for _, tg := range targets {
			if tg == "_" {
				continue
			}
			if name == "" {
				name = tg
			} else if name != "" {
				// the trailing (value, error) slot under an ARBITRARY
				// name (err, err2, err3, e — real code names it freely)
				// is dropped like strconv.Atoi's error return
				continue
			}
		}
		if name == "" {
			// `_, err := os.ReadFile(p)` — the read STATUS would need an
			// assign-capture twin of readFileIfCond in statement position;
			// refusing is the honest shape until that lands
			p.failf("os.ReadFile needs a target var (v2)")
		}
		inner := execStmt("cat", []map[string]any{p.exprToWord(arg)}, "Emulable")
		capture := map[string]any{
			"type": "Call", "func": "capture",
			"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
			"purity": "Spawn",
		}
		p.registerVar(name, "Str")
		return []map[string]any{assignStmt(name, capture)}
	}

	// generic RHS
	rhs := p.parseExpr()

	// q, _ := f(args) — a call to a DEFINED sub as the RHS: the shell
	// shape is `q=$(f args)` — the sub's echo IS its return channel,
	// captured into the target (mirrors the os.ReadFile capture below).
	// Multiple non-_ targets would need IFS word-splitting to distribute
	// the echo words — refused (Refuse > guess).
	// os.ReadDir(dir) with multi-target (`entries, err2 := os.ReadDir(d)`)
	// → entries gets the captured `ls -1 dir` listing (names-only; the
	// "captured multi-line return" convention), err2 = "" (always succeeds)
	if rhs.kind == "call" && rhs.callee == "os.ReadDir" && len(rhs.args) == 1 {
		dirW := p.exprToWord(rhs.args[0])
		for _, tg := range targets {
			p.registerVar(tg, "Array")
			if dt := dirTestPath(dirW); dt != "" {
				p.readDirVars[tg] = dt
			}
		}
		capWr := map[string]any{
			"type": "Call", "func": "capture",
			"args": []any{map[string]any{
				"type": "Arrow", "body": []any{
					execStmt("ls", []map[string]any{strExpr("-1"), dirW}, "Spawn"),
				},
			}},
			"purity": "Spawn",
		}
		var rdOut []map[string]any
		rdOut = append(rdOut, assignStmt(targets[0], capWr))
		for i := 1; i < len(targets); i++ {
			p.registerVar(targets[i], "Str")
			rdOut = append(rdOut, assignStmt(targets[i], strExpr("")))
		}
		return rdOut
	}
	// recover() in an assign (`r := recover()` — run's err capture):
	// the caught value rides the defer's as-binding (getVar reads
	// the Error object; Sprintf %v renders it). The generic
	// call path would exec a missing "recover" sub and bind "".
	// (Before the callTargetName gate — recover is a builtin, never a
	// user sub.)
	if rhs.kind == "call" && rhs.callee == "recover" && !p.atPunct(",") {
		if p.deferRecover == "" {
			p.failf("recover() outside a defer func (v2)")
		}
		p.deferUsedRcv = true
		var ro []map[string]any
		for _, tg := range targets {
			if tg == "_" {
				continue
			}
			p.registerVar(tg, "Str")
			ro = append(ro, assignStmt(tg, getVarExpr(p.deferRecover)))
		}
		return ro
	}
	if rhs.kind == "call" && p.callTargetName(rhs.callee) != "" && !p.atPunct(",") {
		// METHOD calls (`x := l.cur()`): the receiver rides as $1; the
		// sub name is the last dotted segment
		// (a trailing `,` means a MULTI-ASSIGN `a, b := f(), g()` — the
		// multi-value loop below handles it; the capture path would
		// mis-read the second call as a multi-return slot)
		calleeName := p.callTargetName(rhs.callee)
		var words []map[string]any
		if dot := strings.LastIndex(rhs.callee, "."); dot >= 0 {
			baseName := rhs.callee[:dot]
			if p.pkgNames[baseName] || p.isExternalAlias(baseName) {
				// PACKAGE MODE: `pkg.F(args)` — no receiver; F is this
				// multi-file package's own function. EXTERNAL-UNIT:
				// `alias.F(args)` — the body lives in another unit;
				// same no-receiver shape (callTargetName admitted it).
				for _, a := range rhs.args {
					words = append(words, p.argToWord(a))
				}
			} else {
				rn := p.resolveVar(baseName)
				if rn == "" || !p.fnNames[calleeName] {
					p.failf("unsupported call %q (v2)", rhs.callee)
				}
				// the receiver rides as $1 — structIDWord maps a
				// PARAM receiver to its $N positional (the statement
				// path's structIDWord; getVarExpr(rn) here read the
				// GLOBAL store when the receiver was a function param,
				// so `t := p.tok()` inside a method body passed the
				// outer p instead of the caller's arena id)
				words = append(words, p.structIDWord(baseName))
				for _, a := range rhs.args {
					words = append(words, p.argToWord(a))
				}
			}
		} else {
			for _, a := range rhs.args {
				words = append(words, p.argToWord(a))
			}
		}
		// MULTI-return (`v, ok := f(...)`, `_, tag, ok := ...`):
		// capture the WHOLE stdout into a hidden temp, then read each
		// slot as whitespace-split word i — Go's per-position value
		// semantics without runtime __ret support
		tmpMr := "__mr_" + strconv.Itoa(p.tmpN)
		p.tmpN++
		p.registerVar(tmpMr, "Str")
		capMr := map[string]any{
			"type": "Call", "func": "capture",
			"args":   []any{map[string]any{"type": "Arrow", "body": []any{execStmtTA(calleeName, words, "Spawn", rhs.typeArgs)}}},
			"purity": "Spawn",
		}
		out := []map[string]any{assignStmt(tmpMr, capMr)}
		// a STRUCT-returning callee arms the dotted-field-write path
		// (`sp.inSub = true` on a newParser() result)
		if sig, okSig := p.fnSig[calleeName]; okSig && p.isStructType(sig[1]) {
			for _, tg := range targets {
				if tg != "_" {
					p.varStruct[p.resolveVar(tg)] = strings.TrimPrefix(sig[1], "*")
				}
			}
		}
		// a func returning a SLICE ([]T): the capture target is an
		// Array-typed store var so ranging/slicing lowers through the
		// param("slice", …) shapes (`args := p.parseArgs()` then
		// `range args[1:]` — go-sh.go's own parseAppendIntoList)
		sig, hasSig := p.fnSig[calleeName]
		retSlice := (hasSig && strings.HasPrefix(sig[1], "[]")) ||
			strings.HasPrefix(p.prescanRet[calleeName], "[]")
		// a func returning a MAP (`map[string]any` — the golib's own
		// word builders: exprToWord, strExpr, …): the targets bind as
		// NAMED ASSOC arrays so x["key"] reads lower to assocGet. The
		// prescan ret (raw text, forward refs) is the fallback when the
		// decl hasn't committed fnSig yet.
		retMap := (hasSig && strings.HasPrefix(sig[1], "map[")) ||
			strings.HasPrefix(p.prescanRet[calleeName], "map[")
		retIds := p.fnRetIdents[calleeName]
		// struct-slice first slot (`[]token` — elements ride a list
		// id, not space-joined items): the generic positional path
		// binds the id directly; the items rebuild below fires only
		// for scalar/pointer elements. Forward refs work (retIds come
		// from the prescan too).
		listElem := p.callFirstListElem(calleeName, retIds)
		sliceDone := false
		listBound := false
		for i, tg := range targets {
			if tg == "_" {
				continue
			}
			if !listBound && listElem != "" {
				p.anyLists[tg] = true
				p.anyElem[tg] = listElem
				listBound = true
			} else if !listBound {
				// rebinding clears stale list marks (see parseVarDecl).
				delete(p.anyLists, tg)
				delete(p.anyElem, tg)
				listBound = true
			}
			if retSlice && listElem == "" && !sliceDone {
				// the FIRST target of a SLICE-returning callee gets the
				// WHOLE array: the return echoes the items space-joined
				// (single array slot — the space-array convention) as
				// segment 0 of the RS-joined capture (later slots ride
				// later segments), so rebuild the array store from the
				// space-split of segment 0. A strSplit-word read would
				// take only the FIRST item — the dogfood app's own
				// `toks, err := lex(src)` (lex returns []token)
				// silently lost the array to `toks = split[0]`.
				sliceDone = true
				p.registerVar(tg, "Array")
				p.varTypes[tg] = "Array"
				seg0 := map[string]any{
					"type": "Call", "func": "listGet",
					"args": []any{
						map[string]any{
							"type": "Call", "func": "strSplit",
							"args":   []any{getVarExpr(tmpMr), strExpr("\036")},
							"purity": "PureCpu",
						},
						map[string]any{"type": "Int", "value": 0},
					},
					"purity": "PureCpu",
				}
				// strSplit yields a LIST id, not items — listItems
				// unwraps to the native array setArray splices
				// (a bare id would strand as one element).
				itemsArr := map[string]any{
					"type": "Call", "func": "listItems",
					"args": []any{map[string]any{
						"type": "Call", "func": "strSplit",
						"args":   []any{seg0, strExpr(" ")},
						"purity": "PureCpu",
					}},
					"purity": "PureCpu",
				}
				out = append(out, assignStmt(tg, map[string]any{
					"type": "Call", "func": "setArray",
					"args": []any{strExpr(tg), map[string]any{
						"type":     "Array",
						"elements": []any{itemsArr},
					}},
					"purity": "Emulable",
				}))
				continue
			}
			if retSlice && listElem == "" {
				// remaining targets of a slice-returning callee (the
				// trailing error slot): the return dropped the trailing
				// nil, so the slot is empty
				p.registerVar(tg, "Str")
				out = append(out, assignStmt(tg, strExpr("")))
				continue
			}
			if retMap {
				p.maps[tg] = true
				p.registerVar(tg, "Map")
			} else {
				rt := ""
				if i < len(retIds) {
					rt = retIds[i]
				}
				switch {
				case rt == "bool":
					p.registerVar(tg, "Bool")
				case p.isStructType(rt):
					p.registerVar(tg, "Str")
					p.varStruct[p.resolveVar(tg)] = strings.TrimPrefix(rt, "*")
				default:
					p.registerVar(tg, "Str")
				}
			}
			splitCall := map[string]any{
				"type": "Call", "func": "strSplit",
				"args":   []any{getVarExpr(tmpMr), strExpr("\036")},
				"purity": "PureCpu",
			}
			out = append(out, assignStmt(tg,
				map[string]any{
					"type": "Call", "func": "listGet",
					"args":   []any{splitCall, map[string]any{"type": "Int", "value": i}},
					"purity": "PureCpu",
				}))
		}
		if len(targets) > 1 {
			return out
		}
		// SINGLE target: classic echo+capture
		name := ""
		for _, tg := range targets {
			if tg != "_" {
				name = tg
			}
		}
		if name == "" {
			return nil // f(args) bare call as RHS of `_ :=` — pure side effect
		}
		p.noteCallResultType(name, rhs.callee, rhs.args)
		inner := execStmtTA(calleeName, words, "Spawn", rhs.typeArgs)
		capture := map[string]any{
			"type": "Call", "func": "capture",
			"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
			"purity": "Spawn",
		}
		if retSlice {
			if le := p.callFirstListElem(calleeName, retIds); le != "" {
				// struct-slice result rides a list id: bind it
				// directly (the generic capture), marked for list
				// reads — NOT the Array store (which would strand
				// the id as one space-joined string).
				p.anyLists[name] = true
				p.anyElem[name] = le
			} else {
				// rebinding clears stale list marks (see parseVarDecl).
				delete(p.anyLists, name)
				delete(p.anyElem, name)
				p.registerVar(name, "Array")
				p.varTypes[name] = "Array"
				// SCALAR slice (`args := p.parseArgs()`): the
				// capture holds space-joined items (single array
				// slot) — rebuild the ARRAY store from the split
				// (mirrors the multi-target slot-0 path). Binding
				// the raw capture strand arrayLen/arrayIndex reads
				// (self-host Println("hi") saw len 0).
				tmpMr2 := "__mr_" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.registerVar(tmpMr2, "Str")
				seg0 := map[string]any{
					"type": "Call", "func": "listGet",
					"args": []any{
						map[string]any{
							"type": "Call", "func": "strSplit",
							"args":   []any{getVarExpr(tmpMr2), strExpr("\036")},
							"purity": "PureCpu",
						},
						map[string]any{"type": "Int", "value": 0},
					},
					"purity": "PureCpu",
				}
				itemsArr := map[string]any{
					"type": "Call", "func": "listItems",
					"args": []any{map[string]any{
						"type": "Call", "func": "strSplit",
						"args":   []any{seg0, strExpr(" ")},
						"purity": "PureCpu",
					}},
					"purity": "PureCpu",
				}
				return []map[string]any{
					assignStmt(tmpMr2, capture),
					assignStmt(name, map[string]any{
						"type": "Call", "func": "setArray",
						"args": []any{strExpr(name), map[string]any{
							"type":     "Array",
							"elements": []any{itemsArr},
						}},
						"purity": "Emulable",
					}),
				}
			}
		} else {
			delete(p.anyLists, name)
			delete(p.anyElem, name)
			p.registerVar(name, "Str")
		}
		return []map[string]any{assignStmt(name, capture)}
	}

	// args := os.Args[1:] — argv with argv0 stripped, the shell's `"$@"`
	// (the array-valued positional slice `${@:off:len}`, which the core
	// lowers to the runtime's native positional list). Go's os.Args is
	// 0-based with argv0 at [0]; bash `${@:off}` is 1-BASED over the
	// positionals (`${@:1}` = all params; `${@:0}` = [argv0, ...params])
	// and is ARRAY-valued — so os.Args[i:] ↔ param("slice", "@", i, "")
	// and os.Args[i:j] ↔ param("slice", "@", i, j-i) (the exclusive-end
	// length, matching sliceWord). The runtime's setArray SPLICES the
	// param-slice array into the array store, so len(args)/args[i] read
	// off the store. Computed bounds stay refused; `range args` over the
	// result lowers to the `${arr[@]}` For-iter shape (ONE array-valued
	// param("slice", name, "@", "") element, flattened by forLoop — see
	// parseFor; templates/go/range_args.go).
	if rhs.kind == "slice" && rhs.target != nil && rhs.target.kind == "member" &&
		rhs.target.name == "os.Args" {
		if rhs.idx1e != nil || rhs.idx2e != nil {
			p.failf("os.Args slice bounds must be literal (v2)")
		}
		if len(targets) > 1 {
			p.failf("os.Args slice with multiple targets (v2)")
		}
		lo := rhs.idx1
		if lo == "" {
			lo = "0"
		}
		length := ""
		if rhs.idx2 != "" {
			loN, err1 := strconv.Atoi(lo)
			hiN, err2 := strconv.Atoi(rhs.idx2)
			if err1 != nil || err2 != nil || hiN < loN {
				p.failf("invalid os.Args slice bounds (v2)")
			}
			length = strconv.Itoa(hiN - loN)
		}
		p.registerVar(targets[0], "Array")
		return []map[string]any{assignStmt(targets[0], map[string]any{
			"type": "Call", "func": "setArray",
			"args": []any{strExpr(targets[0]), map[string]any{
				"type": "Array",
				"elements": []any{
					paramCall("slice", "@", lo, length),
				},
			}},
			"purity": "Emulable",
		})}
	}

	// upd := append([]T{}, x.f[mark:]...) — the slice-COPY idiom over a
	// MEMBER list: the fresh listSlice ref IS the new slice value (an
	// empty array literal + exactly one member-slice spread).
	if rhs.kind == "call" && rhs.callee == "append" && len(rhs.args) == 2 &&
		rhs.args[0].kind == "arraylit" && len(rhs.args[0].elems) == 0 &&
		rhs.args[1].spread && rhs.args[1].kind == "slice" &&
		rhs.args[1].target != nil && p.memberListType(rhs.args[1].target) != "" {
		p.registerVar(targets[0], "ListRef")
		return []map[string]any{assignStmt(targets[0], p.memberSliceWord(rhs.args[1]))}
	}
	// a = append(a, "c", "d") → setArrayAppend (the `arr+=(c d)` shape)
	if rhs.kind == "call" && rhs.callee == "append" {
		if len(rhs.args) < 2 || (rhs.args[0].kind != "var" &&
			rhs.args[0].kind != "arraylit") {
			p.failf("append needs (array, elems...) (v2)")
		}
		var elems []any
		var appendPre []map[string]any
		for _, a := range rhs.args[1:] {
			switch a.kind {
			case "str", "num", "rawstr":
				elems = append(elems, strExpr(a.text))
			case "char":
				// a Go rune literal element — its ASCII code (the
				// buffer/decode loops append integer codes)
				elems = append(elems, strExpr(charCode(a)))
			case "structlit":
				// a STRUCT VALUE: inline allocation — the element is
				// the object reference id
				elems = append(elems, p.objNewCall(a))
			case "maplit", "arraylit":
				// anonymous composite element: allocate + populate via
				// allocComposite; the element is its reference id
				tmpC, allocStmts := p.allocComposite(a)
				appendPre = append(appendPre, allocStmts...)
				elems = append(elems, getVarExpr(tmpC))
			case "addr":
				if a.lhs != nil && a.lhs.kind == "structlit" {
					elems = append(elems, p.objNewCall(a.lhs))
					break
				}
				p.failf("append elements must be literals or vars (v2)")
			case "var":
				// s = append(s, v) with a VARIABLE element — the dogfood
				// CLI's argv filter (`filtered = append(filtered, a)`) and
				// the golib's `tas = append(tas, item)`. The A1
				// setArrayAppend element contract is an EXPRESSION (shell
				// `arr+=(x)` lowers to split(getVar(x)) in shir.rs) — the
				// literal-only refusal was self-imposed. Lower through
				// exprToWord (getVar after resolve): one element per
				// appended VALUE, no field-splitting (Go semantics).
				elems = append(elems, p.exprToWord(a))
			case "call", "index", "member", "fieldof", "add", "slice":
				// computed elements ride as words (captures/reads; "add" =
				// string concatenation: zig-sh-go's
				// `params = append(params, pt+" "+pn.text)`; "slice" = the
				// golib's `append(parts, src[i:])` A1-builder calls)
				elems = append(elems, p.exprToWord(a))
			default:
				if a.spread {
					// slice spread (`append(out, other...)`) — the Spread
					// node expands the list at the runtime boundary
					elems = append(elems, p.argToWord(a))
				} else {
					p.failf("append elements must be literals or vars (v2)")
				}
			}
		}
		if memberBase != "" {
			// p.toks = append(p.toks, t) → p = jsonSet("p", "toks",
			// jsonArrAppend(jsonGet("p", "toks"), t)) — the go-sh
			// self-hosting contract (the golib's `p.fnParamOrd = append(...)`).
			p.registerVar(memberBase, "Struct")
			inner := map[string]any{
				"type": "Call", "func": "jsonGet",
				"args":   []any{strExpr(p.resolveVar(memberBase)), strExpr(memberField)},
				"purity": "PureCpu",
			}
			var appArgs []any
			appArgs = append(appArgs, inner)
			for _, el := range elems {
				appArgs = append(appArgs, el)
			}
			return []map[string]any{assignStmt(memberBase, map[string]any{
				"type": "Call", "func": "jsonSet",
				"args": []any{
					strExpr(p.resolveVar(memberBase)), strExpr(memberField),
					map[string]any{"type": "Call", "func": "jsonArrAppend", "args": appArgs, "purity": "PureCpu"},
				},
				"purity": "PureCpu",
			})}
		}
		p.registerVar(rhs.args[0].name, "Array")
		// the composite-element prelude (objNew/listNew allocations for
		// maplit/arraylit elements) MUST precede the append — the old
		// `return` before the prelude made it dead code, so the temp
		// refs read unset ("") at runtime (the dogfood app's own
		// `funcStmts = append(funcStmts, map[string]any{…})`)
		if ln := p.anyListVar(rhs.args[0].name); ln != "" {
			// ANY-LIST append (`out = append(out, tok{...})` — struct
			// elements ride a list id): listPush each element.
			out := append(appendPre, assignStmt(ln, map[string]any{
				"type": "Call", "func": "listPush",
				"args":   append([]any{getVarExpr(ln)}, elems...),
				"purity": "PureCpu",
			}))
			return out
		}
		out := append(appendPre, assignStmt(rhs.args[0].name, map[string]any{
			"type": "Call", "func": "setArrayAppend",
			"args":   []any{strExpr(rhs.args[0].name), map[string]any{"type": "Array", "elements": elems}},
			"purity": "Emulable",
		}))
		return out
	}

	// err := cmd.Run() — exec the stored command
	if rhs.kind == "call" && strings.HasSuffix(rhs.callee, ".Run") {
		base := strings.TrimSuffix(rhs.callee, ".Run")
		if args, ok := p.cmds[base]; ok {
			return []map[string]any{p.execFromArgs(args)}
		}
		p.failf("unknown command %q (v2)", base)
	}

	// comma-ok type assertion: v, ok := x.(T) — the TypeAssert ext node
	// for the value (checked passthrough), and the ok BOOLEAN as the
	// frontend's typeof comparison (`typeof(x) == kind` → "true"/"false";
	// a bare Bool var condition lowers to `"$ok" = true`, condTestString).
	if len(targets) == 2 && rhs.kind == "assert" {
		k := goTypeKind(rhs.typeName)
		if k == "" {
			// NAMED struct types (*StrE, *LitStr, …): the object store
			// records each allocation's declared type, so the runtime
			// typeof vocabulary IS the struct name — assert against it
			base := strings.TrimPrefix(strings.TrimSpace(rhs.typeName), "*")
			if p.isStructType(base) {
				k = base
			}
		}
		if k == "" {
			p.failf("unsupported type assertion to %q (v2)", rhs.typeName)
		}
		w := p.exprToWord(rhs)
		vName, okName := targets[0], targets[1]
		// a MAP assertion binds the value as a NAMED ASSOC array (the
		// A1's map model): x["k"] reads lower to assocGet after the
		// comma-ok `v, ok := x.(map[string]any)` form. The asserted
		// value (a list element, a jsonObject word) materializes via
		// the runtime toAssoc — a bare passthrough would strand a
		// plain object no assocGet can read.
		if k == "map" {
			p.maps[vName] = true
			p.registerVar(vName, "Map")
			w = map[string]any{
				"type": "Call", "func": "toAssocInto",
				"args":   []any{strExpr(vName), w},
				"purity": "PureCpu",
			}
		} else {
			p.registerVar(vName, "Str")
		}
		p.registerVar(okName, "Bool")
		return []map[string]any{
			assignStmt(vName, w),
			// ok ← typeof(x) == kind ? "true" : "false" as a branch pair
			// (the A1 BinOp Eq renders natively on every backend; the
			// textual "true"/"false" match Go's fmt bool printing).
			{
				"type": "If",
				"cond": map[string]any{
					"type": "BinOp", "op": "Eq",
					"lhs": map[string]any{
						"type": "Call", "func": "typeof",
						"args":   []any{p.exprToWord(rhs.lhs)},
						"purity": "PureCpu",
					},
					"rhs": strExpr(k),
				},
				"then":   []any{assignStmt(okName, strExpr("true"))},
				"elsifs": []any{},
				"else":   []any{assignStmt(okName, strExpr("false"))},
			},
		}
	}

	// single-target MAP assertion: x := v.(map[string]any) — the
	// value binds as a NAMED ASSOC array (the A1's map model: maps
	// exist as assoc arrays, never as var-store values), so x["k"]
	// reads lower to assocGet and writes to assocSet (the go-sh
	// golib's own `lit := parts[0].(map[string]any)` word access)
	if len(targets) == 1 && rhs.kind == "assert" && goTypeKind(rhs.typeName) == "map" {
		p.maps[targets[0]] = true
		p.registerVar(targets[0], "Map")
		return []map[string]any{assignStmt(targets[0], map[string]any{
			"type": "Call", "func": "toAssocInto",
			"args":   []any{strExpr(targets[0]), p.exprToWord(rhs)},
			"purity": "PureCpu",
		})}
	}

	// comma-ok MAP read: v, ok := m[k] — v gets the element, ok gets
	// presence as a textual bool (JS != "" coerces to true/false)
	// SINGLE-value form only: a trailing `, v2` is a multi-assign RHS
	// list (`td, ntPath := os.Args[1], os.Args[2]`), not a comma-ok
	if len(targets) == 2 && rhs.kind == "index" && !p.atPunct(",") {
		w := p.exprToWord(rhs)
		vName, okName := targets[0], targets[1]
		p.registerVar(vName, "Str")
		p.registerVar(okName, "Bool")
		out := []map[string]any{assignStmt(vName, w)}
		if okName != "_" {
			out = append(out, assignStmt(okName, map[string]any{
				"type": "BinOp", "op": "Ne",
				"lhs": w, "rhs": strExpr(""),
			}))
		}
		return out
	}

	// multi-assign: a, b := x, y → Block of Assigns (A=x B=y shape)
	if len(targets) > 1 {
		values := []*expr{rhs}
		for p.acceptPunct(",") {
			p.skipNL()
			values = append(values, p.parseExpr())
		}
		// non-nil init: an EMPTY literal must marshal body as [],
		// never null (the ingress rejects Block.body: not an array)
		body := []map[string]any{}
		for i, tg := range targets {
			if tg == "_" {
				continue
			}
			if i >= len(values) {
				p.failf("multi-assign arity mismatch (v2)")
			}
			var w map[string]any
			if values[i].kind == "member" || values[i].kind == "index" || values[i].kind == "call" || values[i].kind == "fieldof" || values[i].kind == "binop" || values[i].kind == "not" {
				if ww, ok2 := p.condOperandA1Word(values[i]); ok2 {
					w = ww
				}
			}
			if w == nil {
				w = p.exprToWord(values[i])
			}
			// struct reference propagation for member reads
			if values[i].kind == "member" {
				parts3 := strings.Split(values[i].name, ".")
				baseName := p.resolveVar(parts3[0])
				typeName := p.varStruct[baseName]
				if typeName != "" {
					layout := p.structs[typeName]
					field := parts3[len(parts3)-1]
					raws := p.structRaw[typeName]
					for fi2, f2 := range layout {
						if f2 == field && fi2 < len(raws) {
							cand := strings.TrimPrefix(strings.TrimPrefix(raws[fi2], "[]"), "*")
							if p.isStructType(cand) {
								p.varStruct[p.resolveVar(tg)] = cand
							}
						}
					}
				}
			}
			tt := p.wordType(w)
			if values[i].kind == "var" && (values[i].name == "true" || values[i].name == "false") {
				tt = "Bool"
			}
			p.registerVar(tg, tt)
			body = append(body, assignStmt(tg, w))
		}
		if len(body) == 0 {
			return nil
		}
		return []map[string]any{{
			"type": "Block",
			"body": body,
		}}
	}

	// struct allocation: x := &T{...} / x := T{...} — the ARENA model
	// (both allocate; Go's copy semantics are unobservable for the
	// corpus's by-reference usage — documented)
	if rhs.kind == "addr" && rhs.lhs != nil && rhs.lhs.kind == "structlit" && len(targets) == 1 {
		stmts := p.newstructStmts(targets[0], rhs.lhs)
		p.registerVar(targets[0], "Str")
		p.varStruct[p.resolveVar(targets[0])] = rhs.lhs.structType
		return stmts
	}
	if rhs.kind == "structlit" && len(targets) == 1 {
		stmts := p.newstructStmts(targets[0], &expr{kind: "addr", lhs: rhs})
		p.registerVar(targets[0], "Str")
		p.varStruct[p.resolveVar(targets[0])] = rhs.structType
		return stmts
	}

	// strings.SplitN(s, sep, n) — track the split relationship so
	// index reads on the target var lower to param ops on the SOURCE
	// var (parts[0] = ${s%%sep*}, parts[1] = ${s#*sep})
	if len(targets) == 1 && rhs.kind == "call" &&
		rhs.callee == "strings.SplitN" && len(rhs.args) == 3 &&
		rhs.args[0].kind == "var" {
		srcVar := p.resolveVar(rhs.args[0].name)
		var sep string
		if rhs.args[1].kind == "str" || rhs.args[1].kind == "rawstr" {
			sep = rhs.args[1].text
		} else {
			p.failf("SplitN separator must be a literal (v2)")
		}
		p.splitNVars[targets[0]] = splitNInfo{src: srcVar, sep: sep}
		p.registerVar(targets[0], "Str")
		return []map[string]any{assignStmt(targets[0], strExpr(""))}
	}

	// re := regexp.MustCompile(`pat`) — track the pattern; value = the
	// pattern TEXT (inert; FindString/MatchString lower from the
	// tracked source via RegexpFind/regexMatch)
	if rhs.kind == "call" &&
		(rhs.callee == "regexp.MustCompile" || rhs.callee == "regexp.Compile") {
		if len(rhs.args) == 1 && (rhs.args[0].kind == "rawstr" || rhs.args[0].kind == "str") {
			p.regexpVars[targets[0]] = rhs.args[0].text
			p.registerVar(targets[0], "Str")
			return []map[string]any{assignStmt(targets[0], strExpr(rhs.args[0].text))}
		}
	}
	// single assign
	var w map[string]any
	if rhs.kind == "binop" || rhs.kind == "not" {
		// boolean expressions as VALUES (empty := a == b): native BinOp;
		// the target registers Bool so later bare-var conditions gate.
		// AND/OR trees lower via the flag-based bool-tree (the statused
		// And/Or render reads stale $? for pure-JS comparison leaves)
		if ww, ok := p.condOperandA1Word(rhs); ok {
			w = ww
			p.registerVar(targets[0], "Bool")
		} else if rhs.BOpKind == "and" || rhs.BOpKind == "or" {
			flag := "__bt_" + strconv.Itoa(p.tmpN)
			p.tmpN++
			p.registerVar(flag, "Str")
			out := p.boolTreeStmts(rhs, flag)
			out = append(out, assignStmt(targets[0],
				map[string]any{"type": "Var", "name": flag, "sigil": nil}))
			return out
		} else {
			p.failf("unsupported comparison in word position (v2)")
		}
	}
	if w == nil {
		w = p.exprToWord(rhs)
	}
	if rhs.kind == "call" && p.isCgoCallee(rhs.callee) {
		p.cgoObjs[targets[0]] = true // native object id (CGO-PATH)
	}
	if st := p.inferElemStructType(rhs); st != "" {
		p.varStruct[p.resolveVar(targets[0])] = st
	}
	if rhs.kind == "var" {
		if st := p.varStruct[p.resolveVar(rhs.name)]; st != "" {
			p.varStruct[p.resolveVar(targets[0])] = st
		}
	}
	if rhs.kind == "call" {
		if tn := p.callTargetName(rhs.callee); tn != "" {
			if sig, ok := p.fnSig[tn]; ok && p.isStructType(sig[1]) {
				p.varStruct[p.resolveVar(targets[0])] = strings.TrimPrefix(sig[1], "*")
			}
			// a user func returning a SLICE ([]T): the target is an
			// Array-typed store var, so ranging/slicing it lowers through
			// the proven param("slice", …) shapes (`args := p.parseArgs()`
			// then `range args[1:]` — go-sh.go's own parseAppendIntoList).
			// LIST-element slices route to list storage first (see the
			// callFirstListElem contract — shell arrays flatten objects).
			if le := p.callFirstListElem(tn, p.fnRetIdents[tn]); le != "" {
				p.anyLists[targets[0]] = true
				p.anyElem[targets[0]] = le
			} else if sig, ok := p.fnSig[tn]; ok && strings.HasPrefix(sig[1], "[]") {
				// rebinding clears stale list marks (see parseVarDecl).
				delete(p.anyLists, targets[0])
				delete(p.anyElem, targets[0])
				p.registerVar(targets[0], "Array")
			}
			// a func returning a MAP (`map[string]any` — the golib's own
			// word builders): the target binds as a NAMED ASSOC array so
			// x["key"] reads lower to assocGet (localVal's `w["value"]`)
			if sig, ok := p.fnSig[tn]; ok && strings.HasPrefix(sig[1], "map[") {
				p.maps[targets[0]] = true
				p.registerVar(targets[0], "Map")
			}
		}
	}
	if rhs.kind == "var" && (rhs.name == "true" || rhs.name == "false") {
		// a Go BOOL literal initializer registers Bool so bare-var
		// conditions (`if matched {`) lower to `"$v" = "true"`
		p.registerVar(targets[0], "Bool")
		return []map[string]any{assignStmt(targets[0], strExpr(rhs.name))}
	}
	if op == "+=" {
		// STRING concat only when the TARGET is a string (or the rhs
		// carries object reads); pure-numeric stays arithmetic
		tIsStr := p.varTypes[p.resolveVar(targets[0])] == "Str"
		if tIsStr || p.hasObjectRead(rhs) || p.addHasString(rhs) {
			cur := getVarExpr(targets[0])
			cat := interpParts([]any{
				map[string]any{"kind": "expr", "expr": cur},
				map[string]any{"kind": "expr", "expr": w},
			})
			return []map[string]any{assignStmt(targets[0], cat)}
		}
		p.registerVar(targets[0], "Int")
		// i += len(op) — a string/array LENGTH in arithmetic: the Arith
		// AST can't express `${#op}`, so lower to the arith-TEXT form
		// (the runtime's evalArith expands ${#...} — the golib's
		// `i += len(op)` operator-length advance).
		if rhs.kind == "strlen" || rhs.kind == "arrlen" {
			lenWord := ""
			if rhs.kind == "strlen" {
				lenWord = "${#" + p.resolveVar(rhs.target.name) + "}"
			} else {
				lenWord = "${#" + p.resolveVar(rhs.target.name) + "[@]}"
			}
			return []map[string]any{assignStmt(targets[0], map[string]any{
				"type": "Call", "func": "arith",
				"args":   []any{strExpr(targets[0] + " + " + lenWord)},
				"purity": "PureCpu",
			})}
		}
		return []map[string]any{assignStmt(targets[0],
			arithWrap(arithBin(arithVar(targets[0]), "+", p.exprToArith(rhs))))}
	}
	// inside a func: `name := lit` on a fresh var → local name=lit
	if p.inFunc && op == ":=" && !p.fnParams[targets[0]] && !p.outer[targets[0]] && !p.fnLocals[targets[0]] {
		p.fnLocals[targets[0]] = true
		// rebinding clears stale list marks (see parseVarDecl);
		// branches below re-mark genuine lists.
		delete(p.anyLists, targets[0])
		delete(p.anyElem, targets[0])
		// register the type (byte reads `c := src[i]`, struct values,
		// field-element reads) so later lowerings (string(c) → chr,
		// char compares) see it — the shared registerAssignType path
		// below is skipped by this early return.
		p.registerAssignType(targets[0], rhs, w)
		// a SLICE-returning call (`args := p.parseArgs()` — the golib's
		// own parseAppendIntoList) binds an Array store so `range
		// args[1:]` lowers through param("slice", …). LIST-element
		// slices (`[]tok`, `[]any`, `[]map[string]any`) bind a list id
		// instead (shell arrays String-coerce object elements). The
		// call word is Str-typed; the signature overrides it.
		if rhs.kind == "call" {
			cn := p.callTargetName(rhs.callee)
			if le := p.callFirstListElem(cn, p.fnRetIdents[cn]); le != "" {
				p.anyLists[targets[0]] = true
				p.anyElem[targets[0]] = le
			} else if sig, ok := p.fnSig[cn]; ok && strings.HasPrefix(sig[1], "[]") {
				p.registerVar(targets[0], "Array")
			} else if strings.HasPrefix(p.prescanRet[cn], "[]") {
				p.registerVar(targets[0], "Array")
			}
		}
		// bool literals register as Bool so bare-var conditions lower to
		// `"$x" = "true"` (the comma-ok idiom's gate)
		if ww, ok := w["value"].(string); ok && (ww == "true" || ww == "false") {
			p.registerVar(targets[0], "Bool")
		}
		// `local name=val` can only carry a LITERAL value (the runtime
		// expands the text). A computed word (src[i], a call, a member
		// read) would silently DROP to `local name=` — the dogfood app's
		// own `c := src[i]` byte read in lex. Emit a plain store assign
		// instead (the runtime's local builtin is a plain store write
		// anyway — the A1 has no scoped locals).
		if lv := localVal(w); lv != "" {
			return []map[string]any{execStmt("local",
				[]map[string]any{strExpr(targets[0] + "=" + lv)}, "Emulable")}
		}
		return []map[string]any{assignStmt(targets[0], w)}
	}
	p.registerAssignType(targets[0], rhs, w)
	return []map[string]any{assignStmt(targets[0], w)}
}

// registerAssignType — the target's type for an assign RHS: a byte read
// (`c := src[i]`), a struct VALUE (`p := &parser{...}`), a struct-field
// ELEMENT read (`t := p.toks[p.pos]` — the field's element type), or the
// word type.
func (p *parser) registerAssignType(name string, rhs *expr, w map[string]any) {
	if rhs.kind == "index" && rhs.target != nil && rhs.target.kind == "var" &&
		p.varTypes[p.resolveVar(rhs.target.name)] != "Array" {
		p.registerVar(name, "Byte")
	} else if rhs.kind == "structlit" {
		p.registerVar(name, "Struct")
		p.varStructTypes[name] = rhs.name
	} else if rhs.kind == "index" && rhs.target != nil && rhs.target.kind == "member" {
		if i := strings.LastIndex(rhs.target.name, "."); i > 0 {
			base, field := rhs.target.name[:i], rhs.target.name[i+1:]
			if elt := p.structFieldTypes[p.structTypeOf(base)][field]; elt != "" {
				if _, ok := p.structFields[elt]; ok {
					p.registerVar(name, "Struct")
					return
				}
			}
		}
		p.registerVar(name, p.wordType(w))
	} else {
		p.registerVar(name, p.wordType(w))
	}
}

// localVal renders the value text for `local name=val`.
func localVal(w map[string]any) string {
	switch v := w["type"].(string); v {
	case "Interpolate":
		if parts, ok := w["parts"].([]any); ok && len(parts) == 1 {
			if pt, ok := parts[0].(map[string]any); ok && pt["kind"] == "lit" {
				return pt["text"].(string)
			}
		}
	case "Str":
		return w["value"].(string)
	}
	return ""
}

// parseMapLiteral: `map[K]V{ k: v, ... }` → one assocSet per pair (the
// runtime's by-name associative-array store; t54). Shared by the
// `name := map[...]...{...}` assign and the `var name = map[...]...{...}`
// decl (the cpp frontend's `var refuseKeywords = map[string]string{...}`
// and `var allowedKinds = map[string]bool{...}` whitelist tables). The
// type position `map[K]V` is consumed as TOKENS, never parsed as
// expressions — `string` inside `[string]` must not hit the `string(x)`
// conversion path. Values accept bool literals (true/false) alongside
// str/num/rawstr — a `map[string]bool` whitelist's `true` is a literal,
// not a `$true` var read.
func (p *parser) parseMapLiteral(targets []string) []map[string]any {
	p.pos++ // map
	p.expect(tPunct, "[")
	for p.tok().kind == tIdent {
		p.next()
	}
	p.expect(tPunct, "]")
	for p.tok().kind == tIdent {
		p.next()
	}
	p.skipNL()
	p.expect(tPunct, "{")
	if len(targets) > 1 {
		p.failf("map literal with multiple targets (v2)")
	}
	p.maps[targets[0]] = true
	p.registerVar(targets[0], "Map")
	// non-nil init: an EMPTY literal must marshal body as [],
		// never null (the ingress rejects Block.body: not an array)
		body := []map[string]any{}
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			break
		}
		key := p.parseExpr()
		if key.kind != "str" && key.kind != "num" && key.kind != "rawstr" {
			p.failf("map keys must be literals (v2)")
		}
		p.expect(tPunct, ":")
		p.skipNL()
		val := p.parseExpr()
		valText := ""
		switch val.kind {
		case "str", "num", "rawstr":
			valText = val.text
		case "var":
			// bool literal values (map[string]bool whitelists)
			if val.name == "true" || val.name == "false" {
				valText = val.name
				break
			}
			p.failf("map values must be literals (v2)")
		default:
			p.failf("map values must be literals (v2)")
		}
		body = append(body, map[string]any{
			"type": "Expr",
			"expr": map[string]any{
				"type": "Call", "func": "assocSet",
				"args":   []any{strExpr(targets[0]), strExpr(key.text), strExpr(valText)},
				"purity": "Emulable",
			},
		})
		if !p.acceptPunct(",") {
			p.skipNL()
			p.expect(tPunct, "}")
			break
		}
	}
	return []map[string]any{{"type": "Block", "body": body}}
}

// arrayLitAhead: the token stream at pos is `[ ] <type> {` — an array
// literal in an EXPRESSION position (the golib's A1 builders' `[]any{...}`).
func (p *parser) arrayLitAhead() bool {
	if p.tok().kind != tPunct || p.tok().text != "[" ||
		p.toks[p.pos+1].kind != tPunct || p.toks[p.pos+1].text != "]" {
		return false
	}
	for i := p.pos + 2; i < len(p.toks); i++ {
		t := p.toks[i]
		if t.kind == tPunct && t.text == "{" {
			return true
		}
		if t.kind == tNL || t.kind == tEOF {
			return false
		}
	}
	return false
}

// parseArrayLiteral parses `[]T{ e1, e2, ... }` and returns the element
// words plus the element type.
// sliceLitAhead: `[ ] [T] {` — a slice composite literal starts here
// (the element type may be dotted/multi-ident).
func (p *parser) sliceLitAhead() bool {
	if !(p.tok().kind == tPunct && p.tok().text == "[") {
		return false
	}
	i := p.pos + 1
	if p.toks[i].kind == tPunct && p.toks[i].text == "]" {
		i++
	} else {
		// [N]... fixed-size array prefix
		for i < len(p.toks) && !(p.toks[i].kind == tPunct && p.toks[i].text == "]") {
			i++
		}
		if i >= len(p.toks) {
			return false
		}
		i++
	}
	// walk the element TYPE to its opening brace: balanced bracket
	// groups + idents/dots/asterisks — handles []T{}, [2]string{},
	// []map[string][]*expr{} alike
	depth := 0
	for i < len(p.toks) {
		tk := p.toks[i]
		if tk.kind == tPunct {
			switch tk.text {
			case "[":
				depth++
			case "]":
				if depth == 0 {
					return false
				}
				depth--
			case "{":
				if depth == 0 {
					return true
				}
				depth++
			case "}":
				depth--
			case "*", "&", ".":
				// pointer/address/qualified type chars ([]*expr{...})
				i++
				continue
			default:
				if depth == 0 {
					return false // any other punct ends the type
				}
			}
			i++
			continue
		}
		if tk.kind == tNL || tk.kind == tEOF || tk.kind == tOp {
			return false
		}
		i++ // idents, nums
	}
	return false
}

// byteConvAhead: the token stream at pos is `[ ] byte (` — the
// []byte(x) conversion (grammar conversion; identity in the A1's
// strings-are-bytes model).
func (p *parser) byteConvAhead() bool {
	return p.pos+3 < len(p.toks) &&
		p.toks[p.pos].kind == tPunct && p.toks[p.pos].text == "[" &&
		p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "]" &&
		p.toks[p.pos+2].kind == tIdent && p.toks[p.pos+2].text == "byte" &&
		p.toks[p.pos+3].kind == tPunct && p.toks[p.pos+3].text == "("
}

// byteSliceLitAhead: the token stream at pos is `[ ] byte {` — the
// []byte{...} byte-slice composite literal (refused, see parseAssignStmt).
func (p *parser) byteSliceLitAhead() bool {
	return p.pos+3 < len(p.toks) &&
		p.toks[p.pos].kind == tPunct && p.toks[p.pos].text == "[" &&
		p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "]" &&
		p.toks[p.pos+2].kind == tIdent && p.toks[p.pos+2].text == "byte" &&
		p.toks[p.pos+3].kind == tPunct && p.toks[p.pos+3].text == "{"
}

// sliceConvAhead: the token stream at pos is `[] <type> (` — a
// slice-TYPE CONVERSION ([]map[string]any(nil), []any(x)): identity
// under the A1's strings-only model (the []byte(x) twin; the golib's
// own `body := []map[string]any(nil)` slice decls). The type walk is
// the sliceLitAhead walker with `(` as the opening-brace terminator.
func (p *parser) sliceConvAhead() bool {
	if !(p.tok().kind == tPunct && p.tok().text == "[") {
		return false
	}
	i := p.pos + 1
	if !(p.toks[i].kind == tPunct && p.toks[i].text == "]") {
		return false
	}
	i++
	depth := 0
	for i < len(p.toks) {
		tk := p.toks[i]
		if tk.kind == tPunct {
			switch tk.text {
			case "[":
				depth++
			case "]":
				if depth == 0 {
					return false
				}
				depth--
			case "(":
				if depth == 0 {
					return true
				}
				depth++
			case ")":
				depth--
			default:
				if depth == 0 {
					return false // any other punct ends the type
				}
			}
			i++
			continue
		}
		if tk.kind == tNL || tk.kind == tEOF || tk.kind == tOp {
			return false
		}
		if tk.kind == tPunct && tk.text == "*" {
			i++
			continue
		}
		if tk.kind == tPunct && tk.text != "[" && tk.text != "]" && tk.text != "(" && tk.text != ")" {
			return false
		}
		i++ // "idents
	}
	return false
}

// parseSliceConv consumes `[] <type> ( <expr> )` — identity conversion.
func (p *parser) parseSliceConv() *expr {
	p.expect(tPunct, "[")
	p.expect(tPunct, "]")
	p.skipType()
	p.expect(tPunct, "(")
	p.skipNL()
	e := p.parseExpr()
	p.skipNL()
	p.expect(tPunct, ")")
	return e
}

func (p *parser) parseArrayLiteral() ([]map[string]any, string) {
	p.expect(tPunct, "[")
	p.skipNL()
	typ := "Str"
	for !p.atPunct("{") {
		t := p.next()
		if t.kind == tEOF {
			p.failf("unterminated array literal")
		}
		if t.kind == tIdent {
			// ANONYMOUS STRUCT element type (`[]struct{ a, b T }{...}` —
			// zig-sh-go's format-spec table): register the field list as
			// a synthetic type so elements lower to objNew refs and
			// `spec.field` reads resolve; then skip to the REAL literal
			// brace (the braces just consumed were the FIELD LIST)
			if t.text == "struct" && p.tok().kind == tPunct && p.tok().text == "{" {
				p.pos++
				var fields []string
				for !p.atPunct("}") {
					if p.tok().kind == tIdent {
						nm := p.next().text
						fields = append(fields, nm)
						if p.acceptPunct(",") {
							p.skipNL()
							continue
						}
						p.skipType() // the group's shared type
						if p.acceptPunct(";") {
							p.skipNL()
							continue
						}
						break
					}
					p.pos++
				}
				p.expect(tPunct, "}")
				typ = "__anon" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.structs[typ] = fields
				p.skipNL()
				continue
			}
			typ = t.text
		}
		p.skipNL()
	}
	p.expect(tPunct, "{")
	// non-nil so an EMPTY literal marshals to `[]`, never `null` — the
	// core's Array.elements is a Vec (shir_json.rs always collects).
	elems := []map[string]any{}
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			break
		}
		// bare `{...}` elements of an anon-struct slice literal: Go
		// elides the type prefix inside []T{...} — positional fields
		if p.atPunct("{") && strings.HasPrefix(typ, "__anon") {
			sl := p.parseStructLit(typ, p.structs[typ])
			elems = append(elems, p.exprToArrayElem(sl))
		} else {
			e := p.parseExpr()
			elems = append(elems, p.exprToArrayElem(e))
		}
		if !p.acceptPunct(",") {
			p.skipNL()
			p.expect(tPunct, "}")
			break
		}
	}
	if typ == "int" || typ == "int64" || typ == "float64" {
		typ = "Int"
	} else {
		typ = "Str"
	}
	if elems == nil {
		// an EMPTY slice literal (`[]string{}`) must emit `elements:
		// []` — the A1 contract rejects null (the golib's own
		// `filtered := []string{}` argv filter)
		elems = []map[string]any{}
	}
	return elems, typ
}

// ── compound statements ─────────────────────────────────────────────

// ifInitReadFileAhead: `if <name>, err := os.ReadFile(` — the if-init
// form of the whole-file read with a NAMED first target (the
// `if _, err := os.Stat(` arm above handles the underscore path-test
// form; the statement form `b, _ := os.ReadFile(p)` lowers in
// parseAssignStmt). Returns the target name. Everything else falls
// through to the generic expression cond.
func (p *parser) ifInitReadFileAhead() (string, bool) {
	if p.tok().kind != tIdent || p.atIdent("_") || p.atIdent("err") {
		return "", false
	}
	name := p.tok().text
	t := p.toks
	i := p.pos + 1
	if i+6 >= len(t) {
		return "", false
	}
	if t[i].kind != tPunct || t[i].text != "," ||
		t[i+1].kind != tIdent || t[i+1].text != "err" ||
		t[i+2].kind != tOp || t[i+2].text != ":=" ||
		t[i+3].kind != tIdent || t[i+3].text != "os" ||
		t[i+4].kind != tPunct || t[i+4].text != "." ||
		t[i+5].kind != tIdent || t[i+5].text != "ReadFile" ||
		t[i+6].kind != tPunct || t[i+6].text != "(" {
		return "", false
	}
	return name, true
}

// ifInitStatAhead: `if <name>, err := os.Stat(` — the NAMED-target
// stat probe (the `_`-target literal-path arm is handled earlier in
// parseIf). Returns true when the token shape matches.
func (p *parser) ifInitStatAhead() bool {
	t := p.toks
	i := p.pos + 1 // after <name>
	if i+5 >= len(t) {
		return false
	}
	return t[i].kind == tPunct && t[i].text == "," &&
		t[i+1].kind == tIdent && t[i+1].text == "err" &&
		((t[i+2].kind == tOp || t[i+2].kind == tPunct) && t[i+2].text == ":=") &&
		t[i+3].kind == tIdent && t[i+3].text == "os" &&
		t[i+4].kind == tPunct && t[i+4].text == "." &&
		t[i+5].kind == tIdent && t[i+5].text == "Stat"
}

// readFileIfCond: the `if b, err := os.ReadFile(p); err (==|!=) nil`
// cond — byte-identical to the core's `if b=$(cat p); then` /
// `if ! b=$(cat p); then` lowering (verified against `otranspilerl-cli file
// --shir`): Call{func:"assign", args:[Str(name), Str("="),
// Capture{native:false, expr:Arrow{body:[Expr exec cat …]}}]}, wrapped
// in the Not BinOp for err != nil (lhs+rhs both carry the assign,
// matching the core's shape). cat is an Emulable sync builtin; the
// []byte result is a string in the A1's strings-are-bytes model (same
// as the statement form).
func (p *parser) readFileIfCond(name string, path map[string]any, neg bool) map[string]any {
	assignCall := map[string]any{
		"type": "Call", "func": "assign",
		"args": []any{
			strExpr(name),
			strExpr("="),
			map[string]any{
				"type": "Capture", "native": false,
				"expr": map[string]any{
					"type": "Arrow",
					"body": []any{execStmt("cat", []map[string]any{path}, "Emulable")},
				},
			},
		},
		"purity": "Emulable",
	}
	if neg {
		return map[string]any{
			"type": "BinOp", "op": "Not",
			"lhs": assignCall, "rhs": assignCall,
		}
	}
	return assignCall
}

func (p *parser) parseIf() []map[string]any {
	p.expect(tIdent, "if")
	p.skipNL()
	var pre []map[string]any
	var cond *expr
	if p.atIdent("_") && p.pos+4 < len(p.toks) &&
		p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "," &&
		p.toks[p.pos+3].kind == tOp && p.toks[p.pos+3].text == ":=" &&
		!(p.toks[p.pos+4].kind == tIdent && p.toks[p.pos+4].text == "os") {
		// if _, X := <expr>; cond { ... } — a GENERAL `_`-discard
		// if-init (the golib's `if _, ok := p.structFields[callName(e)];
		// !ok` map-presence checks): X = <expr> as a pre-statement, then
		// the If on cond. A map-index RHS sets X to the PRESENCE bool
		// (assocHas), so a later `!ok` / `ok` tests it correctly.
		p.pos++ // _
		p.pos++ // ,
		p.skipNL()
		xName := p.expect(tIdent, "").text
		p.expect(tOp, ":=")
		p.skipNL()
		val := p.parseExpr()
		var w map[string]any
		if val.kind == "index" && val.target != nil && val.target.kind == "var" && p.maps[val.target.name] {
			// `_, ok := m[k]` — ok is the PRESENCE bool (assocHas); the
			// key is resolved at runtime (a member/call key lowers to its
			// cmdsub word, which assocHas expandWord's).
			var keyWord map[string]any
			if val.idx1e != nil {
				keyWord = p.exprToWord(val.idx1e)
			} else {
				keyWord = strExpr(val.idx1)
			}
			w = assocHasCall(val.target.name, keyWord)
		} else if val.kind == "index" && val.target != nil && val.target.kind == "member" {
			// `_, ok := p.structFields[k]` — presence in a STRUCT's map
			// field (jsonHas). The key word resolves at runtime.
			if i := strings.LastIndex(val.target.name, "."); i > 0 {
				base, field := val.target.name[:i], val.target.name[i+1:]
				if p.varTypes[p.resolveVar(base)] == "Struct" {
					var keyWord map[string]any
					if val.idx1e != nil {
						keyWord = p.exprToWord(val.idx1e)
					} else {
						keyWord = strExpr(val.idx1)
					}
					w = map[string]any{
						"type": "Call", "func": "jsonHas",
						"args":   []any{strExpr(p.resolveVar(base)), strExpr(field), keyWord},
						"purity": "PureCpu",
					}
				} else {
					w = p.exprToWord(val)
				}
			} else {
				w = p.exprToWord(val)
			}
		} else {
			w = p.exprToWord(val)
		}
		pre = append(pre, assignStmt(xName, w))
		p.registerAssignType(xName, val, w)
		p.skipNL()
		p.expect(tPunct, ";")
		p.skipNL()
		cond = p.parseExpr()
	} else if p.atIdent("_") && p.pos+7 < len(p.toks) &&
		p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "," &&
		p.toks[p.pos+2].kind == tIdent && p.toks[p.pos+2].text == "err" &&
		(p.toks[p.pos+3].kind == tOp || p.toks[p.pos+3].kind == tPunct) && p.toks[p.pos+3].text == ":=" &&
		p.toks[p.pos+4].kind == tIdent && p.toks[p.pos+4].text == "os" &&
		p.toks[p.pos+5].kind == tPunct && p.toks[p.pos+5].text == "." &&
		p.toks[p.pos+6].kind == tIdent && p.toks[p.pos+6].text == "Stat" {
		// if _, err := os.Stat("path"); err == nil { → test("-e path")
		// (-e = exists, ANY type — Go's os.Stat succeeds for devices,
		// dirs and symlinks alike; bash `-f` is regular files only, and
		// a probe stat-ing /dev/null would flip to the else branch).
		p.pos++
		p.expect(tPunct, ",")
		p.expect(tIdent, "err")
		p.expect(tPunct, ":=")
		p.expect(tIdent, "os")
		p.expect(tPunct, ".")
		p.expect(tIdent, "Stat")
		p.expect(tPunct, "(")
		pathTok := p.expect(tStr, "")
		p.skipNL()
		p.expect(tPunct, ")")
		p.expect(tPunct, ";")
		p.skipNL()
		cond = p.parseExpr() // err == nil / err != nil
		neg := false
		// err != nil → `test ! -e path` (the negated stat test). The
		// condTestString prefix sniff alone would miss this polarity:
		// `err != nil` renders as `"$?" -ne 0`, which has no "! "
		// prefix, and the then-body would run on EXISTING files — the
		// inverse of Go's err != nil.
		if cond.kind == "binop" && cond.BOp == "!=" {
			neg = true
		} else if c := p.safeCondTestString(cond); strings.HasPrefix(c, "! ") {
			neg = true
		}
		arg := "-e " + decodeGoStr(pathTok.raw)
		if neg {
			arg = "! -e " + decodeGoStr(pathTok.raw)
		}
		cond = &expr{kind: "cond", text: arg}
	} else if p.tok().kind == tIdent && !p.atIdent("_") && !p.atIdent("err") &&
		p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "," &&
		p.ifInitStatAhead() {
		// if info, err := os.Stat(<expr>); <cond> { — the NAMED-target
		// stat with a runtime path (go-sh CLI's directory probe). The
		// cond vocabulary: `err == nil` → -e; `err != nil` → ! -e;
		// `err == nil && info.IsDir()` → -d (Go IsDir ≡ exists AND
		// directory — the exact bash -d semantics). Other conds refuse.
		infoName := p.next().text
		p.expect(tPunct, ",")
		p.expect(tIdent, "err")
		p.expect(tOp, ":=")
		p.expect(tIdent, "os")
		p.expect(tPunct, ".")
		p.expect(tIdent, "Stat")
		p.expect(tPunct, "(")
		p.skipNL()
		pathExpr := p.parseExpr()
		p.skipNL()
		p.expect(tPunct, ")")
		p.expect(tPunct, ";")
		p.skipNL()
		pathW := p.exprToWord(pathExpr)
		pw := func() string {
			if w, ok := pathW["value"].(string); ok && pathW["type"] == "Str" {
				return w
			}
			if g, ok := pathW["name"].(string); ok {
				return "\"" + g + "\""
			}
			if a, ok := pathW["args"].([]any); ok && len(a) >= 1 {
				if t, ok2 := pathW["func"].(string); ok2 && t == "getVar" {
					if lit, ok3 := a[0].(map[string]any); ok3 {
						if v, ok4 := lit["value"].(string); ok4 {
							// the runtime getVar read → "$v" in the test word
							return "\"$" + v + "\""
						}
					}
				}
			}
			p.failf("os.Stat path must be a literal or plain var (v2)")
			return ""
		}
		cond2 := p.parseExpr()
		arg3 := ""
		switch {
		case cond2.kind == "binop" && cond2.BOpKind == "and" &&
			cond2.lhs != nil && cond2.lhs.kind == "binop" &&
			cond2.lhs.lhs != nil && cond2.lhs.lhs.kind == "var" && cond2.lhs.lhs.name == "err" &&
			cond2.lhs.rhs != nil && cond2.lhs.rhs.kind == "var" && cond2.lhs.rhs.name == "nil" &&
			cond2.lhs.BOp == "==" &&
			cond2.rhs != nil && cond2.rhs.kind == "call" &&
			strings.HasSuffix(cond2.rhs.callee, ".IsDir") &&
			strings.HasPrefix(cond2.rhs.callee, infoName+"."):
			// (err == nil) && info.IsDir() ≡ exists AND directory
			arg3 = "-d " + pw()
		case cond2.kind == "binop" && cond2.lhs.kind == "var" && cond2.lhs.name == "err" && cond2.rhs.kind == "var" && cond2.rhs.name == "nil":
			if cond2.BOp == "==" {
				arg3 = "-e " + pw()
			} else {
				arg3 = "! -e " + pw()
			}
		default:
			p.failf("unsupported if-init os.Stat condition (v2)")
		}
		// cond only — the shared If tail below parses then/else and
		// consumes the `else` clause
		cond = &expr{kind: "cond", text: arg3}
	} else if name, ok := p.ifInitReadFileAhead(); ok {
		// if b, err := os.ReadFile(path); err == nil { — the if-init
		// whole-file read: the read's SUCCESS is the branch condition,
		// the `if b=$(cat p); then` shape (Call func=assign wrapping a
		// Capture — byte-identical to the core's own lowering of the
		// shell form, verified against otranspilerl-cli file --shir). err == nil
		// → the assign cond; err != nil → the core's `if ! b=$(cat p)`
		// Not BinOp (lhs+rhs both carry the assign). Any other
		// condition refuses loudly (Refuse > guess).
		p.pos++ // <name>
		p.expect(tPunct, ",")
		p.expect(tIdent, "err")
		p.expect(tOp, ":=")
		p.expect(tIdent, "os")
		p.expect(tPunct, ".")
		p.expect(tIdent, "ReadFile")
		p.expect(tPunct, "(")
		p.skipNL()
		path := p.parseExpr()
		p.skipNL()
		p.expect(tPunct, ")")
		p.skipNL()
		p.expect(tPunct, ";")
		p.skipNL()
		c := p.parseExpr()
		errEqNil := c.kind == "binop" && c.BOp == "==" &&
			c.lhs.kind == "var" && c.lhs.name == "err" &&
			c.rhs.kind == "var" && c.rhs.name == "nil"
		neg := c.kind == "binop" && c.BOp == "!=" &&
			c.lhs.kind == "var" && c.lhs.name == "err" &&
			c.rhs.kind == "var" && c.rhs.name == "nil"
		if !errEqNil && !neg {
			p.failf("unsupported if-init os.ReadFile condition (v2)")
		}
		p.registerVar(name, "Str")
		cond = &expr{kind: "rawjson", rawJSON: p.readFileIfCond(name, p.exprToWord(path), neg)}
	} else if p.tok().kind == tIdent &&
		((p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == ",") ||
			(p.toks[p.pos+1].kind == tOp && p.toks[p.pos+1].text == ":=")) {
		// generic if-init assignment: `if x, ok := expr; cond {` — the
		// init lowers as ordinary assignment statements; only the COND
		// gates the branch. Constructs the init cannot lower (type
		// assertions, unsupported calls) refuse loudly from their own
		// sites instead of dying as raw parse errors.
		for {
			pre = append(pre, p.parseAssignStmt()...)
			p.skipNL()
			if p.acceptPunct(";") {
				break
			}
			if !p.acceptPunct(",") {
				break
			}
		}
		cond = p.parseExpr()
	} else {
		cond = p.parseExpr()
	}
	then := p.parseBlockStmts()
	var elseBody []map[string]any
	p.skipNL()
	if p.atIdent("else") {
		p.pos++
		p.skipNL()
		if p.atIdent("if") {
			elseBody = p.parseIf()
		} else {
			elseBody = p.parseBlockStmts()
		}
	} else {
		elseBody = []map[string]any{}
	}
	// AND/OR conditions lower via the flag-based bool-tree (the core's
	// statused And/Or render reads stale $? for native-JS comparison
	// leaves); single comparisons keep the direct cond shape.
	if cond.kind == "binop" && (cond.BOpKind == "and" || cond.BOpKind == "or") {
		flag := "__bt_" + strconv.Itoa(p.tmpN)
		p.tmpN++
		p.registerVar(flag, "Str")
		stmts := p.boolTreeStmts(cond, flag)
		guarded := []map[string]any{{
			"type":   "If",
			"cond":   testCall("\"$" + flag + "\"==\"true\""),
			"then":   then,
			"elsifs": []any{},
			"else":   elseBody,
		}}
		return append(pre, append(stmts, guarded...)...)
	}
	return append(pre, p.condToJSONIf(cond, then, elseBody)...)
}

// condToJSONIf: plain If with an already-lowered cond
func (p *parser) condToJSONIf(cond *expr, then, elseBody []map[string]any) []map[string]any {
	return []map[string]any{{
		"type":   "If",
		"cond":   p.condToJSON(cond),
		"then":   then,
		"elsifs": []any{},
		"else":   elseBody,
	}}
}

// splitBoolCondIf: `if A && B` → nested ifs; `if A || B` → if A {then}
// else {if B {then} else {else}}. The core renders BinOp And/Or with
// SHELL STATUS semantics (`(l, lastExit===0 ? r : false)`) — correct
// for sh2.test leaves but WRONG for the native JS comparisons a
// pure-Go predicate body produces (the compare sets no status, so the
// chain reads stale $?). Nesting preserves short-circuit exactly and
// lets every leaf lower independently.
// boolTreeStmts: lower a Go boolean tree (comparisons, calls, &&/||)
// into statements that leave FLAG holding "true"/"false" — Go's exact
// short-circuit semantics, immune to the statused And/Or render (whose
// `(l, lastExit===0 ? r : false)` form reads STALE $? when the leaves
// are native JS comparisons).
//
//	or:  eval lhs; if flag != "true", eval rhs
//	and: eval lhs; if flag == "true", eval rhs
//	leaf: If(condToJSON(leaf)) { flag = "true" } else { flag = "false" }
func (p *parser) boolTreeStmts(e *expr, flag string) []map[string]any {

	setTrue := assignStmt(flag, strExpr("true"))
	setFalse := assignStmt(flag, strExpr("false"))
	if e.kind == "binop" && (e.BOpKind == "and" || e.BOpKind == "or") {
		out := p.boolTreeStmts(e.lhs, flag)
		var gate map[string]any
		if e.BOpKind == "and" {
			// rhs runs only if lhs came out TRUE; a false lhs keeps the
			// flag false
			gate = testCall("\"$" + flag + "\"==\"true\"")
		} else {
			// rhs runs only if lhs came out FALSE; a true lhs keeps the
			// flag true
			gate = testCall("\"$" + flag + "\"!=\"true\"")
		}
		out = append(out, map[string]any{
			"type":   "If",
			"cond":   gate,
			"then":   []any{map[string]any{"type": "Block", "body": p.boolTreeStmts(e.rhs, flag)}},
			"elsifs": []any{},
			"else":   []any{},
		})
		return out
	}
	if e.kind == "not" {
		// !(tree): evaluate the inner tree into FLAG, then invert once —
		// correct for any nesting (`!(A && B)`, `!!A`, …)
		out := p.boolTreeStmts(e.lhs, flag)
		out = append(out, map[string]any{
			"type":   "If",
			"cond":   testCall("\"$" + flag + "\"!=\"true\""),
			"then":   []any{assignStmt(flag, strExpr("true"))},
			"elsifs": []any{},
			"else":   []any{assignStmt(flag, strExpr("false"))},
		})
		return out
	}
	// BARE bool literals (`return true` / `return false` in a bool
	// function): constant flags — condToJSON would read `$true` (an
	// unset var, always false).
	if e.kind == "var" && (e.name == "true" || e.name == "false") {
		if e.name == "true" {
			return []map[string]any{setTrue}
		}
		return []map[string]any{setFalse}
	}
	cond := p.condToJSON(e)
	return []map[string]any{{
		"type":   "If",
		"cond":   cond,
		"then":   []any{setTrue},
		"elsifs": []any{},
		"else":   []any{setFalse},
	}}
}

func (p *parser) parseFor() []map[string]any {
	p.expect(tIdent, "for")
	p.skipNL()
	// for i := range N { — Go's range-over-int (i = 0..N-1, exclusive
	// end) → the core For Range shape (t73). Over a CONTAINER instead of
	// a literal: the index-only range (`for i := range tgts`, go-sh.go's
	// own multi-target restore) binds i = 0..len(X)-1 — a counted ForInit
	// over the container's length:
	//   Array-typed var   → the ${#a[@]} length call (the proven arrlen
	//                       word: join(param("slice", "#a", "@", "")))
	//   list field member → listLen(objGet chain)
	// The two-value form (`for i, v := range X`) stays a contract
	// boundary (core-requests go-sh-dogfood: needs an index-binding For).
	if p.tok().kind == tIdent && p.toks[p.pos+1].text == ":=" &&
		p.pos+2 < len(p.toks) && p.toks[p.pos+2].kind == tIdent && p.toks[p.pos+2].text == "range" {
		v := p.next().text
		p.pos++ // :=
		p.skipNL()
		p.next() // range
		p.skipNL()
		if p.tok().kind == tNum {
			end, err := strconv.Atoi(p.next().text)
			if err != nil || end < 0 {
				p.failf("range over int needs a non-negative literal (v2)")
			}
			body := p.parseBlockStmts()
			p.registerVar(v, "Int")
			return []map[string]any{{
				"type": "For",
				"var":  v,
				"iter": map[string]any{"type": "Range", "start": 0, "end": end - 1},
				"body": body,
			}}
		}
		rv := p.parseExpr()
		// `for k := range m` over a MAP — Go iterates the KEYS: the
		// runtime assocKeys (the golib's own SortedKeys loop)
		if rv.kind == "var" && (p.maps[rv.name] || p.maps[p.resolveVar(rv.name)]) {
			mn := rv.name
			if p.maps[p.resolveVar(rv.name)] {
				mn = p.resolveVar(rv.name)
			}
			body := p.parseBlockStmts()
			p.registerVar(v, "Str")
			return []map[string]any{{
				"type": "For",
				"var":  v,
				"iter": map[string]any{"type": "Array", "elements": []any{
					map[string]any{"type": "Call", "func": "assocKeys",
						"args":   []any{strExpr(mn)},
						"purity": "PureCpu"},
				}},
				"body": body,
			}}
		}
		var lenExpr map[string]any
		switch {
		case rv.kind == "var" && !p.maps[rv.name] && p.varTypes[p.resolveVar(rv.name)] == "Array":
			lenExpr = joinCall(paramCall("slice", "#"+p.paramName(rv.name), "@", ""))
		case rv.kind == "member":
			if lw, tag := p.structFieldWord(rv.name); tag == "list" {
				lenExpr = map[string]any{
					"type": "Call", "func": "listLen",
					"args":   []any{lw},
					"purity": "PureCpu",
				}
			}
		}
		if lenExpr == nil {
			p.failf("for-index range needs an Array var, list field, or int literal (v2)")
		}
		p.registerVar(v, "Int")
		init3 := []map[string]any{arithAssignStmt(v, 0)}
		cond3 := map[string]any{
			"type": "BinOp", "op": "Lt",
			"lhs": map[string]any{"type": "Arith", "ast": arithVar(v)},
			"rhs": lenExpr,
		}
		step3 := []map[string]any{{
			"type":    "Assign",
			"targets": []any{map[string]any{"var": v, "sigil": nil, "indices": []any{}}},
			"expr": map[string]any{
				"type": "Arith",
				"ast":  map[string]any{"type": "IncDec", "var": v, "delta": 1, "prefix": false},
			},
		}}
		body3 := p.parseBlockStmts()
		return []map[string]any{{
			"type": "ForInit",
			"init": init3, "cond": cond3, "step": step3, "body": body3,
		}}
	}
	// range forms
	// for i, v := range arr { — INDEX+VALUE range: lowered C-style
	// (ForInit) since the For node binds only the element
	if p.tok().kind == tIdent && p.tok().text != "_" && !(p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == ":=") &&
		p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "," {
		idxName := p.next().text
		p.expect(tPunct, ",")
		p.skipNL()
		valName := p.expect(tIdent, "").text
		p.expect(tPunct, ":=")
		p.skipNL()
		p.expect(tIdent, "range")
		p.skipNL()
		rv := p.parseExpr()
		if rv.kind == "arraylit" {
			// for i, n := range []T{...} — bind value only (index ignored
			// by the corpus); identical to the single-var literal form
			p.registerVar(valName, "Str")
			body := p.parseBlockStmts()
			el := make([]any, len(rv.elems))
			for i, elw := range rv.elems {
				el[i] = elw
			}
			return []map[string]any{{
				"type": "For",
				"var":  valName,
				"iter": map[string]any{"type": "Array", "elements": el},
				"body": body,
			}}
		}
		if rv.kind == "member" {
			// list-object field (`for i, t := range e.fieldVals`)
			if lw, tag := p.structFieldWord(rv.name); tag == "list" {
				p.registerVar(idxName, "Int")
				p.registerVar(valName, "Str")
				if et := p.listElemStructType(rv.name); et != "" {
					p.varStruct[p.resolveVar(valName)] = et
				}
				b2 := []map[string]any{assignStmt(valName, map[string]any{
					"type": "Call", "func": "listGet",
					"args":   []any{lw, getVarExpr(idxName)},
					"purity": "PureCpu",
				})}
				b2 = append(b2, p.parseBlockStmts()...)
				return []map[string]any{{
					"type": "ForInit",
					"init": []map[string]any{arithAssignStmt(idxName, 0)},
					"cond": map[string]any{
						"type": "BinOp", "op": "Lt",
						"lhs": map[string]any{"type": "Arith", "ast": arithVar(idxName)},
						"rhs": map[string]any{
							"type": "Call", "func": "listLen",
							"args":   []any{lw},
							"purity": "PureCpu",
						},
					},
					"step": []map[string]any{{
						"type":    "Assign",
						"targets": []any{map[string]any{"var": idxName, "sigil": nil, "indices": []any{}}},
						"expr": map[string]any{
							"type": "Arith",
							"ast":  map[string]any{"type": "IncDec", "var": idxName, "delta": 1, "prefix": false},
						},
					}},
					"body": b2,
				}}
			}
		}
		if rv.kind == "index" {
			// range over a COMPUTED container (`p.structs[typeName]` — an
			// element read yielding a list value): the container word
			// evaluates natively (mapGet/listGet chain); index+value bind
			// C-style exactly like the list-field form above
			lw := p.exprToWord(rv)
			p.registerVar(idxName, "Int")
			p.registerVar(valName, "Str")
			b3 := []map[string]any{assignStmt(valName, map[string]any{
				"type": "Call", "func": "listGet",
				"args":   []any{lw, getVarExpr(idxName)},
				"purity": "PureCpu",
			})}
			b3 = append(b3, p.parseBlockStmts()...)
			return []map[string]any{{
				"type": "ForInit",
				"init": []map[string]any{arithAssignStmt(idxName, 0)},
				"cond": map[string]any{
					"type": "BinOp", "op": "Lt",
					"lhs": map[string]any{"type": "Arith", "ast": arithVar(idxName)},
					"rhs": map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{lw},
						"purity": "PureCpu",
					},
				},
				"step": []map[string]any{{
					"type":    "Assign",
					"targets": []any{map[string]any{"var": idxName, "sigil": nil, "indices": []any{}}},
					"expr": map[string]any{
						"type": "Arith",
						"ast":  map[string]any{"type": "IncDec", "var": idxName, "delta": 1, "prefix": false},
					},
				}},
				"body": b3,
			}}
		}
		if p.varTypes[p.resolveVar(rv.name)] == "" && rv.kind == "var" {
			lw2 := map[string]any{
				"type": "Call", "func": "strSplit",
				"args":   []any{p.exprToWord(rv), strExpr("\n")},
				"purity": "PureCpu",
			}
			cnt := "__ri_" + strconv.Itoa(p.tmpN)
			p.tmpN++
			p.registerVar(cnt, "Int")
			p.registerVar(valName, "Str")
			init := []map[string]any{arithAssignStmt(cnt, 0)}
			cond2 := map[string]any{
				"type": "BinOp", "op": "Lt",
				"lhs": map[string]any{"type": "Arith", "ast": arithVar(cnt)},
				"rhs": map[string]any{
					"type": "Call", "func": "listLen",
					"args":   []any{lw2},
					"purity": "PureCpu",
				},
			}
			step := []map[string]any{{
				"type":    "Assign",
				"targets": []any{map[string]any{"var": cnt, "sigil": nil, "indices": []any{}}},
				"expr": map[string]any{
					"type": "Arith",
					"ast":  map[string]any{"type": "IncDec", "var": cnt, "delta": 1, "prefix": false},
				},
			}}
			b2 := []map[string]any{assignStmt(valName, map[string]any{
				"type": "Call", "func": "listGet",
				"args":   []any{lw2, getVarExpr(cnt)},
				"purity": "PureCpu",
			})}
			b2 = append(b2, p.parseBlockStmts()...)
			return []map[string]any{{
				"type": "ForInit",
				"init": init, "cond": cond2, "step": step, "body": b2,
			}}
		}
		if rv.kind == "member" || rv.kind == "fieldof" {
			// member of a COMPUTED base (`args[0].args` — an element
			// read of a struct slice, then its list field): the
			// container word evaluates natively (objGet chain over the
			// element ref); index+value bind C-style like the index form
			lw := p.exprToWord(rv)
			p.registerVar(idxName, "Int")
			p.registerVar(valName, "Str")
			b4 := []map[string]any{assignStmt(valName, map[string]any{
				"type": "Call", "func": "listGet",
				"args":   []any{lw, getVarExpr(idxName)},
				"purity": "PureCpu",
			})}
			b4 = append(b4, p.parseBlockStmts()...)
			return []map[string]any{{
				"type": "ForInit",
				"init": []map[string]any{arithAssignStmt(idxName, 0)},
				"cond": map[string]any{
					"type": "BinOp", "op": "Lt",
					"lhs": map[string]any{"type": "Arith", "ast": arithVar(idxName)},
					"rhs": map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{lw},
						"purity": "PureCpu",
					},
				},
				"step": []map[string]any{{
					"type":    "Assign",
					"targets": []any{map[string]any{"var": idxName, "sigil": nil, "indices": []any{}}},
					"expr": map[string]any{
						"type": "Arith",
						"ast":  map[string]any{"type": "IncDec", "var": idxName, "delta": 1, "prefix": false},
					},
				}},
				"body": b4,
			}}
		}
		if rv.kind == "var" {
			if ln := p.anyListVar(rv.name); ln != "" || p.paramSlice[rv.name] || p.paramSlice[p.resolveVar(rv.name)] {
				// ANY-LIST var index+value range (`for i, s := range
				// stmts` — toAnyStmts over a list id): C-style over
				// listLen; the value binds listGet (RAW — objects
				// survive for member reads). The container reads
				// through paramName so positional params resolve.
				// Scalar-slice params (paramSlice, list ids) share
				// this shape (no struct typing — anyElem misses).
				p.registerVar(idxName, "Int")
				p.registerVar(valName, "Str")
				if et := p.anyElem[ln]; et != "" && p.isStructType(et) {
					p.varStruct[p.resolveVar(valName)] = et
				}
				lw := getVarExpr(p.paramName(rv.name))
				b5 := []map[string]any{assignStmt(valName, map[string]any{
					"type": "Call", "func": "listGet",
					"args":   []any{lw, getVarExpr(idxName)},
					"purity": "PureCpu",
				})}
				b5 = append(b5, p.parseBlockStmts()...)
				return []map[string]any{{
					"type": "ForInit",
					"init": []map[string]any{arithAssignStmt(idxName, 0)},
					"cond": map[string]any{
						"type": "BinOp", "op": "Lt",
						"lhs": map[string]any{"type": "Arith", "ast": arithVar(idxName)},
						"rhs": map[string]any{
							"type": "Call", "func": "listLen",
							"args":   []any{lw},
							"purity": "PureCpu",
						},
					},
					"step": []map[string]any{{
						"type":    "Assign",
						"targets": []any{map[string]any{"var": idxName, "sigil": nil, "indices": []any{}}},
						"expr": map[string]any{
							"type": "Arith",
							"ast":  map[string]any{"type": "IncDec", "var": idxName, "delta": 1, "prefix": false},
						},
					}},
					"body": b5,
				}}
			}
		}
		if rv.kind != "var" {
			p.failf("range over a non-var (v2)")
		}
		name := p.paramName(rv.name)
		p.registerVar(idxName, "Int")
		elemTyp := "Str"
		if info, ok := p.arrays[name]; ok {
			elemTyp = info.typ
		}
		p.registerVar(valName, elemTyp)
		// the ranged var's STRUCT type carries to the loop var — the
		// elements of a struct-slice ARE the struct (`for i, v := range
		// vs` where vs []VarType binds v VarType; shir-emit-go's
		// toAnySlice). The parser's varStruct is GLOBAL, so a loop var
		// REUSED by a later function must be re-bound here, not left to
		// inherit a stale entry from an earlier function's scope.
		if st := p.varStruct[p.resolveVar(rv.name)]; st != "" {
			p.varStruct[p.resolveVar(valName)] = st
		}
		// Propagate readDirVars tracking through range loops so
		// e.Name()/e.IsDir() methods resolve on the loop variable
		// (the VALUE is the dir-path test fragment; a range var over
		// an os.ReadDir capture inherits it)
		if dt, isRD := p.readDirVars[name]; isRD {
			p.readDirVars[valName] = dt
		}
		body := []map[string]any{
			assignStmt(valName, getVarExpr(name+"[$"+idxName+"]")),
		}
		body = append(body, p.parseBlockStmts()...)
		return []map[string]any{{
			"type": "ForInit",
			"init": []map[string]any{arithAssignStmt(idxName, 0)},
			"cond": map[string]any{
				"type": "BinOp", "op": "Lt",
				"lhs": map[string]any{"type": "Arith", "ast": arithVar(idxName)},
				"rhs": joinCall(paramCall("slice", "#"+name, "@", "")),
			},
			"step": []map[string]any{{
				"type":    "Assign",
				"targets": []any{map[string]any{"var": idxName, "sigil": nil, "indices": []any{}}},
				"expr": map[string]any{
					"type": "Arith",
					"ast":  map[string]any{"type": "IncDec", "var": idxName, "delta": 1, "prefix": false},
				},
			}},
			"body": body,
		}}
	}
	if p.atIdent("_") || p.atIdent("range") {
		var v string
		idxVar := ""
		if p.atIdent("_") {
			p.pos++
			p.expect(tPunct, ",")
			p.skipNL()
			v = p.expect(tIdent, "").text
			p.expect(tPunct, ":=")
		} else if !p.atIdent("range") {
			// for range X { — bare value-less range: bind a throwaway
			v = "_"
		} else {
			// for range X { — bare value-less range ("range" NOT consumed;
			// the shared code below expects it)
			v = "_"
		}
		p.skipNL()
		p.expect(tIdent, "range")
		p.skipNL()
		var iter []map[string]any
		typ := "Str"
		if p.atPunct("[") {
			elems, t := p.parseArrayLiteral()
			iter, typ = elems, t
			// anon-struct element type: bind the loop var's struct so
			// `spec.field` reads lower to objGet over the element ref
			if strings.HasPrefix(t, "__anon") && len(p.structs[t]) > 0 {
				p.registerVar(v, "Str")
				p.varStruct[p.resolveVar(v)] = t
			}
		} else {
			rv := p.parseExpr()
			if rv.kind != "var" {
				// VAR SLICE (`for _, a := range args[1:]` — a slice of a
				// known Array-typed store var): the For iter is the single
				// array-valued param("slice", name, lo, "") element the
				// runtime's forLoop flattens (the same contract as ranging
				// the whole array)
				if rv.kind == "slice" && rv.target != nil && rv.target.kind == "var" &&
					(p.varTypes[p.resolveVar(rv.target.name)] == "Array" || p.paramSlice[rv.target.name]) {
					lo := "0"
					if rv.idx1e != nil {
						lo = p.arithKeyText(rv.idx1e)
					} else if rv.idx1 != "" {
						lo = rv.idx1
					}
					body := p.parseBlockStmts()
					p.registerVar(v, "Str")
					return []map[string]any{{
						"type": "For",
						"var":  v,
						"iter": map[string]any{"type": "Array", "elements": []any{
							paramCall("slice", p.resolveVar(rv.target.name), lo, ""),
						}},
						"body": body,
					}}
				}
				// LIST-FIELD SLICE (`for _, a := range rhs.args[1:]`)
				if rv.kind == "slice" && rv.target != nil && rv.target.kind == "member" {
					if lw, tag := p.structFieldWord(rv.target.name); tag == "list" {
						lo := "0"
						if rv.idx1e != nil {
							lo = p.arithKeyText(rv.idx1e)
						} else if rv.idx1 != "" {
							lo = rv.idx1
						}
						cnt2 := "__ri_" + strconv.Itoa(p.tmpN)
						p.tmpN++
						p.registerVar(cnt2, "Int")
						p.registerVar(v, "Str")
						init2 := []map[string]any{arithAssignStmt(cnt2, 0)}
						cond2 := map[string]any{
							"type": "BinOp", "op": "Lt",
							"lhs": map[string]any{"type": "Arith", "ast": arithVar(cnt2)},
							"rhs": map[string]any{
								"type": "Call", "func": "listLen",
								"args":   []any{lw},
								"purity": "PureCpu",
							},
						}
						step2 := []map[string]any{{
							"type":    "Assign",
							"targets": []any{map[string]any{"var": cnt2, "sigil": nil, "indices": []any{}}},
							"expr": map[string]any{
								"type": "Arith",
								"ast":  map[string]any{"type": "IncDec", "var": cnt2, "delta": 1, "prefix": false},
							},
						}}
						b2 := []map[string]any{assignStmt(v, map[string]any{
							"type":   "Call",
							"func":   "listGet",
							"args":   []any{lw, getVarExpr(cnt2 + "+" + lo)},
							"purity": "PureCpu",
						})}
						b2 = append(b2, p.parseBlockStmts()...)
						return []map[string]any{{
							"type": "ForInit",
							"init": init2, "cond": cond2, "step": step2, "body": b2,
						}}
					}
				}
				// range over a COMPUTED member (`for _, a := range
				// args[0].args` — element read of a struct slice, then
				// its list field): the container word evaluates natively
				// (objGet chain over the element ref)
				if rv.kind == "member" || rv.kind == "fieldof" {
					if _, tag := p.structFieldWord(rv.name); tag != "list" {
						if cw := p.exprToWord(rv); cw != nil {
							body := p.parseBlockStmts()
							p.registerVar(v, "Str")
							return []map[string]any{{
								"type": "For",
								"var":  v,
								"iter": map[string]any{"type": "Array", "elements": []any{
									map[string]any{"type": "Call", "func": "listItems", "args": []any{cw}, "purity": "PureCpu"},
								}},
								"body": body,
							}}
						}
					}
				}
				// range over a LIST-object field (`for _, fv := range e.fieldVals`)
				if rv.kind == "member" {
					if lw, tag := p.structFieldWord(rv.name); tag == "list" {
						cnt := "__ri_" + strconv.Itoa(p.tmpN)
						p.tmpN++
						p.registerVar(cnt, "Int")
						if et := p.listElemStructType(rv.name); et != "" {
							p.registerVar(v, "Str")
							p.varStruct[p.resolveVar(v)] = et
						} else {
							p.registerVar(v, "Str")
						}
						init := []map[string]any{arithAssignStmt(cnt, 0)}
						cond := map[string]any{
							"type": "BinOp", "op": "Lt",
							"lhs": map[string]any{"type": "Arith", "ast": arithVar(cnt)},
							"rhs": map[string]any{
								"type": "Call", "func": "listLen",
								"args":   []any{lw},
								"purity": "PureCpu",
							},
						}
						step := []map[string]any{{
							"type":    "Assign",
							"targets": []any{map[string]any{"var": cnt, "sigil": nil, "indices": []any{}}},
							"expr": map[string]any{
								"type": "Arith",
								"ast":  map[string]any{"type": "IncDec", "var": cnt, "delta": 1, "prefix": false},
							},
						}}
						b2 := []map[string]any{assignStmt(v, map[string]any{
							"type": "Call", "func": "listGet",
							"args":   []any{lw, getVarExpr(cnt)},
							"purity": "PureCpu",
						})}
						b2 = append(b2, p.parseBlockStmts()...)
						return []map[string]any{{
							"type": "ForInit",
							"init": init, "cond": cond, "step": step, "body": b2,
						}}
					}
				}
				p.failf("range over a non-var (v2)")
			}
			if p.varTypes[p.resolveVar(rv.name)] == "" && rv.kind == "var" {
				// SLICE-param value range (`for _, a := range args` —
				// the param holds a list id positionally): iterate it
				// directly, not via rangeItems (which reads arrays).
				var lw2 map[string]any
				rn := p.resolveVar(rv.name)
				if p.paramSlice[rv.name] || p.paramSlice[rn] {
					if n, ok := p.paramNumber(rn); ok {
						lw2 = getVarExpr(strconv.Itoa(n))
					} else if n, ok := p.paramNumber(rv.name); ok {
						lw2 = getVarExpr(strconv.Itoa(n))
					}
				}
				if lw2 == nil {
					// untyped var: array items if populated, else newline-split
					// string (rangeItems covers forward refs like the lexer's
					// multiOps, where static typing lags the runtime store).
					lw2 = map[string]any{
						"type": "Call", "func": "rangeItems",
						"args":   []any{strExpr(p.resolveVar(rv.name))},
						"purity": "PureCpu",
					}
				}
				cnt := "__ri_" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.registerVar(cnt, "Int")
				p.registerVar(v, "Str")
				init := []map[string]any{arithAssignStmt(cnt, 0)}
				cond2 := map[string]any{
					"type": "BinOp", "op": "Lt",
					"lhs": map[string]any{"type": "Arith", "ast": arithVar(cnt)},
					"rhs": map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{lw2},
						"purity": "PureCpu",
					},
				}
				step := []map[string]any{{
					"type":    "Assign",
					"targets": []any{map[string]any{"var": cnt, "sigil": nil, "indices": []any{}}},
					"expr": map[string]any{
						"type": "Arith",
						"ast":  map[string]any{"type": "IncDec", "var": cnt, "delta": 1, "prefix": false},
					},
				}}
				b2 := []map[string]any{assignStmt(v, map[string]any{
					"type": "Call", "func": "listGet",
					"args":   []any{lw2, getVarExpr(cnt)},
					"purity": "PureCpu",
				})}
				b2 = append(b2, p.parseBlockStmts()...)
				return []map[string]any{{
					"type": "ForInit",
					"init": init, "cond": cond2, "step": step, "body": b2,
				}}
			}
			// range over a LIST-object field (`for _, fv := range e.fieldVals`)
			if lw, tag := p.structFieldWord(rv.name); tag == "list" {
				cnt := "__ri_" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.registerVar(cnt, "Int")
				if et := p.listElemStructType(rv.name); et != "" {
					p.registerVar(v, "Str")
					p.varStruct[p.resolveVar(v)] = et
				} else {
					p.registerVar(v, "Str")
				}
				init := []map[string]any{arithAssignStmt(cnt, 0)}
				cond2 := map[string]any{
					"type": "BinOp", "op": "Lt",
					"lhs": map[string]any{"type": "Arith", "ast": arithVar(cnt)},
					"rhs": map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{lw},
						"purity": "PureCpu",
					},
				}
				step := []map[string]any{{
					"type":    "Assign",
					"targets": []any{map[string]any{"var": cnt, "sigil": nil, "indices": []any{}}},
					"expr": map[string]any{
						"type": "Arith",
						"ast":  map[string]any{"type": "IncDec", "var": cnt, "delta": 1, "prefix": false},
					},
				}}
				b2 := []map[string]any{assignStmt(v, map[string]any{
					"type": "Call", "func": "listGet",
					"args":   []any{lw, getVarExpr(cnt)},
					"purity": "PureCpu",
				})}
				b2 = append(b2, p.parseBlockStmts()...)
				return []map[string]any{{
					"type": "ForInit",
					"init": init, "cond": cond2, "step": step, "body": b2,
				}}
			}
			if info, ok := p.arrays[rv.name]; ok {
				iter, typ = info.elems, info.typ
			} else if ln := p.anyListVar(rv.name); ln != "" {
				// ANY-LIST var (`for _, t := range toks` — struct/any
				// elements ride a list id): C-style ForInit over
				// listLen; the value binds listGet (RAW — objects
				// survive for member reads).
				p.registerVar(v, "Str")
				if et := p.anyElem[ln]; et != "" && p.isStructType(et) {
					p.varStruct[p.resolveVar(v)] = et
				}
				lw := getVarExpr(ln)
				cnt := "__ri_" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.registerVar(cnt, "Int")
				b := []map[string]any{assignStmt(v, map[string]any{
					"type": "Call", "func": "listGet",
					"args":   []any{lw, getVarExpr(cnt)},
					"purity": "PureCpu",
				})}
				b = append(b, p.parseBlockStmts()...)
				return []map[string]any{{
					"type": "ForInit",
					"init": []map[string]any{arithAssignStmt(cnt, 0)},
					"cond": map[string]any{
						"type": "BinOp", "op": "Lt",
						"lhs": map[string]any{"type": "Arith", "ast": arithVar(cnt)},
						"rhs": map[string]any{
							"type": "Call", "func": "listLen",
							"args":   []any{lw},
							"purity": "PureCpu",
						},
					},
					"step": []map[string]any{{
						"type":    "Assign",
						"targets": []any{map[string]any{"var": cnt, "sigil": nil, "indices": []any{}}},
						"expr": map[string]any{
							"type": "Arith",
							"ast":  map[string]any{"type": "IncDec", "var": cnt, "delta": 1, "prefix": false},
						},
					}},
					"body": b,
				}}
			} else if p.varTypes[rv.name] == "Array" {
				// Runtime-loaded array (e.g. `args := os.Args[1:]` → the
				// setArray param-slice; `a = append(a, …)`): the A1 For
				// iter is a STATIC element list, but its elements are
				// EXPRESSIONS — the contract's `${arr[@]}` shape is ONE
				// array-valued param("slice", name, "@", "") element,
				// which the runtime's forLoop FLATTENS (the core emits
				// exactly this for `for x in "${arr[@]}"`; setArray has
				// spliced the positional slice into the array store, so
				// the iter reads the store). Loop vars are Str elements.
				// Untyped vars stay a loud refusal (Refuse > guess).
				// readDirVars propagation FIRST: the loop-var binding must
				// be in place before the body parses (e.Name() in the
				// body resolves through it)
				if dt, isRD := p.readDirVars[rv.name]; isRD {
					p.readDirVars[v] = dt
				}
				body := p.parseBlockStmts()
				p.registerVar(v, "Str")
				return p.rangeFor(idxVar, v, map[string]any{"type": "Array", "elements": []any{
					paramCall("slice", rv.name, "@", ""),
				}}, body)
			} else {
				// UNKNOWN array name: a captured multi-line return —
				// split on newlines into a list object and iterate it
				lw2 := map[string]any{
					"type": "Call", "func": "strSplit",
					"args":   []any{getVarExpr(p.resolveVar(rv.name)), strExpr("\n")},
					"purity": "PureCpu",
				}
				cnt := "__ri_" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.registerVar(cnt, "Int")
				init2 := []map[string]any{arithAssignStmt(cnt, 0)}
				cond2 := map[string]any{
					"type": "BinOp", "op": "Lt",
					"lhs": map[string]any{"type": "Arith", "ast": arithVar(cnt)},
					"rhs": map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{lw2},
						"purity": "PureCpu",
					},
				}
				step2 := []map[string]any{{
					"type":    "Assign",
					"targets": []any{map[string]any{"var": cnt, "sigil": nil, "indices": []any{}}},
					"expr": map[string]any{
						"type": "Arith",
						"ast":  map[string]any{"type": "IncDec", "var": cnt, "delta": 1, "prefix": false},
					},
				}}
				b2 := []map[string]any{assignStmt(v, map[string]any{
					"type": "Call", "func": "listGet",
					"args":   []any{lw2, getVarExpr(cnt)},
					"purity": "PureCpu",
				})}
				b2 = append(b2, p.parseBlockStmts()...)
				return []map[string]any{{
					"type": "ForInit",
					"init": init2, "cond": cond2, "step": step2, "body": b2,
				}}
			}
		}
		body := p.parseBlockStmts()
		p.registerVar(v, typ)
		elems := make([]any, len(iter))
		for i, el := range iter {
			elems[i] = el
		}
		return p.rangeFor(idxVar, v, map[string]any{"type": "Array", "elements": elems}, body)
	}
	// for sc.Scan() { → While(read sc) — bufio.Scanner stdin loop
	if p.pos+3 < len(p.toks) && p.tok().kind == tIdent && p.stdinRdr[p.tok().text] &&
		p.toks[p.pos+1].text == "." && p.toks[p.pos+2].kind == tIdent &&
		p.toks[p.pos+2].text == "Scan" && p.toks[p.pos+3].text == "(" {
		scName := p.next().text
		p.pos += 2 // . Scan
		p.expect(tPunct, "(")
		p.skipNL()
		p.expect(tPunct, ")")
		body := p.parseBlockStmts()
		return []map[string]any{{
			"type": "While",
			"cond": execCond("read", []map[string]any{strExpr(scName)}),
			"body": body,
		}}
	}
	// for ; cond; post { — header form with EMPTY init
	if p.atPunct(";") {
		p.pos++
		p.skipNL()
		cond := p.parseExpr()
		p.expect(tPunct, ";")
		p.skipNL()
		var post []map[string]any
		if !p.atPunct("{") {
			postName := p.expect(tIdent, "").text
			postOp := "+"
			delta := 1
			if p.acceptPunct("--") {
				postOp = "-"
				delta = -1
			} else if p.acceptPunct("+=") {
				p.skipNL()
				rhs := p.parseExpr()
				post = []map[string]any{assignStmt(postName,
					arithWrap(arithBin(arithVar(postName), "+", p.exprToArith(rhs))))}
				p.expect(tPunct, "{")
				body := p.parseBlockStmts()
				_ = body
				return []map[string]any{{"type": "ForInit",
					"init": []map[string]any{}, "cond": p.condToJSON(cond), "step": post, "body": body}}
			} else {
				p.expect(tPunct, "++")
			}
			post = []map[string]any{assignStmt(postName,
				arithWrap(arithBin(arithVar(postName), postOp, arithNum(delta))))}
			body := p.parseBlockStmts()
			return []map[string]any{{"type": "ForInit",
				"init": []map[string]any{}, "cond": p.condToJSON(cond), "step": post, "body": body}}
		}
	}
	// for i := 1; i <= 2; i++ {  — header form
	if p.tok().kind == tIdent && p.toks[p.pos+1].text == ":=" {
		initName := p.next().text
		p.pos++ // :=
		p.skipNL()
		rhs := p.parseExpr()
		pre := []map[string]any{assignStmt(initName, p.exprToWord(rhs))}
		p.registerVar(initName, "Int")
		// FORCE the counter type: a C-style for header (`for k := p.pos-6;
		// k < p.pos+4; k++`) is numeric by construction (arith init, ++/--
		// post), but varTypes is GLOBAL across the file — a same-named
		// loop var registered "Str" by an earlier function (e.g. `for i,
		// k := range e.keys`) would otherwise poison the numeric
		// comparison (`k < p.pos+4` refused as a Str operand). The
		// registerVar first-wins guard is bypassed deliberately: valid Go
		// cannot re-:= a name already in scope, so the header counter is
		// always fresh.
		p.varTypes[initName] = "Int"
		p.expect(tPunct, ";")
		p.skipNL()
		// cond/post may each be EMPTY (`for i := 0; ; i++`)
		var cond *expr
		if !p.atPunct(";") {
			cond = p.parseExpr()
		}
		p.expect(tPunct, ";")
		p.skipNL()
		post := []map[string]any{}
		postDelta := 1
		if cond == nil {
			cond = &expr{kind: "cond", text: "true"}
		}
		if !p.atPunct("{") {
			postName := p.expect(tIdent, "").text
			postDelta = 1
			postOp := "+"
			if p.acceptPunct("--") {
				postDelta = -1
				postOp = "-"
			} else {
				p.expect(tPunct, "++")
			}
			post = []map[string]any{assignStmt(postName,
				arithWrap(arithBin(arithVar(postName), postOp, arithNum(postDelta))))}
		}
		body := p.parseBlockStmts()
		// `i := N; i <= M; i++` (or `i < M`) → the core's ForInit shape
		// (byte-identical to the `for ((i=N; i<=M; i++))` lowering in
		// shir.rs): init Assign(Arith Assign) / cond exec `let "i<=M"` /
		// step Assign(Arith IncDec) / body. NOT the For+Range iter form:
		// the core emits Range only for `for i in $(seq N M)` (the
		// seq_range_for transform), and the ESTree lowering of that Range
		// counter keeps the loop var as a native JS local WITHOUT syncing
		// sh2.vars — string-context body reads (`echo n$i` / printf) then
		// see "" (t58_seq_range DIFF: n vs n2/n3/n4). ForInit lowers to
		// the setVar-synced while machinery, which matches bash exactly.
		postName := ""
		if len(post) > 0 {
			if t0, ok := post[0]["targets"].([]any); ok && len(t0) > 0 {
				if tt, ok2 := t0[0].(map[string]any); ok2 {
					postName = tt["var"].(string)
				}
			}
		}
		if cond != nil && rhs.kind == "num" && initName == postName &&
			cond.kind == "binop" && cond.BOpKind == "cmp" &&
			cond.lhs.kind == "var" && cond.lhs.name == initName &&
			cond.rhs.kind == "num" {
			if start, err := strconv.Atoi(rhs.text); err == nil {
				if _, err2 := strconv.Atoi(cond.rhs.text); err2 == nil {
					if cond.BOp == "<" || cond.BOp == "<=" {
						return []map[string]any{{
							"type": "ForInit",
							"init": []any{arithAssignStmt(initName, start)},
							"cond": execCond("let", []map[string]any{
								strExpr(initName + cond.BOp + cond.rhs.text),
							}),
							"step": []any{arithIncDecStmt(postName)},
							"body": body,
						}}
					}
				}
			}
		}
		// GENERAL C-style for (non-numeric bounds like `i < len(raw)`,
		// any cmp op, numeric init): ForInit with a condToJSON cond.
		// The While+appended-post fallback drops post on `continue`
		// (self-host decodeGoStr looped forever on 'h'); ForInit's
		// step runs on continue (core semantics, t-pinned).
		if cond != nil && initName == postName &&
			cond.kind == "binop" && cond.BOpKind == "cmp" &&
			cond.lhs.kind == "var" && cond.lhs.name == initName {
			if start, err := strconv.Atoi(rhs.text); err == nil && rhs.kind == "num" {
				return []map[string]any{{
					"type": "ForInit",
					"init": []any{arithAssignStmt(initName, start)},
					"cond": p.condToJSON(cond),
					"step": []any{map[string]any{
						"type":    "Assign",
						"targets": []any{map[string]any{"var": postName, "sigil": nil, "indices": []any{}}},
						"expr": map[string]any{
							"type": "Arith",
							"ast":  map[string]any{"type": "IncDec", "var": postName, "delta": postDelta, "prefix": false},
						},
					}},
					"body": body,
				}}
			}
		}
		body = append(body, post...)
		return append(pre, map[string]any{
			"type": "While",
			"cond": p.condToJSON(cond),
			"body": body,
		})
	}
	// for { } — the BARE infinite loop → While(true)
	if p.atPunct("{") {
		body := p.parseBlockStmts()
		return []map[string]any{{
			"type": "While",
			"cond": map[string]any{"type": "Bool", "value": true},
			"body": body,
		}}
	}
	// for cond {  → While
	cond := p.parseExpr()
	body := p.parseBlockStmts()
	return []map[string]any{{
		"type": "While",
		"cond": p.condToJSON(cond),
		"body": body,
	}}
}

// rangeFor: build the A1 For (with the index COUNTER when the loop is
// `for i, s := range arr` — the go-sh self-hosting contract: i=0 before,
// i++ after the body; the golib's 37 index+value ranges).
func (p *parser) rangeFor(idxVar, v string, iter map[string]any, body []map[string]any) []map[string]any {
	if idxVar == "" {
		return []map[string]any{{"type": "For", "var": v, "iter": iter, "body": body}}
	}
	p.registerVar(idxVar, "Int")
	body = append(body, assignStmt(idxVar,
		arithWrap(arithBin(arithVar(idxVar), "+", arithNum(1)))))
	return []map[string]any{
		assignStmt(idxVar, strExpr("0")),
		{"type": "For", "var": v, "iter": iter, "body": body},
	}
}

func (p *parser) parseSwitch() []map[string]any {
	p.expect(tIdent, "switch")
	p.skipNL()
	// BARE switch (`switch {` — switch-true, the Go if/else-chain
	// idiom): each case is a full CONDITION; lowers to one If with the
	// cases as elsifs and default as else. No discriminant, no patterns.
	if p.atPunct("{") {
		p.pos++
		var conds []*expr
		var bodies [][]map[string]any
		var defaultBody []map[string]any
		hasDefault := false
		for {
			p.skipNL()
			if p.atPunct("}") {
				p.pos++
				break
			}
			if p.atIdent("default") {
				p.pos++
				p.expect(tPunct, ":")
				defaultBody = p.parseSwitchBody()
				hasDefault = true
			} else if p.atIdent("case") {
				p.pos++
				// COMMA-SEPARATED case expressions (`case A, B:`): each
				// expression becomes its own cond; they share ONE body
				// (the If-chain build duplicates the body per arm —
				// Go semantics, any match runs it). The body is appended
				// once per cond ADDED IN THIS CASE — a `for range conds`
				// over the ACCUMULATED list would duplicate the body for
				// every earlier case too, mis-associating the If-chain
				// arms (the dogfood app's own lex switch: the `//` case
				// got the `\n` case's body).
				body := []map[string]any(nil)
				start := len(conds)
				for {
					conds = append(conds, p.parseExpr())
					if !p.acceptPunct(",") {
						break
					}
					p.skipNL()
				}
				p.expect(tPunct, ":")
				body = p.parseSwitchBody()
				for i := start; i < len(conds); i++ {
					bodies = append(bodies, body)
				}
			} else {
				p.failf("expected case/default in bare switch, got %q", p.tok().text)
			}
		}
		// build the If chain from the tail: else = default (or empty)
		nest := defaultBody
		if !hasDefault {
			nest = []map[string]any{}
		}
		for i := len(conds) - 1; i >= 0; i-- {
			c := conds[i]
			if c.kind == "binop" && (c.BOpKind == "and" || c.BOpKind == "or") {
				// AND/OR case conditions lower via the flag-based
				// bool-tree (the statused And/Or render reads stale $?
				// for pure-JS comparison leaves — posix-sh-go's lexer
				// switch: `case c == '$':` chains)
				flag := "__sw_" + strconv.Itoa(p.tmpN)
				p.tmpN++
				p.registerVar(flag, "Str")
				stmts := p.boolTreeStmts(c, flag)
				stmts = append(stmts, map[string]any{
					"type":   "If",
					"cond":   testCall("\"$" + flag + "\"==\"true\""),
					"then":   bodies[i],
					"elsifs": []any{},
					"else":   nest,
				})
				nest = stmts
				continue
			}
			nest = []map[string]any{{
				"type":   "If",
				"cond":   p.condToJSON(c),
				"then":   bodies[i],
				"elsifs": []any{},
				"else":   nest,
			}}
		}
		return nest
	}
	// type switch: `switch [v :=] x.(type) {` — runtime type dispatch
	// (core request go-sh-20260813-154009, now implemented in the A1):
	// lowered to the EXISTING Case node with discriminant
	// Call{func:"typeof", args:[getVar x]} (the renderer maps the
	// `typeof` callee to sh2.typeOf) and type-name clause patterns
	// ("*" for default). The guard var v binds to getVar x in every arm
	// (reads resolve through p.varAlias), so a store-backed x dispatches
	// on its text and a lifted x on its runtime value — faithfully.
	if gv, x, ok := p.peekTypeSwitch(); ok {
		p.skipNL()
		p.expect(tPunct, "{")
		var clauses []any
		for {
			p.skipNL()
			if p.atPunct("}") {
				p.pos++
				break
			}
			if p.atIdent("default") {
				p.pos++
				p.expect(tPunct, ":")
				clauses = append(clauses, map[string]any{
					"patterns": []any{"*"},
					"body":     p.parseTypeSwitchBody(gv, x),
				})
			} else if p.atIdent("case") {
				p.pos++
				var pats []any
				pats = append(pats, p.typePattern())
				for p.acceptPunct(",") {
					p.skipNL()
					pats = append(pats, p.typePattern())
				}
				p.expect(tPunct, ":")
				clauses = append(clauses, map[string]any{
					"patterns": pats,
					"body":     p.parseTypeSwitchBody(gv, x),
				})
			} else {
				p.failf("expected case/default in type switch, got %q", p.tok().text)
			}
		}
		return []map[string]any{{
			"type": "Case",
			"discriminant": map[string]any{
				"type": "Call", "func": "typeof",
				"args":   []any{getVarExpr(x)},
				"purity": "PureCpu",
			},
			"clauses": clauses,
		}}
	}
	// boolean switch: `switch { case cond: ... }` — no discriminant
	// (the cpp frontend's lexer dispatch: `switch { case c == ' ': ... }`).
	// The A1 Case node needs a discriminant, so lower to the nested
	// if-else chain — the faithful shape (each case condition is a
	// boolean test; default is the final else).
	if p.atPunct("{") {
		p.pos++
		var conds []*expr
		var bodies [][]map[string]any
		var defBody []map[string]any
		hasDefault := false
		for {
			p.skipNL()
			if p.atPunct("}") {
				p.pos++
				break
			}
			if p.atIdent("default") {
				p.pos++
				p.expect(tPunct, ":")
				defBody = p.parseSwitchBody()
				hasDefault = true
			} else if p.atIdent("case") {
				p.pos++
				c := p.parseExpr()
				p.expect(tPunct, ":")
				conds = append(conds, c)
				bodies = append(bodies, p.parseSwitchBody())
			} else {
				p.failf("expected case/default in boolean switch, got %q", p.tok().text)
			}
		}
		var chain []map[string]any
		for i := len(conds) - 1; i >= 0; i-- {
			elseBody := defBody
			if i < len(conds)-1 {
				elseBody = chain
			}
			chain = []map[string]any{{
				"type":   "If",
				"cond":   p.condToJSON(conds[i]),
				"then":   bodies[i],
				"elsifs": []any{},
				"else":   elseBody,
			}}
		}
		if len(conds) == 0 && hasDefault {
			chain = []map[string]any{{"type": "Block", "body": defBody}}
		}
		return chain
	}
	// value switch (existing path)
	// Go's switch-with-init: `switch <init>; <disc> {` — the init lowers
	// as ordinary assignments BEFORE the Case node (the golib's own
	// `switch v := w["type"].(string); v {` word-dispatch in localVal)
	var switchPre []map[string]any
	if p.tok().kind == tIdent && p.pos+1 < len(p.toks) &&
		p.toks[p.pos+1].kind == tOp && p.toks[p.pos+1].text == ":=" {
		for {
			pre2 := p.parseAssignStmt()
			switchPre = append(switchPre, pre2...)
			p.skipNL()
			if p.acceptPunct(";") {
				break
			}
			if !p.acceptPunct(",") {
				break
			}
		}
	}
	disc := p.parseExpr()
	p.skipNL()
	p.expect(tPunct, "{")
	var clauses []any
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			break
		}
		if p.atIdent("default") {
			p.pos++
			p.expect(tPunct, ":")
			clauses = append(clauses, map[string]any{
				"patterns": []any{"*"},
				"body":     p.parseSwitchBody(),
			})
		} else if p.atIdent("case") {
			p.pos++
			var pats []any
			pats = append(pats, p.switchPattern(p.parseExpr()))
			for p.acceptPunct(",") {
				p.skipNL()
				pats = append(pats, p.switchPattern(p.parseExpr()))
			}
			p.expect(tPunct, ":")
			clauses = append(clauses, map[string]any{
				"patterns": pats,
				"body":     p.parseSwitchBody(),
			})
		} else {
			p.failf("expected case/default in switch, got %q", p.tok().text)
		}
	}
	out := []map[string]any{{
		"type":         "Case",
		"discriminant": p.exprToWord(disc),
		"clauses":      clauses,
	}}
	if len(switchPre) > 0 {
		return append(switchPre, out...)
	}
	return out
}

// peekTypeSwitch detects `switch [v :=] x.(type) {` and consumes the
// guard tokens. Returns (guardVar, guardedVar, true) for a type switch
// (guardVar "" for the bare `switch x.(type)` form); anything else
// leaves the token stream untouched and reports false — the value-switch
// path parses the discriminant as an expression.
func (p *parser) peekTypeSwitch() (string, string, bool) {
	i := p.pos
	t := p.toks
	gv := ""
	if i+1 < len(t) && t[i].kind == tIdent && t[i+1].kind == tOp && t[i+1].text == ":=" {
		gv = t[i].text
		i += 2
	}
	if i+4 < len(t) &&
		t[i].kind == tIdent &&
		t[i+1].kind == tPunct && t[i+1].text == "." &&
		t[i+2].kind == tPunct && t[i+2].text == "(" &&
		t[i+3].kind == tIdent && t[i+3].text == "type" &&
		t[i+4].kind == tPunct && t[i+4].text == ")" {
		x := t[i].text
		p.pos = i + 5
		return gv, x, true
	}
	return "", "", false
}

// typePattern: a type-switch case label — a plain type NAME (int,
// string, ...). Composite type lists ([]byte, *T, ...) stay refused
// (Refuse > guess: the Case pattern vocabulary is the type-name string).
func (p *parser) typePattern() string {
	p.skipNL()
	t := p.expect(tIdent, "")
	return t.text
}

// parseTypeSwitchBody parses one arm with the guard var v aliased to the
// guarded var x, so reads of v lower to getVar x (the contract binding).
func (p *parser) parseTypeSwitchBody(gv, x string) []map[string]any {
	if gv != "" {
		old, had := p.varAlias[gv]
		p.varAlias[gv] = x
		defer func() {
			if had {
				p.varAlias[gv] = old
			} else {
				delete(p.varAlias, gv)
			}
		}()
	}
	return p.parseSwitchBody()
}

// resolveVar: reads of a type-switch guard var resolve to the guarded
// var (the v -> x binding); all other names pass through.
func (p *parser) resolveVar(name string) string {
	if t, ok := p.varAlias[name]; ok {
		return t
	}
	return name
}

func (p *parser) parseSwitchBody() []map[string]any {
	out := []map[string]any{}
	for {
		p.skipNL()
		if p.atIdent("case") || p.atIdent("default") || p.atPunct("}") {
			return out
		}
		out = append(out, p.parseStmt()...)
	}
}

// parseIIFEStmt: `func(params) { body }(args)` as a statement — a
// private Function sub + synchronous exec call (the subs-share-store
// model carries captures; params bind positionally like named subs).
func (p *parser) parseIIFEStmt() []map[string]any {
	fn := p.parseFuncLit()
	p.skipNL()
	if !p.atPunct("(") {
		p.failf("func literal needs invocation or assignment (v2)")
	}
	p.pos++
	args := p.parseArgs()
	var words []map[string]any
	for _, a := range args {
		words = append(words, p.argToWord(a))
	}
	name := "__iife_" + strconv.Itoa(p.tmpN)
	p.tmpN++
	p.fnNames[name] = true
	return []map[string]any{
		{"type": "Function", "name": name, "params": fn.params, "body": fn.body},
		execStmt(name, words, "Spawn"),
	}
}

// funcLitAhead: `func` is followed by a `(` group and then `{` — a
// func LITERAL, not a decl (a decl has a name after the optional
// receiver group). Used where a body shares the top-level dispatch.
func (p *parser) funcLitAhead() bool {
	j := p.pos + 1
	for j < len(p.toks) && p.toks[j].kind == tNL {
		j++
	}
	if j >= len(p.toks) || p.toks[j].kind != tPunct || p.toks[j].text != "(" {
		return false
	}
	depth := 0
	for ; j < len(p.toks); j++ {
		t := p.toks[j]
		if t.kind == tPunct {
			if t.text == "(" {
				depth++
			} else if t.text == ")" {
				depth--
				if depth == 0 {
					j++
					break
				}
			}
		} else if t.kind == tEOF {
			return false
		}
	}
	for j < len(p.toks) && p.toks[j].kind == tNL {
		j++
	}
	return j < len(p.toks) && p.toks[j].kind == tPunct && p.toks[j].text == "{"
}

// parseGo: go func() { ... }() → Background(Subshell(body)) + wait
func (p *parser) parseGo() []map[string]any {
	p.expect(tIdent, "go")
	p.skipNL()
	if !p.atIdent("func") {
		p.failf("go statement needs a func literal (v2)")
	}
	fn := p.parseFuncLit()
	p.skipNL()
	p.expect(tPunct, "(")
	p.expect(tPunct, ")")
	return []map[string]any{
		{
			"type": "Background",
			"body": []any{map[string]any{"type": "Subshell", "body": fn.body}},
		},
		execStmt("wait", []map[string]any{}, "Spawn"),
	}
}

// ── exec / capture / return lowering ────────────────────────────────

func (p *parser) isSyncBuiltin(cmd string) bool {
	switch cmd {
	case "echo", "printf", "read", "cat", "export", "local", "false", "true":
		return true
	}
	return false
}

func (p *parser) execFromArgs(args []*expr) map[string]any {
	if len(args) == 0 {
		p.failf("exec.Command needs a command name (v2)")
	}
	cmd := args[0].text
	words := make([]map[string]any, 0, len(args)-1)
	for _, a := range args[1:] {
		if a.kind == "str" {
			words = append(words, strExpr(a.text))
		} else {
			p.failf("exec.Command args must be string literals (v2)")
		}
	}
	purity := "Spawn"
	if p.isSyncBuiltin(cmd) {
		purity = "Emulable"
	}
	return execStmt(cmd, words, purity)
}

// captureAssign: x, _ := exec.Command(...).Output() → Assign x =
// capture(Arrow(exec ...))  (the `X=$(echo hi)` shape).
func (p *parser) captureAssign(targets []string, args []*expr) map[string]any {
	name := ""
	for _, tg := range targets {
		if tg != "_" {
			name = tg
			break
		}
	}
	if name == "" {
		p.failf("capture needs a target var (v2)")
	}
	inner := p.execFromArgs(args)
	capture := map[string]any{
		"type": "Call", "func": "capture",
		"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
		"purity": "Spawn",
	}
	p.registerVar(name, "Str")
	return assignStmt(name, capture)
}

// returnToStmt: `return expr` inside a func → echo of expr.
// isBoolExpr — a Go boolean expression (a comparison, a logical
// and/or chain, a negation, or a bool-returning function call): the
// golib's `return isIdentStart(c) || (c >= '0' && c <= '9')`.
func (p *parser) isBoolExpr(e *expr) bool {
	switch e.kind {
	case "binop":
		return true
	case "not":
		return true
	case "call":
		// a bool-returning function call: a USER function/method
		// (isIdentStart/isIdentPart/p.atPunct/...) or a bool-returning
		// stdlib (strings.Contains/HasPrefix/HasSuffix). NOT a
		// string/map returning call like b.String().
		return p.isBoolFnCall(e) ||
			e.callee == "strings.Contains" || e.callee == "strings.HasPrefix" || e.callee == "strings.HasSuffix"
	case "var":
		return e.name == "true" || e.name == "false"
	}
	return false
}

// isBoolFnCall — is the call a USER function or method (the golib's
// isIdentStart/isIdentPart/atIdent/atPunct/...)? Methods (p.atPunct)
// resolve to the method name.
func (p *parser) isBoolFnCall(e *expr) bool {
	fn := e.callee
	if i := strings.LastIndex(fn, "."); i > 0 {
		if p.varTypes[p.resolveVar(fn[:i])] == "Struct" {
			fn = fn[i+1:]
		}
	}
	return p.fnNames[fn]
}

// returnToStmt: `return expr` inside a func → echo of expr. A BOOLEAN
// expression echoes "true"/"false" (the caller's condition test
// compares the captured output — the go-sh self-hosting contract).
func (p *parser) returnToStmt(e *expr) map[string]any {
	if p.isBoolExpr(e) {
		return map[string]any{
			"type":   "If",
			"cond":   p.condToJSON(e),
			"then":   []map[string]any{execStmt("echo", []map[string]any{strExpr("true")}, "Emulable")},
			"elsifs": []any{},
			"else":   []map[string]any{execStmt("echo", []map[string]any{strExpr("false")}, "Emulable")},
		}
	}
	return execStmt("echo", []map[string]any{p.exprToWord(e)}, "Emulable")
}

// ── word lowering ───────────────────────────────────────────────────

func (p *parser) registerVar(name, typ string) {
	if p.inFunc && !p.fnParams[name] && !p.outer[name] && !p.fnLocals[name] {
		p.fnLocals[name] = true
	}
	if p.varTypes[name] == "" || p.varTypes[name] == "Array" {
		p.varTypes[name] = typ
	}
	p.outer[name] = true
}

func (p *parser) wordType(w map[string]any) string {
	switch w["type"] {
	case "Str":
		if v, ok := w["value"].(string); ok {
			if v == "true" || v == "false" {
				// Go bool literal textual form — Bool so bare-var
				// conditions lower to the ="true" gate
				return "Bool"
			}
			if _, err := strconv.ParseInt(v, 10, 64); err == nil {
				return "Int"
			}
		}
		return "Str"
	case "Arith":
		return "Int"
	case "MapLiteral":
		return "Map"
	}
	return "Str"
}

// isCgoCallee: does this dotted callee belong to the CGO-PATH? Known
// native families route to the CgoCall ext node (faithful shIR whose
// execution is the C frontend build) instead of refusing.
func (p *parser) isCgoCallee(callee string) bool {
	if strings.HasPrefix(callee, "sitter.") || strings.HasPrefix(callee, "psgrammar.") ||
		strings.HasPrefix(callee, "C.") || strings.HasPrefix(callee, "c.") ||
		strings.HasPrefix(callee, "unsafe.") || strings.HasPrefix(callee, "cpp.") ||
		strings.HasPrefix(callee, "bashgrammar.") {
		return true
	}
	dot := strings.LastIndex(callee, ".")
	if dot > 0 && p.cgoObjs[p.resolveVar(callee[:dot])] {
		return true
	}
	return false
}

// stringFieldByteRead: `c := l.src[l.pos]` / `l.src[l.pos] != '\n'` —
// a BYTE READ on a STRING-typed struct field (fish/zsh lexers). Go
// bytes ≡ chars on the ASCII corpus, so the faithful read is ONE
// character: the drop-in SubStrExtract over the objGet chain word.
func (p *parser) stringFieldByteRead(e *expr) (map[string]any, bool) {
	if e.target == nil || e.target.kind != "member" {
		return nil, false
	}
	w, tag := p.structFieldWord(e.target.name)
	if tag != "ref" {
		return nil, false
	}
	parts2 := strings.Split(e.target.name, ".")
	if len(parts2) < 2 {
		return nil, false
	}
	baseName := p.resolveVar(parts2[0])
	typeName := p.varStruct[baseName]
	field := parts2[len(parts2)-1]
	layout := p.structs[typeName]
	raws := p.structRaw[typeName]
	isStringField := false
	for i, f := range layout {
		if f == field && i < len(raws) && strings.HasPrefix(raws[i], "string") {
			isStringField = true
		}
	}
	if !isStringField {
		return nil, false
	}
	var offW map[string]any
	if e.idx1e != nil {
		offW = p.exprToWord(e.idx1e)
	} else {
		offW = strExpr(e.idx1)
	}
	return map[string]any{
		"type":   "SubStrExtract",
		"text":   w,
		"offset": offW,
		"length": map[string]any{"type": "Int", "value": 1},
	}, true
}

// displayCallWord: a captured call word for DISPLAY (stdout)
// positions — the return channel joins slots with \036; display joins
// with space (Go's Println multi-value rendering: `fmt.Println(f())`
// for 2-slot f prints "v0 v1"). Single-slot captures contain no
// separator (identity).
func (p *parser) displayCallWord(w map[string]any) map[string]any {
	return map[string]any{
		"type": "Call", "func": "strReplaceAll",
		"args":   []any{w, strExpr("\036"), strExpr(" ")},
		"purity": "PureCpu",
	}
}

// verdictDisplayWord: a bool-verdict sub call as a DISPLAY word — the
// true/false verdict capture (userCallWord's bool shape). ok=false when
// the callee isn't a known bool-verdict sub (other paths handle it).
func (p *parser) verdictDisplayWord(e *expr) (map[string]any, bool) {
	if e.kind != "call" || e.spread {
		return nil, false
	}
	callee := e.callee
	var args []*expr
	if strings.Contains(callee, ".") {
		dot := strings.LastIndex(callee, ".")
		baseName, meth := callee[:dot], callee[dot+1:]
		rn := p.resolveVar(baseName)
		if p.varStruct[rn] == "" || !p.fnNames[meth] || !p.boolFuncs[meth] {
			return nil, false
		}
		args = append([]*expr{{kind: "var", name: rn}}, e.args...)
		callee = meth
	} else {
		if !p.fnNames[callee] || !p.boolFuncs[callee] {
			return nil, false
		}
		args = e.args
	}
	return p.userCallWord(callee, args), true
}

// userCallWord: a defined sub called in WORD position — the
// capture(Arrow(exec ...)) shape (the value-return protocol's read side).
func (p *parser) userCallWord(name string, args []*expr) map[string]any {
	var words []map[string]any
	for _, a := range args {
		words = append(words, p.argToWord(a))
	}
	// BOOL-RETURNING sub (status protocol): the verdict rides $? — the
	// capture wraps exec + an echo of `$?` mapped to "true"/"false", so
	// VALUE-position calls compose (nested calls' inner execs echo
	// nothing; only this final echo lands in the capture). Matches Go's
	// bool printing (`fmt.Println(isIdStart('x'))` → true).
	if p.boolFuncs[name] {
		// run the sub as the If CONDITION (exit-status protocol), each
		// arm echoing its verdict — capture collects exactly ONE echo
		callExpr := &expr{kind: "call", callee: name, args: args}
		verdict := []map[string]any{{
			"type":   "If",
			"cond":   p.condToJSON(callExpr),
			"then":   []any{execStmt("echo", []map[string]any{strExpr("true")}, "Emulable")},
			"elsifs": []any{},
			"else":   []any{execStmt("echo", []map[string]any{strExpr("false")}, "Emulable")},
		}}
		return map[string]any{
			"type": "Call", "func": "capture",
			"args":   []any{map[string]any{"type": "Arrow", "body": []any{verdict[0]}}},
			"purity": "Spawn",
		}
	}
	inner := execStmtTA(name, words, "Spawn", nil)
	return map[string]any{
		"type": "Call", "func": "capture",
		"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
		"purity": "Spawn",
	}
}

// noteCallResultType: after `x := f(...)`, x's struct type comes from
// f's declared return type (the signature capture).
func (p *parser) noteCallResultType(target, callee string, args []*expr) {
	meth := callee
	if strings.Contains(callee, ".") {
		dot := strings.LastIndex(callee, ".")
		meth = callee[dot+1:]
	}
	ret := ""
	if sig, ok := p.fnSig[meth]; ok {
		ret = sig[1]
	} else if sig, ok := p.fnSig[callee]; ok {
		ret = sig[1]
	} else if r, ok := p.prescanRet[meth]; ok && p.isStructType(r) {
		ret = r
	} else if r, ok := p.prescanRet[callee]; ok && p.isStructType(r) {
		ret = r
	}
	_ = args
	if p.isStructType(ret) {
		rn := p.resolveVar(target)
		p.varStruct[rn] = strings.TrimPrefix(ret, "*")
	}
}

// appendEls: the element words of an append(...) expression, FLATTENED
// across nested appends (`append(append(a, b...), c...)` — the golib's
// parseTopLevel return): an append whose first arg is itself an append
// splices the inner elements instead of nesting an Array word (the
// echo/capture return protocol space-joins and re-splits, so a nested
// Array would round-trip as a literal nested array, not the flat list).
func (p *parser) appendEls(e *expr) []any {
	var out []any
	if e.callee != "append" {
		return []any{p.exprToWord(e)}
	}
	if len(e.args) >= 1 {
		a0 := e.args[0]
		if a0.kind == "call" && a0.callee == "append" {
			out = append(out, p.appendEls(a0)...)
		} else if a0.kind == "var" && p.varTypes[p.resolveVar(a0.name)] == "Array" {
			out = append(out, paramCall("slice", p.resolveVar(a0.name), "@", ""))
		} else {
			out = append(out, p.exprToWord(a0))
		}
	}
	for _, a := range e.args[1:] {
		if a.spread {
			// `append(x, y...)` — the spread's ITEMS concatenate
			if a.kind == "arraylit" {
				for _, el := range a.elems {
					out = append(out, el)
				}
			} else if a.kind == "var" && p.varTypes[p.resolveVar(a.name)] == "Array" {
				out = append(out, paramCall("slice", p.resolveVar(a.name), "@", ""))
			} else {
				out = append(out, p.exprToWord(a))
			}
		} else {
			out = append(out, p.exprToWord(a))
		}
	}
	return out
}

// appendChainParts flattens append(append(A, Bs...), Cs...) into the
// ordered part list [A, Bs..., Cs...] (spread flags ride the exprs).
func appendChainParts(e *expr) []*expr {
	if e.kind == "call" && e.callee == "append" && len(e.args) >= 1 {
		return append(appendChainParts(e.args[0]), e.args[1:]...)
	}
	return []*expr{e}
}

// returnAppendList lowers `return append(...)` over an any-list base
// (parseTopLevel's `return append(append(declStmts, funcStmts...),
// out...)`): the legacy appendEls array-flattening would
// String-coerce object elements. Instead a temp list concatenates
// (listExtend for spreads, listPush for singletons) and the caller
// echoes/binds its id. ok=false → legacy path (non-list base).
func (p *parser) returnAppendList(e *expr) (stmts []map[string]any, tmp string, ok bool) {
	parts := appendChainParts(e)
	if len(parts) == 0 {
		return nil, "", false
	}
	// the ultimate base must ride a list id (any-list var, or a
	// list-element slice call result).
	var baseW map[string]any
	baseSet := false
	b := parts[0]
	if b.kind == "var" && p.anyListVar(b.name) != "" {
		baseW = getVarExpr(p.paramName(b.name))
		baseSet = true
	}
	if !baseSet && b.kind == "call" && p.callTargetName(b.callee) != "" {
		if le := p.callFirstListElem(p.callTargetName(b.callee), p.fnRetIdents[p.callTargetName(b.callee)]); le != "" {
			baseW = p.exprToWord(b)
			baseSet = true
		}
	}
	if !baseSet {
		return nil, "", false
	}
	tmp = "__ret_l" + strconv.Itoa(p.tmpN)
	p.tmpN++
	stmts = append(stmts, assignStmt(tmp,
		map[string]any{"type": "Call", "func": "listNew", "args": []any{}, "purity": "PureCpu"}))
	stmts = append(stmts, p.listExtendStmt(tmp, baseW))
	for _, a := range parts[1:] {
		if a.spread {
			sub, ok := p.spreadAppendPart(tmp, a)
			if !ok {
				p.failf("spread append into a list needs a list value (v2)")
			}
			stmts = append(stmts, sub...)
			continue
		}
		stmts = append(stmts, p.listPushStmt(tmp, p.exprToWord(a)))
	}
	// STMT-LIST BOUNDARY (self-host echo protocol): the list holds
	// compile-time node temps (temp-assoc names) alongside live ids —
	// freezeStmts resolves exactly the marked node temps into plain
	// objects (null-restoring sigil/params), passing everything else
	// (obj#/list# refs, words, runtime names) through. The temps set is
	// global, so this works in plain-func bodies too.
	frozen := "__ret_f" + strconv.Itoa(p.tmpN)
	p.tmpN++
	stmts = append(stmts, assignStmt(frozen,
		map[string]any{"type": "Call", "func": "freezeStmts",
			"args": []any{getVarExpr(tmp),
				strExpr("nodeTemps"),
				strExpr("sigil,params"),
				strExpr("__nodeSnaps")},
			"purity": "PureCpu"}))
	return stmts, frozen, true
}

// listExtendStmt appends all of the word's items onto the tmp list.
func (p *parser) listExtendStmt(tmp string, w map[string]any) map[string]any {
	return map[string]any{
		"type": "Expr",
		"expr": map[string]any{
			"type": "Call", "func": "listExtend",
			"args":   []any{getVarExpr(tmp), w},
			"purity": "PureCpu",
		},
	}
}

// listPushStmt pushes one element word onto the tmp list.
func (p *parser) listPushStmt(tmp string, w map[string]any) map[string]any {
	return map[string]any{
		"type": "Expr",
		"expr": map[string]any{
			"type": "Call", "func": "listPush",
			"args":   []any{getVarExpr(tmp), w},
			"purity": "PureCpu",
		},
	}
}

// spreadAppendPart lowers one spread constituent of a list-building
// append into statements extending tmp: any-list vars and list-result
// calls extend directly; a nested append call recurses (its own base
// is always spliced). ok=false means caller refuses.
func (p *parser) spreadAppendPart(tmp string, a *expr) (stmts []map[string]any, ok bool) {
	if a.kind == "call" && a.callee == "append" {
		subStmts, subTmp, subOk := p.returnAppendList(a)
		if !subOk {
			return nil, false
		}
		stmts = append(stmts, subStmts...)
		stmts = append(stmts, p.listExtendStmt(tmp, getVarExpr(subTmp)))
		return stmts, true
	}
	if a.kind == "var" && p.anyListVar(a.name) != "" {
		return []map[string]any{p.listExtendStmt(tmp, getVarExpr(p.paramName(a.name)))}, true
	}
	if a.kind == "call" && p.callTargetName(a.callee) != "" {
		callee := p.callTargetName(a.callee)
		if le := p.callFirstListElem(callee, p.fnRetIdents[callee]); le != "" {
			return []map[string]any{p.listExtendStmt(tmp, p.exprToWord(a))}, true
		}
	}
	return nil, false
}

// argToWord lowers a CALL ARGUMENT: a spread-marked arg (f(args...))
// wraps its word in the Spread ext node — valid only for ARRAY-typed
// vars (the runtime expands the elements as individual positionals;
// a scalar spread would silently vanish). Other args pass through.
func (p *parser) argToWord(e *expr) map[string]any {
	if e.spread {
		if e.kind == "slice" && e.target != nil && e.target.kind == "var" {
			// toks[j+1:k]... — the computed-bound param-slice word rides
			// inside a Spread node (runtime expands at the boundary)
			sw := p.exprToWord(e)
			return map[string]any{"type": "Spread", "expr": sw}
		}
		if e.kind != "var" || p.varTypes[p.resolveVar(e.name)] != "Array" {
			p.failf("variadic spread needs an array-typed var (v2)")
		}
		name := p.resolveVar(e.name)
		return map[string]any{
			"type": "Spread",
			"expr": map[string]any{
				"type": "Call", "func": "arrayItems",
				"args": []any{strExpr(name)}, "purity": "PureCpu",
			},
		}
	}
	// ARRAY var passed to a call (non-spread `f(arr)` — Go only allows
	// a slice here, so the callee's slice param): freeze to a list id
	// (the slice-param protocol — single opaque value, reentrant; the
	// callee reads listGet/listLen). any-lists already ride ids.
	if e.kind == "var" && !e.spread {
		rn := p.resolveVar(e.name)
		if p.varTypes[rn] == "Array" && p.anyListVar(e.name) == "" {
			return map[string]any{
				"type": "Call", "func": "arrayToList",
				"args":   []any{strExpr(rn)},
					"purity": "PureCpu",
				}
		}
		if e.name == p.variadicParam && p.variadicParam != "" {
			// forwarding the current variadic (`g(parts)` — a shell
			// array from the entry prologue).
			return map[string]any{
				"type": "Call", "func": "arrayToList",
				"args":   []any{strExpr(rn)},
					"purity": "PureCpu",
				}
			}
	}
	return p.exprToWord(e)
}

func (p *parser) structTypeOf(name string) string {
	if t, ok := p.varStructTypes[name]; ok {
		return t
	}
	return p.receiverTypes[name]
}

func (p *parser) indexArithText(e *expr) string {
	switch e.kind {
	case "var":
		return p.resolveVar(e.name)
	case "member":
		// a struct field bound (p.pos) — the dotted name; the runtime's
		// arithExpand resolves it via the struct's JSON (the golib's
		// `p.toks[p.pos+1]` cursor arithmetic).
		return strings.TrimPrefix(e.name, ".")
	case "num":
		return e.text
	case "add", "mul":
		l, r := p.indexArithText(e.lhs), p.indexArithText(e.rhs)
		if l == "" || r == "" {
			return ""
		}
		return l + e.op + r
	case "neg":
		l := p.indexArithText(e.lhs)
		if l == "" {
			return ""
		}
		return "-" + l
	}
	return ""
}

// exprToWord lowers an expression to its A1 word JSON.
func (p *parser) exprToWord(e *expr) map[string]any {
	switch e.kind {
	case "str":
		return interpLit(e.text)
	case "rawstr":
		return interpLit(e.text)
	case "char":
		// a Go rune literal is an INTEGER — its ASCII code (the A1 is
		// string-flavored, so the code is the value; `c := ' '` → c =
		// "32", and byte comparisons `c == ' '` → `"$c"="32"`).
		return strExpr(charCode(e))
	case "structlit":
		// a struct VALUE — the JSON object string (jsonNew). The field
		// names: the NAMED fields, or the tracked struct type's fields
		// (positional `tok{"a", "b"}`).
		names := e.fieldNames
		if len(names) == 0 {
			names = p.structFields[e.name]
		}
		if len(names) != len(e.args) {
			p.failf("struct literal %q field count mismatch (v2)", e.name)
		}
		// []any{} — NOT var args []any: an empty field list must
		// marshal as [] (a nil slice marshals as null, and the estree
		// ingress rejects ext-child.args: not an array — the same
		// empty-composite contract the CLI's []string{} hit)
		args := []any{}
		for i, f := range e.args {
			args = append(args, strExpr(names[i]), p.exprToWord(f))
		}
		return map[string]any{
			"type": "Call", "func": "jsonNew",
			"args":   args,
			"purity": "PureCpu",
		}
	case "arrlit":
		// an array literal in an expression position — the jsonArrNew
		// call (carried in rawJSON).
		return e.rawJSON
	case "num":
		return strExpr(e.text)
	case "var":
		if e.name == "nil" {
			return strExpr("")
		}
		if e.name == "true" || e.name == "false" {
			// Go bool literal in VALUE position — its textual form (fmt
			// prints bools as true/false; byte-faithful under echo)
			return strExpr(e.name)
		}
		name := p.resolveVar(e.name)
		if n, ok := p.paramNumber(name); ok {
			return getVarExpr(strconv.Itoa(n))
		}
		return getVarExpr(name)
	case "member":
		// STRUCT FIELD ACCESS: a dotted name whose base is a
		// struct-typed var resolves through the arena layout — each
		// segment becomes a computed subscript of the type's arena.
		if w, tag := p.structFieldWord(e.name); tag != "none" {
			return w
		}
		// c.Args on a stored exec.Command → the Go-style bracketed argv
		// ("[echo hi]"). exec.Command args are string literals by the
		// frontend contract, so the argv is statically known (t53).
		if i := strings.LastIndex(e.name, "."); i > 0 {
			base, field := e.name[:i], e.name[i+1:]
			if field == "Args" {
				if args, ok := p.cmds[base]; ok {
					var b strings.Builder
					b.WriteByte('[')
					for j, a := range args {
						if j > 0 {
							b.WriteByte(' ')
						}
						b.WriteString(a.text)
					}
					b.WriteByte(']')
					return strExpr(b.String())
				}
			}
			// p.toks — a struct field read → the jsonGet helper (the
			// go-sh self-hosting contract: structs are JSON object
			// strings; the receiver is resolved by name — a param holding
			// the receiver's name follows).
			if p.varTypes[p.resolveVar(base)] == "Struct" {
				return map[string]any{
					"type": "Call", "func": "jsonGet",
					"args":   []any{strExpr(p.resolveVar(base)), strExpr(field)},
					"purity": "PureCpu",
				}
			}
		}
		p.failf("unsupported bare member %q (v2)", e.name)
	case "add", "mul", "neg":
		return p.arithOrConcat(e)
	case "addr":
		// AddressOf ext node — snapshot passthrough on value-only
		// backends; Perl renders a true reference.
		return map[string]any{
			"type": "AddressOf", "operand": p.exprToWord(e.lhs),
		}
	case "deref":
		// Deref ext node — matching read side of AddressOf.
		return map[string]any{
			"type": "Deref", "pointer": p.exprToWord(e.lhs),
		}
	case "make":
		// make(map[K]V) / make([]T, n) in word position: an empty
		// object-store allocation (map → objNew "map", slice → listNew)
		if e.makeMap {
			return p.objNewCallNamed("map", []any{}, []any{})
		}
		return map[string]any{
			"type": "Call", "func": "listNew",
			"args":   []any{},
			"purity": "PureCpu",
		}
	case "assert":
		// TypeAssert ext node — checked passthrough; kind vocabulary =
		// sh2.typeOf strings + declared struct names (obj-store typed)
		k := goTypeKind(e.typeName)
		if k == "" {
			base := strings.TrimPrefix(strings.TrimSpace(e.typeName), "*")
			if p.isStructType(base) {
				k = base
			}
		}
		if k == "" {
			p.failf("unsupported type assertion to %q (v2) — named types have no knowable dynamic kind", e.typeName)
		}
		return map[string]any{
			"type": "TypeAssert", "expr": p.exprToWord(e.lhs), "kind": k,
		}
	case "maplit":
		// MapLiteral ext node is PERL-only — the JS ingress rejects it.
		// The runtime jsonObject builds the object from parallel key/
		// value word arrays (values resolve refs recursively), so the
		// map value rides the normal word channel.
		var mkeys, mvals []any
		for i := range e.keys {
			mkeys = append(mkeys, p.exprToWord(e.keys[i]))
			mv := p.exprToWord(e.vals[i])
			if mv != nil {
				mvals = append(mvals, mv)
			}
		}
		if mkeys == nil {
			mkeys = []any{}
		}
		if mvals == nil {
			mvals = []any{}
		}
		return map[string]any{
			"type": "Call", "func": "jsonObject",
			"args": []any{
				map[string]any{"type": "Array", "elements": mkeys},
				map[string]any{"type": "Array", "elements": mvals},
			},
			"purity": "PureCpu",
		}
	case "index":
		// SplitN-tracked var element reads: parts[0] → ${s%%sep*},
		// parts[1] → ${s#*sep} — bash param ops on the SOURCE var
		if e.target != nil && e.target.kind == "var" {
			if sn, ok := p.splitNVars[p.resolveVar(e.target.name)]; ok {
				idx := ""
				if e.idx1e != nil {
					idx = e.idx1e.text
				} else {
					idx = e.idx1
				}
				if idx == "0" {
					return paramCall("%%", sn.src, sn.sep+"*")
				}
				return paramCall("#", sn.src, "*"+sn.sep)
			}
		}
		// m["key"] on a map var → assocGet (the runtime's by-name
		// associative-array read; t54). Computed keys lower through
		// exprToWord — the runtime coerces the key word to its value.
		if e.target != nil && e.target.kind == "var" && p.maps[e.target.name] {
			var keyW map[string]any
			if e.idx1e != nil {
				keyW = p.exprToWord(e.idx1e)
			} else {
				keyW = strExpr(e.idx1)
			}
			return map[string]any{
				"type": "Call", "func": "assocGet",
				"args":   []any{strExpr(e.target.name), keyW},
				"purity": "PureCpu",
			}
		}
		// indexing a STRUCT FIELD that is a list/map (`l.toks[p.pos]`,
		// `m.varTypes[name]`) — the OBJECT STORE accessors
		if e.target != nil && e.target.kind == "member" && e.target.name == "os.Args" {
			// os.Args[i] — the positional read: [0] is $0 (the program
			// name), [k≥1] is the (k)th positional (`${@:k:1}` — the same
			// slice contract the os.Args[i:] range lowering pins;
			// ts-coverage's multi-target `td, ntPath := os.Args[1], os.Args[2]`)
			key := ""
			if e.idx1e != nil {
				key = p.arithKeyText(e.idx1e)
			} else {
				key = e.idx1
			}
			if key == "0" {
				return getVarExpr("0")
			}
			return joinCall(paramCall("slice", "@", key, "1"))
		}
		if e.target != nil && e.target.kind == "member" {
			if w, tag := p.structFieldWord(e.target.name); tag != "none" && tag != "ref" {
				// the key rides as a WORD: numbers, vars, arith and
				// object reads all coerce at the runtime boundary
				var keyWord map[string]any
				if e.idx1e != nil {
					keyWord = p.exprToWord(e.idx1e)
				} else {
					keyWord = strExpr(e.idx1)
				}
				fn := "listGet"
				if tag == "map" {
					fn = "mapGet"
				}
				return map[string]any{
					"type": "Call", "func": fn,
					"args":   []any{w, keyWord},
					"purity": "PureCpu",
				}
			}
			if node, ok := p.stringFieldByteRead(e); ok {
				return node
			}
		}
		// CHAINED index: `post[0]["targets"]` — a string-keyed map read
		// on a SLICE ELEMENT (the golib's own stmt-array word access):
		// the element word (an array-store read resolving to a map ref
		// id) feeds the runtime mapGet. Literal string keys only.
		if e.target != nil && e.target.kind == "index" &&
			((e.idx1e != nil && e.idx1e.kind == "str") || e.idx1 != "") {
			key := e.idx1
			if e.idx1e != nil {
				key = e.idx1e.text
			}
			return map[string]any{
				"type": "Call", "func": "mapGet",
				"args":   []any{p.exprToWord(e.target), strExpr(key)},
				"purity": "PureCpu",
			}
		}
		if e.idx1e != nil {
			// a COMPOSITE VALUE target (map literal / assertion result)
			// may take a literal STRING key — the ElementRead ext node.
			compositeTarget := e.target != nil &&
				(e.target.kind == "maplit" || e.target.kind == "assert")
			if !(compositeTarget && e.idx1e.kind == "str") {
				// computed ARRAY/STRING index (src[i], p.toks[p.pos]): the
				// subscript text rides the word shape — the runtime
				// evaluates it with evalArith. Strings read ONE element
				// (${s:$i:1}; Go bytes ≡ chars for the ASCII corpus —
				// documented caveat).
				// MAP reads through a struct field or a chained index
				// (`p.m[k]`, `p.m[k1][k2]` — the golib's own
				// `p.structFieldTypes[t][f]`): the A1 map model stores
				// maps by NAME, so the inner read (objGet → the field's
				// map name, or the inner index's mapGet word) is the map
				// reference and the outer read is mapGet(ref, key) — the
				// key rides the WORD channel (map keys are strings),
				// unlike the array paths below (arith keys).
				if e.target != nil && (e.target.kind == "member" || e.target.kind == "index") {
					if mw, tag := p.mapRefWord(e.target); tag == "map" {
						return map[string]any{
							"type": "Call", "func": "mapGet",
							"args":   []any{mw, p.exprToWord(e.idx1e)},
							"purity": "PureCpu",
						}
					}
				}
				if e.target == nil || e.target.kind != "var" {
					p.failf("unsupported index key (v2) — must be a number literal")
				}
				// any-list element read with a COMPUTED key
				// (`toks[j+1]` — the list id resolves, then listGet;
				// the shell-array subscript below would read the id).
				if ln := p.anyListVar(e.target.name); ln != "" {
					return map[string]any{
						"type": "Call", "func": "listGet",
						"args":   []any{p.anyListReadWord(e.target.name), p.exprToWord(e.idx1e)},
						"purity": "PureCpu",
					}
				}
				key := p.arithKeyText(e.idx1e)
				name := p.resolveVar(e.target.name)
				// SLICE-param element (`args[0]` — the param holds a
				// list id under the slice-param protocol): listGet,
				// not the positional subscript (getVar "N[i]" never
				// resolves). any-lists handled above; this is the
				// scalar-slice remainder.
				if p.paramSlice[e.target.name] || p.paramSlice[name] {
					if n, ok := p.paramNumber(name); ok {
						return map[string]any{
							"type": "Call", "func": "listGet",
							"args":   []any{getVarExpr(strconv.Itoa(n)), strExpr(key)},
							"purity": "PureCpu",
						}
					}
				}
				if n, ok := p.paramNumber(name); ok {
					name = strconv.Itoa(n)
				}
				if p.varTypes[p.resolveVar(e.target.name)] == "Str" {
					// Go byte access into a string — the sh2.byteAt helper
					// (Go bytes are INTEGERS: the code is the value, so a
					// later charCode comparison agrees — the go-sh
					// self-hosting contract)
					return map[string]any{
						"type": "Call", "func": "byteAt",
						"args":   []any{strExpr(name), strExpr(key)},
						"purity": "PureCpu",
					}
				}
				return getVarExpr(name + "[" + key + "]")
			}
		}
		if e.target != nil && e.target.kind == "var" {
			name := p.resolveVar(e.target.name)
			// SLICE-param element, literal key — listGet (see above).
			if p.paramSlice[e.target.name] || p.paramSlice[name] {
				if n, ok := p.paramNumber(name); ok {
					return map[string]any{
						"type": "Call", "func": "listGet",
						"args":   []any{getVarExpr(strconv.Itoa(n)), strExpr(e.idx1)},
						"purity": "PureCpu",
					}
				}
			}
			if n, ok := p.paramNumber(name); ok {
				name = strconv.Itoa(n)
			}
			// any-list element read with a LITERAL key (`toks[0]` —
			// the shell-array subscript below reads the id string).
			if ln := p.anyListVar(e.target.name); ln != "" {
				return map[string]any{
					"type": "Call", "func": "listGet",
					"args":   []any{p.anyListReadWord(e.target.name), strExpr(e.idx1)},
					"purity": "PureCpu",
				}
			}
			// a STRING-typed var with a literal key reads its BYTE (the
			// sh2.byteAt helper — the code, so charCode comparisons
			// agree; the go-sh self-hosting contract). Arrays keep the
			// array-element word.
			if p.varTypes[p.resolveVar(e.target.name)] == "Str" {
				return map[string]any{
					"type": "Call", "func": "byteAt",
					"args":   []any{strExpr(name), strExpr(e.idx1)},
					"purity": "PureCpu",
				}
			}
			return joinCall(paramCall("", name+"["+e.idx1+"]"))
		}
		// indexing a COMPOSITE VALUE (a map literal, an assertion result):
		// the ElementRead ext node — computed coll[key] on the native
		// surface. Literal keys only (the frontend's word contract).
		if e.target != nil && (e.target.kind == "maplit" || e.target.kind == "assert") {
			key := ""
			if e.idx1e != nil {
				key = e.idx1e.text
			} else {
				key = e.idx1
			}
			return map[string]any{
				"type": "ElementRead",
				"coll": p.exprToWord(e.target),
				"key":  strExpr(key),
			}
		}
		p.failf("index target must be a var (v2)")
	case "slice":
		if e.target != nil && e.target.kind == "var" {
			return p.sliceWord(e)
		}
		// MEMBER-LIST slice: x.f[lo:hi] over a []T struct field →
		// listSlice(objGet(id, f), lo, hi) — a NEW list ref holding the
		// copied range (zig-sh-go's `x.out[:mark]` truncate /
		// `x.out[mark:]` tail-copy idioms). Open bounds are explicit:
		// 0 and listLen(ref).
		if e.target != nil && p.memberListType(e.target) != "" {
			return p.memberSliceWord(e)
		}
		// non-var slice target (`raws[off][vi+1:]` — an element read
		// sliced): the drop-in SubStrExtract ext node. Go string-slice
		// semantics: [lo:hi] = bytes lo..hi-1; a missing bound runs to
		// the end (length omitted → SubStrExtract's to-end form).
		if e.target != nil {
			offW := map[string]any{"type": "Int", "value": 0}
			if e.idx1e != nil {
				offW = p.exprToWord(e.idx1e)
			} else if e.idx1 != "" {
				offW = strExpr(e.idx1)
			}
			node := map[string]any{
				"type":   "SubStrExtract",
				"text":   p.exprToWord(e.target),
				"offset": offW,
			}
			// a computed hi (`s[lo:hiExpr]`) or literal hi: length = hi-lo
			if e.idx2e != nil {
				loE := e.idx1e
				if loE == nil {
					// open low bound (`s[:hiExpr]`): length = hi - 0
					loE = &expr{kind: "num", text: "0"}
				}
				node["length"] = p.exprToWord(&expr{kind: "add", op: "-", lhs: e.idx2e, rhs: loE})
			} else if e.idx2 != "" {
				var loN int
				if n, err := strconv.Atoi(e.idx1); err == nil {
					loN = n
				}
				if hiN, err := strconv.Atoi(e.idx2); err == nil {
					node["length"] = map[string]any{"type": "Int", "value": hiN - loN}
				}
			}
			return node
		}
		p.failf("slice target must be a var (v2)")
	case "strlen":
		if e.target != nil && e.target.kind == "var" {
			name := p.resolveVar(e.target.name)
			if n, ok := p.paramNumber(name); ok {
				return paramCall("len", strconv.Itoa(n))
			}
			return paramCall("len", name)
		}
		// len(<struct field>) — strLen/listLen over the objGet chain
		// (`len(p.src)`, posix-sh-go's scanner)
		if e.target != nil && e.target.kind == "member" {
			if w, tag := p.structFieldWord(e.target.name); tag == "list" {
				return map[string]any{
					"type": "Call", "func": "listLen",
					"args":   []any{w},
					"purity": "PureCpu",
				}
			} else if w != nil {
				return map[string]any{
					"type": "Call", "func": "strLen",
					"args":   []any{w},
					"purity": "PureCpu",
				}
			}
		}
		// len("lit") — folded at emit time with Go's byte-length
		// semantics, matching the native run exactly (t75).
		if e.target != nil && (e.target.kind == "str" || e.target.kind == "rawstr") {
			return strExpr(strconv.Itoa(len(e.target.text)))
		}
		p.failf("len() arg must be a var (v2)")
	case "arrlen":
		if e.target != nil && e.target.kind == "var" {
			// ListRef var: holds a list#N object ref — count via the
			// runtime listLen (the ${#arr[@]} shape reads the A1 array
			// store, which a ref-holding var doesn't populate)
			if p.varTypes[p.resolveVar(e.target.name)] == "ListRef" {
				return map[string]any{
					"type": "Call", "func": "listLen",
					"args":   []any{p.exprToWord(e.target)},
					"purity": "PureCpu",
				}
			}
			// Any-list var: holds a list#N id (struct/any elements) —
			// same listLen shape as ListRef.
			if ln := p.anyListVar(e.target.name); ln != "" {
				return map[string]any{
					"type": "Call", "func": "listLen",
					"args":   []any{p.anyListReadWord(e.target.name)},
					"purity": "PureCpu",
				}
			}
			// SLICE-param len (list id under the slice-param protocol).
			rn := p.resolveVar(e.target.name)
			if p.paramSlice[e.target.name] || p.paramSlice[rn] {
				if n, ok := p.paramNumber(rn); ok {
					return map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{getVarExpr(strconv.Itoa(n))},
						"purity": "PureCpu",
					}
				}
				if n, ok := p.paramNumber(e.target.name); ok {
					return map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{getVarExpr(strconv.Itoa(n))},
						"purity": "PureCpu",
					}
				}
			}
			name := p.resolveVar(e.target.name)
			if n, ok := p.paramNumber(name); ok {
				name = strconv.Itoa(n)
			}
			return joinCall(paramCall("slice", "#"+name, "@", ""))
		}
		if e.target != nil && e.target.kind == "member" {
			if w, tag := p.structFieldWord(e.target.name); tag == "list" {
				return map[string]any{
					"type": "Call", "func": "listLen",
					"args":   []any{w},
					"purity": "PureCpu",
				}
			}
		}
		p.failf("len() of array must be a var (v2)")
	case "call":
		// chr(code) — Go string(byte) rune semantics (the lexer's
		// `string(c)` punct text): the runtime chr helper. Emitted
		// only for int-family args (parsePrimary gates the shape).
		if e.callee == "chr" && len(e.args) == 1 {
			return map[string]any{
				"type": "Call", "func": "chr",
				"args":   []any{p.exprToWord(e.args[0])},
				"purity": "PureCpu",
			}
		}
		// json.Marshal(x) — the shir-emit-go A1-JSON emission (the
		// golib's Emit): the runtime jsonMarshal serializes the assoc
		// array with sorted keys (encoding/json parity)
		if e.callee == "json.Marshal" && len(e.args) == 1 {
			// a MAP-typed arg passes its ASSOC NAME (the map lives in the
			// assoc store, not the var store — the var read is empty)
			argW := p.exprToWord(e.args[0])
			if e.args[0].kind == "var" && p.maps[e.args[0].name] {
				argW = strExpr(p.resolveVar(e.args[0].name))
			}
			return map[string]any{
				"type": "Call", "func": "jsonMarshal",
				"args":   []any{argW},
				"purity": "PureCpu",
			}
		}
		// recover() INSIDE a deferred closure — the caught value via
		// the enclosing TryExcept's as-binding (the golib's panic-
		// recovery defers); outside a defer it refuses loudly
		if e.callee == "recover" {
			if p.deferRecover == "" {
				p.failf("recover() outside a defer func (v2)")
			}
			p.deferUsedRcv = true
			return getVarExpr(p.deferRecover)
		}
		// append(x, elems...) as a VALUE (return position — the golib's
		// `return append(pre, more...)` slice building): the resulting
		// slice as an Array word — the echo/capture return protocol
		// space-joins and re-splits it, and list/obj ref ids contain no
		// spaces, so the item list round-trips.
		if e.callee == "append" {
			return map[string]any{"type": "Array", "elements": p.appendEls(e)}
		}
		// strings.ContainsAny(s, cutset) in VALUE position — the
		// runtime strContainsAny membership test
		if e.callee == "strings.SplitN" {
			p.failf("strings.SplitN unsupported (v2) — SplitN's rest-with-separators semantics need a dedicated lowering")
		}
		if e.callee == "strings.ContainsAny" && len(e.args) == 2 {
			return map[string]any{
				"type": "Call", "func": "strContainsAny",
				"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
				"purity": "PureCpu",
			}
		}
		// strings.ReplaceAll(s, old, new) with computed operands — the
		// runtime strReplaceAll (split/rejoin, no regex escaping);
		// literal ${s//old/new} covers the static case
		// DirEntry method calls on readDirVars entries: e.Name() →
		// identity (entries ARE names from ls -1); e.IsDir() in WORD
		// position refuses (it is a bool — the condition path lowers
		// it to the -d test; see condToJSON)
		if dot := strings.LastIndex(e.callee, "."); dot > 0 {
			baseName := e.callee[:dot]
			if _, ok := p.readDirVars[p.resolveVar(baseName)]; ok {
				meth := e.callee[dot+1:]
				switch meth {
				case "Name":
					return getVarExpr(p.resolveVar(baseName))
				}
			}
		}
		if e.callee == "strings.TrimLeft" && len(e.args) == 2 {
			return map[string]any{
				"type":   "CutsetTrim",
				"text":   p.exprToWord(e.args[0]),
				"cutset": p.exprToWord(e.args[1]),
				"side":   "left",
			}
		}
		if e.callee == "strings.TrimRight" && len(e.args) == 2 {
			return map[string]any{
				"type":   "CutsetTrim",
				"text":   p.exprToWord(e.args[0]),
				"cutset": p.exprToWord(e.args[1]),
				"side":   "right",
			}
		}
		// strings.Replace(s, old, neu, n) — the COUNTED variant: at most
		// the first n replacements (strReplaceN runtime twin; go-sh.go's
		// own fmt fast-path uses it). Literal or computed operands ride.
		if e.callee == "strings.Replace" && len(e.args) == 4 {
			return map[string]any{
				"type": "Call", "func": "strReplaceN",
				"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1]), p.exprToWord(e.args[2]), p.exprToWord(e.args[3])},
				"purity": "PureCpu",
			}
		}
		// strings.Count(s, sub) — non-overlapping instance count
		// (strCount runtime twin; go-sh.go's own fmt fast-path gate)
		if e.callee == "strings.Count" && len(e.args) == 2 {
			return map[string]any{
				"type": "Call", "func": "strCount",
				"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
				"purity": "PureCpu",
			}
		}
		if e.callee == "strings.ReplaceAll" && len(e.args) == 3 {
			return map[string]any{
				"type": "Call", "func": "strReplaceAll",
				"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1]), p.exprToWord(e.args[2])},
				"purity": "PureCpu",
			}
		}
		// strings.IndexByte/Index(s, n) — the first-occurrence index
		// (-1 when absent): the runtime strIndex
		if (e.callee == "strings.IndexByte" || e.callee == "strings.IndexRune" || e.callee == "strings.Index") && len(e.args) == 2 {
			return map[string]any{
				"type": "Call", "func": "strIndex",
				"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
				"purity": "PureCpu",
			}
		}
		// CGO-PATH: calls into cgo-bound native libraries (tree-sitter
		// bindings) lower to the CgoCall ext node — faithful shIR whose
		// execution is the C frontend build, never a parse-time refusal
		dotC := strings.LastIndex(e.callee, ".")
		if dotC > 0 && p.cgoObjs[p.resolveVar(e.callee[:dotC])] {
			e.callee = e.callee[:dotC] + "." + e.callee[dotC+1:] // unchanged; marker for below
		}
		if strings.HasPrefix(e.callee, "sitter.") || strings.HasPrefix(e.callee, "C.") || strings.HasPrefix(e.callee, "c.") ||
			strings.HasPrefix(e.callee, "unsafe.") || strings.HasPrefix(e.callee, "psgrammar.") || strings.HasPrefix(e.callee, "cpp.") || strings.HasPrefix(e.callee, "bashgrammar.") ||
			(dotC > 0 && p.cgoObjs[p.resolveVar(e.callee[:dotC])]) {
			argsW := []any{strExpr(e.callee)}
			for _, a := range e.args {
				argsW = append(argsW, p.exprToWord(a))
			}
			return map[string]any{
				"type":   "CgoCall",
				"target": strExpr(e.callee),
				"args":   argsW[1:],
			}
		}
		// <re>.FindString(s) / <re>.MatchString(s) over a tracked
		// regexp var — RegexpFind ext node (leftmost match, "" when
		// none) and the statused regex test respectively
		if dot := strings.LastIndex(e.callee, "."); dot > 0 {
			base := e.callee[:dot]
			meth := e.callee[dot+1:]
			if pat, ok := p.regexpVars[p.resolveVar(base)]; ok && len(e.args) == 1 {
				switch meth {
				case "FindString":
					return map[string]any{
						"type":    "RegexpFind",
						"text":    p.exprToWord(e.args[0]),
						"pattern": strExpr(pat),
					}
				case "MatchString":
					return map[string]any{
						"type": "Call", "func": "regexMatch",
						"args": []any{map[string]any{
							"type": "Regex", "value": pat,
						}, p.exprToWord(e.args[0])},
						"purity": "PureCpu",
					}
				}
			}
		}
		switch e.callee {
		case "os.Getenv":
			if len(e.args) == 1 && e.args[0].kind == "str" {
				return getVarExpr(e.args[0].text)
			}
			p.failf("os.Getenv needs a string literal (v2)")
		case "strings.ReplaceAll":
			// ReplaceAll(s, old, new) → ${s//old/new} (ALL occurrences);
			// raw-string args (`\`, `\\` — sedBreakEscape) are the same
			// text as interpreted strings
			if len(e.args) == 3 && e.args[0].kind == "var" &&
				(e.args[1].kind == "str" || e.args[1].kind == "rawstr") &&
				(e.args[2].kind == "str" || e.args[2].kind == "rawstr") {
				return paramCall("//", e.args[0].name, e.args[1].text, e.args[2].text)
			}
			p.failf("strings.ReplaceAll needs (var, str, str) (v2)")
		case "strings.Trim":
			// Trim(s, cutset) — strip ALL leading/trailing chars in the
			// set: the drop-in CutsetTrim ext node (bash has no char-set
			// trim twin; go-sh.go's own sedBreakEscape)
			if len(e.args) == 2 {
				return map[string]any{
					"type":   "CutsetTrim",
					"text":   p.exprToWord(e.args[0]),
					"cutset": p.exprToWord(e.args[1]),
				}
			}
			p.failf("strings.Trim needs (str, cutset) (v2)")
		case "strings.TrimPrefix", "strings.TrimSuffix":
			// TrimPrefix(s, p) → ${s#p} — remove ONE leading literal
			// (bash `#` strips a single occurrence; a glob-metachar p
			// would glob-match in the shell, so those route to the
			// drop-in AffixStrip ext node instead).
			if len(e.args) == 2 {
				prefix := e.callee == "strings.TrimPrefix"
				if e.args[0].kind == "var" && e.args[1].kind == "str" && !strings.ContainsAny(e.args[1].text, "*?[]\\") {
					op := "#"
					if !prefix {
						op = "%"
					}
					return paramCall(op, e.args[0].name, e.args[1].text)
				}
				if w, ok := foldPureLiteralCall(e.callee, e.args); ok {
					return strExpr(w)
				}
				// non-var operand (raws[off], a composite read): the
				// drop-in AffixStrip ext node (single-occurrence strip,
				// absent affix → text unchanged) — same contract as the
				// param-op shape above
				return map[string]any{
					"type":    "AffixStrip",
					"text":    p.exprToWord(e.args[0]),
					"pattern": p.exprToWord(e.args[1]),
					"prefix":  prefix,
				}
			}
			p.failf("%s needs (var|str, str) (v2)", e.callee)
		case "strings.Join":
			// Join(arr[lo:hi], " ") → ${arr[@]:lo:len} joined with a space
			// — exactly the A1 join(param("slice", …)) shape (the runtime
			// joins arrays with " ", matching Go's space separator).
			if len(e.args) == 2 && e.args[1].kind == "str" && e.args[1].text == " " {
				if e.args[0].kind == "slice" && e.args[0].target != nil && e.args[0].target.kind == "var" {
					return p.sliceWord(e.args[0])
				}
				// Join(arr, " ") on a FULL array → the `${arr[@]}` join
				// shape (join(param("slice", name, "@", "")) — the runtime's
				// arrayItems + space join; the app's
				// `strings.Join(redirects, " ")` form).
				if e.args[0].kind == "var" && p.varTypes[e.args[0].name] == "Array" {
					return joinCall(paramCall("slice", e.args[0].name, "@", ""))
				}
			}
			// Join(memberSlice, sep) — `x.out[mark:]`: listSlice ref word
			// joined with the separator (zig-sh-go's range-form capture)
			if len(e.args) == 2 && e.args[0].kind == "slice" &&
				e.args[0].target != nil && p.memberListType(e.args[0].target) != "" {
				return map[string]any{
					"type": "Call", "func": "joinSep",
					"args": []any{
						p.memberSliceWord(e.args[0]),
						p.exprToWord(e.args[1]),
					},
					"purity": "PureCpu",
				}
			}
			// Join(memberArr, sep) — a struct-FIELD slice (`x.out`, the
			// zig-sh-go emit-buffer accumulator): the field reads as
			// objGet(id, field) (the same shape len(x.out) lowers to) and
			// joinSep joins the resulting list verbatim.
			if len(e.args) == 2 && (e.args[0].kind == "member" || e.args[0].kind == "fieldof") {
				return map[string]any{
					"type": "Call", "func": "joinSep",
					"args": []any{
						p.exprToWord(e.args[0]),
						p.exprToWord(e.args[1]),
					},
					"purity": "PureCpu",
				}
			}
			// Any other separator ("\n" — the app's dominant form,
			// bat-sh-go's `strings.Join(bodyLines, "\n")`) has no
			// separator arg on the A1 join — declared boundary
			// (core-requests go-sh-dogfood-20260815 §8); refuse loudly.
			if len(e.args) == 2 && e.args[0].kind == "var" {
				return map[string]any{
					"type": "Call", "func": "joinSep",
					"args": []any{
						paramCall("slice", e.args[0].name, "@", ""),
						strExpr(e.args[1].text),
					},
					"purity": "PureCpu",
				}
			}
			p.failf(`strings.Join needs (arr[lo:hi]|arr, " ") (v2)`)
		case "filepath.Join":
			// Join(p1, p2, …) → the runtime joinSep with "/" — the
			// exact Go path join for the corpus's simple operands (no
			// ".."/"." cleaning needed: two plain operands join to
			// p1/p2; Go's Clean would only change redundant slashes)
			if len(e.args) >= 2 {
				var pEls []any
				for _, a := range e.args {
					pEls = append(pEls, p.exprToWord(a))
				}
				return map[string]any{
					"type": "Call", "func": "joinSep",
					"args":   []any{map[string]any{"type": "Array", "elements": pEls}, strExpr("/")},
					"purity": "PureCpu",
				}
			}
			p.failf("filepath.Join needs at least 2 args (v2)")
		case "filepath.Dir", "filepath.Ext":
			// Pure path ops on string literals — folded at emit time with
			// exact Go stdlib semantics (t55).
			if len(e.args) == 1 && e.args[0].kind == "str" {
				if w, ok := foldPureLiteralCall(e.callee, e.args); ok {
					return strExpr(w)
				}
			}
			// NON-literal operand (a closure call `s(0)` — the golib's
			// own foldPureLiteralCall): the runtime pathDir/pathExt twin
			if len(e.args) == 1 {
				fn := "pathDir"
				if e.callee == "filepath.Ext" {
					fn = "pathExt"
				}
				return map[string]any{
					"type": "Call", "func": fn,
					"args":   []any{p.exprToWord(e.args[0])},
					"purity": "PureCpu",
				}
			}
			p.failf("%s needs a string literal (v2)", e.callee)
		case "strings.HasPrefix":
			if len(e.args) == 2 {
				if w, ok := foldPureLiteralCall(e.callee, e.args); ok {
					return strExpr(w)
				}
			}
			// non-literal haystack (raws[off], a composite read): the
			// native strHasPrefix call over arbitrary words — the same
			// shape the condition path pins (condOperandA1Word)
			if len(e.args) == 2 {
				return map[string]any{
					"type": "Call", "func": "strHasPrefix",
					"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
					"purity": "PureCpu",
				}
			}
			p.failf("strings.HasPrefix needs (str, str) literals (v2)")
		case "strings.ToUpper", "strings.ToLower":
			// var arg → the `${s,,}` / `${s^^}` param ops
			// (LowercaseAll/UppercaseAll — byte-identical to the core's
			// `param(",," name)` / `param("^^" name)` lowering of the
			// shell expansions; the runtime folds to toLowerCase /
			// toUpperCase). Literals keep folding at emit time (t71).
			if len(e.args) == 1 && e.args[0].kind == "var" {
				op := ",,"
				if e.callee == "strings.ToUpper" {
					op = "^^"
				}
				return paramCall(op, e.args[0].name)
			}
			if w, ok := foldPureLiteralCall(e.callee, e.args); ok {
				return strExpr(w)
			}
			// NON-literal operand (a closure call — the golib's own
			// foldPureLiteralCall): the native MethodCall word
			if len(e.args) == 1 {
				meth := "toLowerCase"
				if e.callee == "strings.ToUpper" {
					meth = "toUpperCase"
				}
				return map[string]any{
					"type": "MethodCall", "object": p.exprToWord(e.args[0]),
					"method": meth, "args": []any{},
				}
			}
			p.failf("%s needs (var|str) args (v2)", e.callee)
		case "strings.Contains", "strings.HasSuffix":
			if w, ok := foldPureLiteralCall(e.callee, e.args); ok {
				return strExpr(w)
			}
			// NON-literal operands (closure args — the golib's own
			// foldPureLiteralCall): the runtime strContains/strHasSuffix
			if len(e.args) == 2 {
				fn := "strContains"
				if e.callee == "strings.HasSuffix" {
					fn = "strHasSuffix"
				}
				return map[string]any{
					"type": "Call", "func": fn,
					"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
					"purity": "PureCpu",
				}
			}
			p.failf("%s needs literal args (v2)", e.callee)
		case "fmt.Sprint":
			// fmt.Sprint(args...) → echo args (space-separated, no trailing newline)
			if len(e.args) >= 1 {
				var words []map[string]any
				for _, a := range e.args {
					words = append(words, p.exprToWord(a))
				}
				return map[string]any{
					"type": "Call", "func": "exec",
					"args":   []any{strExpr("echo"), map[string]any{"type": "Array", "elements": words}},
					"purity": "Emulable",
				}
			}
			p.failf("fmt.Sprint needs at least one arg (v2)")
		case "fmt.Sprintf":
			// Sprintf over literals folds at emit time with the Go stdlib
			// (t74).
			if w, ok := foldPureLiteralCall(e.callee, e.args); ok {
				return strExpr(w)
			}
			// Var-arg Sprintf with a LITERAL format → the command-
			// substitution shape `$(printf FMT ARGS...)` —
			// capture(Arrow[exec printf …]): the value twin of the
			// fmt.Printf statement path (printfStmt delegates the same
			// format verbs to the runtime printf; t46), and the A1's
			// capture of an Emulable printf is the shell-flavored
			// formatted-string value. A NON-literal format (a var
			// format, `args...` variadics — the app's go-sh.go failf)
			// stays refused: the format string is the verb contract.
			if len(e.args) >= 2 && e.args[0].kind == "str" {
				var words []map[string]any
				words = append(words, interpLit(e.args[0].raw))
				for _, a := range e.args[1:] {
					words = append(words, p.argToWord(a))
				}
				inner := execStmt("printf", words, "Emulable")
				return map[string]any{
					"type": "Call", "func": "capture",
					"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
					"purity": "Spawn",
				}
			}
			// VAR format (`fmt.Sprintf(format, args...)` — the variadic
			// helper idiom): the runtime printf evaluates the verbs at run
			// time, so the same capture(printf) shape works with the
			// format as a getVar word and a Spread for `args...`. Caveat
			// (documented in FRONTEND.md): shell printf interprets
			// backslash escapes in the FORMAT — Go's Sprintf does not —
			// so var formats must be escape-free; %v/%t verbs render via
			// the runtime's printf verb table.
			if len(e.args) >= 2 && e.args[0].kind == "var" {
				var words []map[string]any
				// param-aware read (a param format like failf's `f`
				// rides positional $N, not the var store).
				words = append(words, p.structIDWord(e.args[0].name))
				for _, a := range e.args[1:] {
					words = append(words, p.argToWord(a))
				}
				inner := execStmt("printf", words, "Emulable")
				return map[string]any{
					"type": "Call", "func": "capture",
					"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
					"purity": "Spawn",
				}
			}
			// MEMBER format (`fmt.Sprintf(args[0].text, rest...)` — the
			// golib's own foldPureLiteralCall): the format word rides
			// exprToWord; the runtime printf evaluates it
			if len(e.args) >= 2 && (e.args[0].kind == "member" || e.args[0].kind == "fieldof" || e.args[0].kind == "index") {
				var words []map[string]any
				words = append(words, p.exprToWord(e.args[0]))
				for _, a := range e.args[1:] {
					words = append(words, p.argToWord(a))
				}
				inner := execStmt("printf", words, "Emulable")
				return map[string]any{
					"type": "Call", "func": "capture",
					"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
					"purity": "Spawn",
				}
			}
			p.failf("unsupported fmt.Sprintf form (v2) — needs (literal|var, args...) with at least one arg")
		case "strings.Split":
			if len(e.args) == 2 {
				return map[string]any{
					"type": "Call", "func": "strSplit",
					"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
					"purity": "PureCpu",
				}
			}
			p.failf("strings.Split needs (str, sep) (v2)")
		case "strconv.Itoa", "strconv.FormatInt", "strconv.FormatUint":
			// Itoa(n) / FormatInt(n, 10) → strItoa(word); a non-10 base
			// reformats digits — refuse loudly (Refuse > guess)
			if len(e.args) == 3 || len(e.args) == 2 {
				if e.args[len(e.args)-1].kind == "str" && e.args[len(e.args)-1].text != "10" {
					p.failf("%s supports base 10 only (v2)", e.callee)
				}
			}
			if len(e.args) >= 1 {
				return map[string]any{
					"type": "Call", "func": "strItoa",
					"args":   []any{p.exprToWord(e.args[0])},
					"purity": "PureCpu",
				}
			}
			p.failf("unsupported strconv call (v2)")
		case "strconv.ParseInt", "strconv.ParseFloat", "strconv.Atoi":
			if len(e.args) >= 1 {
				return map[string]any{
					"type": "Call", "func": "strAtoi",
					"args":   []any{p.exprToWord(e.args[0])},
					"purity": "PureCpu",
				}
			}
			p.failf("unsupported strconv call (v2)")
		case "strings.ContainsRune":
			if len(e.args) == 2 {
				return map[string]any{
					"type": "Call", "func": "strContainsRune",
					"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
					"purity": "PureCpu",
				}
			}
			p.failf("strings.ContainsRune needs (str, rune) (v2)")
		case "strings.LastIndex":
			if len(e.args) == 2 {
				return map[string]any{
					"type": "Call", "func": "strLastIndex",
					"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
					"purity": "PureCpu",
				}
			}
			p.failf("strings.LastIndex needs (str, str) (v2)")
		case "strings.Index":
			if len(e.args) == 2 {
				return map[string]any{
					"type": "Call", "func": "strIndex",
					"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
					"purity": "PureCpu",
				}
			}
			p.failf("strings.Index needs (str, str) (v2)")
		case "strings.TrimSpace":
			if w := p.stringsHelperWord(e); w != nil {
				return w
			}
			p.failf("unsupported strings.TrimSpace (v2)")
		case "fmt.Errorf":
			// error CONSTRUCTION: a constant message folds to its text
			// (the value rides the multi-return echo words); %-verb
			// varargs keep the printf capture shape
			if w, ok := foldPureLiteralCall("fmt.Sprintf", e.args); ok {
				return strExpr(w)
			}
			if len(e.args) >= 1 && e.args[0].kind == "str" {
				var words2 []map[string]any
				words2 = append(words2, interpLit(e.args[0].raw))
				for _, a := range e.args[1:] {
					words2 = append(words2, p.argToWord(a))
				}
				inner := execStmt("printf", words2, "Emulable")
				return map[string]any{
					"type": "Call", "func": "capture",
					"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
					"purity": "Spawn",
				}
			}
			p.failf("unsupported fmt.Errorf form (v2) — needs a literal or var format")
		}
		// USER fn / METHOD calls in word position: `p.parseExpr()`,
		// `lex(src)` — the value-return protocol (echo + capture) makes
		// the returned value a word; struct results are arena INDICES,
		// so pointer semantics ride the same channel.
		if strings.Contains(e.callee, ".") {
			dot := strings.LastIndex(e.callee, ".")
			baseName, meth := e.callee[:dot], e.callee[dot+1:]
			if rn := p.resolveVar(baseName); p.varStruct[rn] != "" && p.fnNames[meth] {
				return p.userCallWord(meth, append([]*expr{{kind: "var", name: rn}}, e.args...))
			}
			// PACKAGE MODE: `pkg.F(args)` where pkg is a package clause
			// in the concatenated source (shiremit.Emit — shir-emit-go
			// in the input) — no receiver. EXTERNAL-UNIT: `alias.F`
			// where alias imports a non-stdlib package (golib.Shir)
			// — same no-receiver shape; the sub resolves when the
			// callee's unit is linked in.
			if p.pkgNames[baseName] && p.fnNames[meth] {
				return p.userCallWord(meth, e.args)
			}
			if p.isExternalAlias(baseName) {
				return p.userCallWord(meth, e.args)
			}
		} else if p.fnNames[e.callee] {
			return p.userCallWord(e.callee, e.args)
		}
		// err.Error() — the error value's message. The A1 has no error
		// objects; an error return is dropped at the call site, so err
		// is a plain var whose value IS the message (in the expressible
		// subset it is never assigned — the error branch is dead code).
		if strings.HasSuffix(e.callee, ".Error") && len(e.args) == 0 {
			base := strings.TrimSuffix(e.callee, ".Error")
			return getVarExpr(base)
		}
		// sc.Text() inside a scanner read-loop → the read var
		if strings.HasSuffix(e.callee, ".Text") {
			base := strings.TrimSuffix(e.callee, ".Text")
			if p.stdinRdr[base] {
				return getVarExpr(base)
			}
		}
		// b.String() on a bytes.Buffer → the accumulated contents
		// (compile-time folded when ALL writes were literals)
		if strings.HasSuffix(e.callee, ".String") {
			base := strings.TrimSuffix(e.callee, ".String")
			if _, ok := p.bufs[base]; ok && !p.bufDyn[base] {
				return strExpr(p.bufs[base])
			}
			dot := strings.LastIndex(e.callee, ".")
			rn := ""
			if dot > 0 {
				rn = p.resolveVar(e.callee[:dot])
			}
			if rn != "" {
				return map[string]any{
					"type": "Call", "func": "objGet",
					"args":   []any{getVarExpr(rn), strExpr("buf")},
					"purity": "PureCpu",
				}
			}
		}
		// e.Error() on an error value — errors ARE strings in the A1
		// (the capture/exit-status channel); the method is an identity
		// read of the receiver (`fmt.Fprintln(os.Stderr, err.Error())`,
		// cpp-sh-go/cmd/main.go)
		if strings.HasSuffix(e.callee, ".Error") {
			base := strings.TrimSuffix(e.callee, ".Error")
			if rn := p.resolveVar(base); rn != "" && !strings.Contains(base, ".") {
				return getVarExpr(rn)
			}
		}
		p.failf("unsupported call %q in word position (v2)", e.callee)
	case "arraylit":
		// a slice literal as a VALUE: the plain Array word (elements
		// are words; object ids ride as strings)
		el := make([]any, len(e.elems))
		for i, w := range e.elems {
			el[i] = w
		}
		return map[string]any{"type": "Array", "elements": el}
	case "fieldof":
		// member access on a CALL RESULT (or chain): objGet over the
		// returned reference id
		base := p.valueWord(e.lhs)
		return map[string]any{
			"type": "Call", "func": "objGet",
			"args":   []any{base, strExpr(e.name)},
			"purity": "PureCpu",
		}
	case "binop", "not":
		if w, ok := p.condOperandA1Word(e); ok {
			return w
		}
		// a SINGLE comparison as a boolean VALUE (`push(tStr, "",
		// sb.String(), c == '"')`): the native A1 BinOp renders as a
		// plain JS/Perl compare — its VALUE is the verdict. AND/OR
		// compositions of calls keep refusing (status protocol)
		if e.BOpKind == "cmp" {
			op := map[string]string{"==": "Eq", "!=": "Ne", "<": "Lt",
				">": "Gt", "<=": "Le", ">=": "Ge"}[e.BOp]
			if op != "" {
				return map[string]any{
					"type": "BinOp", "op": op,
					"lhs": p.condWordAny(e.lhs),
					"rhs": p.condWordAny(e.rhs),
				}
			}
		}
		p.failf("unsupported comparison in word position (v2)")
	}
	p.failf("unsupported expression %q (v2 subset)", e.kind)
	return nil
}

// isBoolLitReturn: `return true` / `return false` in a
// bool-declared function — a STATUS-protocol predicate return like a
// comparison (`acceptPunct`'s direct-boolean callers read $?; the
// echo-only lowering left them always-true, hanging parseVarSpec's
// names loop in self-host). Gated on the declared return type so
// `return true` in an any/interface function keeps value semantics.
func (p *parser) isBoolLitReturn(e *expr) bool {
	if e.kind != "var" || (e.name != "true" && e.name != "false") {
		return false
	}
	if p.curFn == "" {
		return false
	}
	if sig, ok := p.fnSig[p.curFn]; ok && len(sig) > 1 {
		return sig[1] == "bool"
	}
	if r, ok := p.prescanRet[p.curFn]; ok {
		return r == "bool"
	}
	return false
}

// isPredicateExpr: a comparison / logical-over-comparisons expression
// (the bool result of `return <cmp>` drives the exit-status protocol).
func (p *parser) isPredicateExpr(e *expr) bool {
	switch e.kind {
	case "binop":
		if e.BOpKind == "cmp" {
			return true
		}
		if e.BOpKind == "and" || e.BOpKind == "or" {
			return p.isPredicateExpr(e.lhs) || p.isPredicateExpr(e.rhs)
		}
		return false
	case "not":
		return p.isPredicateExpr(e.lhs)
	case "call":
		// Only BOOLEAN-returning strings.* funcs are predicates;
		// string-returning funcs (ReplaceAll, TrimLeft, …) are VALUES
		boolFns := []string{"strings.Contains", "strings.HasPrefix",
			"strings.HasSuffix", "strings.ContainsAny", "strings.ContainsRune"}
		for _, bf := range boolFns {
			if e.callee == bf {
				return true
			}
		}
		return false
	}
	return false
}

// valueWord: an expression whose value is a REFERENCE ID (user-fn /
// method captures, fieldof chains, struct-typed vars) as one word.
func (p *parser) valueWord(e *expr) map[string]any {
	switch e.kind {
	case "call":
		// chr(code) — the runtime helper word (not a sub call).
		if e.callee == "chr" && len(e.args) == 1 {
			return p.exprToWord(e)
		}
		callee := e.callee
		var args []*expr
		if strings.Contains(callee, ".") {
			dot := strings.LastIndex(callee, ".")
			baseName, meth := callee[:dot], callee[dot+1:]
			rn := p.resolveVar(baseName)
			if !p.fnNames[meth] || p.varStruct[rn] == "" {
				p.failf("unsupported call %q in word position (v2)", callee)
			}
			args = append([]*expr{{kind: "var", name: rn}}, e.args...)
			callee = meth
		} else if !p.fnNames[callee] {
			p.failf("unsupported call %q in word position (v2)", callee)
		} else {
			args = e.args
		}
		return p.userCallWord(callee, args)
	case "fieldof":
		return map[string]any{
			"type": "Call", "func": "objGet",
			"args":   []any{p.valueWord(e.lhs), strExpr(e.name)},
			"purity": "PureCpu",
		}
	case "var":
		rn := p.resolveVar(e.name)
		if p.varStruct[rn] != "" {
			return p.structIDWord(e.name)
		}
		p.failf("unsupported value expression %q (v2)", e.name)
	case "index":
		return p.exprToWord(e)
	case "member":
		if w, ok := p.structMemberWord(e.name); ok {
			return w
		}
		p.failf("unsupported value expression %q (v2)", e.name)
	}
	p.failf("unsupported value expression (v2)")
	return nil
}

// foldPureLiteralCall folds a pure stdlib call over string/number
// literals at emit time, returning the Go-stdlib-exact result string.
// The frontend's literal-only contract makes this deterministic (t55,
// t57); non-literal args keep the shell-shape paths above.
func foldPureLiteralCall(callee string, args []*expr) (string, bool) {
	for _, a := range args {
		if a.kind != "str" && a.kind != "num" {
			return "", false
		}
	}
	s := func(i int) string { return args[i].text }
	switch callee {
	case "filepath.Dir":
		if len(args) == 1 {
			return filepath.Dir(s(0)), true
		}
	case "filepath.Ext":
		if len(args) == 1 {
			return filepath.Ext(s(0)), true
		}
	case "strings.TrimPrefix":
		if len(args) == 2 {
			return strings.TrimPrefix(s(0), s(1)), true
		}
	case "strings.TrimSuffix":
		if len(args) == 2 {
			return strings.TrimSuffix(s(0), s(1)), true
		}
	case "strings.ToUpper":
		if len(args) == 1 {
			return strings.ToUpper(s(0)), true
		}
	case "strings.ToLower":
		if len(args) == 1 {
			return strings.ToLower(s(0)), true
		}
	case "strings.Contains":
		if len(args) == 2 {
			return fmt.Sprintf("%t", strings.Contains(s(0), s(1))), true
		}
	case "strings.HasSuffix":
		if len(args) == 2 {
			return fmt.Sprintf("%t", strings.HasSuffix(s(0), s(1))), true
		}
	case "strings.ReplaceAll":
		if len(args) == 3 {
			return strings.ReplaceAll(s(0), s(1), s(2)), true
		}
	case "fmt.Sprintf":
		if len(args) >= 1 && args[0].kind == "str" {
			rest := make([]any, 0, len(args)-1)
			for _, a := range args[1:] {
				if a.kind == "num" {
					if n, err := strconv.ParseInt(a.text, 0, 64); err == nil {
						rest = append(rest, n)
						continue
					}
				}
				rest = append(rest, a.text)
			}
			return fmt.Sprintf(args[0].text, rest...), true
		}
	case "strings.HasPrefix":
		if len(args) == 2 {
			return fmt.Sprintf("%t", strings.HasPrefix(s(0), s(1))), true
		}
	}
	return "", false
}

// sliceWord lowers a slice expr to its A1 word JSON. A1 slice args are
// (var, start, LENGTH) — Go's [i:j] end index is EXCLUSIVE, so emit
// length = j - i (t37; matches the ${s:off:len} shape the core emits).
// Open ends: `s[:j]` starts at 0; `s[i:]` / `s[:]` carry no length (the
// runtime renders that as `v.slice(off)` — the ${s:off} shape).
//
// Computed bounds (Go index expressions) lower to the parameter-
// expansion glob ops, which are EXACT for literal needles:
//   - x[strings.LastIndex(x, n)+1:] → ${x##*n} — the longest-prefix
//     removal of `*n` strips through the LAST occurrence of n, which is
//     precisely Go's LastIndex(n)+1 tail.
//   - x[:strings.Index(x, n)] → ${x%%n*} — the longest-suffix removal
//     of `n*` strips from the FIRST occurrence of n, Go's exclusive
//     end index.
func (p *parser) sliceWord(e *expr) map[string]any {
	name := p.resolveVar(e.target.name)
	if n, ok := p.paramNumber(name); ok {
		name = strconv.Itoa(n)
	}
	// x[strings.LastIndex(x, n)+1:] → param("##", x, "*"+n)
	if e.idx2e == nil && e.idx2 == "" && e.idx1e != nil {
		if v, n, ok := p.lastIndexPlusOne(e.idx1e); ok && v == name {
			return paramCall("##", name, "*"+n)
		}
	}
	// x[:strings.Index(x, n)] → param("%%", x, n+"*")
	if e.idx1e == nil && e.idx1 == "" && e.idx2e != nil {
		if v, n, ok := p.indexCall(e.idx2e); ok && v == name {
			return paramCall("%%", name, n+"*")
		}
	}
	// GENERAL computed bounds: the runtime slice offsets/lengths are
	// arithmetic expressions (evalArith), so `src[start+1 : i]` lowers
	// to ${src:(start+1):(i)-(start+1)} — Go's exclusive end becomes a
	// LENGTH subtraction. Byte vs char: ASCII corpus equivalence holds
	// (documented caveat).
	if e.idx1e != nil || e.idx2e != nil {
		name2 := p.resolveVar(name)
		// BOUNDS EXPRESSIBLE as shell-arithmetic text → the ${v:off:len}
		// param shape. A bound reading a STRUCT FIELD (len(spec.zig) —
		// zig-sh-go's format-spec match) has no arith twin (objGet chains
		// are not evalArith operands): fall back to the strSlice runtime
		// helper, whose bounds are plain WORDS.
		offOK, lenOK := true, true
		if e.idx1e != nil && p.hasObjectRead(e.idx1e) {
			offOK = false
		}
		if e.idx2e != nil && p.hasObjectRead(e.idx2e) {
			lenOK = false
		}
		if !offOK || !lenOK {
			loW := strExpr("0")
			if e.idx1e != nil {
				loW = p.exprToWord(e.idx1e)
			} else if e.idx1 != "" {
				loW = strExpr(e.idx1)
			}
			hiW := map[string]any{
				"type": "Call", "func": "strLen",
				"args":   []any{getVarExpr(name2)},
				"purity": "PureCpu",
			}
			if e.idx2e != nil {
				hiW = p.exprToWord(e.idx2e)
			} else if e.idx2 != "" {
				hiW = strExpr(e.idx2)
			}
			return map[string]any{
				"type": "Call", "func": "strSlice",
				"args":   []any{getVarExpr(name2), loW, hiW},
				"purity": "PureCpu",
			}
		}
		off := "0"
		if e.idx1e != nil {
			off = p.arithKeyText(e.idx1e)
		} else if e.idx1 != "" {
			off = e.idx1
		}
		if e.idx2e != nil {
			length := "(" + p.arithKeyText(e.idx2e) + ")-(" + off + ")"
			return joinCall(paramCall("slice", name2, off, length))
		}
		if e.idx2 != "" {
			return joinCall(paramCall("slice", name2, off, e.idx2))
		}
		return joinCall(paramCall("slice", name2, off, ""))
	}
	lo, loErr := strconv.Atoi(e.idx1)
	hi, hiErr := strconv.Atoi(e.idx2)
	switch {
	case e.idx2 == "":
		start := e.idx1
		if e.idx1 == "" {
			start = "0"
		}
		return joinCall(paramCall("slice", name, start, ""))
	case loErr == nil && hiErr == nil:
		return joinCall(paramCall("slice", name,
			strconv.Itoa(lo), strconv.Itoa(hi-lo)))
	}
	return joinCall(paramCall("slice", name, e.idx1, e.idx2))
}

// lastIndexPlusOne: matches `strings.LastIndex(v, "n") + 1` (the Go
// idiom for "one past the last occurrence") → (v, n).
func (p *parser) lastIndexPlusOne(e *expr) (string, string, bool) {
	if e == nil || e.kind != "add" || e.op != "+" {
		return "", "", false
	}
	if e.rhs == nil || e.rhs.kind != "num" || e.rhs.text != "1" {
		return "", "", false
	}
	if e.lhs == nil || e.lhs.kind != "call" || e.lhs.callee != "strings.LastIndex" {
		return "", "", false
	}
	// (same (var, str) arg shape as Index)
	if len(e.lhs.args) != 2 || e.lhs.args[0].kind != "var" || e.lhs.args[1].kind != "str" {
		return "", "", false
	}
	return e.lhs.args[0].name, e.lhs.args[1].text, true
}

// indexCall: matches `strings.Index(v, "n")` → (v, n). Literal n only —
// a glob-metachar needle would change meaning under the `%`/`#` ops.
func (p *parser) indexCall(e *expr) (string, string, bool) {
	if e == nil || e.kind != "call" || e.callee != "strings.Index" {
		return "", "", false
	}
	if len(e.args) != 2 || e.args[0].kind != "var" || e.args[1].kind != "str" {
		return "", "", false
	}
	return e.args[0].name, e.args[1].text, true
}

// arithOrConcat: `+` chains involving a string (literal, Str-typed var,
// index/param — anything non-numeric) → concat Interpolate, flattening
// the whole add chain into parts; otherwise (and all * / -) → Arith.
func (p *parser) arithOrConcat(e *expr) map[string]any {
	// object-field reads inside arithmetic: plain Arith vars cannot
	// address them — lower to the runtime num_* call tree
	if p.hasObjectRead(e) {
		if e.kind == "add" && p.addHasString(e) {
			var parts []any
			p.addConcatParts(e, &parts)
			return interpParts(parts)
		}
		return p.arithNumCalls(e)
	}
	if e.kind == "add" && p.addHasString(e) {
		var parts []any
		p.addConcatParts(e, &parts)
		return interpParts(parts)
	}
	return arithWrap(p.exprToArith(e))
}

// addHasString: does this add chain involve a string anywhere? (An
// `a[0] + " " + a[1]` chain has no direct string operand at the top
// level, so a shallow check misses it.)
func (p *parser) addHasString(e *expr) bool {
	switch e.kind {
	case "add":
		// nil-guard: a malformed/degenerate add node (nil side) must
		// not crash the parser — treat the missing side as non-string
		if e.rhs != nil && p.addHasString(e.rhs) {
			return true
		}
		return e.lhs != nil && p.addHasString(e.lhs)
	case "str", "rawstr":
		return true
	case "var":
		return e.name == "nil" || p.varTypes[p.resolveVar(e.name)] == "Str"
	}
	return false
}

// addConcatParts: flatten a concat chain into parts; a sub-chain that
// is itself pure arithmetic stays a single expr part (its Arith value).
func (p *parser) addConcatParts(e *expr, parts *[]any) {
	if e.kind == "add" && p.addHasString(e) {
		if e.lhs != nil {
			p.addConcatParts(e.lhs, parts)
		}
		if e.rhs != nil {
			p.addConcatParts(e.rhs, parts)
		}
		return
	}
	*parts = append(*parts, p.concatPart(e))
}

func (p *parser) concatPart(e *expr) any {
	switch e.kind {
	case "str":
		return partLit(e.text)
	case "num":
		return partLit(e.text)
	default:
		return partExpr(p.exprToWord(e))
	}
}

// operandKind: "str" for string literals and Str-typed vars, "int" for
// numeric operands.
func (p *parser) operandKind(e *expr) string {
	switch e.kind {
	case "str", "rawstr":
		return "str"
	case "num":
		return "int"
	case "var":
		if e.name == "nil" {
			return "str"
		}
		switch p.varTypes[p.resolveVar(e.name)] {
		case "Str":
			return "str"
		case "Int":
			return "int"
		}
		return "int"
	}
	return "int"
}

// arithKeyText renders an index expression as SHELL ARITHMETIC text for
// computed subscripts (`arr[$i]`, `toks[$p + $off]`) — the runtime
// evaluates subscript/slice-offset text with evalArith ($name reads the
// store; ${#a[@]} is the length). Only the numeric subset lowers; a
// string operand refuses loudly.
func (p *parser) arithKeyText(e *expr) string {
	switch e.kind {
	case "num":
		return e.text
	case "var":
		name := p.resolveVar(e.name)
		if n, ok := p.paramNumber(name); ok {
			return "$" + strconv.Itoa(n)
		}
		return "$" + name
	case "add", "mul":
		return "(" + p.arithKeyText(e.lhs) + e.op + p.arithKeyText(e.rhs) + ")"
	case "neg":
		return "(-" + p.arithKeyText(e.lhs) + ")"
	case "arrlen":
		if e.target != nil && e.target.kind == "var" {
			return "${#" + p.resolveVar(e.target.name) + "[@]}"
		}
	case "strlen":
		if e.target != nil && e.target.kind == "var" {
			return "${#" + p.resolveVar(e.target.name) + "}"
		}
	}
	p.failf("unsupported index expression (v2): %s", e.kind)
	return ""
}

func (p *parser) exprToArith(e *expr) map[string]any {
	switch e.kind {
	case "num":
		if n, err := strconv.Atoi(e.text); err == nil {
			return arithNum(n)
		}
		p.failf("non-integer numeric literal %q (v2)", e.text)
	case "var":
		name := p.resolveVar(e.name)
		if n, ok := p.paramNumber(name); ok {
			return arithVar(strconv.Itoa(n))
		}
		return arithVar(name)
	case "add", "mul":
		// nil-guard: a degenerate add/mul node (missing side) must
		// failf cleanly, not crash the parser
		if e.lhs == nil || e.rhs == nil {
			p.failf("malformed arithmetic node (nil operand) (v2)")
		}
		return arithBin(p.exprToArith(e.lhs), e.op, p.exprToArith(e.rhs))
	case "neg":
		return arithBin(arithNum(0), "-", p.exprToArith(e.lhs))
	case "str":
		if n, err := strconv.Atoi(e.text); err == nil {
			return arithNum(n)
		}
	case "strlen":
		// len(s) over a STRING in arithmetic — the ${#s} length read
		// (getVar("#s") counts chars/bytes; a param maps to its $N
		// positional — the dogfood app's own `i < len(src)` lexer loops)
		if e.target != nil && e.target.kind == "var" {
			return arithVar("#" + p.paramName(e.target.name))
		}
	case "arrlen":
		if e.target != nil && e.target.kind == "var" {
			// len(arr) over an ARRAY in arithmetic — the `#arr` length
			// read (getVar("#arr") → arrayLen; mirrors the strlen case
			// above, which uses the same `#name` form for scalar char
			// count). The bash `${#arr[@]}` shape is ONLY valid inside a
			// quoted word/template string (the runtime pre-processes it
			// there) — used as an A1 Var name in arithmetic it is read
			// back literally and yields the empty string, which is the
			// dogfood app's `len(filtered) < 2` argv-gate bug.
			if p.varTypes[p.resolveVar(e.target.name)] == "ListRef" {
				return map[string]any{
					"type": "Call", "func": "listLen",
					"args":   []any{p.exprToWord(e.target)},
					"purity": "PureCpu",
				}
			}
			return arithVar("#" + p.paramName(e.target.name))
		}
	}
	if e.kind == "call" && e.callee == "chr" && len(e.args) == 1 {
		// chr(code) in arithmetic is the code itself.
		return p.exprToArith(e.args[0])
	}
	p.failf("non-numeric operand in arithmetic (v2): %s", e.kind)
	return nil
}

func (p *parser) exprToArrayElem(e *expr) map[string]any {
	switch e.kind {
	case "str", "num", "var":
		return p.exprToWord(e)
	case "call", "structlit", "fieldof", "index", "maplit", "member", "strlen", "arrlen":
		// object ids / captures / whole-dict values ride as words;
		// member/strlen/arrlen lower to native read calls that coerce at
		// the boundary (`[]any{st.idw, st.fld, vw}` — go-sh.go's own
		// multi-target restore builds slice literals from field reads)
		// object ids / captures ride the element channel as words
		return p.exprToWord(e)
	case "char":
		// a Go rune literal element — its ASCII code (the golib's
		// `[]byte{'\\n'}` newline terminators)
		return strExpr(charCode(e))
	default:
		// a call/structlit/arrlit element (the golib's A1 builders'
		// `[]any{strExpr(name)}`) — the lowered word (a JSON fragment).
		return p.exprToWord(e)
	}
}

func (p *parser) switchPattern(e *expr) string {
	switch e.kind {
	case "str", "num", "var":
		// a VAR that is a compile-time constant folds to its value
		// (the token-kind consts `tNum`/`tStr`/… in `switch t.kind`
		// case labels — a raw name would compare the discriminant
		// against the literal string "tNum" and never match).
		if e.kind == "var" {
			if n, ok := p.consts[e.name]; ok {
				return strconv.Itoa(n)
			}
			if s, ok := p.constStrs[e.name]; ok {
				return s
			}
		}
		return e.text
	case "char":
		// a Go rune literal is an INTEGER — its ASCII code (the golib's
		// `switch raw[i] { case 'n': ... }` escape decoder).
		return charCode(e)
	}
	p.failf("unsupported case pattern (v2)")
	return ""
}

// ── condition lowering ──────────────────────────────────────────────

// hasMemberCall — does the expr contain a member-on-call (`p.tok().kind`)?
func (p *parser) hasMemberCall(e *expr) bool {
	// ITERATIVE (no recursion): recursive bool calls echo for the value
	// protocol, clobbering exit status so direct-if callers always saw
	// true self-hosted (every comparison took the member-hoist branch).
	// Explicit stack with pure ops only (no echoing calls) keeps status
	// clean; nil links are skipped explicitly (nil != "" compares).
	if e == nil {
		return false
	}
	// Worklist of pending subtrees (append-only; nil links are never
	// pushed so no nil-deref can occur below).
	var stack []*expr
	if e != nil {
		stack = append(stack, e)
	}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if n.kind == "member" && n.memberTarget != nil {
			return true
		}
		if n.lhs != nil {
			stack = append(stack, n.lhs)
		}
		if n.rhs != nil {
			stack = append(stack, n.rhs)
		}
		if n.target != nil {
			stack = append(stack, n.target)
		}
		if n.idx1e != nil {
			stack = append(stack, n.idx1e)
		}
		if n.idx2e != nil {
			stack = append(stack, n.idx2e)
		}
	}
	return false
}

// hoistMemberCalls — rewrite member-on-call exprs to temp-var jsonGet
// reads, emitting the assign-capture into pre (the cond's BinOp And
// chain runs the assigns before the test).
func (p *parser) hoistMemberCalls(e *expr, pre *[]map[string]any) *expr {
	if e == nil {
		return nil
	}
	if e.kind == "member" && e.memberTarget != nil {
		tmp := fmt.Sprintf("__t%d", p.tmpSeq)
		p.tmpSeq++
		field := strings.TrimPrefix(e.name, ".")
		capture := p.exprToWord(e.memberTarget) // the method-call capture
		*pre = append(*pre, map[string]any{
			"type": "Call", "func": "assign",
			"args":   []any{strExpr(tmp), strExpr("="), capture},
			"purity": "Emulable",
		})
		return &expr{kind: "member", name: tmp + "." + field}
	}
	e.lhs = p.hoistMemberCalls(e.lhs, pre)
	e.rhs = p.hoistMemberCalls(e.rhs, pre)
	e.target = p.hoistMemberCalls(e.target, pre)
	e.idx1e = p.hoistMemberCalls(e.idx1e, pre)
	e.idx2e = p.hoistMemberCalls(e.idx2e, pre)
	return e
}

func (p *parser) condToJSON(c *expr) map[string]any {
	if c.kind == "cond" {
		return testCall(c.text)
	}
	if c.kind == "rawjson" {
		return c.rawJSON
	}
	// a comparison with a member-on-call operand (`p.tok().kind ==
	// tNL` — the golib's parser methods): hoist the method call into a
	// temp via the assign-capture, then test the temp's field — the
	// BinOp And of the assign and the test (the assign runs as part of
	// the cond; the And's status is the test's).
	if c.kind == "binop" && c.BOpKind == "cmp" {
		if p.hasMemberCall(c.lhs) || p.hasMemberCall(c.rhs) {
			var pre []map[string]any
			l := p.hoistMemberCalls(c.lhs, &pre)
			r := p.hoistMemberCalls(c.rhs, &pre)
			// the rewritten comparison
			test := testCall(p.condTestString(&expr{kind: "binop", BOp: c.BOp, BOpKind: "cmp", lhs: l, rhs: r}))
			// chain the pre-assigns with the test via And
			out := test
			for i := len(pre) - 1; i >= 0; i-- {
				out = map[string]any{
					"type": "BinOp", "op": "And",
					"lhs": pre[i], "rhs": out,
				}
			}
			return out
		}
	}
	// a bool-returning function call in a condition (the golib's
	// `isIdentPart(src[i])`): capture the function's echoed
	// "true"/"false" into a temp, then test it — the BinOp And of the
	// assign-capture and the test (the assign runs as part of the cond;
	// the And's status is the test's).
	// only USER-DEFINED functions AND methods (stdlib strings.* has
	// specific glob-test lowering below).
	if c.kind == "call" {
		fn := c.callee
		rec := ""
		if i := strings.LastIndex(fn, "."); i > 0 {
			if p.varTypes[p.resolveVar(fn[:i])] == "Struct" {
				// a METHOD call (`p.atPunct("(")`) — the receiver passed
				// by name, the method name in fnNames.
				rec = p.resolveVar(fn[:i])
				fn = fn[i+1:]
			}
		}
		if p.fnNames[fn] {
			// UNIVERSAL user-call condition (no callee knowledge —
			// forward refs and mutual recursion included): exec with
			// stdout captured; verdict = status 0 AND (silent OR
			// "true"). Status-only predicate bodies (Return 0/1,
			// silent) satisfy the first two; echoing bool bodies
			// (`return ok` → "true"/"false") the first and third. The
			// old capture-only shape read "" for predicates (always
			// false); a status-only shape would miss echoing bodies.
			// A1 assign leaves lastExit as the capture body's end
			// status.
			var words []map[string]any
			if rec != "" {
				// the receiver rides as $1 — its VALUE (the object id /
				// positional), not the literal name (a literal "p"
				// would objGet("p", …) → empty — the method body's
				// field reads all resolve to "").
				words = append(words, p.structIDWord(rec))
			}
			for _, a := range c.args {
				words = append(words, p.exprToWord(a))
			}
			tmp := fmt.Sprintf("__rc_%d", p.tmpSeq)
			p.tmpSeq++
			p.registerVar(tmp, "Str")
			inner := execStmt(fn, words, "Spawn")
			capW := map[string]any{
				"type": "Call", "func": "capture",
				"args":   []any{map[string]any{"type": "Arrow", "body": []any{inner}}},
				"purity": "Spawn",
			}
			assignC := map[string]any{
				"type": "Call", "func": "assign",
				"args":   []any{strExpr(tmp), strExpr("="), capW},
				"purity": "Emulable",
			}
			orEmptyTrue := map[string]any{
				"type": "BinOp", "op": "Or",
				"lhs":  testCall("\"$" + tmp + "\"=\"\""),
				"rhs":  testCall("\"$" + tmp + "\"=\"true\""),
			}
			return map[string]any{
				"type": "BinOp", "op": "And",
				"lhs": assignC,
				"rhs": map[string]any{
					"type": "BinOp", "op": "And",
					"lhs":  testCall(`"$?"=="0"`),
					"rhs":  orEmptyTrue,
				},
			}
		}
	}
	if c.kind == "not" {
		// `!(...)`: object/native reads AND predicate exec-calls are
		// native VALUES (exec yields boolean success), so BinOp Not
		// (!expr) is faithful; plain [ ]-test conds keep the "! " form
		if inner := p.condToJSON(c.lhs); inner != nil {
			t := inner["type"]
			fn := ""
			if tf, ok := inner["func"].(string); ok {
				fn = tf
			}
			native := t == "BinOp" || t == "MethodCall" || t == "Var" || (t == "Call" && fn != "test")
			if native {
				return map[string]any{
					"type": "BinOp", "op": "Not",
					"lhs": inner, "rhs": strExpr(""),
				}
			}
			if s := p.safeCondTestString(c.lhs); s != "" {
				return testCall("! " + strings.TrimSpace(s))
			}
		}
		return testCall("! " + strings.TrimSpace(p.condTestString(c.lhs)))
	}
	// OBJECT/NATIVE equality: BOTH operands lower to A1 words (slices,
	// struct fields, helper calls — condOperandA1Word's vocabulary) —
	// compare natively (BinOp Eq/Ne over the words; the runtime string-
	// compares the values). zig-sh-go's `inner[i:i+len(spec.zig)] ==
	// spec.zig` format-spec match: the slice word evaluates to the
	// sliced text. Placed BEFORE the And/Or arms so compound guards
	// with a sliced leaf lower natively too (condSideJSON routes here).
	if c.kind == "binop" && (c.BOp == "==" || c.BOp == "!=") {
		lw, ok1 := p.condOperandA1Word(c.lhs)
		rw, ok2 := p.condOperandA1Word(c.rhs)
		if ok1 && ok2 {
			op := "Eq"
			if c.BOp == "!=" {
				op = "Ne"
			}
			return map[string]any{
				"type": "BinOp", "op": op,
				"lhs": lw, "rhs": rw,
			}
		}
	}
	if c.kind == "binop" && c.BOpKind == "and" {
		return map[string]any{
			"type": "BinOp", "op": "And",
			"lhs": p.condSideJSON(c.lhs), "rhs": p.condSideJSON(c.rhs),
		}
	}
	if c.kind == "binop" && c.BOpKind == "or" {
		return map[string]any{
			"type": "BinOp", "op": "Or",
			"lhs": p.condSideJSON(c.lhs), "rhs": p.condSideJSON(c.rhs),
		}
	}
	// strings.Contains(s, p) → the `[[ $s == *p* ]]` glob-test shape —
	// the HasPrefix/Suffix precedent (`"$s"=h*`): operand quoted, the
	// pattern bare so the glob engine sees it (t68). The `test` call
	// records its verdict in sh2.lastExit, so it works as a BinOp
	// And/Or operand too; the `contains` call (PureCpu → native
	// String.includes) does NOT set lastExit, and the core's native
	// &&/|| lowering of a pure operand branches on the STALE status —
	// t68 was silently dropping the `alt2` branch.
	// PREDICATE calls (`isIdentPart(src[i])`, `p.atBoundary()`): a
	// bool-returning sub's verdict rides the EXIT STATUS protocol —
	// exec the call as the If/While condition itself.
	if c.kind == "call" && p.callTargetName(c.callee) != "" {
		calleeName := p.callTargetName(c.callee)
		var words []map[string]any
		if dot := strings.LastIndex(c.callee, "."); dot >= 0 {
			rn := p.resolveVar(c.callee[:dot])
			words = append(words, p.structIDWord(c.callee[:dot]))
			_ = rn
		}
		for _, a := range c.args {
			words = append(words, p.argToWord(a))
		}
		return map[string]any{
			"type": "Call", "func": "exec",
			"args":   []any{strExpr(calleeName), map[string]any{"type": "Array", "elements": words}},
			"purity": "Spawn",
		}
	}
	// DirEntry.IsDir() on an os.ReadDir loop var (`if e.IsDir() || …`,
	// the go-sh CLI's dir-filter loop): the `-d dir/name` test — Go's
	// IsDir ≡ exists AND directory (the exact bash -d semantics, same
	// as the os.Stat arm). The dir fragment comes from readDirVars
	// tracking; a non-var entry refuses loudly (Refuse > guess).
	if c.kind == "call" && strings.HasSuffix(c.callee, ".IsDir") {
		base := strings.TrimSuffix(c.callee, ".IsDir")
		if dt, ok := p.readDirVars[p.resolveVar(base)]; ok {
			return testCall("-d \"" + dt + "/$" + p.resolveVar(base) + "\"")
		}
	}
	// strings.ContainsRune(set, c) as a whole condition — a char-set
	// membership test (`if strings.ContainsRune("=+-*/...", rune(c))`,
	// zig-sh-go's lexer): the quoted set against the `*$c*` glob —
	// bash expands $c inside [[ ]] patterns, so this is exactly
	// Go's rune-membership for single-char needles.
	if c.kind == "call" && c.callee == "strings.ContainsRune" && len(c.args) == 2 {
		set := ""
		switch c.args[0].kind {
		case "str", "rawstr":
			set = c.args[0].text
		case "var":
			set = "$" + p.resolveVar(c.args[0].name)
		default:
			p.failf("strings.ContainsRune set must be str|var (v2)")
		}
		needle := ""
		switch c.args[1].kind {
		case "var":
			needle = "$" + p.resolveVar(c.args[1].name)
		case "str", "num":
			needle = c.args[1].text
		default:
			p.failf("strings.ContainsRune needle must be var|conversion (v2)")
		}
		return testCall("\"" + set + "\"=*" + needle + "*")
	}
	// strings.ContainsAny(s, cutset) as a condition — the runtime
	// strContainsAny membership test (`!strings.ContainsAny(mapName,
	// "#%/")`, posix-sh-go)
	if c.kind == "call" && c.callee == "strings.ContainsAny" && len(c.args) == 2 {
		return map[string]any{
			"type": "Call", "func": "strContainsAny",
			"args":   []any{p.exprToWord(c.args[0]), p.exprToWord(c.args[1])},
			"purity": "PureCpu",
		}
	}
	// strings.ContainsAny(s, cutset) — runtime strContainsAny membership
	if c.kind == "call" && c.callee == "strings.ContainsAny" && len(c.args) == 2 {
		return map[string]any{
			"type": "Call", "func": "strContainsAny",
			"args":   []any{p.exprToWord(c.args[0]), p.exprToWord(c.args[1])},
			"purity": "PureCpu",
		}
	}
	// strings.ReplaceAll(s, old, new) — the runtime strReplaceAll
	if c.kind == "call" && c.callee == "strings.ReplaceAll" && len(c.args) == 3 {
		return map[string]any{
			"type": "Call", "func": "strReplaceAll",
			"args":   []any{p.exprToWord(c.args[0]), p.exprToWord(c.args[1]), p.exprToWord(c.args[2])},
			"purity": "PureCpu",
		}
	}
	if c.kind == "call" && c.callee == "strings.Contains" {
		if len(c.args) != 2 || c.args[1].kind != "str" {
			p.failf("strings.Contains needs (haystack, str needle) (v2)")
		}
		hk := c.args[0].kind
		if hk != "var" && hk != "str" && hk != "num" {
			// a MEMBER/slice haystack (`strings.Contains(e.callee, ".")`
			// — the golib's own dotted-name guards): the runtime
			// strContains over the word
			return map[string]any{
				"type": "Call", "func": "strContains",
				"args":   []any{p.exprToWord(c.args[0]), strExpr(c.args[1].text)},
				"purity": "PureCpu",
			}
		}
		return testCall(p.condOperandQ(c.args[0]) + "=*" + c.args[1].text + "*")
	}
	// COMPARISON over OBJECT reads (`l.cur().kind != "eof"`): the
	// native A1 BinOp — runtime values are words, so Eq/Ne render as
	// plain JS ==/!=. Plain store-var operands keep the [ ] test shapes.
	if c.kind == "binop" && c.BOpKind == "cmp" {
		// NUMERIC comparisons (`i < len(src)`, `i+1 >= len(p.toks)`): the
		// native BinOp Lt renders as JS `<` — a STRING comparison
		// (`"2" < "112"` is false lexicographically). Go's < <= > >= are
		// always numeric, so NUMERIC-typed operands lower as numeric
		// words (arith nodes → Number(...); num_* calls for object
		// reads) — the dogfood app's own `for i < len(src)` lexer loops.
		// CHAR comparisons (`ch >= '0'`) stay STRING comparisons: single
		// ASCII chars compare by code point exactly like Go's bytes.
		if c.BOp == "<" || c.BOp == "<=" || c.BOp == ">" || c.BOp == ">=" {
			if p.isNumericCmpOperand(c.lhs) && p.isNumericCmpOperand(c.rhs) {
				op := map[string]string{"<": "Lt", ">": "Gt", "<=": "Le", ">=": "Ge"}[c.BOp]
				return map[string]any{
					"type": "BinOp", "op": op,
					"lhs": p.numericWord(c.lhs), "rhs": p.numericWord(c.rhs),
				}
			}
		}
		lw, lok := p.condOperandA1Word(c.lhs)
		rw, rok := p.condOperandA1Word(c.rhs)
		op := map[string]string{"==": "Eq", "!=": "Ne"}[c.BOp]
		if op != "" && (lok || rok) {
			// at least one operand is an OBJECT/strlen/index read: the
			// whole comparison lowers as a native BinOp (plain operands
			// render as ordinary store words)
			if !lok {
				lw = p.condWordAny(c.lhs)
			}
			if !rok {
				rw = p.condWordAny(c.rhs)
			}
			return map[string]any{
				"type": "BinOp", "op": op,
				"lhs": lw, "rhs": rw,
			}
		}
	}
	// strings.* PURE helpers in condition position (`strings.TrimSpace(b.buf)
	// == ""`) — native MethodCall words (JS String.prototype twins)

	// strings.* PURE helpers as whole conditions (`if strings.TrimSpace(x) != ""`
	// folded forms / direct truthy use): the native MethodCall word coerces
	if c.kind == "call" {
		if w := p.stringsHelperWord(c); w != nil {
			return w
		}
	}
	// TRUTHY object/map reads as whole conditions (`exprBoundary[t.text]`,
	// `p.maps[name]`): non-empty = true (JS coercion; Go map lookups
	// yield their zero value when absent — equivalent for the corpus)
	if c.kind == "index" || c.kind == "member" || c.kind == "fieldof" {
		if w, ok := p.condOperandA1Word(c); ok {
			return w
		}
	}
	// strings.HasPrefix(s, p) / strings.HasSuffix(s, p) → the `[[ $s ==
	// p* ]]` / `[[ $s == *p ]]` glob-test shape (the core's `$s==p*`
	// string; the operand stays quoted, the pattern bare so the glob
	// engine sees it — t68). The golib's lexer uses a SLICE haystack and
	// a VAR pattern (`strings.HasPrefix(src[i:], op)`), both supported.
	if c.kind == "call" && (c.callee == "strings.HasPrefix" || c.callee == "strings.HasSuffix") {
		// non-var haystacks (`src[i:]` slices, object reads): the native
		// strHasPrefix/strHasSuffix calls over arbitrary words
		if len(c.args) == 2 && c.args[0].kind != "var" {
			fn := "strHasPrefix"
			if c.callee == "strings.HasSuffix" {
				fn = "strHasSuffix"
			}
			// returning from condToJSON directly — the payload IS the cond
			return map[string]any{
				"type": "Call", "func": fn,
				"args":   []any{p.exprToWord(c.args[0]), p.exprToWord(c.args[1])},
				"purity": "PureCpu",
			}
		}
		if len(c.args) != 2 || c.args[0].kind != "var" {
			p.failf("%s needs (var|slice, str|var) (v2)", c.callee)
		}
		hay := p.condOperandQ(c.args[0])
		pat := ""
		switch c.args[1].kind {
		case "str":
			pat = c.args[1].text
		case "var":
			// a VAR pattern (`op` — the loop var; the golib's
			// `strings.HasPrefix(src[i:], op)`)
			pat = `"$` + p.resolveVar(c.args[1].name) + `"`
		default:
			p.failf("%s pattern must be literal/var (v2)", c.callee)
		}
		if c.callee == "strings.HasSuffix" {
			pat = "*" + pat
		} else {
			pat = pat + "*"
		}
		return testCall(hay + "=" + pat)
	}
	// a bare map-index / struct-member used as a TRUTHINESS (the golib's
	// `exprBoundary[t.text]` / `t.kind` conditions): the value's boolean
	// reading — `"$(sh2.assocGet …)"="true"` / `"$(sh2.jsonGet …)"="true"`
	// (Go maps/fields carry true/false values; the runtime resolves dotted
	// member keys via the nested cmdsub handler).
	if c.kind == "index" && c.target != nil && c.target.kind == "var" && p.maps[c.target.name] {
		key := ""
		if c.idx1e != nil {
			if c.idx1e.kind == "member" {
				key = `$(sh2.jsonGet(` + strings.TrimPrefix(c.idx1e.name, ".") + `))`
			} else if off := p.condTestText(c.idx1e); off != "" {
				key = off
			} else {
				p.failf("map-index cond key must be member/literal (v2)")
			}
		} else {
			key = c.idx1
		}
		return testCall(`"$(sh2.assocGet(` + p.resolveVar(c.target.name) + `, ` + key + `))"="true"`)
	}
	if c.kind == "member" && c.memberTarget == nil {
		if i := strings.LastIndex(c.name, "."); i > 0 {
			return testCall(`"$(sh2.jsonGet(` + p.resolveVar(c.name[:i]) + `, ` + c.name[i+1:] + `))"="true"`)
		}
	}
	return testCall(p.condTestString(c))
}

// assocHasCall — `Call{func:"assocHas", args:[Str(map), <key-word>]}` — the
// presence check (the golib's `_, ok := m[k]` if-inits); the key word is
// resolved at runtime (expandWord handles member/call cmdsubs).
func assocHasCall(name string, key map[string]any) map[string]any {
	return map[string]any{
		"type": "Call", "func": "assocHas",
		"args":   []any{strExpr(name), key},
		"purity": "PureCpu",
	}
}

// condTestText — a bare value as a cmdsub key/name (var/num/str without
// quotes — the runtime resolves them by name).
func (p *parser) condTestText(e *expr) string {
	switch e.kind {
	case "var":
		return p.resolveVar(e.name)
	case "num", "str":
		return e.text
	}
	return ""
}

// condTestString renders a comparison as the core's [ ] argument string
// (the `"$X"="1"` / `1 -lt 2` / ` -z "$X"` shapes).
func (p *parser) condTestString(c *expr) string {
	if c.kind == "call" {
		// recover() inside a defer — the caught value
		if c.callee == "recover" {
			p.deferUsedRcv = true
			if p.deferRecover != "" {
				return `"$` + p.deferRecover + `"`
			}
		}
		// strings PREDICATES as [ ]-test strings — the condToJSON shapes
		// (HasSuffix → "$s"=*.go etc.), so a `!`-wrapped predicate
		// (`if !strings.HasSuffix(n, ".go")`, the go-sh CLI's filter
		// loop) negates with the plain "! " test prefix instead of
		// dying on "unsupported condition: call". Non-var/literal
		// operands fall through to the failure below.
		switch c.callee {
		case "strings.HasPrefix", "strings.HasSuffix":
			if len(c.args) == 2 && c.args[0].kind == "var" && c.args[1].kind == "str" {
				pat := c.args[1].text
				if c.callee == "strings.HasSuffix" {
					pat = "*" + pat
				} else {
					pat = pat + "*"
				}
				return p.condOperandQ(c.args[0]) + "=" + pat
			}
		case "strings.Contains":
			if len(c.args) == 2 && c.args[1].kind == "str" {
				return p.condOperandQ(c.args[0]) + "=*" + c.args[1].text + "*"
			}
		}
	}
	if c.kind == "cond" {
		return c.text
	}
	if c.kind == "not" {
		return "! " + strings.TrimSpace(p.condTestString(c.lhs))
	}
	// a bare BOOL var (the comma-ok `if ok {` idiom): the stored textual
	// "true"/"false" compared against "true"
	if c.kind == "var" && p.varTypes[p.resolveVar(c.name)] == "Bool" {
		return `"` + p.condVarRef(c.name) + `"="true"`
	}
	if c.kind != "binop" {
		if c.kind == "var" {
			// bare VAR condition (the `if ok {` idiom): non-empty =
			// truthy — matches Go's bool semantics for the "true"/""
			// strings the lowering produces
			return "-n \"" + p.condVarRef(c.name) + "\""
		}
		p.failf("unsupported condition (v2): %s", c.kind)
	}
	l, r := c.lhs, c.rhs
	// err == nil / err != nil → $? tests
	if l.kind == "var" && l.name == "err" && r.kind == "var" && r.name == "nil" {
		if c.BOp == "==" {
			return `"$?" -eq 0`
		}
		return `"$?" -ne 0`
	}
	ls, rs := p.condOperandQ(l), p.condOperandQ(r)
	switch c.BOp {
	case "==":
		if r.kind == "str" && r.text == "" {
			return " -z " + p.condOperandArg(l)
		}
		return ls + "=" + rs
	case "!=":
		if r.kind == "str" && r.text == "" {
			return " -n " + p.condOperandArg(l)
		}
		return ls + "!=" + rs
	case "<":
		// STRING comparison (`[ "$a" < "$b" ]` — the runtime's test
		// evaluates < > lexicographically, matching Go's byte semantics
		// for single ASCII chars; `-lt` is numeric-only and intCmp on a
		// non-numeric operand mis-lowered the dogfood lexer's char tests).
		return p.condOperandArg(l) + " < " + p.condOperandArg(r)
	case "<=":
		return "! " + p.condOperandArg(l) + " > " + p.condOperandArg(r)
	case ">":
		return p.condOperandArg(l) + " > " + p.condOperandArg(r)
	case ">=":
		return "! " + p.condOperandArg(l) + " < " + p.condOperandArg(r)
	}
	p.failf("unsupported comparison %q (v2)", c.BOp)
	return ""
}

// condWordAny: the permissive fallback — any condition operand as an
// A1 word (plain vars/literals included).
func (p *parser) condWordAny(e *expr) map[string]any {
	if w, ok := p.condOperandA1Word(e); ok {
		return w
	}
	switch e.kind {
	case "char":
		// a Go rune literal as a comparison operand (`c == '\t'` — the
		// golib's own lexer switch): same convention as condOperandQ —
		// the byte's numeric-string code (byteAt renders the code, so
		// the test compares code vs code)
		return strExpr(charCode(e))
	case "var":
		name := p.resolveVar(e.name)
		if n, ok := p.paramNumber(name); ok {
			return getVarExpr(strconv.Itoa(n))
		}
		return getVarExpr(name)
	case "str", "rawstr":
		// rawstr: backtick literal, content verbatim (see condOperandQ)
		return strExpr(e.text)
	case "num":
		return strExpr(e.text)
	case "arrlen", "strlen":
		// len(...) in a comparison operand — the ${#arr[@]} / ${#s}
		// length word as an A1 word
		if e.target != nil && e.target.kind == "var" {
			// SLICE-param len (list id): listLen in a cmdsub (the
			// positional array-length word would read $N as an array).
			rn := p.resolveVar(e.target.name)
			if e.kind == "arrlen" && (p.paramSlice[e.target.name] || p.paramSlice[rn]) {
				if n, ok := p.paramNumber(rn); ok {
					return map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{getVarExpr(strconv.Itoa(n))},
						"purity": "PureCpu",
					}
				}
				if n, ok := p.paramNumber(e.target.name); ok {
					return map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{getVarExpr(strconv.Itoa(n))},
						"purity": "PureCpu",
					}
				}
			}
			name := p.paramName(e.target.name)
			if e.kind == "arrlen" {
				// SLICE-param len (list id) — listLen, not the
				// positional array-length word.
				rn := p.resolveVar(e.target.name)
				if p.paramSlice[e.target.name] || p.paramSlice[rn] {
					if n, ok := p.paramNumber(rn); ok {
						return map[string]any{
							"type": "Call", "func": "listLen",
							"args":   []any{getVarExpr(strconv.Itoa(n))},
							"purity": "PureCpu",
						}
					}
					if n, ok := p.paramNumber(e.target.name); ok {
						return map[string]any{
							"type": "Call", "func": "listLen",
							"args":   []any{getVarExpr(strconv.Itoa(n))},
							"purity": "PureCpu",
						}
					}
				}
				return joinCall(paramCall("slice", "#"+name, "@", ""))
			}
			return getVarExpr("#" + name)
		}
		if w, tag := p.structFieldWord(e.target.name); e.target != nil && w != nil {
			fn := "strLen"
			if e.kind == "arrlen" || tag == "list" {
				fn = "listLen"
			}
			return map[string]any{
				"type": "Call", "func": fn,
				"args":   []any{w},
				"purity": "PureCpu",
			}
		}
	case "member":
		if w, ok := p.structMemberWord(e.name); ok {
			return w
		}
	case "call":
		// a pure call as a comparison operand (`os.Getenv("X") != ""`
		// — the golib's own PANICSTACK guard): the word form
		if w := p.exprToWord(e); w != nil {
			return w
		}
	case "add", "mul", "neg":
		return arithWrap(p.exprToArith(e))
	}
	p.failf("unsupported comparison operand (v2): %s", e.kind)
	return nil
}

// condSideJSON: an And/Or operand — compound conditions recurse through
// condToJSON; plain vars/literals become truthy words (condWordAny).
func (p *parser) condSideJSON(c *expr) map[string]any {
	switch c.kind {
	case "binop", "not", "index", "member", "fieldof", "call":
		return p.condToJSON(c)
	}
	return p.condWordAny(c)
}

// safeCondTestString: the negation sniff in parseIf runs on conditions
// that may be object/native (BinOp) forms with no test-string spelling
// — failf's panic is recovered and reported as "" (no negation known).
func (p *parser) safeCondTestString(c *expr) (s string) {
	defer func() {
		if recover() != nil {
			s = ""
		}
	}()
	return p.condTestString(c)
}

// stringsHelperWord: `strings.TrimSpace/ToUpper/ToLower(x)` as the
// native MethodCall word (JS String.prototype twins); nil when the call
// isn't one of the supported pure helpers.
func (p *parser) stringsHelperWord(e *expr) map[string]any {
	if e == nil || e.kind != "call" {
		return nil
	}
	meth := map[string]string{
		"strings.TrimSpace": "trim",
		"strings.ToUpper":   "toUpperCase",
		"strings.ToLower":   "toLowerCase",
	}[e.callee]
	if meth == "" || len(e.args) != 1 {
		return nil
	}
	return map[string]any{
		"type": "MethodCall", "object": p.exprToWord(e.args[0]),
		"method": meth, "args": []any{},
	}
}

// condOperandA1Word: a condition operand as an A1 WORD when it involves
// OBJECT reads (struct members, list/map fields, user-fn captures);
// plain vars/literals report ok=false so the shell test-string shapes
// keep handling them.
func (p *parser) condOperandA1Word(e *expr) (map[string]any, bool) {
	w, ok := p.condOperandA1WordInner(e)
	return w, ok
}

func (p *parser) condOperandA1WordInner(e *expr) (map[string]any, bool) {
	switch e.kind {
	case "slice":
		// a SLICED operand in comparison position (`inner[i:j] == spec.zig`
		// — zig-sh-go's format-spec match): the slice word evaluates to
		// the sliced TEXT, so the ==/!= compares strings natively
		if e.target != nil && e.target.kind == "var" {
			return p.sliceWord(e), true
		}
		if e.target != nil && p.memberListType(e.target) != "" {
			return p.memberSliceWord(e), true
		}
		return nil, false
	case "member":
		if w, tag := p.structFieldWord(e.name); tag != "none" {
			return w, true
		}
		return nil, false
	case "fieldof":
		return p.valueWord(e), true
	case "call":
		// recover() inside a defer func — the caught value read
		if e.callee == "recover" {
			if p.deferRecover == "" {
				return nil, false
			}
			p.deferUsedRcv = true
			return getVarExpr(p.deferRecover), true
		}
		if strings.HasPrefix(e.callee, "strings.") {
			return p.exprToWord(e), true
		}
		if strings.HasSuffix(e.callee, ".Len") {
			// <buf>.Len() — bytes.Builder/strings.Builder length: the
			// strLen of the accumulator contents (`sb.Len() > 0`,
			// posix-sh-go's fragment scanner)
			base := strings.TrimSuffix(e.callee, ".Len")
			if p.bufs[base] != "" || p.bufDyn[base] {
				return map[string]any{
					"type": "Call", "func": "strLen",
					"args":   []any{getVarExpr(p.resolveVar(base))},
					"purity": "PureCpu",
				}, true
			}
		}
		// strings.IndexByte(s, c) / strings.Index(s, substr) — the
		// first-occurrence index (-1 when absent): the runtime strIndex
		if (e.callee == "strings.IndexByte" || e.callee == "strings.IndexRune") && len(e.args) == 2 {
			return map[string]any{
				"type": "Call", "func": "strIndex",
				"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
				"purity": "PureCpu",
			}, true
		}
		if e.callee == "strings.Index" && len(e.args) == 2 {
			return map[string]any{
				"type": "Call", "func": "strIndex",
				"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
				"purity": "PureCpu",
			}, true
		}
		if e.callee == "strings.ContainsRune" && len(e.args) == 2 {
			return map[string]any{
				"type": "Call", "func": "strContainsRune",
				"args":   []any{p.exprToWord(e.args[0]), p.exprToWord(e.args[1])},
				"purity": "PureCpu",
			}, true
		}
		callee := e.callee
		var args []*expr
		if strings.Contains(callee, ".") {
			dot := strings.LastIndex(callee, ".")
			baseName, meth := callee[:dot], callee[dot+1:]
			rn := p.resolveVar(baseName)
			if !p.fnNames[meth] || p.varStruct[rn] == "" {
				return nil, false
			}
			args = append([]*expr{{kind: "var", name: rn}}, e.args...)
			callee = meth
		} else if !p.fnNames[callee] {
			return nil, false
		} else {
			args = e.args
		}
		w := p.userCallWord(callee, args)
		return w, true
	case "not":
		if inner := p.condToJSON(e.lhs); inner != nil {
			return map[string]any{
				"type": "BinOp", "op": "Not",
				"lhs": inner, "rhs": strExpr(""),
			}, true
		}
		return nil, false
	case "var":
		if rn := p.resolveVar(e.name); p.varStruct[rn] != "" {
			return p.structIDWord(e.name), true
		}
		if n, ok := p.consts[e.name]; ok {
			return strExpr(strconv.Itoa(n)), true
		}
		return nil, false
	case "str":
		return strExpr(e.text), true
	case "num":
		return strExpr(e.text), true
	case "strlen":
		// len(src) over a STRING → ${#src}; arrays use the length word;
		// MEMBER targets (object fields) use the strLen runtime helper
		if e.target != nil && e.target.kind == "var" {
			// SLICE-param len (list id) — listLen, not the array word.
			rn := p.resolveVar(e.target.name)
			if p.paramSlice[e.target.name] || p.paramSlice[rn] {
				if n, ok := p.paramNumber(rn); ok {
					return map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{getVarExpr(strconv.Itoa(n))},
						"purity": "PureCpu",
					}, true
				}
				if n, ok := p.paramNumber(e.target.name); ok {
					return map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{getVarExpr(strconv.Itoa(n))},
						"purity": "PureCpu",
					}, true
				}
			}
			name := p.paramName(e.target.name)
			if p.varTypes[p.resolveVar(e.target.name)] == "Array" {
				return joinCall(paramCall("slice", "#"+name, "@", "")), true
			}
			return getVarExpr("#" + name), true
		}
		if e.target != nil && e.target.kind == "index" {
			return map[string]any{
				"type": "Call", "func": "strLen",
				"args":   []any{p.exprToWord(e.target)},
				"purity": "PureCpu",
			}, true
		}
		if e.target != nil && (e.target.kind == "fieldof" || e.target.kind == "index") {
			// a CHAIN length (`len(rhs.args[0].elems)` — the golib's
			// own slice-copy guard): the chain word resolves to a list
			// ref — count via the runtime listLen
			return map[string]any{
				"type": "Call", "func": "listLen",
				"args":   []any{p.exprToWord(e.target)},
				"purity": "PureCpu",
			}, true
		}
		if e.target != nil && e.target.kind == "member" {
			if w, tag := p.structFieldWord(e.target.name); tag != "none" && w != nil {
				if tag == "list" {
					return map[string]any{
						"type": "Call", "func": "listLen",
						"args":   []any{w},
						"purity": "PureCpu",
					}, true
				}
				return map[string]any{
					"type": "Call", "func": "strLen",
					"args":   []any{w},
					"purity": "PureCpu",
				}, true
			}
		}
		return nil, false
	case "add", "mul", "neg":
		// arithmetic sub-expressions render as native JS numbers inside
		// the BinOp comparison. Object reads inside the arithmetic
		// (`k < p.pos+4`) lower through the num_* call words — the Arith
		// AST cannot carry an objGet chain, and string-glue would be
		// wrong for a numeric comparison.
		if p.hasObjectRead(e) {
			return p.arithNumCalls(e), true
		}
		return arithWrap(p.exprToArith(e)), true
	case "binop":
		lw, lok := p.condOperandA1Word(e.lhs)
		rw, rok := p.condOperandA1Word(e.rhs)
		op := map[string]string{"==": "Eq", "!=": "Ne", "<": "Lt", ">": "Gt", "<=": "Le", ">=": "Ge",
			"&&": "And", "||": "Or"}[e.BOp]
		if lok && rok && op != "" {
			return map[string]any{
				"type": "BinOp", "op": op,
				"lhs": lw, "rhs": rw,
			}, true
		}
		return nil, false
	case "arrlen":
		if e.target != nil && e.target.kind == "member" {
			// len(x.field) over a LIST object — listLen word
			if lw, tag := p.structFieldWord(e.target.name); tag != "none" {
				fn := "strLen"
				if tag == "list" {
					fn = "listLen"
				}
				return map[string]any{
					"type": "Call", "func": fn,
					"args":   []any{lw},
					"purity": "PureCpu",
				}, true
			}
			return nil, false
		}
		if e.target != nil && e.target.kind == "var" {
			return joinCall(paramCall("slice", "#"+p.paramName(e.target.name), "@", "")), true
		}
		return nil, false
	case "index":
		// element read on a STRUCT FIELD list/map (`l.toks[i]`, `p.fnNames[b]`)
		if e.target != nil && e.target.kind == "member" {
			if w, tag := p.structFieldWord(e.target.name); tag != "none" && tag != "ref" {
				var keyWord map[string]any
				if e.idx1e != nil {
					keyWord = p.exprToWord(e.idx1e)
				} else {
					keyWord = strExpr(e.idx1)
				}
				fn := "listGet"
				if tag == "map" {
					fn = "mapGet"
				}
				return map[string]any{
					"type": "Call", "func": fn,
					"args":   []any{w, keyWord},
					"purity": "PureCpu",
				}, true
			}
		}
		// CHAINED index in a condition (`post[0]["targets"] == "x"`):
		// string-keyed map read on a slice element — same mapGet shape
		if e.target != nil && e.target.kind == "index" &&
			((e.idx1e != nil && e.idx1e.kind == "str") || e.idx1 != "") {
			key := e.idx1
			if e.idx1e != nil {
				key = e.idx1e.text
			}
			return map[string]any{
				"type": "Call", "func": "mapGet",
				"args":   []any{p.exprToWord(e.target), strExpr(key)},
				"purity": "PureCpu",
			}, true
		}
		// ASSOC-map store element read on a plain var (`m[key]`)
		if e.target != nil && e.target.kind == "var" && p.maps[e.target.name] {
			mn := p.resolveVar(e.target.name)
			var kw map[string]any
			if e.idx1e != nil {
				kw = p.exprToWord(e.idx1e)
			} else {
				kw = strExpr(e.idx1)
			}
			return map[string]any{
				"type": "Call", "func": "assocGet",
				"args":   []any{strExpr(mn), kw},
				"purity": "PureCpu",
			}, true
		}
		// BYTE READ on a STRING field as a comparison operand
		// (`l.src[l.pos] != '\n'`)
		if node, ok := p.stringFieldByteRead(e); ok {
			return node, true
		}
		// plain store indexing in conditions: `src[i+1] == '/'`
		if e.target != nil && e.target.kind == "var" {
			name := p.paramName(e.target.name)
			key := ""
			keyWord := map[string]any(nil)
			if e.idx1e != nil {
				key = p.arithKeyText(e.idx1e)
				keyWord = p.exprToWord(e.idx1e)
			} else {
				key = e.idx1
				keyWord = strExpr(key)
			}
			_ = keyWord
			if p.varTypes[p.resolveVar(e.target.name)] == "Str" {
				// Go byte access is an INTEGER (the code) — byteAt,
				// so char comparisons (`s[i] != '\"'`, charCode 34)
				// agree. (The old 1-char-slice shape compared chars
				// to codes and never matched — the lexer's strings
				// ran off the end.) Params ride by number.
				nm := p.resolveVar(e.target.name)
				if n, ok := p.paramNumber(nm); ok {
					nm = strconv.Itoa(n)
				}
				var kw map[string]any
				if e.idx1e != nil {
					kw = p.exprToWord(e.idx1e)
				} else {
					kw = strExpr(e.idx1)
				}
				return map[string]any{
					"type": "Call", "func": "byteAt",
					"args":   []any{strExpr(nm), kw},
					"purity": "PureCpu",
				}, true
			}
			return getVarExpr(name + "[" + key + "]"), true
		}
	}
	return nil, false
}

// charCode — the ASCII code of a Go rune literal (a char expr's text
// is the decoded char; Go chars are integers, so the code is the value
// in byte contexts).
func charCode(e *expr) string {
	if e == nil || e.text == "" {
		return "0"
	}
	return strconv.Itoa(int(e.text[0]))
}

// condOperandQ: `==`/`!=` operand — quoted: `"$x"` / `"lit"` / `"42"`.
func (p *parser) condOperandQ(e *expr) string {
	switch e.kind {
	case "var":
		if e.name == "nil" {
			// nil is the empty string in the A1 (the zero value)
			return `""`
		}
		return `"$` + p.paramName(e.name) + `"`
	case "str", "rawstr":
		// rawstr: a backtick literal whose CONTENT is the token text
		// verbatim (zig-sh-go's `mod.text != \`"std\"\`` — the text
		// INCLUDES the quote chars, so the comparison is exact)
		return `"` + e.text + `"`
	case "char":
		// a Go rune literal is an INTEGER — its ASCII code (the golib's
		// `c == ' '` byte tests; c holds the code from byteAt).
		return `"` + charCode(e) + `"`
	case "num":
		return `"` + e.text + `"`
	case "call":
		// src[i] in a comparison — the sh2.byteAt helper rendered in a
		// cmdsub word (the runtime's test evaluator resolves it in JS).
		if e.callee == "byteAt" && len(e.args) == 2 {
			return `"$(sh2.byteAt(` + e.args[0].text + `, ` + e.args[1].text + `))"`
		}
		p.failf("unsupported comparison operand (v2): %s", e.kind)
	case "member":
		// t.kind — a struct field read in a comparison (the golib's
		// `t.kind != tEOF` token-kind tests): the jsonGet helper in a
		// cmdsub word.
		if e.memberTarget == nil {
			if i := strings.LastIndex(e.name, "."); i > 0 {
				return `"$(sh2.jsonGet(` + p.resolveVar(e.name[:i]) + `, ` + e.name[i+1:] + `))"`
			}
		}
		p.failf("unsupported comparison operand (v2): %s", e.kind)
	case "arrlen":
		// len(arr) → the `${#arr[@]}` length word, quoted like `"$x"`
		// (the statement-position lowering at emitExpr uses the same
		// shape via join(param("slice", "#arr", "@", ""))).
		return `"${#` + p.paramName(e.target.name) + `[@]}"`
	case "strlen":
		// len(s) → the `${#s}` length word (the same shape as the
		// statement-position lowering — getVar("#"+name)).
		return `"${#` + p.paramName(e.target.name) + `}"`
	case "index":
		// src[i] in a comparison — the sh2.byteAt helper rendered in a
		// cmdsub word (the golib's `src[i] != '\n'` byte tests; the
		// runtime's test evaluator resolves the sh2.* call in JS).
		if e.target != nil && e.target.kind == "var" && p.varTypes[p.resolveVar(e.target.name)] != "Array" {
			if e.idx1e != nil {
				if off := p.indexArithText(e.idx1e); off != "" {
					return `"$(sh2.byteAt(` + p.resolveVar(e.target.name) + `, ` + off + `))"`
				}
				p.failf("index key must be a number literal (v2)")
			}
			return `"$(sh2.byteAt(` + p.resolveVar(e.target.name) + `, ` + e.idx1 + `))"`
		}
		// a[0] → the quoted `${a[0]}` array-element word — the CLI's
		// `filtered[0] != "--shir"` argv gate (frontends/go-sh/cmd/
		// go-sh/main.go:24; the refusal surfaced with the line
		// attribution of the NEXT statement, `inp := filtered[1]`,
		// because condToJSON runs after the if-body parse — the same
		// attribution trap as the arrlen operand). Same mechanism as
		// the arrlen case above: the core's try_native_test falls back
		// to sh2.test for non-plain operands, and the runtime's
		// tokenizeTest expands the quoted word via expandWord
		// (arrayIndex) inside a quoted test word.
		if e.target != nil && e.target.kind == "var" {
			if p.maps[e.target.name] {
				p.failf("map key in comparison unsupported (v2)")
			}
			name := p.paramName(e.target.name)
			key := e.idx1
			if e.idx1e != nil {
				// computed subscript (`s[i] == "x"`): arith text resolved
				// by evalArith inside the quoted word's expansion
				key = p.arithKeyText(e.idx1e)
				if p.varTypes[p.resolveVar(e.target.name)] == "Str" {
					// a STRING subscript is a single-element read (${s:$i:1});
					// Go bytes = chars for the ASCII corpus (documented).
					return "\"${" + name + ":" + key + ":1}\""
				}
			}
			return "\"${" + name + "[" + key + "]}\""
		}
		p.failf("index target must be a var (v2)")
	}
	p.failf("unsupported comparison operand (v2): %s", e.kind)
	return ""
}

// condOperandArg: `-lt`-style operand — `"$x"` for vars, digits for nums.
func (p *parser) condOperandArg(e *expr) string {
	switch e.kind {
	case "var":
		if e.name == "nil" {
			return ""
		}
		return `"$` + p.paramName(e.name) + `"`
	case "str", "rawstr":
		// rawstr: backtick literal, content verbatim (see condOperandQ)
		return `"` + e.text + `"`
	case "char":
		// a Go rune literal is an INTEGER — its ASCII code (the golib's
		// `c >= '0'` digit tests).
		return `"` + charCode(e) + `"`
	case "num":
		return e.text
	case "call":
		if e.callee == "byteAt" && len(e.args) == 2 {
			return `"$(sh2.byteAt(` + e.args[0].text + `, ` + e.args[1].text + `))"`
		}
		p.failf("unsupported comparison operand (v2): %s", e.kind)
	case "arrlen":
		// len(arr) in a numeric comparison — the quoted length word
		// (e.g. `"${#arr[@]}" -gt 1`; a bare ${#arr[@]} would need the
		// word-splitting the quoted form avoids).
		return `"${#` + p.paramName(e.target.name) + `[@]}"`
	case "strlen":
		// len(s) in a numeric comparison — the quoted length word
		// (`"${#s}" -gt 1`; the same shape as condOperandQ).
		return `"${#` + p.paramName(e.target.name) + `}"`
	case "index":
		// src[i] in a numeric comparison — the sh2.byteAt cmdsub word
		// (the golib's byte tests).
		if e.target != nil && e.target.kind == "var" && p.varTypes[p.resolveVar(e.target.name)] != "Array" {
			if e.idx1e != nil {
				if off := p.indexArithText(e.idx1e); off != "" {
					return `"$(sh2.byteAt(` + p.resolveVar(e.target.name) + `, ` + off + `))"`
				}
				p.failf("index key must be a number literal (v2)")
			}
			return `"$(sh2.byteAt(` + p.resolveVar(e.target.name) + `, ` + e.idx1 + `))"`
		}
		// a[0] in a numeric comparison — the quoted element word
		// (`[ "${a[0]}" -gt 1 ]`; bare would need the word-splitting
		// the quoted form avoids). Literal keys only, like the
		// statement-position lowering (exprToWord).
		if e.target != nil && e.target.kind == "var" {
			if p.maps[e.target.name] {
				p.failf("map key in comparison unsupported (v2)")
			}
			name := p.paramName(e.target.name)
			key := e.idx1
			if e.idx1e != nil {
				// computed subscript (`s[i] == "x"`): arith text resolved
				// by evalArith inside the quoted word's expansion
				key = p.arithKeyText(e.idx1e)
				if p.varTypes[p.resolveVar(e.target.name)] == "Str" {
					// a STRING subscript is a single-element read (${s:$i:1});
					// Go bytes = chars for the ASCII corpus (documented).
					return "\"${" + name + ":" + key + ":1}\""
				}
			}
			return "\"${" + name + "[" + key + "]}\""
		}
		p.failf("index target must be a var (v2)")
	}
	p.failf("unsupported comparison operand (v2): %s", e.kind)
	return ""
}

// ─────────────────────────────────────────────────────────────────────
// Shir — go-sh as a library: Go source -> A1 shIR JSON bytes (no
// trailing newline). Both the CLI (cmd/go-sh) and the combined busybox
// dispatch through this single entry point.
// ─────────────────────────────────────────────────────────────────────

// prescanFuncNames: collect every declared function/method NAME up
// front, so forward references (`lex` calling `isIdentPart` declared
// below it) resolve during body parsing.
func (p *parser) prescanFuncNames() {
	// PACKAGE MODE: collect `package <name>` clauses — a qualified call
	// `pkg.F(...)` whose base matches a clause resolves to F when the
	// package's own files are concatenated into the source (the CLI's
	// multi-file mode; cpp-sh-go/main.go calling parser.go-adjacent
	// entry points through the package qualifier)
	for i, t := range p.toks {
		if t.kind == tIdent && t.text == "package" &&
			i+1 < len(p.toks) && p.toks[i+1].kind == tIdent {
			p.pkgNames[p.toks[i+1].text] = true
		}
	}
	// pre-register every STRUCT TYPE name so forward references
	// (`v := f()` where f returns a struct declared LATER in the file)
	// resolve at use time
	for i, t := range p.toks {
		if t.kind == tIdent && t.text == "type" &&
			i+2 < len(p.toks) &&
			p.toks[i+1].kind == tIdent && p.toks[i+2].kind == tIdent && p.toks[i+2].text == "struct" {
			p.structs[p.toks[i+1].text] = []string{}
			p.structFT[p.toks[i+1].text] = []string{}
			p.structRaw[p.toks[i+1].text] = []string{}
		}
	}
	for i, t := range p.toks {
		if t.kind != tIdent || t.text != "func" {
			continue
		}
		j := i + 1
		// skip an optional receiver `(r T)`
		if j < len(p.toks) && p.toks[j].kind == tPunct && p.toks[j].text == "(" {
			depth := 0
			for j < len(p.toks) {
				if p.toks[j].kind == tPunct && p.toks[j].text == "(" {
					depth++
				} else if p.toks[j].kind == tPunct && p.toks[j].text == ")" {
					depth--
					if depth == 0 {
						j++
						break
					}
				}
				j++
			}
		}
		if j < len(p.toks) && p.toks[j].kind == tIdent {
			name := p.toks[j].text
			if name != "main" && name != "_" {
				p.fnNames[name] = true
			}
			j++
			// skip the parameter list before scanning the return type
			// (the raw return text must not include `(e *expr)`)
			if j < len(p.toks) && p.toks[j].kind == tPunct && p.toks[j].text == "(" {
				depth := 0
				for j < len(p.toks) {
					if p.toks[j].kind == tPunct && p.toks[j].text == "(" {
						depth++
					} else if p.toks[j].kind == tPunct && p.toks[j].text == ")" {
						depth--
						if depth == 0 {
							j++
							break
						}
					}
					j++
				}
			}
			k := j
			var posIds []string
			var retRaw string
			for k < len(p.toks) && !(p.toks[k].kind == tPunct && p.toks[k].text == "{") && p.toks[k].kind != tNL && p.toks[k].kind != tEOF {
				retRaw += p.toks[k].text
				if p.toks[k].kind == tIdent {
					base := p.toks[k].text
					// a POINTER element (`[]*expr`) keeps its `*` so
					// callFirstListElem returns "" (pointer elements ride
					// shell arrays as arena-id strings, never the list-id
					// path) — without it `[]*expr` is misread as a
					// struct-slice of `expr`.
					if k > 0 && p.toks[k-1].kind == tPunct && p.toks[k-1].text == "*" {
						base = "*" + base
					}
					// record provisional per-position ret types (resolved
					// against structs at use time) — forward-referenced
					// `(T, bool)`/`*T` returns arm comma-ok Bool and the
					// dotted-field paths BEFORE the decl parse commits
					posIds = append(posIds, base)
					p.prescanRet[name] = base
				}
				k++
			}
			// a MAP return (`map[string]any`) — the prescan stores the
			// FULL raw text so forward call sites bind the target as a
			// NAMED ASSOC array before the decl parse commits fnSig
			if strings.HasPrefix(retRaw, "map[") {
				p.prescanRet[name] = retRaw
			}
			// a SLICE return (`[]any`) — keep the prefix so forward
			// call sites route the result to an Array store var
			if strings.HasPrefix(retRaw, "[]") && len(posIds) > 0 {
				p.prescanRet[name] = "[]" + posIds[len(posIds)-1]
			}
			if len(posIds) > 0 {
				p.fnRetIdents[name] = posIds
			}
		}
	}
}

var debugNoRecover string

func Shir(src string) ([]byte, error) {
	debugNoRecover = "1"
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{
		toks:        toks,
		varTypes:    map[string]string{},
		consts:      map[string]int{},
		constStrs:   map[string]string{},
		arrays:      map[string]arrayInfo{},
		anyLists:    map[string]bool{},
		anyElem:     map[string]string{},
		maps:        map[string]bool{},
		bufs:        map[string]string{},
		cmds:        map[string][]*expr{},
		stdinRdr:    map[string]bool{},
		fnNames:     map[string]bool{},
		outer:       map[string]bool{},
		varAlias:    map[string]string{},
		structs:     map[string][]string{},
		structFT:    map[string][]string{},
		structRaw:   map[string][]string{},
		bufDyn:      map[string]bool{},
		prescanRet:  map[string]string{},
		pkgNames:    map[string]bool{},
		importAlias: map[string]string{},
		fnRetIdents: map[string][]string{},
		boolFuncs:   map[string]bool{},
		readDirVars: map[string]string{},
		splitNVars:  make(map[string]splitNInfo),
		cgoObjs:     map[string]bool{},
		varStruct:   map[string]string{},
		fnSig:       map[string][2]string{},
		fnParams:    map[string]bool{},
		fnParamOrd:  []string{},
		fnLocals:    map[string]bool{},
		paramTypes:  map[string]string{},
		regexpVars:  map[string]string{},
		paramSlice:  map[string]bool{},
		// the self-hosting contract's maps (positional composite
		// literals, element types, receiver typing, runtime buffers)
		structFields:     map[string][]string{},
		structFieldTypes: map[string]map[string]string{},
		varStructTypes:   map[string]string{},
		receiverTypes:    map[string]string{},
		runtimeBufs:      map[string]bool{},
	}
	p.prescanFuncNames()

	stmts, err := p.run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "PARSE ERROR:", err)
		return nil, err
	}
	prog := &shiremit.Program{Stmts: stmts}
	return shiremit.Emit(prog)
}

// run drives the parser with panic-based error recovery.
func (p *parser) run() (stmts []map[string]any, err error) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintln(os.Stderr, "PANIC:", r)
			err = fmt.Errorf("%v", r)
		}
	}()
	return p.parseTopLevel(), nil
}
