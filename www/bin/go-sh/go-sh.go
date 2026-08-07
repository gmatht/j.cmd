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
// (→ seq Range when numeric), switch/case/default, func literals
// (params -> $1.., fresh vars -> `local`), go-func background,
// raw-string heredocs, comments, shebang.
//
// Refuse > guess: anything outside the subset is a hard error (the gate
// reports FAIL), never a silent mis-lowering.
package golib

import (
	"fmt"
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

var multiOps = []string{":=", "==", "!=", "<=", ">=", "&&", "||", "+=", "++"}

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
	return map[string]any{
		"type": "Arith",
		"ast":  map[string]any{"type": "Bin", "lhs": lhs, "op": op, "rhs": rhs},
	}
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
func execStmt(cmd string, words []map[string]any, purity string) map[string]any {
	elems := make([]any, len(words))
	for i, w := range words {
		elems[i] = w
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
// "arrlen" "call" "func".
type expr struct {
	kind string
	// str/num
	text string
	raw  string // printf-format raw text
	// var
	name string
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
	callee string
	args   []*expr
	// func literal (lowered body, params in args)
	body   []map[string]any
	params []string
}

// ─────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────

type parser struct {
	toks []token
	pos  int
	// semantic side-state (the Go subset's shell-shaped meanings)
	varTypes   map[string]string // name -> "Int" | "Str" | "Array"
	arrays     map[string]arrayInfo
	cmds       map[string][]*expr // cmd := exec.Command(...) -> args
	stdinRdr   map[string]bool    // r := bufio.NewReader(os.Stdin)
	fnNames    map[string]bool    // f := func(...){...} — callable subs
	outer      map[string]bool    // vars assigned at top level
	fnParams   map[string]bool    // inside a func literal
	fnParamOrd []string           // ordered param names -> $1..
	fnLocals   map[string]bool
	inFunc     bool
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
		l = &expr{kind: "binop", BOp: "||", BOpKind: "or", lhs: l, rhs: p.parseAnd()}
	}
	return l
}

func (p *parser) parseAnd() *expr {
	l := p.parseCmp()
	for p.atPunct("&&") {
		p.pos++
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
			nm := p.expect(tIdent, "").text
			e = &expr{kind: "member", name: callName(e) + "." + nm}
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
			return &expr{kind: "strlen", target: arg}
		case "string":
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
	}
	p.failf("unexpected token %q in expression", t.text)
	return nil
}

// ── func literals ───────────────────────────────────────────────────

// parseFuncLit parses `func(params) [ret] { body }` with the function
// scope active (params -> $1.., fresh vars -> local) and returns an expr
// carrying the lowered body.
func (p *parser) parseFuncLit() *expr {
	p.expect(tIdent, "func")
	p.expect(tPunct, "(")
	params := p.parseFuncParams()
	p.skipNL()
	// optional return type: ident | (a, b) | []T | *T
	for p.tok().kind == tIdent && p.tok().text != "{" {
		p.pos++
		p.skipNL()
	}
	for p.atPunct("(") || p.atPunct("[") || p.atPunct("*") {
		p.pos++
		p.skipNL()
		for p.tok().kind == tIdent {
			p.pos++
		}
		p.skipNL()
	}
	p.skipNL()
	// function scope
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

func (p *parser) parseFuncParams() []string {
	var params []string
	p.skipNL()
	for !p.atPunct(")") {
		if p.atPunct("(") {
			p.pos++
			params = append(params, p.parseFuncParams()...)
			continue
		}
		nm := p.expect(tIdent, "").text
		// skip the type (ident, possibly bracketed/pointer)
		for p.tok().kind == tIdent {
			p.pos++
		}
		for p.atPunct("[") || p.atPunct("*") || p.atPunct("]") || p.atPunct(",") || p.atPunct("(") || p.atPunct(")") {
			break
		}
		params = append(params, nm)
		if p.acceptPunct(",") {
			p.skipNL()
		}
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
		case p.atIdent("package") || p.atIdent("import") || p.atIdent("func"):
			p.pos++
			p.skipToLineEnd()
		default:
			out = append(out, p.parseStmt()...)
		}
	}
}

func (p *parser) skipToLineEnd() {
	for p.tok().kind != tNL && p.tok().kind != tEOF {
		p.pos++
	}
}

func (p *parser) parseStmt() []map[string]any {
	p.skipNL()
	t := p.tok()
	if t.kind != tIdent {
		p.failf("unrecognized statement starting with %q", t.text)
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
		return []map[string]any{p.returnToStmt(p.parseExpr())}
	case "go":
		return p.parseGo()
	case "case", "default":
		p.failf("'%s' outside switch", t.text)
	}
	if p.toks[p.pos+1].kind == tPunct && p.toks[p.pos+1].text == "." {
		return p.parseDottedStmt()
	}
	return p.parseAssignStmt()
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
	case "fmt.Printf":
		return p.printfStmt()
	case "os.WriteFile":
		return p.writeFileStmt()
	case "os.Setenv":
		return p.setenvStmt()
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
	p.failf("unsupported call %s.%s (v2)", first, method)
	return nil
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
			words = append(words, p.exprToWord(a))
		}
		return []map[string]any{execStmt(args[0].callee, words, "Spawn")}
	}
	var words []map[string]any
	if len(args) > 1 {
		// fmt.Println(a, b) → echo "$a" "$b": Go separates operands with a
		// space, which IS shell word separation — one word per operand
		// (t40 fixes the old interpParts concat that printed "$i$j").
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
				words = append(words, p.exprToWord(a))
			}
		}
	} else {
		words = []map[string]any{p.exprToWord(args[0])}
	}
	return []map[string]any{execStmt("echo", words, "Emulable")}
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

func (p *parser) parseAssignStmt() []map[string]any {
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
	// indexed assign: a[1] = "X" → target var "a[1]" (the `arr[1]=X` shape)
	if p.atPunct("[") {
		if len(targets) != 1 {
			p.failf("indexed assign with multiple targets (v2)")
		}
		p.pos++
		idx := p.expect(tNum, "").text
		p.expect(tPunct, "]")
		targets[0] = targets[0] + "[" + idx + "]"
	}
	// function call statement: f(args)
	if p.atPunct("(") {
		p.pos++
		args := p.parseArgs()
		var words []map[string]any
		for _, a := range args {
			words = append(words, p.exprToWord(a))
		}
		return []map[string]any{execStmt(targets[0], words, "Spawn")}
	}
	// x++
	if p.atPunct("++") {
		p.pos++
		if len(targets) != 1 {
			p.failf("++ needs one target")
		}
		p.registerVar(targets[0], "Int")
		return []map[string]any{assignStmt(targets[0],
			arithBin(arithVar(targets[0]), "+", arithNum(1)))}
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
	// array literal: name := []T{...}
	if p.atPunct("[") {
		elems, typ := p.parseArrayLiteral()
		p.arrays[targets[0]] = arrayInfo{elems: elems, typ: typ}
		p.registerVar(targets[0], "Array")
		if len(targets) > 1 {
			p.failf("array literal with multiple targets (v2)")
		}
		return []map[string]any{assignStmt(targets[0],
			map[string]any{
				"type": "Call", "func": "setArray",
				"args":   []any{strExpr(targets[0]), map[string]any{"type": "Array", "elements": elems}},
				"purity": "Emulable",
			})}
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

	// generic RHS
	rhs := p.parseExpr()

	// a = append(a, "c", "d") → setArrayAppend (the `arr+=(c d)` shape)
	if rhs.kind == "call" && rhs.callee == "append" {
		if len(rhs.args) < 2 || rhs.args[0].kind != "var" {
			p.failf("append needs (array, elems...) (v2)")
		}
		var elems []any
		for _, a := range rhs.args[1:] {
			if a.kind != "str" && a.kind != "num" {
				p.failf("append elements must be literals (v2)")
			}
			elems = append(elems, strExpr(a.text))
		}
		p.registerVar(rhs.args[0].name, "Array")
		return []map[string]any{assignStmt(rhs.args[0].name, map[string]any{
			"type": "Call", "func": "setArrayAppend",
			"args":   []any{strExpr(rhs.args[0].name), map[string]any{"type": "Array", "elements": elems}},
			"purity": "Emulable",
		})}
	}

	// err := cmd.Run() — exec the stored command
	if rhs.kind == "call" && strings.HasSuffix(rhs.callee, ".Run") {
		base := strings.TrimSuffix(rhs.callee, ".Run")
		if args, ok := p.cmds[base]; ok {
			return []map[string]any{p.execFromArgs(args)}
		}
		p.failf("unknown command %q (v2)", base)
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
			w := p.exprToWord(values[i])
			p.registerVar(tg, p.wordType(w))
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

	// single assign
	w := p.exprToWord(rhs)
	if op == "+=" {
		p.registerVar(targets[0], "Int")
		return []map[string]any{assignStmt(targets[0],
			arithBin(arithVar(targets[0]), "+", p.exprToArith(rhs)))}
	}
	// inside a func: `name := lit` on a fresh var → local name=lit
	if p.inFunc && op == ":=" && !p.fnParams[targets[0]] && !p.outer[targets[0]] && !p.fnLocals[targets[0]] {
		p.fnLocals[targets[0]] = true
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

func (p *parser) parseIf() []map[string]any {
	p.expect(tIdent, "if")
	p.skipNL()
	var pre []map[string]any
	var cond *expr
	if p.atIdent("_") {
		// if _, err := os.Stat("path"); err == nil { → test("-f path")
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
		if c := p.condTestString(cond); strings.HasPrefix(c, "! ") {
			neg = true
		}
		arg := "-f " + decodeGoStr(pathTok.raw)
		if neg {
			arg = "! -f " + decodeGoStr(pathTok.raw)
		}
		cond = &expr{kind: "cond", text: arg}
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
	return append(pre, map[string]any{
		"type":   "If",
		"cond":   p.condToJSON(cond),
		"then":   then,
		"elsifs": []any{},
		"else":   elseBody,
	})
}

func (p *parser) parseFor() []map[string]any {
	p.expect(tIdent, "for")
	p.skipNL()
	// range forms
	if p.atIdent("_") || p.atIdent("range") {
		var v string
		if p.atIdent("_") {
			p.pos++
			p.expect(tPunct, ",")
			p.skipNL()
			v = p.expect(tIdent, "").text
			p.expect(tPunct, ":=")
		} else {
			v = p.expect(tIdent, "").text
			p.expect(tPunct, ":=")
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
				p.failf("range over a non-var (v2)")
			}
			info, ok := p.arrays[rv.name]
			if !ok {
				p.failf("range over unknown array %q (v2)", rv.name)
			}
			iter, typ = info.elems, info.typ
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
		cond := p.parseExpr()
		p.expect(tPunct, ";")
		p.skipNL()
		postName := p.expect(tIdent, "").text
		p.expect(tPunct, "++")
		post := []map[string]any{assignStmt(postName,
			arithBin(arithVar(postName), "+", arithNum(1)))}
		body := p.parseBlockStmts()
		// `i := N; i <= M; i++` (or `i < M`) → the core's For Range
		// (`for i in $(seq N M)`) shape — byte-identical lowering.
		if rhs.kind == "num" && initName == postName &&
			cond.kind == "binop" && cond.BOpKind == "cmp" &&
			cond.lhs.kind == "var" && cond.lhs.name == initName &&
			cond.rhs.kind == "num" {
			if start, err := strconv.Atoi(rhs.text); err == nil {
				if end, err2 := strconv.Atoi(cond.rhs.text); err2 == nil {
					if cond.BOp == "<" {
						end--
					}
					if cond.BOp == "<" || cond.BOp == "<=" {
						return []map[string]any{{
							"type": "For",
							"var":  initName,
							"iter": map[string]any{"type": "Range", "start": start, "end": end},
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
			if _, err := strconv.ParseInt(v, 10, 64); err == nil {
				return "Int"
			}
		}
		return "Str"
	case "Arith":
		return "Int"
	}
	return "Str"
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
		if n, ok := p.paramNumber(e.name); ok {
			return getVarExpr(strconv.Itoa(n))
		}
		return getVarExpr(e.name)
	case "member":
		p.failf("bare member %q (v2)", e.name)
	case "add", "mul", "neg":
		return p.arithOrConcat(e)
	case "index":
		if e.idx1e != nil {
			p.failf("index key must be a number literal (v2)")
		}
		if e.target != nil && e.target.kind == "var" {
			return joinCall(paramCall("", e.target.name+"["+e.idx1+"]"))
		}
		p.failf("index target must be a var (v2)")
	case "slice":
		if e.target != nil && e.target.kind == "var" {
			return p.sliceWord(e)
		}
		p.failf("slice target must be a var (v2)")
	case "strlen":
		if e.target != nil && e.target.kind == "var" {
			return paramCall("len", e.target.name)
		}
		p.failf("len() arg must be a var (v2)")
	case "arrlen":
		if e.target != nil && e.target.kind == "var" {
			return joinCall(paramCall("slice", "#"+e.target.name, "@", ""))
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
		case "strings.TrimPrefix":
			// TrimPrefix(s, p) → ${s#p} — remove ONE leading literal
			// (bash `#` strips a single occurrence; a glob-metachar p
			// would glob-match in the shell, so literals only).
			if len(e.args) == 2 && e.args[0].kind == "var" && e.args[1].kind == "str" {
				return paramCall("#", e.args[0].name, e.args[1].text)
			}
			p.failf("strings.TrimPrefix needs (var, str) (v2)")
		case "strings.TrimSuffix":
			// TrimSuffix(s, p) → ${s%p} — remove ONE trailing literal.
			if len(e.args) == 2 && e.args[0].kind == "var" && e.args[1].kind == "str" {
				return paramCall("%", e.args[0].name, e.args[1].text)
			}
			p.failf("strings.TrimSuffix needs (var, str) (v2)")
		case "strings.Join":
			// Join(arr[lo:hi], " ") → ${arr[@]:lo:len} joined with a space
			// — exactly the A1 join(param("slice", …)) shape (the runtime
			// joins arrays with " ", matching Go's space separator).
			if len(e.args) == 2 && e.args[1].kind == "str" && e.args[1].text == " " &&
				e.args[0].kind == "slice" && e.args[0].target != nil && e.args[0].target.kind == "var" {
				return p.sliceWord(e.args[0])
			}
			p.failf(`strings.Join needs (arr[lo:hi], " ") (v2)`)
		}
		// sc.Text() inside a scanner read-loop → the read var
		if strings.HasSuffix(e.callee, ".Text") {
			base := strings.TrimSuffix(e.callee, ".Text")
			if p.stdinRdr[base] {
				return getVarExpr(base)
			}
		}
		p.failf("unsupported call %q in word position (v2)", e.callee)
	case "binop":
		p.failf("comparison in word position (v2)")
	}
	p.failf("unsupported expression %q (v2 subset)", e.kind)
	return nil
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
	if e.idx1e != nil || e.idx2e != nil {
		p.failf("unsupported computed slice bound (v2)")
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
	if e.kind == "add" && p.addHasString(e) {
		var parts []any
		p.addConcatParts(e, &parts)
		return interpParts(parts)
	}
	return p.exprToArith(e)
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
		return e.name == "nil" || p.varTypes[e.name] == "Str"
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
		switch p.varTypes[e.name] {
		case "Str":
			return "str"
		case "Int":
			return "int"
		}
		return "int"
	}
	return "int"
}

func (p *parser) exprToArith(e *expr) map[string]any {
	switch e.kind {
	case "num":
		if n, err := strconv.Atoi(e.text); err == nil {
			return arithNum(n)
		}
		p.failf("non-integer numeric literal %q (v2)", e.text)
	case "var":
		if n, ok := p.paramNumber(e.name); ok {
			return arithVar(strconv.Itoa(n))
		}
		return arithVar(e.name)
	case "add", "mul":
		return arithBin(p.exprToArith(e.lhs), e.op, p.exprToArith(e.rhs))
	case "neg":
		return arithBin(arithNum(0), "-", p.exprToArith(e.lhs))
	case "str":
		if n, err := strconv.Atoi(e.text); err == nil {
			return arithNum(n)
		}
	}
	p.failf("non-numeric operand in arithmetic (v2): %s", e.kind)
	return nil
}

func (p *parser) exprToArrayElem(e *expr) map[string]any {
	switch e.kind {
	case "str", "num", "var":
		return strExpr(e.text)
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
	if c.kind == "not" {
		return testCall("! " + strings.TrimSpace(p.condTestString(c.lhs)))
	}
	if c.kind == "binop" && c.BOpKind == "and" {
		return map[string]any{
			"type": "BinOp", "op": "And",
			"lhs": p.condToJSON(c.lhs), "rhs": p.condToJSON(c.rhs),
		}
	}
	if c.kind == "binop" && c.BOpKind == "or" {
		return map[string]any{
			"type": "BinOp", "op": "Or",
			"lhs": p.condToJSON(c.lhs), "rhs": p.condToJSON(c.rhs),
		}
	}
	// strings.Contains(haystack, needle) → the `X | grep Y` contains
	// shape (haystack: var → getVar, literal → Interpolate; needle:
	// SingleQuoted — matching the core).
	if c.kind == "call" && c.callee == "strings.Contains" {
		if len(c.args) != 2 {
			p.failf("strings.Contains needs (haystack, needle) (v2)")
		}
		return map[string]any{
			"type": "Call", "func": "contains",
			"args":   []any{p.containsWord(c.args[0]), p.containsNeedle(c.args[1])},
			"purity": "PureCpu",
		}
	}
	// strings.HasPrefix(s, p) / strings.HasSuffix(s, p) → the `[[ $s ==
	// p* ]]` / `[[ $s == *p ]]` glob-test shape (the core's `$s==p*`
	// string; the operand stays quoted, the pattern bare so the glob
	// engine sees it — t68).
	if c.kind == "call" && (c.callee == "strings.HasPrefix" || c.callee == "strings.HasSuffix") {
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
	if c.kind == "cond" {
		return c.text
	}
	if c.kind == "not" {
		return "! " + strings.TrimSpace(p.condTestString(c.lhs))
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

// containsWord: the haystack word of a strings.Contains cond.
func (p *parser) containsWord(e *expr) map[string]any {
	switch e.kind {
	case "str":
		return interpLit(e.text)
	case "var":
		if n, ok := p.paramNumber(e.name); ok {
			return getVarExpr(strconv.Itoa(n))
		}
		return getVarExpr(e.name)
	}
	p.failf("unsupported contains haystack (v2): %s", e.kind)
	return nil
}

// containsNeedle: the grep pattern — a SingleQuoted Str (core shape).
func (p *parser) containsNeedle(e *expr) map[string]any {
	if e.kind != "str" {
		p.failf("contains needle must be a string literal (v2)")
	}
	return map[string]any{"type": "Str", "value": e.text, "style": "SingleQuoted"}
}

// condOperandQ: `==`/`!=` operand — quoted: `"$x"` / `"lit"` / `"42"`.
func (p *parser) condOperandQ(e *expr) string {
	switch e.kind {
	case "var":
		return `"$` + e.name + `"`
	case "str":
		return `"` + e.text + `"`
	case "num":
		return `"` + e.text + `"`
	}
	p.failf("unsupported comparison operand (v2): %s", e.kind)
	return ""
}

// condOperandArg: `-lt`-style operand — `"$x"` for vars, digits for nums.
func (p *parser) condOperandArg(e *expr) string {
	switch e.kind {
	case "var":
		return `"$` + e.name + `"`
	case "str":
		return `"` + e.text + `"`
	case "num":
		return e.text
	}
	p.failf("unsupported comparison operand (v2): %s", e.kind)
	return ""
}

// ─────────────────────────────────────────────────────────────────────
// Shir — go-sh as a library: Go source -> A1 shIR JSON bytes (no
// trailing newline). Both the CLI (cmd/go-sh) and the combined busybox
// dispatch through this single entry point.
// ─────────────────────────────────────────────────────────────────────

func Shir(src string) ([]byte, error) {
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{
		toks:     toks,
		varTypes: map[string]string{},
		arrays:   map[string]arrayInfo{},
		cmds:     map[string][]*expr{},
		stdinRdr: map[string]bool{},
		fnNames:  map[string]bool{},
		outer:    map[string]bool{},
	}
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
