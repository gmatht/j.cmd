// py-sh-go: Python source -> shIR JSON (A1 contract), ANTLR4+Go.
//
// The full antlr4-generated Python parser is TODO (grammars/ holds the
// official Python3 grammar — generation is the worker's job). This file
// is a hand-rolled recursive-descent parser + lowerer for the v1
// shell-flavored Python subset (the t01-t52 language-ladder corpus):
//
//	print(...) / f-strings / %-format       → echo / printf
//	assignments / tuple assignment           → Assign (arith via Arith)
//	os.environ reads & sets                  → getVar / Assign
//	os.system / subprocess.run / Popen       → exec / capture / Background
//	if/elif/else, while, for, def/return     → If / While / For / Function
//	lists, indexing, slicing, len            → setArray / arrayIndex /
//	                                           param("slice") / param("len")
//	with open(...) as fh: fh.write(...)      → Redirect (echo > file)
//
// The emitted A1 shIR JSON uses EXACTLY the node shapes the core's
// `debashc --shir` produces for the equivalent shell source, so the
// ESTree backend (`--shir-in-estree` + harness/estree-runner.mjs)
// renders and executes it. Only statements the ESTree renderer accepts
// are emitted (Expr/Assign/If/While/For/Function/... — the Perl-only
// Output/Warn nodes panic the ESTree backend, so they are never
// emitted here).
package pylib

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
	"strings"

	shiremit "github.com/gmatht/sh2loop/frontends/shir-emit-go"
)

// ─────────────────────────────────────────────────────────────────────
// AST
// ─────────────────────────────────────────────────────────────────────

type Expr interface{}

type LitStr struct{ Value string } // de-escaped Python string literal
type LitInt struct{ Text string }
type NameE struct{ Name string }
type BoolLit struct{ Value bool }
type FStrE struct{ Parts []FStrPart }
type FStrPart struct {
	IsLit bool
	Lit   string
	Expr  Expr
}
type BinOpE struct {
	Op       string // + - * / %
	Lhs, Rhs Expr
}
type CompareE struct {
	Op       string // == != < > <= >=
	Lhs, Rhs Expr
}
type NotE struct{ Arg Expr }
type BoolE struct {
	Op       string // and / or
	Lhs, Rhs Expr
}
type TernaryE struct{ Cond, Then, Else Expr }
type ListE struct{ Elems []Expr }
type SubscriptE struct {
	Obj        Expr
	Index      Expr // a[i] form
	SliceStart Expr // a[i:j] form (nil if absent)
	SliceEnd   Expr
}
type AttrE struct {
	Obj  Expr
	Name string
}
type Kwarg struct {
	Key   string
	Value Expr
}
type CallE struct {
	Path   []string // dotted callee: os.system → ["os","system"]
	Args   []Expr
	Kwargs []Kwarg
}
type MethodCallE struct {
	Obj  Expr
	Name string
	Args []Expr
}
type PercentE struct {
	Format Expr
	Args   []Expr
}

type Stmt interface{}

type PrintS struct{ Args []Expr }
type AssignS struct {
	Targets []string // "x" or "os.environ[K]" (the raw env name)
	Op      string   // "=" or "+="
	Expr    Expr
}
type IfS struct {
	Cond  Expr
	Then  []Stmt
	Elifs []ElifS
	Else  []Stmt
}
type ElifS struct {
	Cond Expr
	Body []Stmt
}
type WhileS struct {
	Cond Expr
	Body []Stmt
}
type ForS struct {
	Var  string
	Iter Expr
	Body []Stmt
}
type FuncS struct {
	Name   string
	Params []string
	Body   []Stmt
}
type ReturnS struct{ Value Expr }
type ExprS struct{ Expr Expr }
type WithS struct {
	Path  string
	Mode  string
	FhVar string
	Body  []Stmt
}
type ImportS struct{}
type GlobalS struct{}

// ─────────────────────────────────────────────────────────────────────
// Lexer
// ─────────────────────────────────────────────────────────────────────

type tokKind int

const (
	tIdent tokKind = iota
	tNum
	tStr
	tFStr
	tOp
	tEOF
)

type tok struct {
	kind tokKind
	text string // raw text (for str: WITH quotes; de-escaped at AST build)
	pos  int
}

type lexer struct {
	src  string
	pos  int
	toks []tok
}

func isIdentStart(c byte) bool { return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }
func isIdentChar(c byte) bool  { return isIdentStart(c) || (c >= '0' && c <= '9') }
func isDigit(c byte) bool      { return c >= '0' && c <= '9' }

// scanString scans a (possibly triple-quoted, multi-line) Python string
// literal starting at s[pos] (which is a quote char). Returns the raw
// literal including quotes.
func scanString(s string, pos int, quote byte) (string, bool) {
	triple := pos+2 < len(s) && s[pos+1] == quote && s[pos+2] == quote
	i := pos + 1
	if triple {
		i = pos + 3
	}
	for i < len(s) {
		if triple {
			if i+2 < len(s) && s[i] == quote && s[i+1] == quote && s[i+2] == quote {
				return s[pos : i+3], true
			}
		} else if s[i] == quote {
			return s[pos : i+1], true
		}
		if s[i] == '\\' && !triple {
			i += 2
			continue
		}
		i++
	}
	if triple {
		// unterminated on this line — the line-joiner already folded the
		// continuation lines in; if still unterminated, take the rest
		return s[pos:], false
	}
	return "", false
}

func lexLine(src string) []tok {
	var toks []tok
	i := 0
	n := len(src)
	for i < n {
		c := src[i]
		if c == ' ' || c == '\t' {
			i++
			continue
		}
		// f-string prefix
		if (c == 'f' || c == 'F') && i+1 < n && (src[i+1] == '"' || src[i+1] == '\'') {
			raw, ok := scanString(src, i+1, src[i+1])
			if ok {
				toks = append(toks, tok{tFStr, raw, i})
				i += 1 + len(raw) // raw starts at i+1
				continue
			}
		}
		if c == '"' || c == '\'' {
			raw, ok := scanString(src, i, c)
			if !ok {
				// fall back: treat the rest as one string (robustness)
				raw = src[i:]
			}
			toks = append(toks, tok{tStr, raw, i})
			i += len(raw)
			continue
		}
		if isIdentStart(c) {
			j := i
			for j < n && isIdentChar(src[j]) {
				j++
			}
			toks = append(toks, tok{tIdent, src[i:j], i})
			i = j
			continue
		}
		if isDigit(c) {
			j := i
			for j < n && isDigit(src[j]) {
				j++
			}
			toks = append(toks, tok{tNum, src[i:j], i})
			i = j
			continue
		}
		// operators (two-char first)
		two := ""
		if i+1 < n {
			two = src[i : i+2]
		}
		switch two {
		case "==", "!=", "<=", ">=", "+=", "**", "//":
			toks = append(toks, tok{tOp, two, i})
			i += 2
			continue
		}
		switch c {
		case '(', ')', '[', ']', ',', ':', '.', '+', '-', '*', '/', '%', '<', '>', '=':
			toks = append(toks, tok{tOp, string(c), i})
			i++
			continue
		}
		// unknown char — skip (robustness)
		i++
	}
	toks = append(toks, tok{tEOF, "", n})
	return toks
}

// ─────────────────────────────────────────────────────────────────────
// Statement parser (indentation-based)
// ─────────────────────────────────────────────────────────────────────

type pline struct {
	indent int
	text   string // comment-stripped logical line
	raw    string // original (for unsupported fallback)
}

// splitLogicalLines folds triple-quoted string continuations and strips
// comments (respecting string literals).
func splitLogicalLines(src string) []pline {
	rawLines := strings.Split(src, "\n")
	var out []pline
	var acc []string
	accIndent := -1
	openTriple := byte(0)
	flush := func() {
		if len(acc) == 0 {
			return
		}
		text := strings.Join(acc, "\n")
		out = append(out, pline{indent: accIndent, text: text, raw: text})
		acc = nil
		accIndent = -1
		openTriple = 0
	}
	for _, ln := range rawLines {
		// compute indent
		ind := 0
		for ind < len(ln) && ln[ind] == ' ' {
			ind++
		}
		if openTriple != 0 {
			acc = append(acc, ln)
			// look for closing triple
			rest := ln
			for {
				idx := strings.IndexByte(rest, openTriple)
				if idx < 0 {
					break
				}
				// count consecutive quotes
				q := 0
				for idx+q < len(rest) && rest[idx+q] == openTriple {
					q++
				}
				if q >= 3 {
					openTriple = 0
					break
				}
				rest = rest[idx+q:]
			}
			if openTriple == 0 {
				flush()
			}
			continue
		}
		trimmed := strings.TrimLeft(ln, " \t")
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		// scan the line tracking strings; a '#' outside a string starts a comment
		body := stripComment(trimmed)
		if strings.TrimSpace(body) == "" {
			continue
		}
		// check for an unterminated triple-quoted string → continuation
		triple, quote := hasOpenTriple(body)
		if triple {
			acc = append(acc, body)
			accIndent = ind
			openTriple = quote
			continue
		}
		out = append(out, pline{indent: ind, text: strings.TrimSpace(body), raw: trimmed})
	}
	flush()
	return out
}

// stripComment removes a '#' comment that starts outside any string literal.
func stripComment(s string) string {
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		if c == '#' {
			return strings.TrimRight(s[:i], " \t")
		}
		if c == '"' || c == '\'' {
			raw, ok := scanString(s, i, c)
			if ok {
				i += len(raw)
				continue
			}
			i++
			continue
		}
		i++
	}
	return s
}

// hasOpenTriple reports whether s contains an unterminated triple-quoted
// string (the line must continue).
func hasOpenTriple(s string) (bool, byte) {
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		if c == '"' || c == '\'' {
			if i+2 < n && s[i+1] == c && s[i+2] == c {
				// triple: find closing
				j := i + 3
				closed := false
				for j+2 < n {
					if s[j] == c && s[j+1] == c && s[j+2] == c {
						closed = true
						i = j + 3
						break
					}
					j++
				}
				if !closed {
					return true, c
				}
				continue
			}
			raw, ok := scanString(s, i, c)
			if ok {
				i += len(raw)
				continue
			}
			i++
			continue
		}
		i++
	}
	return false, 0
}

type parser struct {
	lines []pline
	pos   int
}

func parseProgram(src string) ([]Stmt, error) {
	p := &parser{lines: splitLogicalLines(src)}
	stmts, err := p.parseSuite(0)
	if err != nil {
		return nil, err
	}
	return stmts, nil
}

func (p *parser) peekIndent() int {
	if p.pos < len(p.lines) {
		return p.lines[p.pos].indent
	}
	return -1
}

// parseSuite parses statements whose indent == indent.
func (p *parser) parseSuite(indent int) ([]Stmt, error) {
	var out []Stmt
	for p.pos < len(p.lines) && p.lines[p.pos].indent == indent {
		st, err := p.parseStmt()
		if err != nil {
			return nil, err
		}
		if st != nil {
			out = append(out, st)
		}
	}
	return out, nil
}

// parseBody parses the block after a ':' header: the body must be more
// indented than headerIndent. Returns the body statements.
func (p *parser) parseBody(headerIndent int) ([]Stmt, error) {
	if p.pos >= len(p.lines) || p.lines[p.pos].indent <= headerIndent {
		return nil, nil // empty body (e.g. `def f(): pass`-less)
	}
	bodyIndent := p.lines[p.pos].indent
	return p.parseSuite(bodyIndent)
}

func (p *parser) parseStmt() (Stmt, error) {
	ln := p.lines[p.pos]
	p.pos++
	text := ln.text
	toks := lexLine(text)
	if len(toks) == 0 {
		return nil, nil
	}
	first := toks[0]
	if first.kind == tIdent {
		switch first.text {
		case "import":
			return &ImportS{}, nil
		case "global":
			return &GlobalS{}, nil
		case "pass":
			return nil, nil
		case "print":
			return p.parsePrint(toks[1:])
		case "def":
			return p.parseFunc(toks[1:], ln.indent)
		case "if":
			st, err := p.parseIf(toks[1:], ln.indent)
			if err != nil {
				return nil, err
			}
			return st, nil
		case "while":
			return p.parseWhile(toks[1:], ln.indent)
		case "for":
			return p.parseFor(toks[1:], ln.indent)
		case "return":
			return p.parseReturn(toks[1:])
		case "with":
			return p.parseWith(toks[1:], ln.indent)
		}
	}
	// expression statement — may be an assignment
	return p.parseExprStmt(toks)
}

func (p *parser) parsePrint(toks []tok) (Stmt, error) {
	if len(toks) < 3 || toks[0].text != "(" {
		return nil, fmt.Errorf("print: expected (")
	}
	args, rest, err := parseArgList(toks[1:])
	if err != nil {
		return nil, err
	}
	if len(rest) > 0 && rest[0].kind != tEOF {
		return nil, fmt.Errorf("print: trailing tokens")
	}
	return &PrintS{Args: args}, nil
}

func (p *parser) parseFunc(toks []tok, indent int) (Stmt, error) {
	if len(toks) < 1 || toks[0].kind != tIdent {
		return nil, fmt.Errorf("def: expected name")
	}
	name := toks[0].text
	// name(params):
	i := 1
	if i >= len(toks) || toks[i].text != "(" {
		return nil, fmt.Errorf("def %s: expected (", name)
	}
	i++
	var params []string
	for i < len(toks) && toks[i].text != ")" {
		if toks[i].kind != tIdent {
			return nil, fmt.Errorf("def %s: bad param", name)
		}
		params = append(params, toks[i].text)
		i++
		if i < len(toks) && toks[i].text == "," {
			i++
		}
	}
	if i >= len(toks) || toks[i].text != ")" {
		return nil, fmt.Errorf("def %s: expected )", name)
	}
	i++
	if i >= len(toks) || toks[i].text != ":" {
		return nil, fmt.Errorf("def %s: expected :", name)
	}
	body, err := p.parseBody(indent)
	if err != nil {
		return nil, err
	}
	return &FuncS{Name: name, Params: params, Body: body}, nil
}

func (p *parser) parseIf(toks []tok, indent int) (Stmt, error) {
	cond, rest, err := parseExprUntil(toks, ":")
	if err != nil {
		return nil, err
	}
	if len(rest) == 0 || rest[0].text != ":" {
		return nil, fmt.Errorf("if: expected :")
	}
	then, err := p.parseBody(indent)
	if err != nil {
		return nil, err
	}
	st := &IfS{Cond: cond, Then: then}
	// elif / else chains at the same indent
	for p.pos < len(p.lines) && p.lines[p.pos].indent == indent {
		t2 := lexLine(p.lines[p.pos].text)
		if len(t2) == 0 || t2[0].kind != tIdent {
			break
		}
		switch t2[0].text {
		case "elif":
			p.pos++
			c, rest2, err := parseExprUntil(t2[1:], ":")
			if err != nil {
				return nil, err
			}
			if len(rest2) == 0 || rest2[0].text != ":" {
				return nil, fmt.Errorf("elif: expected :")
			}
			b, err := p.parseBody(indent)
			if err != nil {
				return nil, err
			}
			st.Elifs = append(st.Elifs, ElifS{Cond: c, Body: b})
		case "else":
			p.pos++
			if len(t2) < 2 || t2[1].text != ":" {
				return nil, fmt.Errorf("else: expected :")
			}
			b, err := p.parseBody(indent)
			if err != nil {
				return nil, err
			}
			st.Else = b
			return st, nil
		default:
			return st, nil
		}
	}
	return st, nil
}

func (p *parser) parseWhile(toks []tok, indent int) (Stmt, error) {
	cond, rest, err := parseExprUntil(toks, ":")
	if err != nil {
		return nil, err
	}
	if len(rest) == 0 || rest[0].text != ":" {
		return nil, fmt.Errorf("while: expected :")
	}
	body, err := p.parseBody(indent)
	if err != nil {
		return nil, err
	}
	return &WhileS{Cond: cond, Body: body}, nil
}

func (p *parser) parseFor(toks []tok, indent int) (Stmt, error) {
	if len(toks) < 1 || toks[0].kind != tIdent {
		return nil, fmt.Errorf("for: expected variable")
	}
	vr := toks[0].text
	i := 1
	if i >= len(toks) || toks[i].text != "in" {
		return nil, fmt.Errorf("for: expected in")
	}
	i++
	iter, rest, err := parseExprUntil(toks[i:], ":")
	if err != nil {
		return nil, err
	}
	if len(rest) == 0 || rest[0].text != ":" {
		return nil, fmt.Errorf("for: expected :")
	}
	body, err := p.parseBody(indent)
	if err != nil {
		return nil, err
	}
	return &ForS{Var: vr, Iter: iter, Body: body}, nil
}

func (p *parser) parseReturn(toks []tok) (Stmt, error) {
	if len(toks) == 0 || toks[0].kind == tEOF {
		return &ReturnS{Value: nil}, nil
	}
	e, rest, err := parseExprUntil(toks, "\x00") // no terminator
	if err != nil {
		return nil, err
	}
	if len(rest) > 0 && rest[0].kind != tEOF {
		return nil, fmt.Errorf("return: trailing tokens")
	}
	return &ReturnS{Value: e}, nil
}

func (p *parser) parseWith(toks []tok, indent int) (Stmt, error) {
	// with open(PATH, MODE) as FH:
	if len(toks) < 1 || toks[0].text != "open" {
		return nil, fmt.Errorf("with: expected open(")
	}
	i := 1
	if i >= len(toks) || toks[i].text != "(" {
		return nil, fmt.Errorf("with: expected (")
	}
	i++
	var args []Expr
	for i < len(toks) && toks[i].text != ")" {
		e, rest, err := parseExprUntil(toks[i:], ",", ")")
		if err != nil {
			return nil, err
		}
		args = append(args, e)
		i = len(toks) - len(rest)
		if i < len(toks) && toks[i].text == "," {
			i++
		}
	}
	if i >= len(toks) || toks[i].text != ")" {
		return nil, fmt.Errorf("with: expected )")
	}
	i++
	if i+1 >= len(toks) || toks[i].text != "as" || toks[i+1].kind != tIdent {
		return nil, fmt.Errorf("with: expected as FH")
	}
	fh := toks[i+1].text
	i += 2
	if i >= len(toks) || toks[i].text != ":" {
		return nil, fmt.Errorf("with: expected :")
	}
	body, err := p.parseBody(indent)
	if err != nil {
		return nil, err
	}
	path, mode := "", "w"
	if len(args) > 0 {
		if s, ok := args[0].(*LitStr); ok {
			path = s.Value
		}
	}
	if len(args) > 1 {
		if s, ok := args[1].(*LitStr); ok {
			mode = s.Value
		}
	}
	return &WithS{Path: path, Mode: mode, FhVar: fh, Body: body}, nil
}

// parseExprStmt handles assignment detection + expression statements.
func (p *parser) parseExprStmt(toks []tok) (Stmt, error) {
	// find a top-level assignment op (=, +=, ...)
	eq := findTopLevelAssign(toks)
	if eq >= 0 {
		lhs := toks[:eq]
		op := toks[eq].text
		if op != "=" {
			op = toks[eq].text
		} else {
			op = "="
		}
		rhs := toks[eq+1:]
		// os.environ["K"] = v
		if len(lhs) == 6 && lhs[0].kind == tIdent && lhs[0].text == "os" &&
			lhs[1].kind == tOp && lhs[1].text == "." &&
			lhs[2].kind == tIdent && lhs[2].text == "environ" &&
			lhs[3].kind == tOp && lhs[3].text == "[" &&
			lhs[4].kind == tStr &&
			lhs[5].kind == tOp && lhs[5].text == "]" {
			val, err := parseRHS(rhs)
			if err != nil {
				return nil, err
			}
			return &AssignS{Targets: []string{envKey(lhs[4].text)}, Op: op, Expr: val}, nil
		}
		// plain targets: NAME (, NAME)*
		var targets []string
		i := 0
		// NAME [ index ] — array-element write; the index is baked into
		// the target name ("a[1]"), exactly the core frontend's own
		// `arr[1]=z` → var "arr[1]" convention (shir.rs: the store owns
		// the element; the runtime setVar routes a[1] names).
		if len(lhs) == 4 && lhs[0].kind == tIdent && lhs[1].kind == tOp && lhs[1].text == "[" &&
			(lhs[2].kind == tNum || lhs[2].kind == tIdent) &&
			lhs[3].kind == tOp && lhs[3].text == "]" {
			targets = append(targets, lhs[0].text+"["+lhs[2].text+"]")
			i = len(lhs)
		}
		for i < len(lhs) {
			if lhs[i].kind != tIdent {
				return nil, fmt.Errorf("bad assignment target")
			}
			targets = append(targets, lhs[i].text)
			i++
			if i < len(lhs) && lhs[i].text == "," {
				i++
				continue
			}
			break
		}
		if i != len(lhs) {
			return nil, fmt.Errorf("bad assignment target")
		}
		val, err := parseRHS(rhs)
		if err != nil {
			return nil, err
		}
		return &AssignS{Targets: targets, Op: op, Expr: val}, nil
	}
	// plain expression statement
	e, rest, err := parseExprUntil(toks, "\x00")
	if err != nil {
		return nil, err
	}
	if len(rest) > 0 && rest[0].kind != tEOF {
		return nil, fmt.Errorf("expression: trailing tokens")
	}
	return &ExprS{Expr: e}, nil
}

// parseRHS parses an assignment RHS: a single expression, or a
// comma-separated tuple (a, b = "x", "y").
func parseRHS(toks []tok) (Expr, error) {
	// split on top-level commas
	var parts [][]tok
	depth := 0
	start := 0
	for i, t := range toks {
		if t.kind != tOp {
			continue
		}
		switch t.text {
		case "(", "[":
			depth++
		case ")", "]":
			depth--
		case ",":
			if depth == 0 {
				parts = append(parts, toks[start:i])
				start = i + 1
			}
		}
	}
	parts = append(parts, toks[start:])
	if len(parts) == 1 {
		return parseExpr(parts[0])
	}
	var elems []Expr
	for _, part := range parts {
		e, err := parseExpr(part)
		if err != nil {
			return nil, err
		}
		elems = append(elems, e)
	}
	return &ListE{Elems: elems}, nil
}

func envKey(raw string) string {
	v, ok := deescapeString(raw)
	if !ok {
		return strings.Trim(raw, "\"'")
	}
	return v
}

// findTopLevelAssign locates the first assignment operator at paren
// depth 0 (not part of == / <= / >=).
func findTopLevelAssign(toks []tok) int {
	depth := 0
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.kind != tOp {
			continue
		}
		switch t.text {
		case "(", "[":
			depth++
		case ")", "]":
			depth--
		case "=", "+=", "-=", "*=", "/=":
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// ─────────────────────────────────────────────────────────────────────
// Expression parser (precedence climbing)
// ─────────────────────────────────────────────────────────────────────

type exprParser struct {
	toks []tok
	pos  int
}

func (e *exprParser) peek() tok {
	if e.pos < len(e.toks) {
		return e.toks[e.pos]
	}
	return tok{tEOF, "", 0}
}

func (e *exprParser) next() tok {
	t := e.peek()
	if e.pos < len(e.toks) {
		e.pos++
	}
	return t
}

func (e *exprParser) isOp(s string) bool {
	t := e.peek()
	return t.kind == tOp && t.text == s
}

func (e *exprParser) isKw(s string) bool {
	t := e.peek()
	return t.kind == tIdent && t.text == s
}

func (e *exprParser) expectOp(s string) error {
	if !e.isOp(s) {
		return fmt.Errorf("expected %q", s)
	}
	e.next()
	return nil
}

// parseExpr parses a full expression (ternary lowest precedence).
func parseExpr(toks []tok) (Expr, error) {
	e := &exprParser{toks: toks}
	ex, err := e.parseTernary()
	if err != nil {
		return nil, err
	}
	if e.peek().kind != tEOF {
		return nil, fmt.Errorf("unexpected token %q", e.peek().text)
	}
	return ex, nil
}

// parseExprUntil parses an expression and stops at the first token in
// stops (or EOF). Returns the expression and the remaining tokens.
func parseExprUntil(toks []tok, stops ...string) (Expr, []tok, error) {
	// find the earliest stop token at depth 0
	depth := 0
	stop := -1
	for i, t := range toks {
		if t.kind != tOp {
			continue
		}
		switch t.text {
		case "(", "[":
			depth++
			continue
		case ")", "]":
			if depth > 0 {
				depth--
				continue
			}
			// depth 0: fall through — a closing bracket is a valid stop
		}
		if depth == 0 {
			for _, s := range stops {
				if t.text == s {
					stop = i
					break
				}
			}
			if stop >= 0 {
				break
			}
		}
	}
	exprToks := toks
	rest := []tok{}
	if stop >= 0 {
		exprToks = toks[:stop]
		rest = toks[stop:]
	}
	if len(exprToks) == 0 {
		return nil, nil, fmt.Errorf("empty expression")
	}
	ex, err := parseExpr(exprToks)
	if err != nil {
		return nil, nil, err
	}
	return ex, rest, nil
}

func (e *exprParser) parseTernary() (Expr, error) {
	then, err := e.parseOr()
	if err != nil {
		return nil, err
	}
	if e.isKw("if") {
		e.next()
		cond, err := e.parseOr()
		if err != nil {
			return nil, err
		}
		if !e.isKw("else") {
			return nil, fmt.Errorf("ternary: expected else")
		}
		e.next()
		els, err := e.parseTernary()
		if err != nil {
			return nil, err
		}
		return &TernaryE{Cond: cond, Then: then, Else: els}, nil
	}
	return then, nil
}

func (e *exprParser) parseOr() (Expr, error) {
	lhs, err := e.parseAnd()
	if err != nil {
		return nil, err
	}
	for e.isKw("or") {
		e.next()
		rhs, err := e.parseAnd()
		if err != nil {
			return nil, err
		}
		lhs = &BoolE{Op: "or", Lhs: lhs, Rhs: rhs}
	}
	return lhs, nil
}

func (e *exprParser) parseAnd() (Expr, error) {
	lhs, err := e.parseNot()
	if err != nil {
		return nil, err
	}
	for e.isKw("and") {
		e.next()
		rhs, err := e.parseNot()
		if err != nil {
			return nil, err
		}
		lhs = &BoolE{Op: "and", Lhs: lhs, Rhs: rhs}
	}
	return lhs, nil
}

func (e *exprParser) parseNot() (Expr, error) {
	if e.isKw("not") {
		e.next()
		arg, err := e.parseNot()
		if err != nil {
			return nil, err
		}
		return &NotE{Arg: arg}, nil
	}
	return e.parseCmp()
}

func (e *exprParser) parseCmp() (Expr, error) {
	lhs, err := e.parseAdd()
	if err != nil {
		return nil, err
	}
	t := e.peek()
	if t.kind == tOp {
		switch t.text {
		case "==", "!=", "<", ">", "<=", ">=":
			e.next()
			rhs, err := e.parseAdd()
			if err != nil {
				return nil, err
			}
			return &CompareE{Op: t.text, Lhs: lhs, Rhs: rhs}, nil
		}
	}
	// `in` — substring containment (a keyword identifier, not an op)
	if e.isKw("in") {
		e.next()
		rhs, err := e.parseAdd()
		if err != nil {
			return nil, err
		}
		return &CompareE{Op: "in", Lhs: lhs, Rhs: rhs}, nil
	}
	return lhs, nil
}

func (e *exprParser) parseAdd() (Expr, error) {
	lhs, err := e.parseMul()
	if err != nil {
		return nil, err
	}
	for {
		t := e.peek()
		if t.kind == tOp && (t.text == "+" || t.text == "-") {
			e.next()
			rhs, err := e.parseMul()
			if err != nil {
				return nil, err
			}
			lhs = &BinOpE{Op: t.text, Lhs: lhs, Rhs: rhs}
			continue
		}
		return lhs, nil
	}
}

func (e *exprParser) parseMul() (Expr, error) {
	lhs, err := e.parseUnary()
	if err != nil {
		return nil, err
	}
	for {
		t := e.peek()
		if t.kind == tOp && (t.text == "*" || t.text == "/" || t.text == "%") {
			e.next()
			rhs, err := e.parseUnary()
			if err != nil {
				return nil, err
			}
			if t.text == "%" {
				// percent-format: "%s-%s" % (a, b)
				if ls, ok := lhs.(*LitStr); ok {
					args := []Expr{rhs}
					if lst, ok := rhs.(*ListE); ok {
						args = lst.Elems
					}
					lhs = &PercentE{Format: ls, Args: args}
					continue
				}
			}
			lhs = &BinOpE{Op: t.text, Lhs: lhs, Rhs: rhs}
			continue
		}
		return lhs, nil
	}
}

func (e *exprParser) parseUnary() (Expr, error) {
	if e.isOp("-") {
		e.next()
		arg, err := e.parseUnary()
		if err != nil {
			return nil, err
		}
		// represent as 0 - arg (arith Un would need special casing)
		return &BinOpE{Op: "-", Lhs: &LitInt{Text: "0"}, Rhs: arg}, nil
	}
	if e.isOp("+") {
		e.next()
		return e.parseUnary()
	}
	return e.parsePostfix()
}

func (e *exprParser) parsePostfix() (Expr, error) {
	ex, err := e.parsePrimary()
	if err != nil {
		return nil, err
	}
	for {
		t := e.peek()
		if t.kind != tOp {
			return ex, nil
		}
		switch t.text {
		case "(":
			// call: dotted module path (os.system / subprocess.run / …)
			// → CallE; method on a value (x.strip(), p.wait()) → MethodCallE
			e.next()
			args, kw, err := e.parseCallArgs()
			if err != nil {
				return nil, err
			}
			switch obj := ex.(type) {
			case *NameE:
				ex = &CallE{Path: []string{obj.Name}, Args: args, Kwargs: kw}
			case *AttrE:
				if path, ok := dottedPath(obj); ok {
					ex = &CallE{Path: path, Args: args, Kwargs: kw}
				} else {
					ex = &MethodCallE{Obj: obj.Obj, Name: obj.Name, Args: args}
				}
			case *CallE:
				// call result called again — not in the subset; chain
				ex = &MethodCallE{Obj: obj, Name: "()", Args: args}
			default:
				ex = &MethodCallE{Obj: obj, Name: "()", Args: args}
			}
		case "[":
			e.next()
			// subscript: expr | expr:expr | expr: | :expr
			var idx, sstart, send Expr
			isSlice := false
			if e.isOp(":") {
				isSlice = true
				e.next()
				if !e.isOp("]") {
					send, err = e.parseTernary()
					if err != nil {
						return nil, err
					}
				}
			} else {
				idx, err = e.parseTernary()
				if err != nil {
					return nil, err
				}
				if e.isOp(":") {
					isSlice = true
					sstart = idx
					idx = nil
					e.next()
					if !e.isOp("]") {
						send, err = e.parseTernary()
						if err != nil {
							return nil, err
						}
					}
				}
			}
			if err := e.expectOp("]"); err != nil {
				return nil, err
			}
			if idx != nil && !isSlice {
				ex = &SubscriptE{Obj: ex, Index: idx}
			} else {
				ex = &SubscriptE{Obj: ex, SliceStart: sstart, SliceEnd: send}
			}
		case ".":
			e.next()
			nt := e.next()
			if nt.kind != tIdent {
				return nil, fmt.Errorf("expected attribute name")
			}
			ex = &AttrE{Obj: ex, Name: nt.text}
		default:
			return ex, nil
		}
	}
}

// dottedPath resolves a dotted attribute chain rooted at a module name
// (os, sys, subprocess) into a call path like ["os","path","exists"].
// Returns ok=false for attribute chains over variables (x.strip()).
func dottedPath(a *AttrE) ([]string, bool) {
	var names []string
	cur := Expr(a)
	for {
		at, ok := cur.(*AttrE)
		if !ok {
			break
		}
		names = append([]string{at.Name}, names...)
		cur = at.Obj
	}
	n, ok := cur.(*NameE)
	if !ok {
		return nil, false
	}
	switch n.Name {
	case "os", "sys", "subprocess":
		return append([]string{n.Name}, names...), true
	}
	return nil, false
}

func (e *exprParser) parseCallArgs() ([]Expr, []Kwarg, error) {
	var args []Expr
	var kwargs []Kwarg
	if e.isOp(")") {
		e.next()
		return args, kwargs, nil
	}
	for {
		// kwarg?
		if e.peek().kind == tIdent && e.pos+1 < len(e.toks) &&
			e.toks[e.pos+1].kind == tOp && e.toks[e.pos+1].text == "=" {
			key := e.next().text
			e.next() // =
			val, err := e.parseTernary()
			if err != nil {
				return nil, nil, err
			}
			kwargs = append(kwargs, Kwarg{Key: key, Value: val})
		} else {
			arg, err := e.parseTernary()
			if err != nil {
				return nil, nil, err
			}
			args = append(args, arg)
		}
		if e.isOp(",") {
			e.next()
			if e.isOp(")") {
				e.next()
				return args, kwargs, nil
			}
			continue
		}
		if err := e.expectOp(")"); err != nil {
			return nil, nil, err
		}
		return args, kwargs, nil
	}
}

func (e *exprParser) parsePrimary() (Expr, error) {
	t := e.next()
	switch t.kind {
	case tNum:
		return &LitInt{Text: t.text}, nil
	case tStr:
		v, ok := deescapeString(t.text)
		if !ok {
			return nil, fmt.Errorf("bad string literal")
		}
		return &LitStr{Value: v}, nil
	case tFStr:
		parts, err := parseFString(t.text)
		if err != nil {
			return nil, err
		}
		return &FStrE{Parts: parts}, nil
	case tIdent:
		switch t.text {
		case "True":
			return &BoolLit{Value: true}, nil
		case "False":
			return &BoolLit{Value: false}, nil
		case "None":
			return &LitStr{Value: ""}, nil
		}
		return &NameE{Name: t.text}, nil
	case tOp:
		if t.text == "(" {
			// parenthesized expr or tuple
			if e.isOp(")") {
				e.next()
				return &ListE{}, nil
			}
			first, err := e.parseTernary()
			if err != nil {
				return nil, err
			}
			if e.isOp(",") {
				// tuple
				elems := []Expr{first}
				for e.isOp(",") {
					e.next()
					if e.isOp(")") {
						break
					}
					el, err := e.parseTernary()
					if err != nil {
						return nil, err
					}
					elems = append(elems, el)
				}
				if err := e.expectOp(")"); err != nil {
					return nil, err
				}
				return &ListE{Elems: elems}, nil
			}
			if err := e.expectOp(")"); err != nil {
				return nil, err
			}
			return first, nil
		}
		if t.text == "[" {
			// list literal
			var elems []Expr
			if e.isOp("]") {
				e.next()
				return &ListE{}, nil
			}
			for {
				el, err := e.parseTernary()
				if err != nil {
					return nil, err
				}
				elems = append(elems, el)
				if e.isOp(",") {
					e.next()
					if e.isOp("]") {
						break
					}
					continue
				}
				break
			}
			if err := e.expectOp("]"); err != nil {
				return nil, err
			}
			return &ListE{Elems: elems}, nil
		}
	}
	return nil, fmt.Errorf("unexpected token %q", t.text)
}

// parseArgList parses print(...) args: a parenthesized, comma-separated list.
func parseArgList(toks []tok) ([]Expr, []tok, error) {
	e := &exprParser{toks: toks}
	var args []Expr
	if e.isOp(")") {
		e.next()
		return args, e.toks[e.pos:], nil
	}
	for {
		arg, err := e.parseTernary()
		if err != nil {
			return nil, nil, err
		}
		args = append(args, arg)
		if e.isOp(",") {
			e.next()
			continue
		}
		break
	}
	if err := e.expectOp(")"); err != nil {
		return nil, nil, err
	}
	return args, e.toks[e.pos:], nil
}

// deescapeString removes Python string quotes and interprets escapes.
func deescapeString(raw string) (string, bool) {
	if len(raw) < 2 {
		return "", false
	}
	q := raw[0]
	if q != '"' && q != '\'' {
		return "", false
	}
	body := raw[1:]
	// triple-quoted?
	triple := len(body) >= 2 && body[0] == q && body[1] == q
	if triple {
		body = body[2:]
		if len(body) < 3 || body[len(body)-3] != q || body[len(body)-2] != q || body[len(body)-1] != q {
			return "", false
		}
		body = body[:len(body)-3]
	} else {
		if body[len(body)-1] != q {
			return "", false
		}
		body = body[:len(body)-1]
	}
	var sb strings.Builder
	i := 0
	for i < len(body) {
		c := body[i]
		if c == '\\' && i+1 < len(body) {
			n := body[i+1]
			switch n {
			case 'n':
				sb.WriteByte('\n')
			case 't':
				sb.WriteByte('\t')
			case 'r':
				sb.WriteByte('\r')
			case '\\':
				sb.WriteByte('\\')
			case '\'':
				sb.WriteByte('\'')
			case '"':
				sb.WriteByte('"')
			case '0':
				sb.WriteByte(0)
			default:
				sb.WriteByte('\\')
				sb.WriteByte(n)
			}
			i += 2
			continue
		}
		sb.WriteByte(c)
		i++
	}
	return sb.String(), true
}

// parseFString parses f"..." into literal/expr parts.
func parseFString(raw string) ([]FStrPart, error) {
	q := raw[0]
	body := raw[1:]
	triple := len(body) >= 2 && body[0] == q && body[1] == q
	if triple {
		body = body[2:]
		body = body[:len(body)-3]
	} else {
		body = body[:len(body)-1]
	}
	var parts []FStrPart
	var lit strings.Builder
	i := 0
	flush := func() {
		if lit.Len() > 0 {
			parts = append(parts, FStrPart{IsLit: true, Lit: lit.String()})
			lit.Reset()
		}
	}
	for i < len(body) {
		c := body[i]
		if c == '{' {
			// find matching close brace
			depth := 1
			j := i + 1
			for j < len(body) && depth > 0 {
				if body[j] == '{' {
					depth++
				} else if body[j] == '}' {
					depth--
				}
				j++
			}
			if depth != 0 {
				return nil, fmt.Errorf("f-string: unbalanced braces")
			}
			inner := body[i+1 : j-1]
			// strip a format spec (:...) — not in the subset
			if k := strings.IndexByte(inner, ':'); k >= 0 {
				inner = inner[:k]
			}
			toks := lexLine(strings.TrimSpace(inner))
			if len(toks) == 0 || toks[0].kind == tEOF {
				return nil, fmt.Errorf("f-string: empty expression")
			}
			ex, err := parseExpr(toks)
			if err != nil {
				return nil, err
			}
			flush()
			parts = append(parts, FStrPart{IsLit: false, Expr: ex})
			i = j
			continue
		}
		if c == '}' && i+1 < len(body) && body[i+1] == '}' {
			lit.WriteByte('}')
			i += 2
			continue
		}
		if c == '\\' && i+1 < len(body) {
			n := body[i+1]
			switch n {
			case 'n':
				lit.WriteByte('\n')
			case 't':
				lit.WriteByte('\t')
			case 'r':
				lit.WriteByte('\r')
			case '\\':
				lit.WriteByte('\\')
			case '{':
				lit.WriteByte('{')
			case '}':
				lit.WriteByte('}')
			default:
				lit.WriteByte('\\')
				lit.WriteByte(n)
			}
			i += 2
			continue
		}
		lit.WriteByte(c)
		i++
	}
	flush()
	return parts, nil
}

// ─────────────────────────────────────────────────────────────────────
// Type inference (during lowering)
// ─────────────────────────────────────────────────────────────────────

type lowerer struct {
	fns       map[string]bool     // defined function names
	types     map[string]string   // var → int|str|list
	params    map[string][]string // function name → params (for scoping)
	curParams map[string]string   // active function: param → positional string
}

func (l *lowerer) collectFuncs(stmts []Stmt) {
	for _, s := range stmts {
		if f, ok := s.(*FuncS); ok {
			l.fns[f.Name] = true
			l.params[f.Name] = f.Params
		}
	}
}

func (l *lowerer) setType(name, t string) {
	l.types[name] = t
}

func (l *lowerer) typeOf(e Expr) string {
	switch t := e.(type) {
	case *LitInt:
		return "int"
	case *LitStr, *FStrE, *PercentE:
		return "str"
	case *BoolLit:
		return "int"
	case *NameE:
		if v, ok := l.types[t.Name]; ok {
			return v
		}
		return "str"
	case *BinOpE:
		if t.Op == "+" {
			if l.typeOf(t.Lhs) == "int" && l.typeOf(t.Rhs) == "int" {
				return "int"
			}
			return "str"
		}
		return "int"
	case *CompareE, *NotE, *BoolE:
		return "int"
	case *ListE:
		return "list"
	case *SubscriptE:
		if t.Index != nil {
			return "str"
		}
		return "str"
	case *CallE:
		path := strings.Join(t.Path, ".")
		switch path {
		case "len":
			return "int"
		case "subprocess.run", "subprocess.Popen":
			return "str"
		case "os.environ":
			return "str"
		}
		return "str"
	case *MethodCallE:
		return "str"
	case *AttrE:
		return "str"
	case *TernaryE:
		a, b := l.typeOf(t.Then), l.typeOf(t.Else)
		if a == b {
			return a
		}
		return "str"
	}
	return "str"
}

// ─────────────────────────────────────────────────────────────────────
// A1 shIR JSON builders (byte-identical to sh2perl/src/shir_json.rs)
// ─────────────────────────────────────────────────────────────────────

// st builds an IrExpr::Str node (DoubleQuoted style — the default the
// core's `st()` uses for literal words).
func st(s string) map[string]any {
	return map[string]any{"type": "Str", "value": s, "style": "DoubleQuoted"}
}

// syncBuiltins mirrors shir.rs SYNC_BUILTINS (ask A3 purity for exec).
var syncBuiltins = map[string]bool{
	".": true, ":": true, "basename": true, "break": true, "cat": true,
	"cd": true, "cmp": true, "comm": true, "continue": true, "cut": true,
	"declare": true, "dirname": true, "echo": true, "eval": true,
	"exit": true, "export": true, "false": true, "grep": true, "head": true,
	"let": true, "local": true, "mapfile": true, "mktemp": true,
	"printf": true, "pwd": true, "read": true, "readarray": true,
	"readonly": true, "return": true, "seq": true, "sed": true, "set": true,
	"shift": true, "sort": true, "source": true, "stat": true, "tail": true,
	"test": true, "touch": true, "tr": true, "trap": true, "true": true,
	"type": true, "typeset": true, "uniq": true, "unset": true, "wc": true,
}

// callPurity mirrors shir_json.rs call_purity (ask A3): the purity
// verdict must match the core's byte-for-byte.
func callPurity(func_ string, args []any) string {
	switch func_ {
	case "contains", "join", "brace", "idiv", "imod", "arith", "arithEval",
		"trimCapture", "dirname", "basename", "not", "guard", "caseMatch",
		"param", "callDirect":
		return "PureCpu"
	case "getVar", "setVar", "setLastExit", "assign", "test", "grepText",
		"listVar", "setArray", "setArrayAppend", "arrayItems", "arrayKeys",
		"arrayLen", "arrayIndex", "fnCall", "define", "forLoop", "whileLoop",
		"block", "shopt", "builtin", "bcSqrt":
		return "Emulable"
	case "exec":
		if len(args) > 0 {
			if a, ok := args[0].(map[string]any); ok {
				if a["type"] == "Str" || a["type"] == "Ident" {
					if s, ok := a["value"].(string); ok && syncBuiltins[s] {
						return "Emulable"
					}
				}
			}
		}
		return "Spawn"
	case "capture", "captureWords", "pipeline", "redirect", "subshell",
		"background", "callUndefined", "unsupported":
		return "Spawn"
	case "return", "break", "continue", "exit":
		return "Control"
	default:
		if strings.HasPrefix(func_, "fs.") {
			return "Fs"
		}
		return "Spawn" // unknown → conservative
	}
}

// call builds an IrExpr::Call node with the A3 purity verdict.
func call(func_ string, args []any) map[string]any {
	return map[string]any{"type": "Call", "func": func_, "args": args, "purity": callPurity(func_, args)}
}

func getVar(name string) map[string]any {
	return call("getVar", []any{st(name)})
}

func execCall(cmd string, words []any) map[string]any {
	return call("exec", []any{st(cmd), array(words)})
}

func array(elems []any) map[string]any {
	return map[string]any{"type": "Array", "elements": elems}
}

func exprStmt(e map[string]any) map[string]any {
	return map[string]any{"type": "Expr", "expr": e}
}

func assignStmt(vr string, e map[string]any) map[string]any {
	return map[string]any{
		"type": "Assign",
		"targets": []any{map[string]any{
			"var":     vr,
			"sigil":   nil,
			"indices": []any{},
		}},
		"expr": e,
	}
}

func ifStmt(cond map[string]any, then, els []map[string]any) map[string]any {
	return map[string]any{
		"type":   "If",
		"cond":   cond,
		"then":   toAnyStmts(then),
		"elsifs": []any{},
		"else":   toAnyStmts(els),
	}
}

func whileStmt(cond map[string]any, body []map[string]any) map[string]any {
	return map[string]any{"type": "While", "cond": cond, "body": toAnyStmts(body)}
}

func forStmt(vr string, iter map[string]any, body []map[string]any) map[string]any {
	return map[string]any{"type": "For", "var": vr, "iter": iter, "body": toAnyStmts(body)}
}

func functionStmt(name string, body []map[string]any) map[string]any {
	return map[string]any{"type": "Function", "name": name, "body": toAnyStmts(body)}
}

func returnStmt(v map[string]any) map[string]any {
	return map[string]any{"type": "Return", "value": v}
}

func backgroundStmt(body []map[string]any) map[string]any {
	return map[string]any{"type": "Background", "body": toAnyStmts(body)}
}

func redirectStmt(inner []map[string]any, fd int, mode, target string) map[string]any {
	return map[string]any{
		"type":  "Redirect",
		"inner": toAnyStmts(inner),
		"redirects": []any{map[string]any{
			"fd":          fd,
			"mode":        mode,
			"target":      st(target),
			"interpolate": true,
		}},
	}
}

func interpolate(parts []any) map[string]any {
	return map[string]any{"type": "Interpolate", "parts": parts}
}

func interpLit(s string) map[string]any {
	return map[string]any{"kind": "lit", "text": s}
}

func interpExpr(e map[string]any) map[string]any {
	return map[string]any{"kind": "expr", "expr": e}
}

func arrow(body []map[string]any) map[string]any {
	return map[string]any{"type": "Arrow", "body": toAnyStmts(body)}
}

func capture(e map[string]any) map[string]any {
	return call("capture", []any{e})
}

func binop(op string, lhs, rhs map[string]any) map[string]any {
	return map[string]any{"type": "BinOp", "op": op, "lhs": lhs, "rhs": rhs}
}

// arith AST builders
func arithExpr(ast map[string]any) map[string]any {
	return map[string]any{"type": "Arith", "ast": ast}
}

func arithBin(op string, lhs, rhs map[string]any) map[string]any {
	return map[string]any{"type": "Bin", "op": op, "lhs": lhs, "rhs": rhs}
}

func arithNum(n int64) map[string]any {
	return map[string]any{"type": "Num", "value": n}
}

func arithVar(vr string) map[string]any {
	return map[string]any{"type": "Var", "name": vr}
}

func toAnyStmts(stmts []map[string]any) []any {
	out := make([]any, len(stmts))
	for i, s := range stmts {
		out[i] = s
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// Lowering: Python AST → A1 shIR statements
// ─────────────────────────────────────────────────────────────────────

// argIR builds the IR for an expression in exec-arg (word) position.
func (l *lowerer) argIR(e Expr) (map[string]any, error) {
	switch t := e.(type) {
	case *LitStr:
		return st(t.Value), nil
	case *LitInt:
		return st(t.Text), nil
	case *BoolLit:
		if t.Value {
			return st("1"), nil
		}
		return st("0"), nil
	case *NameE:
		// inside a function body, params read the positionals
		if pos, ok := l.curParams[t.Name]; ok {
			return getVar(pos), nil
		}
		return getVar(t.Name), nil
	case *FStrE:
		return l.interpIR(t.Parts), nil
	case *BinOpE:
		if t.Op == "+" && (l.typeOf(t) == "str") {
			return l.concatIR(t), nil
		}
		return l.arithIR(t)
	case *SubscriptE:
		return l.subscriptIR(t)
	case *CallE:
		return l.callIR(t, false)
	case *MethodCallE:
		return l.methodIR(t)
	case *AttrE:
		// x.returncode / out.stdout → the variable itself
		if n, ok := t.Obj.(*NameE); ok && (t.Name == "returncode" || t.Name == "stdout") {
			return getVar(n.Name), nil
		}
		// subprocess.run(...).stdout — the capture result
		if _, ok := t.Obj.(*CallE); ok && t.Name == "stdout" {
			return l.argIR(t.Obj)
		}
		return nil, fmt.Errorf("unsupported attribute expression")
	case *PercentE:
		return nil, fmt.Errorf("%%-format only valid in print")
	case *ListE:
		return nil, fmt.Errorf("list literal in word position")
	case *TernaryE:
		return nil, fmt.Errorf("ternary in word position")
	}
	return nil, fmt.Errorf("unsupported expression")
}

// concatIR flattens a string-concat BinOp into an Interpolate.
func (l *lowerer) concatIR(e Expr) map[string]any {
	var parts []any
	var walk func(x Expr)
	walk = func(x Expr) {
		if b, ok := x.(*BinOpE); ok && b.Op == "+" && l.typeOf(b) == "str" {
			walk(b.Lhs)
			walk(b.Rhs)
			return
		}
		if s, ok := x.(*LitStr); ok {
			parts = append(parts, interpLit(s.Value))
			return
		}
		if f, ok := x.(*FStrE); ok {
			for _, p := range f.Parts {
				if p.IsLit {
					parts = append(parts, interpLit(p.Lit))
				} else {
					if ir, err := l.argIR(p.Expr); err == nil {
						parts = append(parts, interpExpr(ir))
					}
				}
			}
			return
		}
		if ir, err := l.argIR(x); err == nil {
			parts = append(parts, interpExpr(ir))
		}
	}
	walk(e)
	return interpolate(parts)
}

func (l *lowerer) interpIR(parts []FStrPart) map[string]any {
	out := []any{}
	for _, p := range parts {
		if p.IsLit {
			out = append(out, interpLit(p.Lit))
		} else {
			if ir, err := l.argIR(p.Expr); err == nil {
				out = append(out, interpExpr(ir))
			}
		}
	}
	return interpolate(out)
}

// arithIR converts a numeric Python expression to the Arith AST.
func (l *lowerer) arithIR(e Expr) (map[string]any, error) {
	switch t := e.(type) {
	case *LitInt:
		n, err := strconv.ParseInt(t.Text, 10, 64)
		if err != nil {
			return nil, err
		}
		return arithExpr(arithNum(n)), nil
	case *NameE:
		return arithExpr(arithVar(t.Name)), nil
	case *BinOpE:
		lhs, err := l.arithIR(t.Lhs)
		if err != nil {
			return nil, err
		}
		rhs, err := l.arithIR(t.Rhs)
		if err != nil {
			return nil, err
		}
		lhsAst := lhs["ast"].(map[string]any)
		rhsAst := rhs["ast"].(map[string]any)
		return arithExpr(arithBin(t.Op, lhsAst, rhsAst)), nil
	case *SubscriptE:
		// array element in arith — rare; treat as var read
		return l.subscriptIR(t)
	case *CallE:
		if len(t.Path) == 1 && t.Path[0] == "len" && len(t.Args) == 1 {
			if n, ok := t.Args[0].(*NameE); ok {
				return call("arrayLen", []any{st(n.Name)}), nil
			}
		}
		return nil, fmt.Errorf("call in arithmetic")
	}
	return nil, fmt.Errorf("unsupported arithmetic")
}

func (l *lowerer) subscriptIR(t *SubscriptE) (map[string]any, error) {
	// os.environ["K"] read
	if at, ok := t.Obj.(*AttrE); ok {
		if path, ok := dottedPath(at); ok && strings.Join(path, ".") == "os.environ" {
			if s, ok := t.Index.(*LitStr); ok {
				return getVar(s.Value), nil
			}
		}
	}
	// x.rsplit(sep, 1)[1] — the part after the LAST sep occurrence:
	// ${x##*sep} (strip the longest prefix ending at the last sep).
	// Python rsplit splits from the right (maxsplit=1) and [1] is the
	// final element; the shell glob does the same greedy scan.
	if mc, ok := t.Obj.(*MethodCallE); ok && mc.Name == "rsplit" && len(mc.Args) >= 1 {
		if one, ok := t.Index.(*LitInt); ok && (one.Text == "1" || one.Text == "-1") {
			if n, ok := mc.Obj.(*NameE); ok {
				if sep, ok := mc.Args[0].(*LitStr); ok {
					return call("param", []any{st("##"), st(n.Name), st("*" + sep.Value)}), nil
				}
			}
		}
		return nil, fmt.Errorf("rsplit subscript: expected var.rsplit(str, 1)[1]")
	}
	name, ok := t.Obj.(*NameE)
	if !ok {
		return nil, fmt.Errorf("subscript target must be a variable")
	}
	if t.Index != nil {
		key, err := l.argIR(t.Index)
		if err != nil {
			return nil, err
		}
		return call("arrayIndex", []any{st(name.Name), key}), nil
	}
	// slice a[i:j] → param("slice", a, start, len)
	start := "0"
	length := ""
	if t.SliceStart != nil {
		if n, ok := t.SliceStart.(*LitInt); ok {
			start = n.Text
		}
	}
	// x[:x.find(p)] — everything before the FIRST occurrence of p:
	// ${x%%p*} (strip the longest suffix that starts at p).
	if mc, ok := t.SliceEnd.(*MethodCallE); ok && mc.Name == "find" && len(mc.Args) == 1 {
		if t.SliceStart == nil {
			if n2, ok := mc.Obj.(*NameE); ok && n2.Name == name.Name {
				if pa, ok := mc.Args[0].(*LitStr); ok {
					return call("param", []any{st("%%"), st(name.Name), st(pa.Value + "*")}), nil
				}
			}
		}
	}
	if t.SliceEnd != nil {
		if n, ok := t.SliceEnd.(*LitInt); ok {
			s, _ := strconv.ParseInt(start, 10, 64)
			en, _ := strconv.ParseInt(n.Text, 10, 64)
			length = strconv.FormatInt(en-s, 10)
		}
	}
	return call("param", []any{st("slice"), st(name.Name), st(start), st(length)}), nil
}

// callIR lowers CallE in word position. isStmt selects statement-form
// lowering (exec without capture).
func (l *lowerer) callIR(t *CallE, isStmt bool) (map[string]any, error) {
	path := strings.Join(t.Path, ".")
	switch path {
	case "len":
		if len(t.Args) == 1 {
			if n, ok := t.Args[0].(*NameE); ok {
				if l.typeOf(n) == "list" {
					return call("arrayLen", []any{st(n.Name)}), nil
				}
				return call("param", []any{st("len"), st(n.Name)}), nil
			}
			if _, ok := t.Args[0].(*ListE); ok {
				// len of a literal list — count elements
				return st(strconv.Itoa(len(t.Args[0].(*ListE).Elems))), nil
			}
		}
		return nil, fmt.Errorf("len: expected a variable")
	case "str":
		// str(x) — identity (the shell has no string/number split;
		// the value already reads as a string)
		if len(t.Args) == 1 {
			return l.argIR(t.Args[0])
		}
		return nil, fmt.Errorf("str: expected one argument")
	case "os.environ":
		if len(t.Args) == 1 {
			if s, ok := t.Args[0].(*LitStr); ok {
				return getVar(s.Value), nil
			}
		}
		return nil, fmt.Errorf("os.environ: expected string key")
	case "os.environ.get":
		// os.environ.get("K") or os.environ.get("K", "default"). The
		// two-arg form is `${K:-default}` — the core frontend's own
		// lowering of DefaultValue is param(":-", name, default)
		// (shir.rs param_ir), which the ESTree renderer supports
		// (DefinedOr is Perl-only and panics the renderer).
		if len(t.Args) == 1 || len(t.Args) == 2 {
			if s, ok := t.Args[0].(*LitStr); ok {
				if len(t.Args) == 2 {
					d, err := l.argIR(t.Args[1])
					if err != nil {
						return nil, err
					}
					return call("param", []any{st(":-"), st(s.Value), d}), nil
				}
				return getVar(s.Value), nil
			}
		}
		return nil, fmt.Errorf("os.environ.get: expected string key[, default]")
	case "os.system":
		if len(t.Args) == 1 {
			if s, ok := t.Args[0].(*LitStr); ok {
				words := strings.Fields(s.Value)
				if len(words) == 0 {
					return execCall("true", []any{}), nil
				}
				cmd := words[0]
				ws := []any{}
				for _, w := range words[1:] {
					ws = append(ws, st(w))
				}
				return execCall(cmd, ws), nil
			}
		}
		return nil, fmt.Errorf("os.system: expected a string")
	case "subprocess.run":
		prog, ws, err := l.procArgs(t.Args)
		if err != nil {
			return nil, err
		}
		captureMode := false
		for _, kw := range t.Kwargs {
			if kw.Key == "capture_output" {
				if b, ok := kw.Value.(*BoolLit); ok && b.Value {
					captureMode = true
				}
			}
		}
		e := execCall(prog, ws)
		if captureMode {
			return capture(arrow([]map[string]any{exprStmt(e)})), nil
		}
		return e, nil
	case "subprocess.Popen":
		prog, ws, err := l.procArgs(t.Args)
		if err != nil {
			return nil, err
		}
		return execCall(prog, ws), nil
	case "sys.stdin.readline":
		return nil, fmt.Errorf("readline handled at statement level")
	case "os.path.exists":
		if len(t.Args) == 1 {
			if s, ok := t.Args[0].(*LitStr); ok {
				return call("test", []any{st("-e " + s.Value)}), nil
			}
		}
		return nil, fmt.Errorf("os.path.exists: expected a string")
	default:
		if len(t.Path) == 1 && l.fns[t.Path[0]] {
			// call to a script-defined function
			ws, err := l.argListIR(t.Args)
			if err != nil {
				return nil, err
			}
			e := execCall(t.Path[0], ws)
			if isStmt {
				return e, nil
			}
			return capture(arrow([]map[string]any{exprStmt(e)})), nil
		}
		return nil, fmt.Errorf("unsupported call %s", path)
	}
}

// procArgs extracts the program + args from subprocess.run([...]) args.
func (l *lowerer) procArgs(args []Expr) (string, []any, error) {
	for _, a := range args {
		if lst, ok := a.(*ListE); ok {
			var ws []any
			for _, el := range lst.Elems {
				ir, err := l.argIR(el)
				if err != nil {
					return "", nil, err
				}
				ws = append(ws, ir)
			}
			if len(ws) == 0 {
				return "true", []any{}, nil
			}
			// first element is the program name
			if s, ok := ws[0].(map[string]any); ok && s["type"] == "Str" {
				prog := s["value"].(string)
				return prog, ws[1:], nil
			}
			return "", nil, fmt.Errorf("subprocess: program must be a literal")
		}
	}
	return "", nil, fmt.Errorf("subprocess: expected [program, args...]")
}

func (l *lowerer) argListIR(args []Expr) ([]any, error) {
	out := []any{}
	for _, a := range args {
		ir, err := l.argIR(a)
		if err != nil {
			return nil, err
		}
		out = append(out, ir)
	}
	return out, nil
}

// methodIR lowers MethodCallE: .strip() / .stdout / .wait() / fh.write().
func (l *lowerer) methodIR(t *MethodCallE) (map[string]any, error) {
	switch t.Name {
	case "strip":
		// identity on the captured/read string (capture already strips)
		return l.argIR(t.Obj)
	case "stdout":
		return l.argIR(t.Obj)
	case "wait":
		return execCall("wait", []any{}), nil
	case "removeprefix":
		// s.removeprefix(p) — ${s#p} (strip the shortest prefix)
		if len(t.Args) == 1 {
			if n, ok := t.Obj.(*NameE); ok {
				if pa, ok := t.Args[0].(*LitStr); ok {
					return call("param", []any{st("#"), st(n.Name), st(pa.Value)}), nil
				}
			}
		}
		return nil, fmt.Errorf("removeprefix: expected var.removeprefix(str)")
	case "removesuffix":
		// s.removesuffix(p) — ${s%p} (strip the shortest suffix)
		if len(t.Args) == 1 {
			if n, ok := t.Obj.(*NameE); ok {
				if pa, ok := t.Args[0].(*LitStr); ok {
					return call("param", []any{st("%"), st(n.Name), st(pa.Value)}), nil
				}
			}
		}
		return nil, fmt.Errorf("removesuffix: expected var.removesuffix(str)")
	case "join":
		// " ".join(a[i:j]) — space-join an array slice: the runtime's
		// param("slice", ...) returns the element ARRAY and join()
		// space-joins it (the perl frontend's array-slice lowering).
		// Only a literal space separator is expressible.
		if len(t.Args) == 1 {
			if sep, ok := t.Obj.(*LitStr); ok && sep.Value == " " {
				sl, err := l.argIR(t.Args[0])
				if err != nil {
					return nil, err
				}
				return call("join", []any{sl}), nil
			}
		}
		return nil, fmt.Errorf("join: expected \" \".join(list-or-slice)")
	case "replace":
		// s.replace(a, b) — `${s//a/b}` (all occurrences): the core
		// frontend's SubstituteAll lowering is param("//", name,
		// pat, rep) (shir.rs param_ir).
		if len(t.Args) == 2 {
			if n, ok := t.Obj.(*NameE); ok {
				if pa, ok := t.Args[0].(*LitStr); ok {
					rb, err := l.argIR(t.Args[1])
					if err != nil {
						return nil, err
					}
					return call("param", []any{st("//"), st(n.Name), st(pa.Value), rb}), nil
				}
			}
		}
		return nil, fmt.Errorf("replace: expected var.replace(str, str)")
	case "write":
		// fh.write("...") — handled at statement level (with-block)
		return nil, fmt.Errorf("write handled at statement level")
	}
	return nil, fmt.Errorf("unsupported method %s", t.Name)
}

// testIR lowers a Python condition to the IR test expression (the core's
// `[ ... ]` raw-string form inside Call("test", [Str])).
func (l *lowerer) testIR(e Expr) (map[string]any, error) {
	switch t := e.(type) {
	case *CompareE:
		lt, err := l.testOperand(t.Lhs)
		if err != nil {
			return nil, err
		}
		rt, err := l.testOperand(t.Rhs)
		if err != nil {
			return nil, err
		}
		switch t.Op {
		case "==":
			return call("test", []any{st(lt + "=" + rt)}), nil
		case "!=":
			return call("test", []any{st(lt + "!=" + rt)}), nil
		case "<":
			return call("test", []any{st(lt + " -lt " + rt)}), nil
		case ">":
			return call("test", []any{st(lt + " -gt " + rt)}), nil
		case "<=":
			return call("test", []any{st(lt + " -le " + rt)}), nil
		case ">=":
			return call("test", []any{st(lt + " -ge " + rt)}), nil
		case "in":
			// `a in b` — substring containment → the core's contains
			// helper (native String.includes, PureCpu). contains takes
			// (haystack, needle); Python's `in` has the haystack on
			// the right.
			a, err := l.argIR(t.Lhs)
			if err != nil {
				return nil, err
			}
			b, err := l.argIR(t.Rhs)
			if err != nil {
				return nil, err
			}
			return call("contains", []any{b, a}), nil
		}
		return nil, fmt.Errorf("unsupported comparison %s", t.Op)
	case *NotE:
		if n, ok := t.Arg.(*NameE); ok {
			return call("test", []any{st("-z \"$" + n.Name + "\"")}), nil
		}
		inner, err := l.testIR(t.Arg)
		if err != nil {
			return nil, err
		}
		if c, ok := inner["args"].([]any); ok && len(c) == 1 {
			if s, ok := c[0].(map[string]any); ok && s["type"] == "Str" {
				return call("test", []any{st("! " + s["value"].(string))}), nil
			}
		}
		return binop("Not", inner, inner), nil
	case *BoolE:
		lhs, err := l.testIR(t.Lhs)
		if err != nil {
			return nil, err
		}
		rhs, err := l.testIR(t.Rhs)
		if err != nil {
			return nil, err
		}
		if t.Op == "and" {
			return binop("And", lhs, rhs), nil
		}
		return binop("Or", lhs, rhs), nil
	case *CallE:
		if strings.Join(t.Path, ".") == "os.path.exists" {
			if len(t.Args) == 1 {
				if s, ok := t.Args[0].(*LitStr); ok {
					return call("test", []any{st("-e " + s.Value)}), nil
				}
			}
		}
		return nil, fmt.Errorf("unsupported condition call")
	case *MethodCallE:
		// s.startswith(p) / s.endswith(p) — a glob match against
		// p* / *p: the runtime's caseMatch returns the matched
		// pattern (truthy) or undefined (falsy).
		if t.Name == "startswith" || t.Name == "endswith" {
			if len(t.Args) == 1 {
				if n, ok := t.Obj.(*NameE); ok {
					if pa, ok := t.Args[0].(*LitStr); ok {
						pat := pa.Value + "*"
						if t.Name == "endswith" {
							pat = "*" + pa.Value
						}
						return call("caseMatch", []any{getVar(n.Name), array([]any{st(pat)})}), nil
					}
				}
			}
			return nil, fmt.Errorf("%s: expected var.%s(str)", t.Name, t.Name)
		}
		return nil, fmt.Errorf("unsupported condition method")
	case *NameE:
		return call("test", []any{st("-n \"$" + t.Name + "\"")}), nil
	}
	return nil, fmt.Errorf("unsupported condition")
}

// testOperand renders one side of a comparison in `[ ... ]` text form.
func (l *lowerer) testOperand(e Expr) (string, error) {
	switch t := e.(type) {
	case *LitInt:
		return t.Text, nil
	case *LitStr:
		return "\"" + t.Value + "\"", nil
	case *NameE:
		return "\"$" + t.Name + "\"", nil
	}
	return "", fmt.Errorf("unsupported test operand")
}

// ─────────────────────────────────────────────────────────────────────
// Statement lowering
// ─────────────────────────────────────────────────────────────────────

func (l *lowerer) stmtsIR(stmts []Stmt) ([]map[string]any, error) {
	var out []map[string]any
	for _, s := range stmts {
		irs, err := l.stmtIR(s)
		if err != nil {
			return nil, err
		}
		out = append(out, irs...)
	}
	return out, nil
}

func (l *lowerer) stmtIR(s Stmt) ([]map[string]any, error) {
	switch t := s.(type) {
	case *ImportS, *GlobalS:
		return nil, nil
	case *PrintS:
		return l.printIR(t)
	case *AssignS:
		return l.assignIR(t)
	case *IfS:
		return l.ifIR(t)
	case *WhileS:
		cond, err := l.testIR(t.Cond)
		if err != nil {
			return nil, err
		}
		body, err := l.stmtsIR(t.Body)
		if err != nil {
			return nil, err
		}
		return []map[string]any{whileStmt(cond, body)}, nil
	case *ForS:
		// for line in sys.stdin → `while read line; do ...; done` —
		// the shell read-loop (the read builtin returns false at EOF,
		// which the While cond branches on).
		if at, ok := t.Iter.(*AttrE); ok {
			if path, ok2 := dottedPath(at); ok2 && strings.Join(path, ".") == "sys.stdin" {
				l.setType(t.Var, "str")
				body, err := l.stmtsIR(t.Body)
				if err != nil {
					return nil, err
				}
				return []map[string]any{whileStmt(execCall("read", []any{st(t.Var)}), body)}, nil
			}
		}
		iter, err := l.iterIR(t.Iter)
		if err != nil {
			return nil, err
		}
		// loop var typing
		if lst, ok := t.Iter.(*ListE); ok && len(lst.Elems) > 0 {
			l.setType(t.Var, l.typeOf(lst.Elems[0]))
		} else if c, ok := t.Iter.(*CallE); ok && len(c.Path) == 1 && c.Path[0] == "range" {
			l.setType(t.Var, "int")
		} else {
			l.setType(t.Var, "str")
		}
		body, err := l.stmtsIR(t.Body)
		if err != nil {
			return nil, err
		}
		return []map[string]any{forStmt(t.Var, iter, body)}, nil
	case *FuncS:
		// params map to positional getVar("1").. — typed as str
		saved := l.curParams
		l.curParams = map[string]string{}
		for i, prm := range t.Params {
			l.types[prm] = "str"
			l.curParams[prm] = strconv.Itoa(i + 1)
		}
		body, err := l.stmtsIR(t.Body)
		l.curParams = saved
		if err != nil {
			return nil, err
		}
		return []map[string]any{functionStmt(t.Name, body)}, nil
	case *ReturnS:
		if t.Value == nil {
			return []map[string]any{map[string]any{"type": "Return", "value": nil}}, nil
		}
		// a string-valued return in a function body → echo the value
		// (shell functions return via stdout)
		ir, err := l.argIR(t.Value)
		if err != nil {
			return nil, err
		}
		return []map[string]any{exprStmt(execCall("echo", []any{ir}))}, nil
	case *ExprS:
		return l.exprStmtIR(t.Expr)
	case *WithS:
		return l.withIR(t)
	}
	return nil, fmt.Errorf("unsupported statement")
}

func (l *lowerer) printIR(t *PrintS) ([]map[string]any, error) {
	// Ternary args in word position have no A1 expression form (the
	// ESTree renderer's IrExpr::Ternary is Perl-only) — hoist each into
	// a fresh temp var via an If statement emitted before the print.
	var pre []map[string]any
	args := make([]Expr, len(t.Args))
	tmpIdx := 0
	for i, a := range t.Args {
		if tr, ok := a.(*TernaryE); ok {
			tmp := fmt.Sprintf("__t%d", tmpIdx)
			tmpIdx++
			cond, err := l.testIR(tr.Cond)
			if err != nil {
				return nil, err
			}
			thenIR, err := l.assignSimple(tmp, tr.Then)
			if err != nil {
				return nil, err
			}
			elseIR, err := l.assignSimple(tmp, tr.Else)
			if err != nil {
				return nil, err
			}
			pre = append(pre, ifStmt(cond, thenIR, elseIR))
			l.setType(tmp, l.typeOf(tr))
			args[i] = &NameE{Name: tmp}
		} else {
			args[i] = a
		}
	}
	nt := &PrintS{Args: args}
	if len(nt.Args) == 1 {
		if p, ok := nt.Args[0].(*PercentE); ok {
			// printf form: "%s-%s" % (a, b) → printf '%s-%s\n' a b
			fmtStr, ok := p.Format.(*LitStr)
			if !ok {
				return nil, fmt.Errorf("%%-format: format must be a string")
			}
			words := []any{st(fmtStr.Value + "\n")}
			for _, a := range p.Args {
				ir, err := l.argIR(a)
				if err != nil {
					return nil, err
				}
				words = append(words, ir)
			}
			return append(pre, exprStmt(execCall("printf", words))), nil
		}
	}
	words, err := l.argListIR(nt.Args)
	if err != nil {
		return nil, err
	}
	return append(pre, exprStmt(execCall("echo", words))), nil
}

func (l *lowerer) assignIR(t *AssignS) ([]map[string]any, error) {
	// os.environ set
	if len(t.Targets) == 1 {
		// plain env assignment handled via the \x00env\x00 marker only at
		// parse; here Targets holds the raw name
	}
	// tuple RHS: a, b = "x", "y"
	var rhsList []Expr
	if lst, ok := t.Expr.(*ListE); ok && len(t.Targets) > 1 {
		rhsList = lst.Elems
	}
	// ternary RHS → If form
	if tr, ok := t.Expr.(*TernaryE); ok && len(t.Targets) == 1 {
		cond, err := l.testIR(tr.Cond)
		if err != nil {
			return nil, err
		}
		thenIR, err := l.assignSimple(t.Targets[0], tr.Then)
		if err != nil {
			return nil, err
		}
		elseIR, err := l.assignSimple(t.Targets[0], tr.Else)
		if err != nil {
			return nil, err
		}
		return []map[string]any{ifStmt(cond, thenIR, elseIR)}, nil
	}
	var out []map[string]any
	for i, tg := range t.Targets {
		val := t.Expr
		if rhsList != nil {
			if i < len(rhsList) {
				val = rhsList[i]
			} else {
				val = &LitStr{Value: ""}
			}
		}
		irs, err := l.assignOne(tg, t.Op, val)
		if err != nil {
			return nil, err
		}
		out = append(out, irs...)
	}
	return out, nil
}

// assignOne lowers a single assignment; may produce multiple statements
// (e.g. subprocess.run → exec + capture).
// stripChain unwraps identity attribute/method layers (.stdout / .strip())
// so the underlying capture/read expression is exposed.
func stripChain(e Expr) Expr {
	for {
		switch t := e.(type) {
		case *MethodCallE:
			if t.Name == "strip" {
				e = t.Obj
				continue
			}
		case *AttrE:
			if t.Name == "stdout" {
				e = t.Obj
				continue
			}
		}
		return e
	}
}

func (l *lowerer) assignOne(target, op string, val Expr) ([]map[string]any, error) {
	// unwrap .stdout/.strip() chains before dispatch
	val = stripChain(val)
	// sys.stdin.readline() → read builtin
	if c, ok := val.(*CallE); ok && strings.Join(c.Path, ".") == "sys.stdin.readline" {
		return []map[string]any{exprStmt(execCall("read", []any{st(target)}))}, nil
	}
	// subprocess.run without capture → run it, capture the exit code
	if c, ok := val.(*CallE); ok && strings.Join(c.Path, ".") == "subprocess.run" {
		captureMode := false
		for _, kw := range c.Kwargs {
			if kw.Key == "capture_output" {
				if b, ok := kw.Value.(*BoolLit); ok && b.Value {
					captureMode = true
				}
			}
		}
		ir, err := l.callIR(c, true)
		if err != nil {
			return nil, err
		}
		if captureMode {
			l.setType(target, "str")
			return []map[string]any{assignStmt(target, ir)}, nil
		}
		return []map[string]any{
			exprStmt(ir),
			assignStmt(target, getVar("?")),
		}, nil
	}
	// subprocess.Popen → background job
	if c, ok := val.(*CallE); ok && strings.Join(c.Path, ".") == "subprocess.Popen" {
		ir, err := l.callIR(c, true)
		if err != nil {
			return nil, err
		}
		return []map[string]any{backgroundStmt([]map[string]any{exprStmt(ir)})}, nil
	}
	// list literal → setArray / setArrayAppend (arr += (...))
	if lst, ok := val.(*ListE); ok {
		var elems []any
		for _, el := range lst.Elems {
			if s, ok := el.(*LitStr); ok {
				elems = append(elems, st(s.Value))
				continue
			}
			if n, ok := el.(*LitInt); ok {
				elems = append(elems, st(n.Text))
				continue
			}
			ir, err := l.argIR(el)
			if err != nil {
				return nil, err
			}
			elems = append(elems, ir)
		}
		l.setType(target, "list")
		if op == "+=" {
			// arr += (...) — the core's PlusAssign-Array lowering
			return []map[string]any{assignStmt(target, call("setArrayAppend", []any{st(target), array(elems)}))}, nil
		}
		return []map[string]any{assignStmt(target, call("setArray", []any{st(target), array(elems)}))}, nil
	}
	// aug-assign
	if op == "+=" {
		if l.typeOf(val) == "int" {
			rhs, err := l.arithIR(val)
			if err != nil {
				return nil, err
			}
			ast := arithBin("+", arithVar(target), rhs["ast"].(map[string]any))
			l.setType(target, "int")
			return []map[string]any{assignStmt(target, arithExpr(ast))}, nil
		}
		// string += → concat
		rhs, err := l.argIR(val)
		if err != nil {
			return nil, err
		}
		return []map[string]any{assignStmt(target, interpolate([]any{
			interpExpr(getVar(target)), interpExpr(rhs),
		}))}, nil
	}
	return l.assignSimple(target, val)
}

// assignSimple lowers `target = value` (single statement).
func (l *lowerer) assignSimple(target string, val Expr) ([]map[string]any, error) {
	// plain string/number/var read
	switch v := val.(type) {
	case *LitStr:
		l.setType(target, "str")
		return []map[string]any{assignStmt(target, st(v.Value))}, nil
	case *LitInt:
		l.setType(target, "int")
		return []map[string]any{assignStmt(target, st(v.Text))}, nil
	case *BoolLit:
		l.setType(target, "int")
		if v.Value {
			return []map[string]any{assignStmt(target, st("1"))}, nil
		}
		return []map[string]any{assignStmt(target, st("0"))}, nil
	}
	// numeric arithmetic
	if l.typeOf(val) == "int" {
		ir, err := l.arithIR(val)
		if err == nil {
			l.setType(target, "int")
			return []map[string]any{assignStmt(target, ir)}, nil
		}
	}
	ir, err := l.argIR(val)
	if err != nil {
		return nil, err
	}
	if _, ok := val.(*NameE); ok {
		l.setType(target, l.typeOf(val))
	} else {
		l.setType(target, l.typeOf(val))
	}
	return []map[string]any{assignStmt(target, ir)}, nil
}

func (l *lowerer) ifIR(t *IfS) ([]map[string]any, error) {
	cond, err := l.testIR(t.Cond)
	if err != nil {
		return nil, err
	}
	then, err := l.stmtsIR(t.Then)
	if err != nil {
		return nil, err
	}
	// elif chains become nested If in the else branch (core shape)
	els := t.Else
	var elsIR []map[string]any
	if len(t.Elifs) > 0 {
		// build a nested If chain: last elif's else is the final else
		var build func(i int) ([]map[string]any, error)
		build = func(i int) ([]map[string]any, error) {
			el := t.Elifs[i]
			c, err := l.testIR(el.Cond)
			if err != nil {
				return nil, err
			}
			b, err := l.stmtsIR(el.Body)
			if err != nil {
				return nil, err
			}
			var inner []map[string]any
			if i+1 < len(t.Elifs) {
				inner, err = build(i + 1)
				if err != nil {
					return nil, err
				}
			} else {
				inner, err = l.stmtsIR(els)
				if err != nil {
					return nil, err
				}
			}
			return []map[string]any{ifStmt(c, b, inner)}, nil
		}
		elsIR, err = build(0)
		if err != nil {
			return nil, err
		}
	} else {
		elsIR, err = l.stmtsIR(els)
		if err != nil {
			return nil, err
		}
	}
	return []map[string]any{ifStmt(cond, then, elsIR)}, nil
}

func (l *lowerer) iterIR(e Expr) (map[string]any, error) {
	switch t := e.(type) {
	case *ListE:
		var elems []any
		for _, el := range t.Elems {
			ir, err := l.argIR(el)
			if err != nil {
				return nil, err
			}
			elems = append(elems, ir)
		}
		return array(elems), nil
	case *NameE:
		// for x in arrvar → the core's "${arr[@]}" lowering
		return array([]any{call("param", []any{st("slice"), st(t.Name), st("@"), st("")})}), nil
	case *CallE:
		// for i in range(a, b) → the core's native numeric-range
		// iterable (seq_range_for's bare Range; INCLUSIVE end —
		// Python's range end is exclusive, so hi = b-1). Bounds must
		// be literal ints for the native-counter lowering.
		if len(t.Path) == 1 && t.Path[0] == "range" {
			if len(t.Args) < 1 || len(t.Args) > 2 {
				return nil, fmt.Errorf("range: expected 1 or 2 arguments")
			}
			ints := make([]int64, 0, 2)
			for _, a := range t.Args {
				n, ok := a.(*LitInt)
				if !ok {
					return nil, fmt.Errorf("range: expected integer bounds")
				}
				v, err := strconv.ParseInt(n.Text, 10, 64)
				if err != nil {
					return nil, fmt.Errorf("range: bad integer %q", n.Text)
				}
				ints = append(ints, v)
			}
			var lo, hi int64
			if len(ints) == 1 {
				lo, hi = 0, ints[0]-1
			} else {
				lo, hi = ints[0], ints[1]-1
			}
			return map[string]any{"type": "Range", "start": lo, "end": hi}, nil
		}
		return nil, fmt.Errorf("unsupported iterable")
	}
	return nil, fmt.Errorf("unsupported iterable")
}

func (l *lowerer) exprStmtIR(e Expr) ([]map[string]any, error) {
	switch t := e.(type) {
	case *CallE:
		path := strings.Join(t.Path, ".")
		switch path {
		case "os.system", "subprocess.run", "subprocess.Popen":
			ir, err := l.callIR(t, true)
			if err != nil {
				return nil, err
			}
			if path == "subprocess.Popen" {
				return []map[string]any{backgroundStmt([]map[string]any{exprStmt(ir)})}, nil
			}
			return []map[string]any{exprStmt(ir)}, nil
		default:
			if len(t.Path) == 1 && l.fns[t.Path[0]] {
				ws, err := l.argListIR(t.Args)
				if err != nil {
					return nil, err
				}
				return []map[string]any{exprStmt(execCall(t.Path[0], ws))}, nil
			}
		}
	case *MethodCallE:
		if t.Name == "wait" {
			return []map[string]any{exprStmt(execCall("wait", []any{}))}, nil
		}
		if t.Name == "write" {
			// fh.write("...") — handled inside with-blocks
			return nil, fmt.Errorf("write outside with-block")
		}
	}
	return nil, fmt.Errorf("unsupported expression statement")
}

func (l *lowerer) withIR(t *WithS) ([]map[string]any, error) {
	// body: fh.write(CONTENT) → echo CONTENT > PATH
	var writes []map[string]any
	for _, s := range t.Body {
		es, ok := s.(*ExprS)
		if !ok {
			return nil, fmt.Errorf("with: only write statements supported")
		}
		mc, ok := es.Expr.(*MethodCallE)
		if !ok || mc.Name != "write" || len(mc.Args) != 1 {
			return nil, fmt.Errorf("with: only fh.write(CONTENT) supported")
		}
		content, ok := mc.Args[0].(*LitStr)
		if !ok {
			return nil, fmt.Errorf("with: write content must be a literal")
		}
		text := content.Value
		// echo re-adds the trailing newline
		text = strings.TrimSuffix(text, "\n")
		inner := []map[string]any{exprStmt(execCall("echo", []any{st(text)}))}
		mode := "w"
		if t.Mode == "a" {
			mode = "a"
		}
		writes = append(writes, redirectStmt(inner, 1, mode, t.Path))
	}
	return writes, nil
}

// ─────────────────────────────────────────────────────────────────────
// Program assembly
// ─────────────────────────────────────────────────────────────────────

func buildProgram(stmts []Stmt) (*shiremit.Program, error) {
	l := &lowerer{
		fns:    map[string]bool{},
		types:  map[string]string{},
		params: map[string][]string{},
	}
	l.collectFuncs(stmts)
	irs, err := l.stmtsIR(stmts)
	if err != nil {
		return nil, err
	}
	// A2 var_types: every assigned variable, sorted by name
	byName := map[string]string{}
	for name, ty := range l.types {
		t := "Str"
		if ty == "int" {
			t = "Int"
		}
		byName[name] = t
	}
	names := make([]string, 0, len(byName))
	for k := range byName {
		names = append(names, k)
	}
	sort.Strings(names)
	vt := make([]shiremit.VarType, 0, len(names))
	for _, k := range names {
		vt = append(vt, shiremit.VarType{Name: k, Type: byName[k]})
	}
	return &shiremit.Program{
		Imports:  []string{},
		Requires: []string{},
		VarTypes: vt,
		Subs:     []shiremit.Sub{},
		Stmts:    irs,
	}, nil
}

// ─────────────────────────────────────────────────────────────────────
// Shir — py-sh-go as a library: Python source -> A1 shIR JSON bytes
// (no trailing newline). Both the CLI (cmd/py-sh-go) and the combined
// busybox dispatch through this single entry point.
// ─────────────────────────────────────────────────────────────────────

func Shir(src string) ([]byte, error) {
	// Strip shebang.
	if i := strings.IndexByte(src, '\n'); i > 0 && strings.HasPrefix(src, "#!") {
		src = src[i+1:]
	}
	stmts, err := parseProgram(src)
	if err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	prog, err := buildProgram(stmts)
	if err != nil {
		return nil, fmt.Errorf("lower: %w", err)
	}
	out, err := shiremit.Emit(prog)
	if err != nil {
		return nil, fmt.Errorf("emit: %w", err)
	}
	// The shared emitter predates the stmt_lines contract field; the
	// core's program JSON always carries it (empty here — no line
	// mappings for the v1 subset). Insert after "requires" — exactly
	// where serde_json's BTreeMap ordering places it.
	out = bytes.Replace(out, []byte(`"requires":[]`), []byte(`"requires":[],"stmt_lines":[]`), 1)
	return out, nil
}
