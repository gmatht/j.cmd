// go-sh: Go source -> shIR JSON (A1 contract), hand-rolled Go frontend.
//
// WORKER REWRITE (2026-08-06): the v1 line-scanner stub is replaced by a
// real tokenizer + recursive-descent parser for the v2 Go subset, with a
// lowering pass that emits the EXACT A1 node shapes the core frontend
// produces for the equivalent shell construct (verified against
// `debashc file --shir` on the paired posix-sh-go testdata, which shares
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
	"path/filepath"
	"strconv"
	"strings"

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
	tStr    // "..."  (text = decoded, raw = verbatim between quotes)
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

var multiOps = []string{"...", ":=", "==", "!=", "<=", ">=", "&&", "||", "+=", "++", "--"}

func lex(src string) ([]token, error) {
	var toks []token
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
			// single-quoted char literal (e.g. ReadString('\n')) — treated
			// as a string token with the body between the quotes
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
			toks = append(toks, token{kind: tStr, raw: src[start+1 : i], text: src[start+1 : i], line: line})
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
			if matched {
				break
			}
			toks = append(toks, token{kind: tPunct, text: string(c), line: line})
			i++
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
	call := map[string]any{
		"type": "Call", "func": "exec",
		"args":   []any{strExpr(cmd), map[string]any{"type": "Array", "elements": elems}},
		"purity": purity,
	}
	if len(typeArgs) > 0 {
		ta := make([]any, len(typeArgs))
		for i, s := range typeArgs {
			ta[i] = s
		}
		call["typeArgs"] = ta
	}
	return map[string]any{
		"type": "Expr",
		"expr": call,
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
	// func literal (lowered body, params in args)
	body   []map[string]any
	params []string
	// raw A1 cond JSON (if-init forms lower their cond directly,
	// bypassing condTestString — the assign-Capture shape has no
	// test-string form)
	rawJSON map[string]any
}

// ─────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────

type parser struct {
	toks []token
	pos  int
	// semantic side-state (the Go subset's shell-shaped meanings)
	varTypes   map[string]string // name -> "Int" | "Str" | "Array" | "Map"
	consts     map[string]int    // evaluated int const values (const refs)
	constStrs  map[string]string // evaluated string const values
	arrays     map[string]arrayInfo
	maps       map[string]bool    // m := map[K]V{...} — assoc-array name
	bufs       map[string]string  // b := bytes.Buffer — accumulated contents
	cmds       map[string][]*expr // cmd := exec.Command(...) -> args
	stdinRdr   map[string]bool    // r := bufio.NewReader(os.Stdin)
	fnNames    map[string]bool    // f := func(...){...} — callable subs
	outer      map[string]bool    // vars assigned at top level
	fnParams   map[string]bool    // inside a func literal
	fnParamOrd []string           // ordered param names -> $1..
	fnLocals   map[string]bool
	inFunc     bool
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
	structs    map[string][]string          // type name -> ordered FIELDS
	structFT   map[string][]string          // type name -> field BASE type names
	structRaw  map[string][]string          // type name -> field RAW type texts
	varStruct  map[string]string            // var -> struct type name (pointer or value)
	bufDyn     map[string]bool              // buffers with DYNAMIC writes (obj model)
	fnSig      map[string][2]string         // func/method name -> [paramTypesCsv, retType]
	paramTypes map[string]string            // (during decl parse) param -> base type
	curFn      string                       // (during body parse) enclosing func name
	prescanRet map[string]string            // func name -> raw return base (pre-decl)
	pkgNames   map[string]bool              // package clauses seen in the concatenated source (PACKAGE MODE)
	lastTypeRaw string                     // (during capture) the raw type text
	lastSig    [2]string                    // (during decl parse) captured signature
	tmpN       int                          // fresh temp counter (newstruct preludes)
	// type-switch guard aliases: `switch v := x.(type)` binds v to x in
	// every arm (core request go-sh-20260813-154009) — reads of the guard
	// var resolve to the guarded var (getVar x), matching the contract's
	// "v binds to getVar(\"x\")" lowering.
	varAlias map[string]string
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
		l = &expr{kind: "binop", BOp: t.text, BOpKind: "cmp", lhs: l, rhs: p.parseAdd()}
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
			} else {
				e = &expr{kind: "member", name: callName(e) + "." + nm}
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
			if arg.kind == "var" && p.varTypes[arg.name] == "Array" {
				return &expr{kind: "arrlen", target: arg}
			}
			if arg.kind == "member" {
				// len(l.toks) over a LIST-object field
				if _, tag := p.structFieldWord(arg.name); tag == "list" {
					return &expr{kind: "arrlen", target: arg}
				}
			}
			return &expr{kind: "strlen", target: arg}
		case "string", "int", "int64", "int32", "float64", "uint8":
			// CONVERSION identity (grammar conversion): string(x), int(x)
			// — the A1 is strings-only, so casts are no-ops
			p.pos++
			p.expect(tPunct, "(")
			p.skipNL()
			arg := p.parseExpr()
			p.expect(tPunct, ")")
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
				p.pos++ // map
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
				return &expr{kind: "maplit", keys: keys, vals: vals}
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
	return &expr{kind: "maplit", keys: keys, vals: vals}
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
func (p *parser) structMemberWord(name string) (map[string]any, bool) {
	w, tag := p.structFieldWord(name)
	if tag != "ref" {
	}
	if tag == "none" || tag == "list" || tag == "map" {
		return nil, false
	}
	return w, true
}

// newstructStmts lowers `target = &T{...}` (or a temp for expression
// uses): ONE objNew call — the OBJECT STORE model. Nested &T{...}
// field values pre-lower into temps (statement boundary), then the
// field word is the temp's value; non-addressed struct fields inline
// their objNew directly.
func (p *parser) newstructStmts(target string, e *expr) []map[string]any {
	layout := p.structs[e.structType]
	prelude := []map[string]any{}
	fieldNames := []any{}
	fieldVals := []any{}
	for i, fv := range e.fieldVals {
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
		fieldVals = append(fieldVals, p.exprToWord(fv))
	}
	out := prelude
	out = append(out, assignStmt(target, p.objNewCallNamed(e.structType, fieldNames, fieldVals)))
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
	layout := p.structs[e.structType]
	for i, fv := range e.fieldVals {
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
		vals = append(vals, p.exprToWord(fv))
	}
	return p.objNewCallNamed(e.structType, names, vals)
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
	_, ok := p.structs[name]
	return ok
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
	base := ""
	slice := false
	for i := start; i < p.pos && i < len(p.toks); i++ {
		if p.toks[i].kind == tIdent {
			base = p.toks[i].text
		}
		if (p.toks[i].kind == tPunct || p.toks[i].kind == tOp) && p.toks[i].text == "[" {
			slice = true
		}
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

// ── statement parsing ───────────────────────────────────────────────

func (p *parser) parseTopLevel() []map[string]any {
	var out []map[string]any
	for {
		p.skipNL()
		t := p.tok()
		if t.kind == tEOF {
			return out
		}
		switch {
		case p.atPunct("{") || p.atPunct("}"):
			p.pos++ // func main's braces / bare blocks
		case p.atIdent("package"):
			p.pos++
			p.skipToLineEnd()
		case p.atIdent("import"):
			// import "fmt" / import ( "fmt" \n "strings" ) — skip the
			// whole clause, parenthesized block included (t71).
			p.pos++
			p.skipNL()
			if p.atPunct("(") {
				depth := 0
				for {
					t := p.next()
					if t.kind == tEOF {
						break
					}
					if t.kind == tPunct && t.text == "(" {
						depth++
					}
					if t.kind == tPunct && t.text == ")" {
						depth--
						if depth == 0 {
							break
						}
					}
				}
			} else {
				p.skipToLineEnd()
			}
		case p.atIdent("func"):
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
				recvName = p.expect(tIdent, "").text
				p.skipNL()
				recvType = p.captureTypeText()
				p.expect(tPunct, ")")
				p.skipNL()
			}
			nm := p.expect(tIdent, "").text
			if nm == "main" {
				p.skipToLineEnd()
				break
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
			p.fnParams = map[string]bool{}
			p.fnParamOrd = nil
			p.fnLocals = map[string]bool{}
			p.inFunc = true
			for _, prm := range params {
				p.fnParams[prm] = true
				p.fnParamOrd = append(p.fnParamOrd, prm)
				if pt := p.paramTypes[prm]; p.isStructType(pt) {
					rn := p.resolveVar(prm)
					p.varStruct[rn] = pt
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
			p.fnNames[nm] = true
			out = append(out, map[string]any{"type": "Function", "name": nm, "body": body})
		case p.atIdent("type"):
			// [see parseTypeDecl for the erasure contract]
			p.parseTypeDecl()
		case p.atIdent("const"):
			// `const x = expr` / `const ( specs )` — Go compile-time
			// constants (FRONTEND-GAP: the old path fell through to
			// parseStmt and died on `tEOF tokKind = iota` → "unexpected
			// token tokKind after expression"). Each name lowers to an
			// Assign of its evaluated value — see parseConstDecl.
			out = append(out, p.parseConstDecl()...)
		default:
			out = append(out, p.parseStmt()...)
		}
	}
}

// parseTypeDecl — `type Name <underlying>`: a TYPE DECLARATION:
// compile-time only, zero runtime statements. The faithful A1 lowering
// is ERASURE (parse the full underlying type, emit nothing) — the same
// contract already pinned for empty interfaces (t80/t82/t84/t85),
// scalar aliases (`type tokKind int`) and generic type parameters.
// Supported underlying forms:
//   interface{…}   — empty OR method-set body (a method SPEC is
//                    itself compile-time only; method DISPATCH on
//                    values stays refused at its use sites)
//   struct{…}      — field list, erased field by field
//   T | pkg.T      — scalar/named alias
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
		p.skipNL()
		// BARE return (no expression): echo an empty word — the zero
		// value the caller's capture reads
		if p.atPunct(";") || p.atPunct("}") || p.tok().kind == tNL || p.tok().kind == tEOF {
			return []map[string]any{execStmt("echo", []map[string]any{strExpr("")}, "Emulable")}
		}
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
		if len(rexprs) == 1 && p.inFunc && p.isPredicateExpr(rexprs[0]) {
			return []map[string]any{{
				"type":   "If",
				"cond":   p.condToJSON(rexprs[0]),
				"then":   []any{map[string]any{"type": "Return", "value": strExpr("0")}},
				"elsifs": []any{},
				"else":   []any{map[string]any{"type": "Return", "value": strExpr("1")}},
			}}
		}
		var words []map[string]any
		for _, e := range rexprs {
			words = append(words, p.exprToWord(e))
		}
		return []map[string]any{execStmt("echo", words, "Emulable")}
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
			for p.tok().kind == tIdent {
				p.next()
			}
			p.skipNL()
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
	if t := p.tok(); !(t.kind == tNL || t.kind == tEOF ||
		(t.kind == tPunct && (t.text == "=" || t.text == ")"))) {
		p.skipType()
	}
	var out []map[string]any
	for _, n := range names {
		p.registerVar(n, "Str")
		if isBuf {
			p.bufs[n] = ""
			out = append(out, assignStmt(n, p.objNewCallNamed("bytes.Buffer",
				[]any{strExpr("buf")}, []any{strExpr("")})))
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
		w := p.exprToWord(rhs)
		p.registerVar(names[0], p.wordType(w))
		return []map[string]any{assignStmt(names[0], w)}
	}
	return out
}

func (p *parser) parseBlockStmts() []map[string]any {
	p.expect(tPunct, "{")
	out := []map[string]any{}
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			return out
		}
		if p.tok().kind == tEOF {
			p.failf("unterminated block")
		}
		out = append(out, p.parseStmt()...)
	}
}

// ── dotted-callee statements ────────────────────────────────────────

func (p *parser) parseDottedStmt() []map[string]any {
	first := p.next().text
	p.expect(tPunct, ".")
	method := p.expect(tIdent, "").text
	switch first + "." + method {
	case "fmt.Println", "fmt.Print":
		return p.printlnStmt()
	case "fmt.Fprintln":
		return p.fprintlnStmt()
	case "fmt.Printf":
		return p.printfStmt()
	case "os.WriteFile":
		return p.writeFileStmt()
	case "os.Setenv":
		return p.setenvStmt()
	case "os.Exit":
		return p.exitStmt()
	}
	// os.Stdout.Write(x) — raw bytes to stdout, no trailing newline:
	// the `printf '%s' x` shape (byte-faithful for the corpus;
	// os.Stdout.Write([]byte{'\n'}) emits the bare newline)
	if first == "os" && method == "Stdout" && p.atPunct(".") {
		p.pos++ // .
		m2 := p.expect(tIdent, "").text
		if m2 == "Write" {
			p.expect(tPunct, "(")
			p.skipNL()
			arg := p.parseExpr()
			p.skipNL()
			p.expect(tPunct, ")")
			return []map[string]any{execStmt("printf",
				[]map[string]any{strExpr("%s"), p.exprToWord(arg)}, "Emulable")}
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
			// the character — Go string(byte) equivalence for ASCII)
			p.bufDyn[first] = true
			idw := getVarExpr(p.resolveVar(first))
			cur := map[string]any{
				"type": "Call", "func": "objGet",
				"args":   []any{idw, strExpr("buf")},
				"purity": "PureCpu",
			}
			cat := interpParts([]any{
				map[string]any{"kind": "expr", "expr": cur},
				map[string]any{"kind": "expr", "expr": p.exprToWord(a)},
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
		return []map[string]any{execStmt(method, words, "Spawn")}
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
				p.skipNL()
				p.expect(tPunct, "]")
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
								"args":   []any{container, kw},
								"purity": "PureCpu",
							}},
							map[string]any{"kind": "expr", "expr": rhsW},
						})
					}
				} else {
					p.failf("expected = in element write (v2)")
				}
				return []map[string]any{{
					"type": "Expr",
					"expr": map[string]any{
						"type": "Call", "func": fn,
						"args":   []any{objGetField(idWord, method), kw, rhsW},
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
	for _, a := range args[1:] {
		elems = append(elems, p.elemWord(a, elemType))
	}
	// objSet(l, f, listPush(objGet(l, f), ...)) — listPush returns the
	// (possibly freshly vivified) list id, the objSet stores it back
	return map[string]any{
		"type": "Expr",
		"expr": map[string]any{
			"type": "Call", "func": "objSet",
			"args": []any{idWord, fieldWord, map[string]any{
				"type": "Call", "func": "listPush",
				"args":   elems,
				"purity": "PureCpu",
			}},
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
	case "arrlen", "strlen":
		// len(x) inside num_* arithmetic: the word path already handles
		// var targets (${#a[@]} / ${#s}) and member targets (listLen /
		// structFieldWord) — the num_* call coerces the word to a number
		// (`p.toks[len(p.toks)-1]`, perl-sh-go peekLine)
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
	// function call in Println: fmt.Println(greet(n)) → the call itself
	// (the function's echo writes stdout — the `greet "$n"` shape)
	if len(args) == 1 && args[0].kind == "call" && p.fnNames[args[0].callee] {
		var words []map[string]any
		for _, a := range args[0].args {
			words = append(words, p.argToWord(a))
		}
		return []map[string]any{execStmtTA(args[0].callee, words, "Spawn", args[0].typeArgs)}
	}
	return []map[string]any{execStmt("echo", p.printlnWords(args), "Emulable")}
}

// printlnWords: Println/Print/Fprintln operand separation — Go separates
// operands with a space, which IS shell word separation — one word per
// operand (t40 fixes the old interpParts concat that printed "$i$j").
func (p *parser) printlnWords(args []*expr) []map[string]any {
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
				words = append(words, p.argToWord(a))
			}
		}
	} else {
		words = []map[string]any{p.exprToWord(args[0])}
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
	echo := execStmt("echo", p.printlnWords(args), "Emulable")
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

// printfStmt: one %s + trailing \n → the echo-interpolation shape
// (`echo "hi $NAME"`); otherwise printf with the RAW format text
// (`printf "%s-%s\n" a b`).
func (p *parser) printfStmt() []map[string]any {
	p.expect(tPunct, "(")
	p.skipNL()
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
	words = append(words, interpLit(fmtTok.raw))
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
		value = map[string]any{"type": "Num", "value": n}
	case tIdent:
		name := p.next().text
		if n, ok := p.paramNumber(name); ok {
			value = map[string]any{"type": "Num", "value": n}
		} else {
			value = getVarExpr(name)
		}
	default:
		value = map[string]any{"type": "Num", "value": 0}
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
func (p *parser) parseMapLiteralBody(name string) []map[string]any {
	p.skipNL()
	p.expect(tPunct, "{")
	p.maps[name] = true
	p.registerVar(name, "Map")
	var body []map[string]any
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
		// GENERAL values: any word-lowerable expression rides assocSet;
		// nested composites (map/slice literals) pre-allocate into temps
		// whose REFERENCE ID becomes the stored value (object-store model)
		var valWord map[string]any
		if val.kind == "maplit" || val.kind == "arraylit" {
			tmp, alloc := p.allocComposite(val)
			body = append(body, alloc...)
			valWord = getVarExpr(tmp)
		} else {
			valWord = p.exprToWord(val)
		}
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
		targets[0] = targets[0] + "[" + idx + "]"
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
	// array literal: name := []T{...} (multi-target `a, b := []T{}, []T{}`
	// supported — each target gets its own literal)
	if p.atPunct("[") {
		var out []map[string]any
		for i := 0; ; i++ {
			if i >= len(targets) {
				p.failf("array literal with more targets than values (v2)")
			}
			elems, typ := p.parseArrayLiteral()
			p.arrays[targets[i]] = arrayInfo{elems: elems, typ: typ}
			p.registerVar(targets[i], "Array")
			out = append(out, assignStmt(targets[i],
				map[string]any{
					"type": "Call", "func": "setArray",
					"args":   []any{strExpr(targets[i]), map[string]any{"type": "Array", "elements": elems}},
					"purity": "Emulable",
				}))
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
	if p.atIdent("map") {
		p.pos++
		p.expect(tPunct, "[")
		for p.tok().kind == tIdent {
			p.next()
		}
		p.expect(tPunct, "]")
		for p.tok().kind == tIdent {
			p.next()
		}
		if len(targets) > 1 {
			p.failf("map literal with multiple targets (v2)")
		}
		return p.parseMapLiteralBody(targets[0])
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
		name := ""
		for _, tg := range targets {
			if tg == "_" || tg == "err" {
				continue
			}
			if name != "" {
				p.failf("strconv.%s returns (value, error) — one target (v2)", fnName)
			}
			name = tg
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

	// b, _ := os.ReadFile(path) → b = $(cat path) — the whole-file-read
	// cmdsub shape (t34's capture; cat is an Emulable sync builtin; the
	// []byte result is a string in the A1's strings-are-bytes model).
	// The error return is dropped like strconv.Atoi's. The if-init form
	// (`if b, err := os.ReadFile(p); err == nil {`) stays REFUSED: its
	// cond is a read-status test, and the A1 If cond is a `test` call,
	// not a command status (Refuse > guess). Other os.* RHS calls
	// (Getenv etc.) fall through to the generic expression RHS.
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
			if tg == "_" || tg == "err" {
				continue
			}
			if name != "" {
				p.failf("os.ReadFile returns ([]byte, error) — one target (v2)")
			}
			name = tg
		}
		if name == "" {
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
	if rhs.kind == "call" && p.callTargetName(rhs.callee) != "" {
		// METHOD calls (`x := l.cur()`): the receiver rides as $1; the
		// sub name is the last dotted segment
		calleeName := p.callTargetName(rhs.callee)
		var words []map[string]any
		if dot := strings.LastIndex(rhs.callee, "."); dot >= 0 {
			baseName := rhs.callee[:dot]
			if p.pkgNames[baseName] {
				// PACKAGE MODE: `pkg.F(args)` — no receiver; F is this
				// multi-file package's own function
				for _, a := range rhs.args {
					words = append(words, p.argToWord(a))
				}
			} else {
				rn := p.resolveVar(baseName)
				if rn == "" || !p.fnNames[calleeName] {
					p.failf("unsupported call %q (v2)", rhs.callee)
				}
				words = append(words, getVarExpr(rn))
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
		// RESULT-SLOT protocol: run the sub, then read each slot
		out := []map[string]any{execStmtTA(calleeName, words, "Spawn", rhs.typeArgs)}
		// a func returning a SLICE ([]T): the capture target is an
		// Array-typed store var so ranging/slicing lowers through the
		// param("slice", …) shapes (`args := p.parseArgs()` then
		// `range args[1:]` — go-sh.go's own parseAppendIntoList)
		sig, hasSig := p.fnSig[calleeName]
		retSlice := hasSig && strings.HasPrefix(sig[1], "[]")
		for i, tg := range targets {
			if tg == "_" {
				continue
			}
			if retSlice {
				p.registerVar(tg, "Array")
				// registerVar's guard keeps an earlier SCALAR typing of a
				// same-named var in another scope — a []T result must win
				p.varTypes[tg] = "Array"
			} else {
				p.registerVar(tg, "Str")
			}
			out = append(out, assignStmt(tg,
				getVarExpr("__ret_"+calleeName+"_"+strconv.Itoa(i+1))))
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
			p.registerVar(name, "Array")
			p.varTypes[name] = "Array"
		} else {
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
			case "call", "index", "member", "fieldof":
				// computed elements ride as words (captures/reads)
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
		p.registerVar(rhs.args[0].name, "Array")
		return []map[string]any{assignStmt(rhs.args[0].name, map[string]any{
			"type": "Call", "func": "setArrayAppend",
			"args":   []any{strExpr(rhs.args[0].name), map[string]any{"type": "Array", "elements": elems}},
			"purity": "Emulable",
		})}
		if len(appendPre) > 0 {
			return append(appendPre, []map[string]any{assignStmt(rhs.args[0].name, map[string]any{
				"type": "Call", "func": "setArrayAppend",
				"args":   []any{strExpr(rhs.args[0].name), map[string]any{"type": "Array", "elements": elems}},
				"purity": "Emulable",
			})}...)
		}
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
			p.failf("unsupported type assertion to %q (v2)", rhs.typeName)
		}
		w := p.exprToWord(rhs)
		vName, okName := targets[0], targets[1]
		p.registerVar(vName, "Str")
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

	// comma-ok MAP read: v, ok := m[k] — v gets the element, ok gets
	// presence as a textual bool (JS != "" coerces to true/false)
	if len(targets) == 2 && rhs.kind == "index" {
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
		var body []map[string]any
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

	// single assign
	var w map[string]any
	if rhs.kind == "binop" || rhs.kind == "not" {
		// boolean expressions as VALUES (empty := a == b): native BinOp;
		// the target registers Bool so later bare-var conditions gate
		if ww, ok := p.condOperandA1Word(rhs); ok {
			w = ww
			p.registerVar(targets[0], "Bool")
		} else {
			p.failf("unsupported comparison in word position (v2)")
		}
	}
	if w == nil {
		w = p.exprToWord(rhs)
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
				p.varStruct[p.resolveVar(targets[0])] = sig[1]
			}
			// a user func returning a SLICE ([]T): the target is an
			// Array-typed store var, so ranging/slicing it lowers through
			// the proven param("slice", …) shapes (`args := p.parseArgs()`
			// then `range args[1:]` — go-sh.go's own parseAppendIntoList)
			if sig, ok := p.fnSig[tn]; ok && strings.HasPrefix(sig[1], "[]") {
				p.registerVar(targets[0], "Array")
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
		return []map[string]any{assignStmt(targets[0],
			arithWrap(arithBin(arithVar(targets[0]), "+", p.exprToArith(rhs))))}
	}
	// inside a func: `name := lit` on a fresh var → local name=lit
	if p.inFunc && op == ":=" && !p.fnParams[targets[0]] && !p.outer[targets[0]] && !p.fnLocals[targets[0]] {
		p.fnLocals[targets[0]] = true
		// bool literals register as Bool so bare-var conditions lower to
		// `"$x" = "true"` (the comma-ok idiom's gate)
		if ww, ok := w["value"].(string); ok && (ww == "true" || ww == "false") {
			p.registerVar(targets[0], "Bool")
		}
		return []map[string]any{execStmt("local",
			[]map[string]any{strExpr(targets[0] + "=" + localVal(w))}, "Emulable")}
	}
	p.registerVar(targets[0], p.wordType(w))
	return []map[string]any{assignStmt(targets[0], w)}
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
			typ = t.text
		}
		p.skipNL()
	}
	p.expect(tPunct, "{")
	var elems []map[string]any
	for {
		p.skipNL()
		if p.atPunct("}") {
			p.pos++
			break
		}
		e := p.parseExpr()
		elems = append(elems, p.exprToArrayElem(e))
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

// readFileIfCond: the `if b, err := os.ReadFile(p); err (==|!=) nil`
// cond — byte-identical to the core's `if b=$(cat p); then` /
// `if ! b=$(cat p); then` lowering (verified against `debashc file
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
	if p.atIdent("_") && !(p.toks[p.pos+2].kind == tIdent && p.toks[p.pos+2].text != "err") {
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
	} else if name, ok := p.ifInitReadFileAhead(); ok {
		// if b, err := os.ReadFile(path); err == nil { — the if-init
		// whole-file read: the read's SUCCESS is the branch condition,
		// the `if b=$(cat p); then` shape (Call func=assign wrapping a
		// Capture — byte-identical to the core's own lowering of the
		// shell form, verified against debashc file --shir). err == nil
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
	out2 := pre
	out2 = append(out2, map[string]any{
		"type":   "If",
		"cond":   p.condToJSON(cond),
		"then":   then,
		"elsifs": []any{},
		"else":   elseBody,
	})
	return out2
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
		var lenExpr map[string]any
		switch {
		case rv.kind == "var" && !p.maps[rv.name] && p.varTypes[p.resolveVar(rv.name)] == "Array":
			lenExpr = joinCall(paramCall("slice", "#"+p.resolveVar(rv.name), "@", ""))
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
			"type":   "Assign",
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
						"type":   "Assign",
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
					"type":   "Assign",
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
				"type":   "Assign",
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
		if rv.kind != "var" {
			p.failf("range over a non-var (v2)")
		}
		name := p.resolveVar(rv.name)
		p.registerVar(idxName, "Int")
		elemTyp := "Str"
		if info, ok := p.arrays[name]; ok {
			elemTyp = info.typ
		}
		p.registerVar(valName, elemTyp)
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
				"type":   "Assign",
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
		} else {
			rv := p.parseExpr()
			if rv.kind != "var" {
				// VAR SLICE (`for _, a := range args[1:]` — a slice of a
				// known Array-typed store var): the For iter is the single
				// array-valued param("slice", name, lo, "") element the
				// runtime's forLoop flattens (the same contract as ranging
				// the whole array)
				if rv.kind == "slice" && rv.target != nil && rv.target.kind == "var" &&
					p.varTypes[p.resolveVar(rv.target.name)] == "Array" {
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
							"type":   "Assign",
							"targets": []any{map[string]any{"var": cnt2, "sigil": nil, "indices": []any{}}},
							"expr": map[string]any{
								"type": "Arith",
								"ast":  map[string]any{"type": "IncDec", "var": cnt2, "delta": 1, "prefix": false},
							},
						}}
						b2 := []map[string]any{assignStmt(v, map[string]any{
							"type":     "Call",
							"func":     "listGet",
							"args":     []any{lw, getVarExpr(cnt2 + "+" + lo)},
							"purity":   "PureCpu",
						})}
						b2 = append(b2, p.parseBlockStmts()...)
						return []map[string]any{{
							"type": "ForInit",
							"init": init2, "cond": cond2, "step": step2, "body": b2,
						}}
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
							"type":   "Assign",
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
				lw2 := map[string]any{
					"type": "Call", "func": "strSplit",
					"args":   []any{p.exprToWord(rv), strExpr("\n")},
					"purity": "PureCpu",
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
					"type":   "Assign",
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
						"type":   "Assign",
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
				body := p.parseBlockStmts()
				p.registerVar(v, "Str")
				return []map[string]any{{
					"type": "For",
					"var":  v,
					"iter": map[string]any{"type": "Array", "elements": []any{
						paramCall("slice", rv.name, "@", ""),
					}},
					"body": body,
				}}
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
					"type":   "Assign",
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
		return []map[string]any{{
			"type": "For",
			"var":  v,
			"iter": map[string]any{"type": "Array", "elements": elems},
			"body": body,
		}}
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
		if cond == nil {
			cond = &expr{kind: "cond", text: "true"}
		}
		if !p.atPunct("{") {
			postName := p.expect(tIdent, "").text
			postDelta := 1
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
				c := p.parseExpr()
				p.expect(tPunct, ":")
				conds = append(conds, c)
				bodies = append(bodies, p.parseSwitchBody())
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
			nest = []map[string]any{{
				"type":   "If",
				"cond":   p.condToJSON(conds[i]),
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
	// value switch (existing path)
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
	return []map[string]any{{
		"type":         "Case",
		"discriminant": p.exprToWord(disc),
		"clauses":      clauses,
	}}
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
func (p *parser) returnToStmt(e *expr) map[string]any {
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

// userCallWord: a defined sub called in WORD position — the
// capture(Arrow(exec ...)) shape (the value-return protocol's read side).
func (p *parser) userCallWord(name string, args []*expr) map[string]any {
	var words []map[string]any
	for _, a := range args {
		words = append(words, p.argToWord(a))
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
		p.varStruct[rn] = ret
	}
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
	return p.exprToWord(e)
}

// exprToWord lowers an expression to its A1 word JSON.
func (p *parser) exprToWord(e *expr) map[string]any {
	switch e.kind {
	case "str":
		return interpLit(e.text)
	case "rawstr":
		return interpLit(e.text)
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
	case "assert":
		// TypeAssert ext node — checked passthrough; kind vocabulary =
		// sh2.typeOf strings. Named/unknown types refuse (goTypeKind).
		k := goTypeKind(e.typeName)
		if k == "" {
			p.failf("unsupported type assertion to %q (v2) — named types have no knowable dynamic kind", e.typeName)
		}
		return map[string]any{
			"type": "TypeAssert", "expr": p.exprToWord(e.lhs), "kind": k,
		}
	case "maplit":
		// MapLiteral ext node — parallel keys/values lists (transient
		// anonymous dict VALUE; read back via ElementRead).
		var keys, vals []any
		for i := range e.keys {
			keys = append(keys, p.exprToWord(e.keys[i]))
			vals = append(vals, p.exprToWord(e.vals[i]))
		}
		return map[string]any{
			"type": "MapLiteral", "keys": keys, "values": vals,
		}
	case "index":
		// m["key"] on a map var → assocGet (the runtime's by-name
		// associative-array read; t54).
		if e.target != nil && e.target.kind == "var" && p.maps[e.target.name] {
			key := ""
			if e.idx1e != nil {
				if e.idx1e.kind != "str" && e.idx1e.kind != "num" {
					p.failf("map key must be a literal (v2)")
				}
				key = e.idx1e.text
			} else {
				key = e.idx1
			}
			return map[string]any{
				"type": "Call", "func": "assocGet",
				"args":   []any{strExpr(e.target.name), strExpr(key)},
				"purity": "Emulable",
			}
		}
		// indexing a STRUCT FIELD that is a list/map (`l.toks[p.pos]`,
		// `m.varTypes[name]`) — the OBJECT STORE accessors
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
				if e.target == nil || e.target.kind != "var" {
					p.failf("unsupported index key (v2) — must be a number literal")
				}
				key := p.arithKeyText(e.idx1e)
				name := p.resolveVar(e.target.name)
				if p.varTypes[name] == "Str" {
					return joinCall(paramCall("slice", name, key, "1"))
				}
				return getVarExpr(name + "[" + key + "]")
			}
		}
		if e.target != nil && e.target.kind == "var" {
			return joinCall(paramCall("", e.target.name+"["+e.idx1+"]"))
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
				"coll":  p.exprToWord(e.target),
				"key":   strExpr(key),
			}
		}
		p.failf("index target must be a var (v2)")
	case "slice":
		if e.target != nil && e.target.kind == "var" {
			return p.sliceWord(e)
		}
		// non-var slice target (`raws[off][vi+1:]` — an element read
		// sliced): the drop-in SubStrExtract ext node. Go string-slice
		// semantics: [lo:hi] = bytes lo..hi-1; a missing bound runs to
		// the end (length omitted → SubStrExtract's to-end form).
		if e.target != nil {
			offW := map[string]any{"type": "Num", "value": 0}
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
				node["length"] = p.exprToWord(&expr{kind: "add", op: "-", lhs: e.idx2e, rhs: e.idx1e})
			} else if e.idx2 != "" {
				var loN int
				if n, err := strconv.Atoi(e.idx1); err == nil {
					loN = n
				}
				if hiN, err := strconv.Atoi(e.idx2); err == nil {
					node["length"] = map[string]any{"type": "Num", "value": hiN - loN}
				}
			}
			return node
		}
		p.failf("slice target must be a var (v2)")
	case "strlen":
		if e.target != nil && e.target.kind == "var" {
			return paramCall("len", e.target.name)
		}
		// len("lit") — folded at emit time with Go's byte-length
		// semantics, matching the native run exactly (t75).
		if e.target != nil && (e.target.kind == "str" || e.target.kind == "rawstr") {
			return strExpr(strconv.Itoa(len(e.target.text)))
		}
		p.failf("len() arg must be a var (v2)")
	case "arrlen":
		if e.target != nil && e.target.kind == "var" {
			return joinCall(paramCall("slice", "#"+e.target.name, "@", ""))
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
		switch e.callee {
		case "os.Getenv":
			if len(e.args) == 1 && e.args[0].kind == "str" {
				return getVarExpr(e.args[0].text)
			}
			p.failf("os.Getenv needs a string literal (v2)")
		case "strings.ReplaceAll":
			// ReplaceAll(s, old, new) → ${s//old/new} (ALL occurrences)
			if len(e.args) == 3 && e.args[0].kind == "var" &&
				e.args[1].kind == "str" && e.args[2].kind == "str" {
				return paramCall("//", e.args[0].name, e.args[1].text, e.args[2].text)
			}
			p.failf("strings.ReplaceAll needs (var, str, str) (v2)")
		case "strings.TrimPrefix", "strings.TrimSuffix":
			// TrimPrefix(s, p) → ${s#p} — remove ONE leading literal
			// (bash `#` strips a single occurrence; a glob-metachar p
			// would glob-match in the shell, so literals only).
			if len(e.args) == 2 {
				prefix := e.callee == "strings.TrimPrefix"
				if e.args[0].kind == "var" && e.args[1].kind == "str" {
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
			// Any other separator ("\n" — the app's dominant form,
			// bat-sh-go's `strings.Join(bodyLines, "\n")`) has no
			// separator arg on the A1 join — declared boundary
			// (core-requests go-sh-dogfood-20260815 §8); refuse loudly.
			p.failf(`strings.Join needs (arr[lo:hi]|arr, " ") (v2)`)
		case "filepath.Dir", "filepath.Ext":
			// Pure path ops on string literals — folded at emit time with
			// exact Go stdlib semantics (t55).
			if len(e.args) == 1 && e.args[0].kind == "str" {
				if w, ok := foldPureLiteralCall(e.callee, e.args); ok {
					return strExpr(w)
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
			p.failf("%s needs (var|str) args (v2)", e.callee)
		case "strings.Contains", "strings.HasSuffix":
			if w, ok := foldPureLiteralCall(e.callee, e.args); ok {
				return strExpr(w)
			}
			p.failf("%s needs literal args (v2)", e.callee)
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
				words = append(words, getVarExpr(p.resolveVar(e.args[0].name)))
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
		} else if p.fnNames[e.callee] {
			return p.userCallWord(e.callee, e.args)
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
	case "structlit":
		// a struct literal as a VALUE: inline allocation — objNew
		// returns the reference id word
		return p.objNewCall(e)
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
		p.failf("unsupported comparison in word position (v2)")
	}
	p.failf("unsupported expression %q (v2 subset)", e.kind)
	return nil
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
		return strings.HasPrefix(e.callee, "strings.")
	}
	return false
}

// valueWord: an expression whose value is a REFERENCE ID (user-fn /
// method captures, fieldof chains, struct-typed vars) as one word.
func (p *parser) valueWord(e *expr) map[string]any {
	switch e.kind {
	case "call":
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
	name := e.target.name
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
		return p.addHasString(e.lhs) || p.addHasString(e.rhs)
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
		p.addConcatParts(e.lhs, parts)
		p.addConcatParts(e.rhs, parts)
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
		return arithBin(p.exprToArith(e.lhs), e.op, p.exprToArith(e.rhs))
	case "neg":
		return arithBin(arithNum(0), "-", p.exprToArith(e.lhs))
	case "str":
		if n, err := strconv.Atoi(e.text); err == nil {
			return arithNum(n)
		}
	case "strlen":
		// len(s) over a STRING in arithmetic — the ${#s} length read
		// (getVar("#s") counts chars/bytes)
		if e.target != nil && e.target.kind == "var" {
			return arithVar("#" + p.resolveVar(e.target.name))
		}
	case "arrlen":
		if e.target != nil && e.target.kind == "var" {
			return arithVar("${#" + p.resolveVar(e.target.name) + "[@]}")
		}
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
	}
	p.failf("unsupported array element %q (v2)", e.kind)
	return nil
}

func (p *parser) switchPattern(e *expr) string {
	switch e.kind {
	case "str", "num", "var":
		return e.text
	}
	p.failf("unsupported case pattern (v2)")
	return ""
}

// ── condition lowering ──────────────────────────────────────────────

func (p *parser) condToJSON(c *expr) map[string]any {
	if c.kind == "cond" {
		return testCall(c.text)
	}
	if c.kind == "rawjson" {
		return c.rawJSON
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
	if c.kind == "call" && c.callee == "strings.Contains" {
		if len(c.args) != 2 || c.args[1].kind != "str" {
			p.failf("strings.Contains needs (haystack, str needle) (v2)")
		}
		hk := c.args[0].kind
		if hk != "var" && hk != "str" && hk != "num" {
			p.failf("strings.Contains haystack must be var|str|num (v2): %s", hk)
		}
		return testCall(p.condOperandQ(c.args[0]) + "=*" + c.args[1].text + "*")
	}
	// COMPARISON over OBJECT reads (`l.cur().kind != "eof"`): the
	// native A1 BinOp — runtime values are words, so Eq/Ne render as
	// plain JS ==/!=. Plain store-var operands keep the [ ] test shapes.
	if c.kind == "binop" && c.BOpKind == "cmp" {
		if s := p.operandDesc(c.rhs); strings.Contains(s, "lhs") {
		}
		lw, lok := p.condOperandA1Word(c.lhs)
		rw, rok := p.condOperandA1Word(c.rhs)
		op := map[string]string{"==": "Eq", "!=": "Ne", "<": "Lt", ">": "Gt", "<=": "Le", ">=": "Ge"}[c.BOp]
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
	// engine sees it — t68).
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
		if len(c.args) != 2 || c.args[0].kind != "var" || c.args[1].kind != "str" {
			p.failf("%s needs (var, str) (v2)", c.callee)
		}
		pat := c.args[1].text
		if c.callee == "strings.HasSuffix" {
			pat = "*" + pat
		} else {
			pat = pat + "*"
		}
		return testCall(p.condOperandQ(c.args[0]) + "=" + pat)
	}
	return testCall(p.condTestString(c))
}

// condTestString renders a comparison as the core's [ ] argument string
// (the `"$X"="1"` / `1 -lt 2` / ` -z "$X"` shapes).
func (p *parser) condTestString(c *expr) string {
	if c.kind == "call" {
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
		return `"$` + p.resolveVar(c.name) + `"="true"`
	}
	if c.kind != "binop" {
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
		return p.condOperandArg(l) + " -lt " + p.condOperandArg(r)
	case "<=":
		return p.condOperandArg(l) + " -le " + p.condOperandArg(r)
	case ">":
		return p.condOperandArg(l) + " -gt " + p.condOperandArg(r)
	case ">=":
		return p.condOperandArg(l) + " -ge " + p.condOperandArg(r)
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
	case "var":
		name := p.resolveVar(e.name)
		if n, ok := p.paramNumber(name); ok {
			return getVarExpr(strconv.Itoa(n))
		}
		return getVarExpr(name)
	case "num":
		return strExpr(e.text)
	case "member":
		if w, ok := p.structMemberWord(e.name); ok {
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
		"type": "MethodCall", "obj": p.exprToWord(e.args[0]),
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
	case "member":
		if w, tag := p.structFieldWord(e.name); tag != "none" {
			return w, true
		}
		return nil, false
	case "fieldof":
		return p.valueWord(e), true
	case "call":
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
			name := p.resolveVar(e.target.name)
			if p.varTypes[name] == "Array" {
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
		if e.target != nil && e.target.kind == "member" {
			if w, tag := p.structFieldWord(e.target.name); tag != "none" {
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
			return joinCall(paramCall("slice", "#"+p.resolveVar(e.target.name), "@", "")), true
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
		// plain store indexing in conditions: `src[i+1] == '/'`
		if e.target != nil && e.target.kind == "var" {
			name := p.resolveVar(e.target.name)
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
			if p.varTypes[name] == "Str" {
				// single-element read (${s:$k:1}); Go bytes = chars on
				// the ASCII corpus (documented caveat)
				return joinCall(paramCall("slice", name, key, "1")), true
			}
			return getVarExpr(name + "[" + key + "]"), true
		}
		return nil, false
	}
	return nil, false
}

// condOperandQ: `==`/`!=` operand — quoted: `"$x"` / `"lit"` / `"42"`.
func (p *parser) condOperandQ(e *expr) string {
	switch e.kind {
	case "var":
		return `"$` + p.resolveVar(e.name) + `"`
	case "str":
		return `"` + e.text + `"`
	case "num":
		return `"` + e.text + `"`
	case "arrlen":
		// len(arr) → the `${#arr[@]}` length word, quoted like `"$x"`
		// (the statement-position lowering at emitExpr uses the same
		// shape via join(param("slice", "#arr", "@", ""))).
		return `"${#` + p.resolveVar(e.target.name) + `[@]}"`
	case "index":
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
			name := p.resolveVar(e.target.name)
			key := e.idx1
			if e.idx1e != nil {
				// computed subscript (`s[i] == "x"`): arith text resolved
				// by evalArith inside the quoted word's expansion
				key = p.arithKeyText(e.idx1e)
				if p.varTypes[name] == "Str" {
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
		return `"$` + p.resolveVar(e.name) + `"`
	case "str":
		return `"` + e.text + `"`
	case "num":
		return e.text
	case "arrlen":
		// len(arr) in a numeric comparison — the quoted length word
		// (e.g. `"${#arr[@]}" -gt 1`; a bare ${#arr[@]} would need the
		// word-splitting the quoted form avoids).
		return `"${#` + p.resolveVar(e.target.name) + `[@]}"`
	case "index":
		// a[0] in a numeric comparison — the quoted element word
		// (`[ "${a[0]}" -gt 1 ]`; bare would need the word-splitting
		// the quoted form avoids). Literal keys only, like the
		// statement-position lowering (exprToWord).
		if e.target != nil && e.target.kind == "var" {
			if p.maps[e.target.name] {
				p.failf("map key in comparison unsupported (v2)")
			}
			name := p.resolveVar(e.target.name)
			key := e.idx1
			if e.idx1e != nil {
				// computed subscript (`s[i] == "x"`): arith text resolved
				// by evalArith inside the quoted word's expansion
				key = p.arithKeyText(e.idx1e)
				if p.varTypes[name] == "Str" {
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
			// capture the RETURN type's base ident for result-typing
			j++
			k := j
			for k < len(p.toks) && !(p.toks[k].kind == tPunct && p.toks[k].text == "{") && p.toks[k].kind != tNL && p.toks[k].kind != tEOF {
				if p.toks[k].kind == tIdent {
					base := p.toks[k].text
					if p.varStruct != nil || true {
						_ = base
					}
					// record provisional ret type (resolved against
					// structs at use time)
					p.prescanRet[name] = base
				}
				k++
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
		toks:      toks,
		varTypes:  map[string]string{},
		consts:    map[string]int{},
		constStrs: map[string]string{},
		arrays:    map[string]arrayInfo{},
		maps:      map[string]bool{},
		bufs:      map[string]string{},
		cmds:      map[string][]*expr{},
		stdinRdr:  map[string]bool{},
		fnNames:   map[string]bool{},
		outer:     map[string]bool{},
		varAlias:  map[string]string{},
		structs:   map[string][]string{},
		structFT:  map[string][]string{},
		structRaw: map[string][]string{},
		bufDyn:    map[string]bool{},
		prescanRet: map[string]string{},
		pkgNames:   map[string]bool{},
		varStruct: map[string]string{},
		fnSig:     map[string][2]string{},
	}
	p.prescanFuncNames()

	stmts, err := p.run()
	if err != nil {
		return nil, err
	}
	prog := &shiremit.Program{Stmts: stmts}
	return shiremit.Emit(prog)
}

// run drives the parser with panic-based error recovery.
func (p *parser) run() (stmts []map[string]any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return p.parseTopLevel(), nil
}
