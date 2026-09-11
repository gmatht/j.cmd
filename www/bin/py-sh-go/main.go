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
//	lists, indexing, slicing, len            → setArray / Index /
//	                                           param("slice") / param("len")
//	with open(...) as fh: fh.write(...)      → Redirect (echo > file)
//
// The emitted A1 shIR JSON uses EXACTLY the node shapes the core's
// `otranspilerl-cli --shir` produces for the equivalent shell source, so the
// ESTree backend (`--shir-in-estree` + harness/estree-runner.mjs)
// renders and executes it. Only statements the ESTree renderer accepts
// are emitted (Expr/Assign/If/While/For/Function/... — the Perl-only
// Output/Warn nodes panic the ESTree backend, so they are never
// emitted here).
package pylib

import (
	"bytes"
	"fmt"
	"math/big"
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
type LitFloat struct{ Text string } // de-tokenized Python float literal (e.g. "0.5")
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

// CompE — list comprehension (grammars-v4 listcomp: `test comp_for`, with
// the optional comp_if filter): an EXPRESSION evaluating to a NEW array
// built by iterating Iter, binding each item to Var, and keeping Elem for
// the items that pass the optional Cond filter. Lowered to the A1
// ArrayComp expr node (core request py-sh-go-comp-if).
type CompE struct {
	Var  string
	Iter Expr
	Elem Expr
	Cond Expr // nil = no filter
}
type DictE struct {
	Keys   []Expr // string-literal keys in the v1 subset
	Values []Expr
}
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

// TryS — Python try/except/else/finally (grammars-v4 `try_stmt`), the
// A1 `Try` node (core request py-sh-go 20260813). Except arms lower to
// TryExcept entries (match null for a bare except, as null when the
// clause has no binding); else/finally are plain statement lists.
type TryS struct {
	Body     []Stmt
	Except   []ExceptS
	ElseBody []Stmt
	Finally  []Stmt
}
type ExceptS struct {
	Match Expr // nil = bare except
	As    string
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
			// float literal: digits '.' digits ("0.5", "3.14"). A '.' NOT
			// followed by a digit stays an attribute-access token.
			if j < n && src[j] == '.' && j+1 < n && isDigit(src[j+1]) {
				j++
				for j < n && isDigit(src[j]) {
					j++
				}
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
		case '(', ')', '[', ']', '{', '}', ',', ':', '.', '+', '-', '*', '/', '%', '<', '>', '=':
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
		case "try":
			return p.parseTry(toks[1:], ln.indent)
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

// parseTry parses `try: body (except [expr [as name]]: body)*
// [else: body] [finally: body]` (grammars-v4 `try_stmt`). The
// except/else/finally clauses continue at the try's OWN indent — the
// same continuation pattern parseIf uses for elif/else. Nothing may
// follow a finally (Python forbids it); anything else at the same
// indent ends the statement.
func (p *parser) parseTry(toks []tok, indent int) (Stmt, error) {
	if len(toks) == 0 || toks[0].text != ":" {
		return nil, fmt.Errorf("try: expected :")
	}
	body, err := p.parseBody(indent)
	if err != nil {
		return nil, err
	}
	st := &TryS{Body: body}
	for p.pos < len(p.lines) && p.lines[p.pos].indent == indent {
		t2 := lexLine(p.lines[p.pos].text)
		if len(t2) == 0 || t2[0].kind != tIdent {
			break
		}
		switch t2[0].text {
		case "except":
			p.pos++
			match, asName, err := p.parseExceptClause(t2[1:])
			if err != nil {
				return nil, err
			}
			b, err := p.parseBody(indent)
			if err != nil {
				return nil, err
			}
			st.Except = append(st.Except, ExceptS{Match: match, As: asName, Body: b})
		case "else":
			p.pos++
			if len(t2) < 2 || t2[1].text != ":" {
				return nil, fmt.Errorf("else: expected :")
			}
			b, err := p.parseBody(indent)
			if err != nil {
				return nil, err
			}
			st.ElseBody = b
		case "finally":
			p.pos++
			if len(t2) < 2 || t2[1].text != ":" {
				return nil, fmt.Errorf("finally: expected :")
			}
			b, err := p.parseBody(indent)
			if err != nil {
				return nil, err
			}
			st.Finally = b
			return st, nil // nothing may follow finally
		default:
			return st, nil
		}
	}
	return st, nil
}

// parseExceptClause parses the `[expr [as name]] :` tail after the
// leading `except` keyword. Bare `except:` yields a nil match and no
// binding; `except E:` a NameE match; `except E as n:` both.
func (p *parser) parseExceptClause(toks []tok) (Expr, string, error) {
	colon := -1
	for i, t := range toks {
		if t.text == ":" {
			colon = i
			break
		}
	}
	if colon < 0 {
		return nil, "", fmt.Errorf("except: expected :")
	}
	clause := toks[:colon]
	if len(clause) == 0 {
		return nil, "", nil // bare except
	}
	asName := ""
	for i, t := range clause {
		if t.kind == tIdent && t.text == "as" {
			rest := clause[i+1:]
			if len(rest) != 1 || rest[0].kind != tIdent {
				return nil, "", fmt.Errorf("except: bad as binding")
			}
			asName = rest[0].text
			clause = clause[:i]
			break
		}
	}
	if len(clause) == 0 {
		return nil, "", fmt.Errorf("except: expected exception")
	}
	e, rest, err := parseExprUntil(clause, "\x00") // no terminator
	if err != nil {
		return nil, "", err
	}
	if len(rest) > 0 && rest[0].kind != tEOF {
		return nil, "", fmt.Errorf("except: trailing tokens")
	}
	return e, asName, nil
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
		case "(", "[", "{":
			depth++
		case ")", "]", "}":
			if depth > 0 {
				depth--
			}
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
		case "(", "[", "{":
			depth++
			continue
		case ")", "]", "}":
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
		if t.kind == tOp && (t.text == "*" || t.text == "/" || t.text == "%" || t.text == "//") {
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
	// Python precedence: power binds TIGHTER than unary minus
	// (-2**2 == -4) and is right-associative (2**3**2 == 2**9); the
	// exponent side recurses through parseUnary so `2**-1` parses too.
	lhs, err := e.parsePostfix()
	if err != nil {
		return nil, err
	}
	if e.isOp("**") {
		e.next()
		rhs, err := e.parseUnary()
		if err != nil {
			return nil, err
		}
		return &BinOpE{Op: "**", Lhs: lhs, Rhs: rhs}, nil
	}
	return lhs, nil
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
		if strings.Contains(t.text, ".") {
			return &LitFloat{Text: t.text}, nil
		}
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
			// list literal — or a comprehension when the first element is
			// followed by `for` (grammars-v4 comp_for [+ comp_if]; the A1
			// ArrayComp expr node): `[elem for var in iter (if cond)]`
			var elems []Expr
			if e.isOp("]") {
				e.next()
				return &ListE{}, nil
			}
			el, err := e.parseTernary()
			if err != nil {
				return nil, err
			}
			if e.isKw("for") {
				// comp_for: 'for' exprlist 'in' or_test comp_iter?
				e.next()
				vt := e.next()
				if vt.kind != tIdent {
					return nil, fmt.Errorf("comp: expected variable")
				}
				if !e.isKw("in") {
					return nil, fmt.Errorf("comp: expected in")
				}
				e.next()
				// or_test level (NOT ternary): a trailing `if` belongs to
				// comp_if, not to an `if ... else` in the iterable.
				iter, err := e.parseOr()
				if err != nil {
					return nil, err
				}
				var cond Expr
				if e.isKw("if") {
					// comp_if: 'if' test_nocond comp_iter?
					e.next()
					cond, err = e.parseOr()
					if err != nil {
						return nil, err
					}
				}
				if err := e.expectOp("]"); err != nil {
					return nil, err
				}
				return &CompE{Var: vt.text, Iter: iter, Elem: el, Cond: cond}, nil
			}
			elems = append(elems, el)
			for {
				if e.isOp(",") {
					e.next()
					if e.isOp("]") {
						break
					}
					el, err := e.parseTernary()
					if err != nil {
						return nil, err
					}
					elems = append(elems, el)
					continue
				}
				break
			}
			if err := e.expectOp("]"); err != nil {
				return nil, err
			}
			return &ListE{Elems: elems}, nil
		}
		if t.text == "{" {
			// dict literal {k: v, ...}
			var keys, vals []Expr
			if e.isOp("}") {
				e.next()
				return &DictE{}, nil
			}
			for {
				k, err := e.parseTernary()
				if err != nil {
					return nil, err
				}
				if err := e.expectOp(":"); err != nil {
					return nil, err
				}
				v, err := e.parseTernary()
				if err != nil {
					return nil, err
				}
				keys = append(keys, k)
				vals = append(vals, v)
				if e.isOp(",") {
					e.next()
					if e.isOp("}") {
						break
					}
					continue
				}
				break
			}
			if err := e.expectOp("}"); err != nil {
				return nil, err
			}
			return &DictE{Keys: keys, Values: vals}, nil
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
	types     map[string]string   // var → int|big|float|str|list|dict
	params    map[string][]string // function name → params (for scoping)
	curParams map[string]string   // active function: param → positional string
	// pending Popen pipe chains (the `a | b` idiom): tail var → ordered
	// stages (each stage is one exec statement). Flushed as an A1
	// `Pipeline` statement at the first non-chain statement / end of
	// body. pipeOrder keeps the flush order deterministic across
	// concurrent chains.
	pipes     map[string][][]map[string]any
	pipeOrder []string
	// bigint regime (2026-09, t86/t87): proven per-var value intervals
	// ([lo, hi], both non-nil when present). Python ints are unbounded,
	// so an integer whose interval is NOT proven within ±2^53 lowers to
	// the bigint domain (exact JS BigInt arith); everything proven stays
	// on the fast Number path. fnSites feeds the param intervals.
	ranges  map[string][2]*big.Int
	// setElemDom tracks set/list element domains for sorted(): var →
	// "int" (every recorded element proven within ±2^53) or "big".
	// Recorded at add()/append() and all-int literals; POISONED
	// (deleted) by setType — every rebinding re-records or falls back
	// to the legacy pipeline, so a stale verdict can never survive a
	// reassignment to non-int content.
	setElemDom map[string]string
	fnSites map[string][][]Expr // function name → per-call arg lists
	fnRet   map[string]string   // function name → inferred return type ("list", …)
	// float-path/bound hoist temp names: the base is context-derived
	// (floatName — `int(n**0.5)` -> `i_sqrt_n`), a per-context sequence
	// disambiguates only on collision (usedHoist tracks the names in
	// use; hoistSeq counts per-base collisions).
	usedHoist map[string]bool
	hoistSeq  map[string]int
}

var two53 = func() *big.Int { return big.NewInt(9007199254740992) }() // 2^53

// foldInt constant-folds an integer expression with exact big.Int
// arithmetic (literals, + - * // % ** over foldable operands). ok=false
// when any operand is not a compile-time integer (vars, floats, calls).
func foldInt(e Expr) (*big.Int, bool) {
	switch t := e.(type) {
	case *LitInt:
		n, ok := new(big.Int).SetString(t.Text, 10)
		return n, ok
	case *BinOpE:
		a, ok1 := foldInt(t.Lhs)
		b, ok2 := foldInt(t.Rhs)
		if !ok1 || !ok2 {
			return nil, false
		}
		switch t.Op {
		case "+":
			return new(big.Int).Add(a, b), true
		case "-":
			return new(big.Int).Sub(a, b), true
		case "*":
			return new(big.Int).Mul(a, b), true
		case "//":
			if b.Sign() == 0 {
				return nil, false
			}
			q, r := new(big.Int).QuoRem(a, b, new(big.Int))
			// Python floor division: round toward -inf
			if r.Sign() != 0 && (r.Sign() < 0) != (b.Sign() < 0) {
				q.Sub(q, big.NewInt(1))
			}
			return q, true
		case "%":
			if b.Sign() == 0 {
				return nil, false
			}
			r := new(big.Int).Rem(a, b)
			if r.Sign() != 0 && (r.Sign() < 0) != (b.Sign() < 0) {
				r.Add(r, b)
			}
			return r, true
		case "**":
			if !b.IsInt64() || b.Int64() < 0 || b.Int64() > 4096 || a.Abs(a).Cmp(big.NewInt(1<<20)) > 0 {
				return nil, false
			}
			return new(big.Int).Exp(a, b, nil), true
		}
		return nil, false
	}
	return nil, false
}

func (l *lowerer) collectFuncs(stmts []Stmt) {
	var walkStmts func(stmts []Stmt, fn string)
	var walkExpr func(e Expr)
	walkExpr = func(e Expr) {
		switch t := e.(type) {
		case *BinOpE:
			walkExpr(t.Lhs)
			walkExpr(t.Rhs)
		case *CompareE:
			walkExpr(t.Lhs)
			walkExpr(t.Rhs)
		case *NotE:
			walkExpr(t.Arg)
		case *BoolE:
			walkExpr(t.Lhs)
			walkExpr(t.Rhs)
		case *TernaryE:
			walkExpr(t.Cond)
			walkExpr(t.Then)
			walkExpr(t.Else)
		case *ListE:
			for _, el := range t.Elems {
				walkExpr(el)
			}
		case *CallE:
			if len(t.Path) == 1 && l.fns[t.Path[0]] {
				l.fnSites[t.Path[0]] = append(l.fnSites[t.Path[0]], t.Args)
			}
			for _, a := range t.Args {
				walkExpr(a)
			}
			for _, kw := range t.Kwargs {
				walkExpr(kw.Value)
			}
		case *MethodCallE:
			walkExpr(t.Obj)
			for _, a := range t.Args {
				walkExpr(a)
			}
		case *SubscriptE:
			walkExpr(t.Obj)
			if t.Index != nil {
				walkExpr(t.Index)
			}
			if t.SliceStart != nil {
				walkExpr(t.SliceStart)
			}
			if t.SliceEnd != nil {
				walkExpr(t.SliceEnd)
			}
		case *AttrE:
			walkExpr(t.Obj)
		}
	}
	walkStmts = func(stmts []Stmt, fn string) {
		for _, s := range stmts {
			switch t := s.(type) {
			case *FuncS:
				l.fns[t.Name] = true
				l.params[t.Name] = t.Params
				walkStmts(t.Body, t.Name)
			case *PrintS:
				for _, a := range t.Args {
					walkExpr(a)
				}
			case *AssignS:
				walkExpr(t.Expr)
			case *IfS:
				walkExpr(t.Cond)
				walkStmts(t.Then, fn)
				walkStmts(t.Else, fn)
				for _, el := range t.Elifs {
					walkExpr(el.Cond)
					walkStmts(el.Body, fn)
				}
			case *WhileS:
				walkExpr(t.Cond)
				walkStmts(t.Body, fn)
			case *ForS:
				walkExpr(t.Iter)
				walkStmts(t.Body, fn)
			case *ReturnS:
				if t.Value != nil {
					if ty := l.typeOf(t.Value); ty == "list" {
						l.fnRet[fn] = ty
					}
				}
			case *ExprS:
				walkExpr(t.Expr)
			case *WithS:
				walkStmts(t.Body, fn)
			case *TryS:
				walkStmts(t.Body, fn)
				for _, ex := range t.Except {
					walkStmts(ex.Body, fn)
				}
				walkStmts(t.ElseBody, fn)
				walkStmts(t.Finally, fn)
			}
		}
	}
	walkStmts(stmts, "")
}

func (l *lowerer) setType(name, t string) {
	l.types[name] = t
	delete(l.setElemDom, name)
}

// noteElemAdd records an integer element domain for set/list adds:
// int-typed values join the verdict (big wins); anything else poisons
// the entry (unknown → legacy pipeline at sorted()).
func (l *lowerer) noteElemAdd(name string, e Expr) {
	if ty := l.typeOf(e); ty != "int" && ty != "big" {
		delete(l.setElemDom, name)
		return
	}
	if cur, ok := l.setElemDom[name]; !ok || cur == "int" {
		l.setElemDom[name] = l.intDom(e)
	}
}

func (l *lowerer) typeOf(e Expr) string {
	switch t := e.(type) {
	case *CompE:
		return "list"
	case *LitInt:
		return l.intDom(t)
	case *LitFloat:
		return "float"
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
		// a float path (x ** 0.5, int(x ** 0.5)) is a float expr
		if (t.Op == "+" || t.Op == "-" || t.Op == "*" || t.Op == "//" ||
			t.Op == "%" || t.Op == "**") && floatPath(t) {
			return "float"
		}
		if t.Op == "+" {
			lt, rt := l.typeOf(t.Lhs), l.typeOf(t.Rhs)
			if (lt == "int" || lt == "big") && (rt == "int" || rt == "big") {
				return l.intDom(t)
			}
			// anything with a string operand concatenates (the shell has
			// no string/number split)
			return "str"
		}
		if t.Op == "//" || t.Op == "%" || t.Op == "*" || t.Op == "-" || t.Op == "**" {
			return l.intDom(t)
		}
		return "int"
	case *CompareE, *NotE, *BoolE:
		return "int"
	case *ListE:
		return "list"
	case *DictE:
		return "dict"
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
		case "int":
			if len(t.Args) == 1 && floatPath(t.Args[0]) {
				return "int"
			}
			if len(t.Args) == 1 {
				return l.intDom(t.Args[0])
			}
			return "int"
		case "sorted", "set", "list":
			return "list"
		case "max", "min", "sum":
			return "int"
		case "subprocess.run", "subprocess.Popen":
			return "str"
		case "os.environ":
			return "str"
		}
		if len(t.Path) == 1 && l.fns[t.Path[0]] {
			if rt, ok := l.fnRet[t.Path[0]]; ok {
				return rt
			}
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
// Integer domains: Python ints are unbounded, so an integer expression
// whose value cannot be PROVEN within ±2^53 lowers to the bigint domain
// (exact JS BigInt arith — Cast(Int64, Num) leaves render BigInt("N")
// literals, proven-big vars read raw from their lifted BigInt bindings,
// and / % compose through the runtime's BigInt-aware idiv/imod). Values
// with a proven interval inside ±2^53 stay on the fast Number path.
// ─────────────────────────────────────────────────────────────────────

// rangeOf returns the proven [lo, hi] value interval of an integer
// expression, or ok=false when nothing can be proven (the caller must
// then treat the value as unbounded → bigint).
func (l *lowerer) rangeOf(e Expr) (*big.Int, *big.Int, bool) {
	if n, ok := foldInt(e); ok {
		return n, new(big.Int).Set(n), true
	}
	switch t := e.(type) {
	case *NameE:
		if iv, present := l.ranges[t.Name]; present {
			return iv[0], iv[1], true
		}
	case *BinOpE:
		aLo, aHi, ok1 := l.rangeOf(t.Lhs)
		bLo, bHi, ok2 := l.rangeOf(t.Rhs)
		if !ok1 || !ok2 {
			// int()/sqrt bounds are provable from ONE side's interval
			if t.Op == "**" {
				if fl, ok := t.Rhs.(*LitFloat); ok && fl.Text == "0.5" {
					if lo, hi, ok3 := l.rangeOf(t.Lhs); ok3 && lo.Sign() >= 0 {
						// int-side handled by the int() case; x**0.5 itself
						// is float — only reachable through int(...), so
						// refuse a bare interval here.
						_ = lo
						_ = hi
					}
				}
			}
			return nil, nil, false
		}
		switch t.Op {
		case "+":
			return new(big.Int).Add(aLo, bLo), new(big.Int).Add(aHi, bHi), true
		case "-":
			return new(big.Int).Sub(aLo, bHi), new(big.Int).Sub(aHi, bLo), true
		case "*":
			p := []*big.Int{
				new(big.Int).Mul(aLo, bLo), new(big.Int).Mul(aLo, bHi),
				new(big.Int).Mul(aHi, bLo), new(big.Int).Mul(aHi, bHi),
			}
			mn, mx := p[0], p[0]
			for _, v := range p[1:] {
				if v.Cmp(mn) < 0 {
					mn = v
				}
				if v.Cmp(mx) > 0 {
					mx = v
				}
			}
			return mn, mx, true
		case "**":
			// base interval to a constant nonneg exponent (base ≥ 0)
			if e2, ok := foldInt(t.Rhs); ok && e2.IsInt64() && e2.Int64() >= 0 && e2.Int64() <= 256 && aLo.Sign() >= 0 {
				exp := uint(e2.Int64())
				return new(big.Int).Exp(aLo, big.NewInt(int64(exp)), nil),
					new(big.Int).Exp(aHi, big.NewInt(int64(exp)), nil), true
			}
		case "//":
			// floor division with a proven-positive divisor:
			// [floor(lo_a / hi_b), floor(hi_a / lo_b)] (both operands ≥ 0)
			if aLo.Sign() >= 0 && bLo.Sign() > 0 {
				q := new(big.Int).Quo(aLo, bHi)
				r := new(big.Int).Quo(aHi, bLo)
				return q, r, true
			}
		case "%":
			// Python modulo with a proven-positive divisor: result ∈ [0, hi_b - 1]
			if bLo.Sign() > 0 {
				return big.NewInt(0), new(big.Int).Sub(bHi, big.NewInt(1)), true
			}
		case "/":
			if aLo.Sign() >= 0 && bLo.Sign() > 0 {
				// bash-trunc == Python floor for nonneg operands
				q := new(big.Int).Quo(aLo, bHi)
				r := new(big.Int).Quo(aHi, bLo)
				return q, r, true
			}
		}
	case *CallE:
		if len(t.Path) == 1 && t.Path[0] == "int" && len(t.Args) == 1 {
			// int(x): trunc toward zero — monotone, so the interval maps
			// endpoint-wise. int(x ** 0.5) — the isqrt idiom: sqrt is
			// monotone too.
			arg := t.Args[0]
			if b, ok := arg.(*BinOpE); ok && b.Op == "**" {
				if fl, ok := b.Rhs.(*LitFloat); ok && fl.Text == "0.5" {
					if lo, hi, ok3 := l.rangeOf(b.Lhs); ok3 && lo.Sign() >= 0 {
						return isqrtBig(lo), isqrtBig(hi), true
					}
				}
			}
			if lo, hi, ok3 := l.rangeOf(arg); ok3 {
				return truncBig(lo), truncBig(hi), true
			}
		}
	}
	return nil, nil, false
}

// isqrtBig — floor square root of a nonneg big.Int (bit-by-bit).
func isqrtBig(n *big.Int) *big.Int {
	if n.Sign() <= 0 {
		return big.NewInt(0)
	}
	// Newton on floats for the seed, exact fixup with big.Int
	x := new(big.Int).Set(n)
	y := new(big.Int).Rsh(x, uint((x.BitLen()+1)/2))
	for {
		y.Div(x, y)
		y.Add(y, x)
		y.Rsh(y, 1)
		if y.Cmp(x) >= 0 {
			return x
		}
		x.Set(y)
	}
}

// truncBig — truncation toward zero (python int() of a float interval
// endpoint; the interval endpoints are integers standing in for reals).
func truncBig(n *big.Int) *big.Int {
	return new(big.Int).Set(n)
}

// intDom — the integer domain of an expression: "int" (proven ±2^53,
// exact JS Number) or "big" (unproven/proven-huge — exact JS BigInt).
// OPERAND domains dominate: a small-RANGE result over huge operands
// (x % 7 where x = 2**100) is still a bigint operation — the leaves must
// be in the same domain or the JS op throws.
func (l *lowerer) intDom(e Expr) string {
	switch t := e.(type) {
	case *BinOpE:
		if l.intDom(t.Lhs) == "big" || l.intDom(t.Rhs) == "big" {
			return "big"
		}
		if t.Op == "**" {
			// pow: unprovable growth — only a proven-small fold stays Number
			if lo, hi, ok := l.rangeOf(e); ok && hi.Cmp(two53) <= 0 && lo.Cmp(new(big.Int).Neg(two53)) >= 0 {
				return "int"
			}
			return "big"
		}
		if lo, hi, ok := l.rangeOf(e); ok {
			if hi.Cmp(two53) <= 0 && lo.Cmp(new(big.Int).Neg(two53)) >= 0 {
				return "int"
			}
			return "big"
		}
		return "int"
	case *CallE:
		if len(t.Path) == 1 && t.Path[0] == "int" && len(t.Args) == 1 {
			if !floatPath(t.Args[0]) {
				return l.intDom(t.Args[0])
			}
			return "int" // float-path int() results are double-derived
		}
	}
	if lo, hi, ok := l.rangeOf(e); ok {
		if hi.Cmp(two53) <= 0 && lo.Cmp(new(big.Int).Neg(two53)) >= 0 {
			return "int"
		}
		return "big"
	}
	switch t := e.(type) {
	case *NameE:
		switch l.types[t.Name] {
		case "big":
			return "big"
		case "int":
			return "int"
		}
		return "big"
	}
	return "big"
}

// floatPath — does this integer-context expression contain a float
// operation (a float literal under **, int() of such)? Those lower to a
// runtime arith-string evaluated with JS doubles (the exact computation
// native python does), not the integer Arith AST.
func floatPath(e Expr) bool {
	switch t := e.(type) {
	case *LitFloat:
		return true
	case *LitInt, *NameE, *BoolLit:
		return false
	case *BinOpE:
		return floatPath(t.Lhs) || floatPath(t.Rhs)
	case *CallE:
		if len(t.Path) == 1 && t.Path[0] == "int" && len(t.Args) == 1 {
			return floatPath(t.Args[0])
		}
		return false
	}
	return false
}

// arithCast — an A1 arith Cast node ({"kind": Int64} renders BigInt(...)
// for a Num arg — exact past 2^53 — and BigInt.asIntN(64, BigInt(x)) for
// a Var arg — exact for proven-±2^63 values).
func arithCast(kind string, arg map[string]any) map[string]any {
	return map[string]any{"type": "Cast", "ty": map[string]any{"kind": kind}, "arg": arg}
}

// bigLitAst — a bigint-domain integer literal: Cast(Int64, Num) when it
// fits i64 (renders the exact BigInt("N") literal); a Horner decomposition
// ((d·10+d')·10+…) of Cast-wrapped digits otherwise (the A1 Num node is
// i64-only, so a >i64 literal is only expressible as an exact expression).
func bigLitAst(text string) (map[string]any, error) {
	n, ok := new(big.Int).SetString(text, 10)
	if !ok {
		return nil, fmt.Errorf("bad integer literal %q", text)
	}
	if n.IsInt64() {
		return arithCast("Int64", arithNum(n.Int64())), nil
	}
	cur := arithCast("Int64", arithNum(0))
	for _, ch := range text {
		if ch < '0' || ch > '9' {
			return nil, fmt.Errorf("bad integer literal %q", text)
		}
		d := ch - '0'
		cur = arithBin("+",
			arithBin("*", cur, arithCast("Int64", arithNum(10))),
			arithCast("Int64", arithNum(int64(d))))
	}
	return cur, nil
}

// tempFor — a fresh, readable IR temp name for a hoisted call operand
// (`min(xs)` -> `_min_xs`; `len(names)` -> `_len_names`). A per-base
// sequence disambiguates only on collision with an existing temp.
func (l *lowerer) tempFor(fn, name string) string {
	base := fmt.Sprintf("_%s_%s", fn, name)
	if !l.usedHoist[base] {
		l.usedHoist[base] = true
		return base
	}
	for {
		l.hoistSeq[base]++
		t := fmt.Sprintf("%s_%d", base, l.hoistSeq[base])
		if !l.usedHoist[t] {
			l.usedHoist[t] = true
			return t
		}
	}
}

// arithIRDom — the domain-aware arith lowering. dom == "big" wraps
// literals as exact BigInt leaves and composes Python's floor division /
// modulo (sign-of-divisor semantics JS lacks) out of + - * % over the
// runtime's BigInt-aware idiv/imod helpers. zeroCmp marks the direct
// child of an `== 0` comparison: Python `a % b == 0` equals JS `a % b ==
// 0` for EVERY sign (zero is zero), so the uncomposed form renders — the
// core's zero-compare native path (no per-iteration helper dispatch).
func (l *lowerer) arithIRDom(e Expr, dom string, zeroCmp bool) (map[string]any, error) {
	switch t := e.(type) {
	case *LitInt:
		if dom == "big" {
			ast, err := bigLitAst(t.Text)
			if err != nil {
				return nil, err
			}
			return arithExpr(ast), nil
		}
		n, err := strconv.ParseInt(t.Text, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("int literal %q out of i64 range in Number context", t.Text)
		}
		return arithExpr(arithNum(n)), nil
	case *LitFloat:
		return nil, fmt.Errorf("float literal outside the float path")
	case *NameE:
		// inside a function body a param reads its POSITIONAL ($1) —
		// mirror toArithText/argIR so the AST never store-marks the
		// param name (a store-marked param loses its lifted BigInt/
		// Number binding; the C backend reads Var("1") as _sh_argv[1]).
		pos := t.Name
		if p, ok := l.curParams[t.Name]; ok {
			pos = p
		}
		if dom == "big" {
			// a bigint-domain read: coerce to exact BigInt. Cast(Int64, …)
			// is the frontend's "read exactly as BigInt" marker — the core
			// renders a bigint-homed var arg as BigInt(raw || 0) with NO
			// asIntN(64, …) wrap (t91_set_sum_fallback: the loop var x can
			// hold 2**100, which must not wrap mod 2^64). A var whose
			// binding may hold a Number/string must coerce up too: BigInt(x)
			// is exact for any integral value within ±2^63.
			return arithExpr(arithCast("Int64", arithVar(pos))), nil
		}
		return arithExpr(arithVar(pos)), nil
	case *CallE:
		if len(t.Path) == 1 && (t.Path[0] == "max" || t.Path[0] == "min" || t.Path[0] == "sum" || t.Path[0] == "len") && len(t.Args) == 1 {
			if n, ok := t.Args[0].(*NameE); ok {
				// a reduction is a VALUE, not an arith leaf — the Arith AST
				// has no call node and every arithIRDom caller extracts
				// ["ast"]. Callers that can emit statements must hoist the
				// call into a temp FIRST (see assignOne's += path); a bare
				// return call(…) here would nil-panic every consumer, so
				// fail loudly and let the caller hoist.
				return nil, fmt.Errorf("reduction call %s(%s) cannot be an arith leaf — hoist it into a temp first", t.Path[0], n.Name)
			}
		}
		if len(t.Path) == 1 && t.Path[0] == "int" && len(t.Args) == 1 {
			return l.arithIRDom(t.Args[0], dom, zeroCmp)
		}
		return nil, fmt.Errorf("unsupported call in arithmetic")
	case *BinOpE:
		la, err := l.arithIRDom(t.Lhs, dom, false)
		if err != nil {
			return nil, err
		}
		ra, err := l.arithIRDom(t.Rhs, dom, false)
		if err != nil {
			return nil, err
		}
		lhsAst := la["ast"].(map[string]any)
		rhsAst := ra["ast"].(map[string]any)
		op := t.Op
		if op == "//" || op == "%" {
			// plain when Python's semantics match the JS operators: both
			// operands proven nonneg and the divisor proven positive
			plain := false
			if aLo, _, ok1 := l.rangeOf(t.Lhs); ok1 && aLo.Sign() >= 0 {
				if bLo, _, ok2 := l.rangeOf(t.Rhs); ok2 && bLo.Sign() > 0 {
					plain = true
				}
			}
			if op == "%" && zeroCmp {
				plain = true // `a % b == 0` is sign-independent
			}
			if !plain {
				// Python modulo: ((a % b) + b) % b; floor division:
				// (a - pythonmod) / b (exact — the remainder is subtracted)
				m1 := arithBin("%", lhsAst, rhsAst)
				m2 := arithBin("+", m1, rhsAst)
				pm := arithBin("%", m2, rhsAst)
				if op == "%" {
					return arithExpr(pm), nil
				}
				return arithExpr(arithBin("/", arithBin("-", lhsAst, pm), rhsAst)), nil
			}
			op = map[string]string{"//": "/", "%": "%"}[op]
		}
		return arithExpr(arithBin(op, lhsAst, rhsAst)), nil
	case *SubscriptE:
		return l.subscriptIR(t)
	}
	return nil, fmt.Errorf("unsupported arithmetic")
}

// toArithText renders an integer-context expression (one with a float
// path) as an evalArith source string: doubles throughout — the SAME
// IEEE-754 computation native python performs for float math. x**0.5
// renders sqrt(x) (Math.sqrt is exactly rounded, matching glibc's
// correctly-rounded pow(x, 0.5) CPython uses); other float pows REFUSE
// (an ulp-level Math.pow vs glibc pow mismatch would silently corrupt
// int() truncation). Inside a function body a param reads its POSITIONAL
// ($1) so the arith text never store-marks the param var (a store-marked
// param loses its lifted BigInt/Number binding and every loop-iteration
// read re-parses the store string).
func (l *lowerer) toArithText(e Expr) (string, error) {
	switch t := e.(type) {
	case *LitInt:
		return t.Text, nil
	case *LitFloat:
		return t.Text, nil
	case *NameE:
		if pos, ok := l.curParams[t.Name]; ok {
			return "$" + pos, nil
		}
		return "$" + t.Name, nil
	case *CallE:
		if len(t.Path) == 1 && t.Path[0] == "int" && len(t.Args) == 1 {
			x, err := l.toArithText(t.Args[0])
			if err != nil {
				return "", err
			}
			return "int(" + x + ")", nil
		}
		return "", fmt.Errorf("unsupported call in float arithmetic")
	case *BinOpE:
		if t.Op == "**" {
			if fl, ok := t.Rhs.(*LitFloat); ok && fl.Text == "0.5" {
				x, err := l.toArithText(t.Lhs)
				if err != nil {
					return "", err
				}
				return "sqrt(" + x + ")", nil
			}
			return "", fmt.Errorf("float pow: only the x ** 0.5 (sqrt) form is supported")
		}
		x, err := l.toArithText(t.Lhs)
		if err != nil {
			return "", err
		}
		y, err := l.toArithText(t.Rhs)
		if err != nil {
			return "", err
		}
		if t.Op == "/" {
			return "", fmt.Errorf("float division unsupported (evalArith truncates)")
		}
		return "(" + x + " " + t.Op + " " + y + ")", nil
	}
	return "", fmt.Errorf("unsupported float-path expression")
}

// hoistFloatIR — the runtime arith-string call for a float-path
// expression (returns the printed double result as a string).
func (l *lowerer) hoistFloatIR(e Expr) (map[string]any, error) {
	// integer-sqrt idiom first: a bare `int(Y**0.5)` (int-domain Y)
	// lowers to the structured `isqrt` Call — no arith-string. The
	// ±K-bound wrapper is handled by hoistIntOperand (two native
	// temps); other callers splice the bare node directly.
	if isq, ok := l.tryIsqrtIR(e); ok {
		return isq, nil
	}
	text, err := l.toArithText(e)
	if err != nil {
		return nil, err
	}
	return call("arith", []any{st(text)}), nil
}

// floatName — a meaningful, context-derived name for a hoisted
// float-path expression: the call chain and variable names, constants
// skipped (`int(n**0.5) + 1` -> `i_sqrt_n`). Disambiguation is by
// CONTEXT (the expression's shape), not by a global sequence number;
// the sequence only kicks in on collision (see hoistIntOperand). Falls
// back to "h" when the expression has no identifiers.
func floatName(e Expr) string {
	parts := floatNameParts(e)
	if len(parts) == 0 {
		return "h"
	}
	return strings.Join(parts, "_")
}

// floatNameParts — the name fragments of a float-path expression: a
// call contributes its abbreviated function name, a variable its name,
// constants nothing. `int(x)` -> `i` + x's parts; `x ** 0.5` -> `sqrt` +
// x's parts (mirrors toArithText's lowering).
func floatNameParts(e Expr) []string {
	switch t := e.(type) {
	case *LitInt, *LitFloat:
		return nil // constants don't add meaning
	case *NameE:
		return []string{t.Name}
	case *CallE:
		if len(t.Path) == 1 && t.Path[0] == "int" && len(t.Args) == 1 {
			return append([]string{"i"}, floatNameParts(t.Args[0])...)
		}
		fn := abbrevFloatFn(t.Path[len(t.Path)-1])
		parts := []string{fn}
		for _, a := range t.Args {
			parts = append(parts, floatNameParts(a)...)
		}
		return parts
	case *BinOpE:
		if t.Op == "**" {
			if fl, ok := t.Rhs.(*LitFloat); ok && fl.Text == "0.5" {
				return append([]string{"sqrt"}, floatNameParts(t.Lhs)...)
			}
		}
		return append(floatNameParts(t.Lhs), floatNameParts(t.Rhs)...)
	}
	return nil
}

// abbrevFloatFn — a short tag for a float-path function name: `int` ->
// `i`, `trunc` -> `tr`; other short single words stay whole (`sqrt`),
// multi-word names abbreviate to first letters, long single words to
// their first 3 chars.
func abbrevFloatFn(name string) string {
	switch name {
	case "int":
		return "i"
	case "trunc":
		return "tr"
	}
	if strings.Contains(name, "_") {
		var b strings.Builder
		for _, w := range strings.Split(name, "_") {
			if w != "" {
				b.WriteByte(w[0])
			}
		}
		return b.String()
	}
	if len(name) <= 6 {
		return name
	}
	return name[:3]
}

// hoistIntOperand — pre-lowering for one side of an integer comparison /
// range bound: a float-path expression evaluates ONCE into a temp pair
// (the arith-string result, then Number/BigInt-ized so the per-iteration
// cond reads a plain binding instead of re-parsing a store string).
// Returns the pre-statements and the int-typed read expression.
// tryIsqrtIR recognizes the integer-sqrt idiom `int(Y ** 0.5)` with an
// int-domain Y and lowers it to a STRUCTURED `isqrt` Call — no
// arith-string detour (`arith("int(sqrt(..))")` + string temp + `+0`
// re-numerify). Only int-domain (intDom(Y) == "int", no float in Y);
// anything else (bigint/float Y, other shapes) reports false and the
// caller keeps the legacy float-string path. A nonneg constant Y folds
// to its exact isqrt (isqrtBig); negative constants abort (preserve the
// legacy path exactly — Python raises, runtimes clamp/garbage).
func (l *lowerer) tryIsqrtIR(e Expr) (map[string]any, bool) {
	c, ok := e.(*CallE)
	if !ok || len(c.Path) != 1 || c.Path[0] != "int" || len(c.Args) != 1 {
		return nil, false
	}
	b, ok := c.Args[0].(*BinOpE)
	if !ok || b.Op != "**" {
		return nil, false
	}
	fl, ok := b.Rhs.(*LitFloat)
	if !ok || fl.Text != "0.5" {
		return nil, false
	}
	y := b.Lhs
	if l.intDom(y) != "int" || floatPath(y) {
		return nil, false
	}
	if lit, ok := y.(*LitInt); ok {
		n, ok := new(big.Int).SetString(lit.Text, 10)
		if !ok || n.Sign() < 0 {
			return nil, false
		}
		r := isqrtBig(n)
		if !r.IsInt64() {
			return nil, false
		}
		return arithExpr(arithNum(r.Int64())), true
	}
	yIR, err := l.arithIRDom(y, "int", false)
	if err != nil {
		return nil, false
	}
	if _, ok := yIR["ast"].(map[string]any); !ok {
		return nil, false
	}
	return call("isqrt", []any{yIR}), true
}

// tryIsqrtHoist lowers an isqrt-idiom bound (`int(Y**0.5)` or
// `int(Y**0.5)±K`, int-domain) to native-int temps holding the
// structured `isqrt` Call — compute-once for hot loop bounds, no
// strings. The ±K folds in a second temp via Arith Var+Num (a Call can
// never nest inside ArithAst, and the bound cond must stay a plain Var
// for fold_range_pair/cstyle). Reports false for any other shape
// (caller keeps the legacy float path).
func (l *lowerer) tryIsqrtHoist(e Expr) (pre []map[string]any, ex Expr, ok bool) {
	inner := e
	var k int64
	hasK := false
	kneg := false
	if b, isBin := e.(*BinOpE); isBin && (b.Op == "+" || b.Op == "-") {
		if lit, isLit := b.Rhs.(*LitInt); isLit {
			if kk, err := strconv.ParseInt(lit.Text, 10, 64); err == nil {
				inner, k, hasK, kneg = b.Lhs, kk, true, b.Op == "-"
			}
		}
	}
	isq, ok := l.tryIsqrtIR(inner)
	if !ok {
		return nil, nil, false
	}
	if hasK && k == 0 {
		hasK = false
	}
	// meaningful temp name from the expression shape
	// (`int(n**0.5)+1` -> `_i_sqrt_nv`, matching the legacy temp).
	base := floatName(e)
	s := "_" + base
	n := s + "v"
	if l.usedHoist[s] || l.usedHoist[n] {
		l.hoistSeq[base]++
		s = fmt.Sprintf("_%s_%d", base, l.hoistSeq[base])
		n = s + "v"
	}
	l.usedHoist[s] = true
	l.usedHoist[n] = true
	l.setType(s, "int")
	pre = []map[string]any{assignStmt(s, isq)}
	if !hasK {
		return pre, &NameE{Name: s}, true
	}
	// second temp folds ±K via Arith Var+Num (a Call can never nest
	// inside ArithAst, and the bound cond must stay a plain Var:
	// fold_range_pair/cstyle only handle Var/Num bound text).
	kop := "+"
	if kneg {
		kop = "-"
	}
	pre = append(pre, assignStmt(n, arithExpr(arithBin(kop, arithVar(s), arithNum(k)))))
	l.setType(n, "int")
	return pre, &NameE{Name: n}, true
}

func (l *lowerer) hoistIntOperand(e Expr, dom string) ([]map[string]any, Expr, error) {
	if !floatPath(e) {
		return nil, e, nil
	}
	// integer-sqrt idiom (`int(Y**0.5)[±K]`, int-domain): a SINGLE
	// native-int temp holding the structured `isqrt` Call — no
	// arith-string, no string temp, no `+0` re-numerify. Big-domain
	// and all other shapes keep the legacy float path below.
	if dom == "int" {
		if pre, ex, ok := l.tryIsqrtHoist(e); ok {
			return pre, ex, nil
		}
	}
	ir, err := l.hoistFloatIR(e)
	if err != nil {
		return nil, nil, err
	}
	// meaningful temp name: `_<context>` where the context is the
	// expression's shape (`int(n**0.5) + 1` -> `_i_sqrt_n`), so the
	// temp reads as what it holds instead of the opaque `__fl0` or a
	// sequence-numbered `__h_int_0`. The `v` suffix marks the numeric
	// (long long) form; the bare name is the arith-string form. A
	// per-context sequence disambiguates only on collision.
	base := floatName(e)
	s := "_" + base
	n := s + "v"
	if l.usedHoist[s] || l.usedHoist[n] {
		l.hoistSeq[base]++
		s = fmt.Sprintf("_%s_%d", base, l.hoistSeq[base])
		n = s + "v"
	}
	l.usedHoist[s] = true
	l.usedHoist[n] = true
	plus := arithNum(0)
	if dom == "big" {
		// BigInt-ize: Cast(store-string) + Cast(0) — exact any size ≤ 2^63
		return []map[string]any{assignStmt(s, ir),
				assignStmt(n, arithExpr(arithBin("+",
					arithCast("Int64", arithVar(s)), arithCast("Int64", arithNum(0)))))},
			&NameE{Name: n}, nil
	}
	_ = plus
	return []map[string]any{assignStmt(s, ir),
			assignStmt(n, arithExpr(arithBin("+", arithVar(s), arithNum(0))))},
		&NameE{Name: n}, nil
}

// ─────────────────────────────────────────────────────────────────────
// A1 shIR JSON builders (byte-identical to sh2perl/src/shir_json.rs)
// ─────────────────────────────────────────────────────────────────────

// st builds an IrExpr::Str node (DoubleQuoted style — the default the
// core's `st()` uses for literal words).
func st(s string) map[string]any {
	return map[string]any{"type": "Str", "value": s, "style": "DoubleQuoted"}
}

// numNode builds an IrExpr::Int node ({"type":"Int","value":N}).
func numNode(n int64) map[string]any {
	return map[string]any{"type": "Int", "value": n}
}

// parsePyInt parses a Python integer literal (underscores, 0x/0o/0b
// prefixes, decimal) into an int64 for typed call args. ok=false when
// unparseable or out of int64 range — the caller keeps the string form
// (status quo), so huge literals never truncate and odd spellings
// never misread (a leading-zero decimal is a Python SyntaxError, so
// refuse it rather than guess octal).
func parsePyInt(text string) (int64, bool) {
	t := strings.ReplaceAll(text, "_", "")
	if t == "" {
		return 0, false
	}
	base := 10
	digits := t
	if strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X") {
		base, digits = 16, t[2:]
	} else if strings.HasPrefix(t, "0o") || strings.HasPrefix(t, "0O") {
		base, digits = 8, t[2:]
	} else if strings.HasPrefix(t, "0b") || strings.HasPrefix(t, "0B") {
		base, digits = 2, t[2:]
	} else if len(t) > 1 && strings.HasPrefix(t, "0") {
		return 0, false
	}
	if digits == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(digits, base, 64)
	if err != nil {
		return 0, false
	}
	return n, true
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
		"param", "callDirect", "sortedIntJoin", "sortedBigintJoin", "isqrt":
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
	if elems == nil {
		elems = []any{}
	}
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

// declareStmt builds a bare Declare node (scope annotation, no init):
// the var is function-scoped when local is true (Python params and
// function-body locals — backends render true C/JS locals from it),
// module-scoped otherwise. It carries no value semantics on its own;
// the initializing Assign is always emitted alongside, so analyses
// keyed off Assign (ranges, liveness, nonnull) see an unchanged IR.
func declareStmt(vr string, local bool) map[string]any {
	return map[string]any{
		"type": "Declare",
		"vars": []any{map[string]any{
			"name":  vr,
			"sigil": nil,
		}},
		"init":  nil,
		"local": local,
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

// pipelineStmt builds the A1 `Pipeline` statement node (schema.json
// "Pipeline", the exact shape src/shir_json.rs emits for a top-level
// shell `a | b`): each stage is a stmt[] (one exec per stage here), and
// the optional fields are null — the same node the core request
// py-sh-go-20260814-164552-pipeline made the ESTree renderer accept.
func pipelineStmt(stages [][]map[string]any) map[string]any {
	ss := make([]any, 0, len(stages))
	for _, st := range stages {
		ss = append(ss, toAnyStmts(st))
	}
	return map[string]any{
		"type":        "Pipeline",
		"stages":      ss,
		"last_output": nil,
		"capture":     nil,
		"cmd_str":     nil,
		"purity":      "Spawn",
	}
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
		if floatPath(t) {
			// a float-path subexpression inside a string/word context
			// (print("bound=", int(n**0.5) + 1)) — the runtime arith-string
			return l.hoistFloatIR(t)
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
	return l.arithIRDom(e, l.intDom(e), false)
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
	// s.split()[0] — the first whitespace-separated word; s.split(sep)[0]
	// — the part before the FIRST sep occurrence. Both lower to ${s%%P*}:
	// strip the longest suffix that starts at the first space/sep (bash
	// param expansion; the core's param lift lowers it natively for a
	// literal core like " " or ","). No-arg split() on a string with
	// LEADING whitespace differs (python skips the whitespace run, the
	// glob keeps it) — out of the corpus idiom's scope.
	if mc, ok := t.Obj.(*MethodCallE); ok && mc.Name == "split" {
		if one, ok := t.Index.(*LitInt); ok && one.Text == "0" {
			if n, ok := mc.Obj.(*NameE); ok {
				sep := " "
				if len(mc.Args) == 1 {
					pa, ok := mc.Args[0].(*LitStr)
					if !ok {
						return nil, fmt.Errorf("split subscript: expected var.split(str)[0]")
					}
					sep = pa.Value
				} else if len(mc.Args) > 1 {
					return nil, fmt.Errorf("split subscript: expected var.split([str])[0]")
				}
				return call("param", []any{st("%%"), st(n.Name), st(sep + "*")}), nil
			}
		}
		return nil, fmt.Errorf("split subscript: expected var.split()[0]")
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
		// A1 `Index` expr node — the contract's rich array-element read
		// ({"type":"Index","var":V,"key":K}), the canonical form of the
		// `arrayIndex` call (core request py-sh-go-20260814-125405; the
		// ESTree renderer's IrExpr::Index arm executes it as
		// sh2.arrayIndex(V, K)). Keys lower as full exprs: Int/Str
		// literals, getVar calls, ...
		return map[string]any{"type": "Index", "var": name.Name, "key": key}, nil
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
	case "max", "min", "sum":
		// max(x) / min(x) / sum(x) over a list/set variable — a typed
		// reduction node. Backends lower natively over an int array
		// (O(1) with maintained aggregates, else a native scan); the
		// consumption-profile pass keeps the array int-typed when it is
		// only reduced this way.
		if len(t.Args) == 1 {
			if n, ok := t.Args[0].(*NameE); ok {
				return call(path, []any{st(n.Name)}), nil
			}
		}
		return nil, fmt.Errorf("%s: expected a list variable", path)
	case "sorted", "list":
		// sorted(x) / sorted(list(x)) — the Python sorted-list repr: the
		// set/array's values, numerically sorted, deduped (set semantics),
		// comma-space-joined. A capture of `printf '%s\n' "${x[@]}" |
		// sort -n -u | awk …` — real GNU sort -n handles arbitrary
		// precision (BigInt values stringify exactly), and the awk stage
		// joins the lines with ", " (paste -sd can't: its delimiter list
		// would cycle chars). The value is the list repr — print() wraps
		// it in brackets; the capture strips trailing newlines.
		if len(t.Args) == 1 {
			arg := t.Args[0]
			if lc, ok := arg.(*CallE); ok && len(lc.Path) == 1 && lc.Path[0] == "list" && len(lc.Args) == 1 {
				arg = lc.Args[0]
			}
			if n, ok := arg.(*NameE); ok {
				// typed sorted-join node when the element domain is
				// proven (int/big): backends lower natively (exact
				// numeric sort, no fork/exec). Otherwise the legacy
				// pipeline below (unchanged behavior).
				if dom, ok := l.setElemDom[n.Name]; ok && (dom == "int" || dom == "big") {
					fn := "sortedIntJoin"
					if dom == "big" {
						fn = "sortedBigintJoin"
					}
					return call(fn, []any{st(n.Name)}), nil
				}
				pipe := map[string]any{"type": "Pipeline", "stages": []any{
					[]map[string]any{exprStmt(execCall("printf", []any{st("%s\n"), call("param", []any{st("slice"), st(n.Name), st("@"), st("")})}))},
					[]map[string]any{exprStmt(execCall("sort", []any{st("-n"), st("-u")}))},
					[]map[string]any{exprStmt(execCall("awk", []any{st("NR>1{printf \"%s\",\", \"}{printf \"%s\",$0}")}))},
				}}
				return capture(arrow([]map[string]any{pipe})), nil
			}
		}
		return nil, fmt.Errorf("sorted: expected a list variable")
	default:
		if len(t.Path) == 1 && l.fns[t.Path[0]] {
			// call to a script-defined function: int-literal args
			// stay numeric (typed); everything else lowers exactly
			// as before (dynamic values stay stringly).
			ws, err := l.argListIRTyped(t.Args)
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

// argListIRTyped lowers call args like argListIR, except integer
// literals that fit int64 stay numeric ({"type":"Int"}) instead of
// degrading to shell words. Used ONLY for script-defined function
// calls: external boundaries (exec argv, echo words, print) stay
// stringly — syscalls and word splitting genuinely take strings.
func (l *lowerer) argListIRTyped(args []Expr) ([]any, error) {
	out := []any{}
	for _, a := range args {
		if lit, ok := a.(*LitInt); ok {
			if n, ok := parsePyInt(lit.Text); ok {
				out = append(out, numNode(n))
				continue
			}
		}
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
	case "upper":
		// s.upper() — ${s^^} (uppercase all): the core's param lift maps
		// "^^" to the runtime/native toUpperCase.
		if n, ok := t.Obj.(*NameE); ok {
			return call("param", []any{st("^^"), st(n.Name)}), nil
		}
		return nil, fmt.Errorf("upper: expected var.upper()")
	case "get":
		// d.get(k) — dict lookup: the runtime's assocGet (${d[k]}). A
		// missing key yields "" (the subset has no None; Python's None
		// default arg is out of scope).
		if len(t.Args) == 1 {
			if n, ok := t.Obj.(*NameE); ok {
				key, err := l.argIR(t.Args[0])
				if err != nil {
					return nil, err
				}
				return call("arrayIndex", []any{st(n.Name), key}), nil
			}
		}
		return nil, fmt.Errorf("get: expected var.get(key)")
	case "write":
		// fh.write("...") — handled at statement level (with-block)
		return nil, fmt.Errorf("write handled at statement level")
	}
	return nil, fmt.Errorf("unsupported method %s", t.Name)
}

// testIR lowers a Python condition to the IR test expression (the core's
// `[ ... ]` raw-string form inside Call("test", [Str])).
func (l *lowerer) testIR(e Expr) (map[string]any, error) {
	pre, cond, err := l.condIR(e)
	if err != nil {
		return nil, err
	}
	if len(pre) != 0 {
		return nil, fmt.Errorf("float-path condition in string-test position")
	}
	return cond, nil
}

// paramRange — the proven value interval of a function's i-th parameter
// from its call sites: every site's arg must constant-fold, and the
// union of the folded values is the interval. Any non-foldable site
// (recursion, runtime args) leaves the param unprovable → bigint.
func (l *lowerer) paramRange(fn string, i int) ([2]*big.Int, bool) {
	sites := l.fnSites[fn]
	if len(sites) == 0 {
		return [2]*big.Int{}, false
	}
	var lo, hi *big.Int
	for _, args := range sites {
		if i >= len(args) {
			return [2]*big.Int{}, false
		}
		n, ok := foldInt(args[i])
		if !ok {
			return [2]*big.Int{}, false
		}
		if lo == nil {
			lo, hi = new(big.Int).Set(n), new(big.Int).Set(n)
			continue
		}
		if n.Cmp(lo) < 0 {
			lo = new(big.Int).Set(n)
		}
		if n.Cmp(hi) > 0 {
			hi = new(big.Int).Set(n)
		}
	}
	return [2]*big.Int{lo, hi}, true
}

// rangeWhile — `for v in range(a, b)` with a computed (non-literal) end:
// a While loop over an int-typed counter with a native arith comparison
// (Python's end is exclusive). The bound evaluates once (float-path
// bounds hoist into a temp pair); the counter steps via the native
// IncDec lowering in the Number domain, an exact arith assign in the
// bigint domain.
func (l *lowerer) rangeWhile(t *ForS, c *CallE) ([]map[string]any, error) {
	var loE, hiE Expr
	if len(c.Args) == 1 {
		loE = &LitInt{Text: "0"}
		hiE = c.Args[0]
	} else {
		loE = c.Args[0]
		hiE = c.Args[1]
	}
	dom := "int"
	if l.intDom(hiE) == "big" || l.intDom(loE) == "big" {
		dom = "big"
	}
	preL, loX, err := l.hoistIntOperand(loE, dom)
	if err != nil {
		return nil, err
	}
	preH, hiX, err := l.hoistIntOperand(hiE, dom)
	if err != nil {
		return nil, err
	}
	l.setType(t.Var, dom)
	if dom == "int" {
		if lo, hi, ok := l.rangeOf(hiE); ok {
			// counter ∈ [lo, hi-1] (exclusive end)
			l.ranges[t.Var] = [2]*big.Int{lo, new(big.Int).Sub(hi, big.NewInt(1))}
		} else {
			delete(l.ranges, t.Var)
		}
	} else {
		delete(l.ranges, t.Var)
	}
	loIR, err := l.arithIRDom(loX, dom, false)
	if err != nil {
		return nil, err
	}
	hiIR, err := l.arithIRDom(hiX, dom, false)
	if err != nil {
		return nil, err
	}
	var step []map[string]any
	if dom == "int" {
		step = []map[string]any{exprStmt(arithExpr(map[string]any{"type": "IncDec", "var": t.Var, "delta": 1, "prefix": false}))}
	} else {
		one, err := bigLitAst("1")
		if err != nil {
			return nil, err
		}
		step = []map[string]any{assignStmt(t.Var, arithExpr(arithBin("+", arithVar(t.Var), one)))}
	}
	body, err := l.stmtsIR(t.Body)
	if err != nil {
		return nil, err
	}
	body = append(body, step...)
	cond := arithExpr(arithBin("<", arithVar(t.Var), hiIR["ast"].(map[string]any)))
	out := append(preL, preH...)
	// function-scoped loop counter: a bare Declare pins locals in
	// backends with function scope (C/JS). Only inside functions and
	// int-domain — top-level loop vars keep the existing global hoist
	// (Python module-scope leak), and bigint counters keep the
	// file-scope mpz_t baseline (no Declare+mpz render path yet).
	// The counter Assign below is unchanged.
	if l.curParams != nil && dom == "int" {
		out = append(out, declareStmt(t.Var, true))
	}
	out = append(out, assignStmt(t.Var, loIR))
	out = append(out, whileStmt(cond, body))
	return out, nil
}

// condIR lowers a condition to (pre-statements, cond expression). Integer
// comparisons (both operands int-typed) lower to the A1 Arith AST — the
// ESTree render is a NATIVE JS comparison (exact for BigInt-domain
// operands, no per-iteration string-test dispatch); anything else keeps
// the shell `[ ... ]` string-test form.
func (l *lowerer) condIR(e Expr) ([]map[string]any, map[string]any, error) {
	switch t := e.(type) {
	case *CompareE:
		switch t.Op {
		case "==", "!=", "<", "<=", ">", ">=":
			lt, rt := l.typeOf(t.Lhs), l.typeOf(t.Rhs)
			if (lt == "int" || lt == "big") && (rt == "int" || rt == "big") {
				dom := "int"
				if lt == "big" || rt == "big" {
					dom = "big"
				}
				preL, lhsE, err := l.hoistIntOperand(t.Lhs, dom)
				if err != nil {
					return nil, nil, err
				}
				preR, rhsE, err := l.hoistIntOperand(t.Rhs, dom)
				if err != nil {
					return nil, nil, err
				}
				la, err := l.arithIRDom(lhsE, dom, false)
				if err != nil {
					return nil, nil, err
				}
				ra, err := l.arithIRDom(rhsE, dom, false)
				if err != nil {
					return nil, nil, err
				}
				// `X == 0` with X holding the %: the zero-compare form —
				// Python `a % b == 0` is sign-independent, so the uncomposed
				// % renders (the core's native zero-compare path — the hot
				// divisibility loop's fast form).
				zeroCmp := false
				if t.Op == "==" {
					if _, isZero := foldInt(t.Rhs); isZero && isZeroInt(t.Rhs) {
						zeroCmp = true
					} else if _, isZero := foldInt(t.Lhs); isZero && isZeroInt(t.Lhs) {
						zeroCmp = true
					}
				}
				lhsAst := la["ast"].(map[string]any)
				rhsAst := ra["ast"].(map[string]any)
				lSide := lhsAst
				rSide := rhsAst
				if zeroCmp {
					// rebuild the %-carrying side with zeroCmp=true
					var modSide Expr
					if isZeroInt(t.Rhs) {
						modSide = t.Lhs
					} else {
						modSide = t.Rhs
					}
					ms, err := l.arithIRDom(modSide, dom, true)
					if err != nil {
						return nil, nil, err
					}
					if isZeroInt(t.Rhs) {
						lSide = ms["ast"].(map[string]any)
					} else {
						rSide = ms["ast"].(map[string]any)
					}
				}
				cond := arithExpr(arithBin(t.Op, lSide, rSide))
				return append(preL, preR...), cond, nil
			}
		}
	}
	cond, err := l.testIRFallback(e)
	return nil, cond, err
}

// isZeroInt — is the expression the integer literal 0?
func isZeroInt(e Expr) bool {
	n, ok := foldInt(e)
	return ok && n.Sign() == 0
}

// testIRFallback — the string-test lowering (the pre-bigint testIR body).
func (l *lowerer) testIRFallback(e Expr) (map[string]any, error) {
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

// pipeChainStmt recognizes a statement in the Popen pipe-chain idiom
// (the Python spelling of `a | b`):
//
//	p1 = subprocess.Popen(["a"], stdout=subprocess.PIPE)
//	p2 = subprocess.Popen(["b"], stdin=p1.stdout)
//	p2.wait()
//
// Chain statements are CONSUMED (no A1 emitted for them); the chain is
// flushed as one A1 `Pipeline` statement at the first non-chain
// statement or the end of the enclosing body. Returns (flushPending,
// consumed, err): a non-chain statement requests a flush of every
// pending chain before it lowers normally.
func (l *lowerer) pipeChainStmt(s Stmt) (bool, bool, error) {
	switch t := s.(type) {
	case *AssignS:
		if len(t.Targets) != 1 || t.Op != "=" {
			return true, false, nil
		}
		c, ok := t.Expr.(*CallE)
		if !ok || strings.Join(c.Path, ".") != "subprocess.Popen" {
			return true, false, nil
		}
		prog, ws, err := l.procArgs(c.Args)
		if err != nil {
			return false, false, err
		}
		stage := []map[string]any{exprStmt(execCall(prog, ws))}
		stdinFrom := ""
		toPipe := false
		for _, kw := range c.Kwargs {
			switch kw.Key {
			case "stdout":
				if at, ok := kw.Value.(*AttrE); ok {
					if path, ok2 := dottedPath(at); ok2 && strings.Join(path, ".") == "subprocess.PIPE" {
						toPipe = true
					}
				}
			case "stdin":
				if at, ok := kw.Value.(*AttrE); ok && at.Name == "stdout" {
					if n, ok := at.Obj.(*NameE); ok {
						stdinFrom = n.Name
					}
				}
			}
		}
		if !toPipe && stdinFrom == "" {
			// plain background Popen — normal lowering
			return true, false, nil
		}
		if stdinFrom != "" {
			stages, ok := l.pipes[stdinFrom]
			if !ok {
				return false, false, fmt.Errorf("Popen: stdin feeds %s which is not a piped Popen", stdinFrom)
			}
			delete(l.pipes, stdinFrom)
			for i, v := range l.pipeOrder {
				if v == stdinFrom {
					l.pipeOrder = append(l.pipeOrder[:i], l.pipeOrder[i+1:]...)
					break
				}
			}
			l.pipes[t.Targets[0]] = append(stages, stage)
			l.pipeOrder = append(l.pipeOrder, t.Targets[0])
		} else {
			// stdout=PIPE starts a chain; re-assigning an existing tail
			// flushes the old chain first (deterministic order)
			if _, exists := l.pipes[t.Targets[0]]; exists {
				for i, v := range l.pipeOrder {
					if v == t.Targets[0] {
						l.pipeOrder = append(l.pipeOrder[:i], l.pipeOrder[i+1:]...)
						break
					}
				}
			}
			l.pipes[t.Targets[0]] = [][]map[string]any{stage}
			l.pipeOrder = append(l.pipeOrder, t.Targets[0])
		}
		return false, true, nil
	case *ExprS:
		// p2.wait() — the Pipeline statement runs synchronously, so the
		// wait on the chain's tail is a no-op
		mc, ok := t.Expr.(*MethodCallE)
		if !ok || mc.Name != "wait" {
			return true, false, nil
		}
		if n, ok := mc.Obj.(*NameE); ok {
			if _, isTail := l.pipes[n.Name]; isTail {
				return false, true, nil
			}
		}
		return true, false, nil
	}
	return true, false, nil
}

func (l *lowerer) flushPipes() []map[string]any {
	var out []map[string]any
	for _, tail := range l.pipeOrder {
		if stages, ok := l.pipes[tail]; ok {
			out = append(out, pipelineStmt(stages))
			delete(l.pipes, tail)
		}
	}
	l.pipeOrder = nil
	return out
}

func (l *lowerer) stmtsIR(stmts []Stmt) ([]map[string]any, error) {
	var out []map[string]any
	for _, s := range stmts {
		flush, consumed, err := l.pipeChainStmt(s)
		if err != nil {
			return nil, err
		}
		if flush {
			out = append(out, l.flushPipes()...)
		}
		if consumed {
			continue
		}
		irs, err := l.stmtIR(s)
		if err != nil {
			return nil, err
		}
		out = append(out, irs...)
	}
	// end of body: close any chains the body left open
	out = append(out, l.flushPipes()...)
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
		pre, cond, err := l.condIR(t.Cond)
		if err != nil {
			return nil, err
		}
		body, err := l.stmtsIR(t.Body)
		if err != nil {
			return nil, err
		}
		return append(pre, whileStmt(cond, body)), nil
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
		// range() with NON-literal bounds — the native-counter Range
		// lowering needs literal ints, so a computed bound (the t86
		// `range(1, int(n**0.5) + 1)` idiom) lowers to a While loop over
		// an int-typed counter with a NATIVE arith comparison (exact in
		// both the Number and BigInt domains; the float-path bound
		// evaluates ONCE into a temp pair).
		if c, ok := t.Iter.(*CallE); ok && len(c.Path) == 1 && c.Path[0] == "range" && len(c.Args) >= 1 && len(c.Args) <= 2 {
			litBounds := true
			for _, a := range c.Args {
				if _, isLit := a.(*LitInt); !isLit {
					litBounds = false
					break
				}
			}
			if !litBounds {
				return l.rangeWhile(t, c)
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
		} else if n, ok := t.Iter.(*NameE); ok {
			// iterating a set/list variable: type the loop var from the
			// element domain (int/big) so arithmetic on it stays numeric
			// (t91_set_sum_fallback: `total += x` over a set of ints must
			// add, not string-concat).
			if dom, ok := l.setElemDom[n.Name]; ok && (dom == "int" || dom == "big") {
				l.setType(t.Var, dom)
			} else {
				l.setType(t.Var, "str")
			}
		} else {
			l.setType(t.Var, "str")
		}
		body, err := l.stmtsIR(t.Body)
		if err != nil {
			return nil, err
		}
		return []map[string]any{forStmt(t.Var, iter, body)}, nil
	case *FuncS:
		// params materialize at function entry: `p = $1` (arith) — the
		// positional value becomes a REAL var so arith Var reads see it
		// (the pre-materialization lowering read arith Var p with the
		// value still in the positional — an unset-var 0). The materialized
		// domain comes from the call sites: every site's arg folding into
		// a ±2^53 interval keeps the param on the Number path; otherwise
		// the param is bigint-exact (Cast(Int64, Var("1")) — BigInt of the
		// positional string).
		saved := l.curParams
		l.curParams = map[string]string{}
		var pre []map[string]any
		for i, prm := range t.Params {
			pos := strconv.Itoa(i + 1)
			l.curParams[prm] = pos
			iv, iok := l.paramRange(t.Name, i)
			if !iok {
				// not provably integer-valued (a string/ unfoldable call
				// arg, no call sites, recursion) — the shell-string param:
				// reads redirect to the positional (the pre-bigint path)
				l.setType(prm, "str")
				continue
			}
			dom := "big"
			if iv[1].Cmp(two53) <= 0 && iv[0].Cmp(new(big.Int).Neg(two53)) >= 0 {
				dom = "int"
			}
			l.ranges[prm] = iv
			if dom == "int" {
				l.setType(prm, "int")
				// function-scoped param: bare Declare pins the C
				// backend (and friends) to a true function local
				// instead of the shell-global default; the Assign
				// below is unchanged so all Assign-keyed analyses
				// see exactly what they saw before. Int-domain only:
				// bigint params keep the file-scope mpz_t baseline
				// (the backend has no Declare+mpz render path yet —
				// a bare Declare would misrender as long long).
				pre = append(pre, declareStmt(prm, true))
				pre = append(pre, assignStmt(prm, arithExpr(arithVar(pos))))
			} else {
				l.setType(prm, "big")
				pre = append(pre, assignStmt(prm, arithExpr(arithCast("Int64", arithVar(pos)))))
			}
		}
		body, err := l.stmtsIR(t.Body)
		l.curParams = saved
		if err != nil {
			return nil, err
		}
		return []map[string]any{functionStmt(t.Name, append(pre, body...))}, nil
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
	case *TryS:
		return l.tryIR(t)
	}
	return nil, fmt.Errorf("unsupported statement")
}

// tryIR lowers Python try/except/else/finally to the A1 `Try` node
// (core request py-sh-go 20260813): body/excepts/else/finally, with
// TryExcept entries {type, match (null for bare except), as (null when
// absent), body} — the exact shape src/shir_json.rs emits and
// src/shir_json_in.rs ingests.
func (l *lowerer) tryIR(t *TryS) ([]map[string]any, error) {
	body, err := l.stmtsIR(t.Body)
	if err != nil {
		return nil, err
	}
	excepts := []any{}
	for _, e := range t.Except {
		eb, err := l.stmtsIR(e.Body)
		if err != nil {
			return nil, err
		}
		var match any
		if e.Match != nil {
			m, err := l.argIR(e.Match)
			if err != nil {
				return nil, err
			}
			match = m
		}
		var asName any
		if e.As != "" {
			asName = e.As
		}
		excepts = append(excepts, map[string]any{
			"type":  "TryExcept",
			"match": match,
			"as":    asName,
			"body":  toAnyStmts(eb),
		})
	}
	elseB, err := l.stmtsIR(t.ElseBody)
	if err != nil {
		return nil, err
	}
	finB, err := l.stmtsIR(t.Finally)
	if err != nil {
		return nil, err
	}
	return []map[string]any{{
		"type":    "Try",
		"body":    toAnyStmts(body),
		"excepts": excepts,
		"else":    toAnyStmts(elseB),
		"finally": toAnyStmts(finB),
	}}, nil
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
	words := make([]any, 0, len(nt.Args))
	for _, a := range nt.Args {
		ir, err := l.argIR(a)
		if err != nil {
			return nil, err
		}
		// Python print of a LIST value — `print([1, 2])` renders the
		// repr: `[e1, e2]` (elements comma-space-joined). The list
		// repr is the newline/comma-joined capture string, so the word
		// is one Interpolate: "[" + value + "]".
		if l.typeOf(a) == "list" {
			words = append(words, interpolate([]any{interpLit("["), interpExpr(ir), interpLit("]")}))
			continue
		}
		words = append(words, ir)
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
	// dict literal → declare -A + setArray ([k]=v elements): the exact
	// shape the core frontend emits for `declare -A d; d=([a]=1 [b]=2)`
	// (the estree runtime registers the name via the declare builtin and
	// stores key=value pairs; reads dispatch through arrayIndex).
	if dt, ok := val.(*DictE); ok {
		var elems []any
		for i, k := range dt.Keys {
			ks, ok := k.(*LitStr)
			if !ok {
				return nil, fmt.Errorf("dict: keys must be string literals")
			}
			switch v := dt.Values[i].(type) {
			case *LitStr:
				elems = append(elems, st("["+ks.Value+"]="+v.Value))
			case *LitInt:
				elems = append(elems, st("["+ks.Value+"]="+v.Text))
			default:
				return nil, fmt.Errorf("dict: value for %q must be a literal", ks.Value)
			}
		}
		l.setType(target, "dict")
		return []map[string]any{
			exprStmt(execCall("declare", []any{st("-A"), st(target)})),
			assignStmt(target, call("setArray", []any{st(target), array(elems)})),
		}, nil
	}
	// list comprehension → the A1 ArrayComp expr node (core request
	// py-sh-go-comp-if): setArray(target, ArrayComp) — the runtime builds
	// a NEW array, binding each iter item to the comp var and skipping
	// items that fail the optional comp_if filter.
	if cp, ok := val.(*CompE); ok {
		if op == "+=" {
			return nil, fmt.Errorf("comp: += unsupported")
		}
		iter, err := l.iterIR(cp.Iter)
		if err != nil {
			return nil, err
		}
		elem, err := l.argIR(cp.Elem)
		if err != nil {
			return nil, err
		}
		var cond any
		if cp.Cond != nil {
			c, err := l.testIR(cp.Cond)
			if err != nil {
				return nil, err
			}
			cond = c
		}
		l.setType(target, "list")
		ac := map[string]any{"type": "ArrayComp", "var": cp.Var, "iter": iter, "elem": elem, "cond": cond}
		return []map[string]any{assignStmt(target, call("setArray", []any{st(target), ac}))}, nil
	}
	// list literal → setArray / setArrayAppend (arr += (...)). `set()` —
	// an empty Python set — lowers to the empty array (dedup + ordering
	// happen at sorted(): sort -nu).
	if lst, ok := val.(*ListE); ok || (func() bool { c, okc := val.(*CallE); return okc && len(c.Path) == 1 && c.Path[0] == "set" && len(c.Args) == 0 })() {
		var elems []any
		if lst != nil {
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
		}
		l.setType(target, "list")
		if lst != nil {
			for _, el := range lst.Elems {
				l.noteElemAdd(target, el)
			}
		}
		if op == "+=" {
			// arr += (...) — the core's PlusAssign-Array lowering
			return []map[string]any{assignStmt(target, call("setArrayAppend", []any{st(target), array(elems)}))}, nil
		}
		return []map[string]any{assignStmt(target, call("setArray", []any{st(target), array(elems)}))}, nil
	}
	// aug-assign
	if op == "+=" {
		vty := l.typeOf(val)
		dom := vty
		if dom != "big" && l.typeOf(&NameE{Name: target}) == "big" {
			dom = "big"
		}
		if dom == "int" || dom == "big" {
			// a call RHS (min/max/sum/len of a name) is a VALUE, not an
			// arith leaf (the Arith AST has no call node): hoist it into
			// a fresh temp first, then compose the accumulator on the
			// temp (`sum_min += min(xs)` → `_min_xs = min(xs); sum_min
			// += _min_xs`). The reduction is pure, so the extra statement
			// is exact. Without this, arithIRDom returns a bare Call node
			// with no "ast" and the accumulator composition below
			// nil-panics (t97).
			pre := []map[string]any{}
			if c, ok := val.(*CallE); ok && len(c.Path) == 1 && len(c.Args) == 1 {
				if n, isName := c.Args[0].(*NameE); isName &&
					(c.Path[0] == "max" || c.Path[0] == "min" || c.Path[0] == "sum" || c.Path[0] == "len") {
					name := n.Name
					if p, ok := l.curParams[name]; ok {
						name = p
					}
					t := l.tempFor(c.Path[0], name)
					l.setType(t, dom)
					pre = []map[string]any{assignStmt(t, call(c.Path[0], []any{st(name)}))}
					val = &NameE{Name: t}
				}
			}
			rhs, err := l.arithIRDom(val, dom, false)
			if err != nil {
				return nil, err
			}
			var rhsAst map[string]any
			if dom == "big" {
				ra := rhs["ast"].(map[string]any)
				rhsAst = ra
				l.setType(target, "big")
				delete(l.ranges, target)
			} else {
				ra := rhs["ast"].(map[string]any)
				rhsAst = ra
				l.setType(target, "int")
				delete(l.ranges, target)
			}
			ast := arithBin("+", arithVar(target), rhsAst)
			if dom == "big" {
				// the accumulator is bigint-typed: read it exactly as BigInt
				// too (Cast(Int64, …) is the frontend's exact-BigInt marker;
				// the core renders a bigint-homed var arg as BigInt(raw || 0)
				// with no asIntN wrap). Without this, `total` reads as a
				// Number and `total + BigInt(x)` mixes types (t91).
				ast = arithBin("+", arithCast("Int64", arithVar(target)), rhsAst)
			}
			return append(pre, assignStmt(target, arithExpr(ast))), nil
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
		if l.intDom(val) == "big" {
			// a literal past i64 (or past 2^53): the exact BigInt value is
			// only expressible as an arith expression — a string assign
			// would read back through Number() and silently round.
			ir, err := l.arithIRDom(val, "big", false)
			if err != nil {
				return nil, err
			}
			l.setType(target, "big")
			if lo, hi, ok := l.rangeOf(val); ok {
				l.ranges[target] = [2]*big.Int{lo, hi}
			} else {
				delete(l.ranges, target)
			}
			return []map[string]any{assignStmt(target, ir)}, nil
		}
		l.setType(target, "int")
		if lo, hi, ok := l.rangeOf(val); ok {
			l.ranges[target] = [2]*big.Int{lo, hi}
		}
		return []map[string]any{assignStmt(target, st(v.Text))}, nil
	case *BoolLit:
		l.setType(target, "int")
		if v.Value {
			return []map[string]any{assignStmt(target, st("1"))}, nil
		}
		return []map[string]any{assignStmt(target, st("0"))}, nil
	}
	// float-path arithmetic (int(x ** 0.5), …) — the runtime arith-string
	// with JS doubles; the result is an integer-valued string the target
	// reads back numerically.
	if floatPath(val) {
		ir, err := l.hoistFloatIR(val)
		if err != nil {
			return nil, err
		}
		l.setType(target, "int")
		if lo, hi, ok := l.rangeOf(val); ok {
			l.ranges[target] = [2]*big.Int{lo, hi}
		} else {
			delete(l.ranges, target)
		}
		return []map[string]any{assignStmt(target, ir)}, nil
	}
	// numeric arithmetic (int or bigint domain)
	if ty := l.typeOf(val); ty == "int" || ty == "big" {
		ir, err := l.arithIRDom(val, ty, false)
		if err == nil {
			l.setType(target, ty)
			if lo, hi, ok := l.rangeOf(val); ok {
				l.ranges[target] = [2]*big.Int{lo, hi}
			} else {
				delete(l.ranges, target)
			}
			return []map[string]any{assignStmt(target, ir)}, nil
		}
	}
	ir, err := l.argIR(val)
	if err != nil {
		return nil, err
	}
	l.setType(target, l.typeOf(val))
	return []map[string]any{assignStmt(target, ir)}, nil
}

func (l *lowerer) ifIR(t *IfS) ([]map[string]any, error) {
	pre, cond, err := l.condIR(t.Cond)
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
			preE, c, err := l.condIR(el.Cond)
			if err != nil {
				return nil, err
			}
			_ = preE
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
	return append(pre, ifStmt(cond, then, elsIR)), nil
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
		if t.Name == "append" || t.Name == "add" {
			// l.append(x) / s.add(x) — list/set element add → arr+=(x): the
			// same Assign(setArrayAppend) shape `a += [x]` lowers to (t56).
			// Python set.add dedups at sorted() time (sort -nu).
			if len(t.Args) == 1 {
				if n, ok := t.Obj.(*NameE); ok {
					ir, err := l.argIR(t.Args[0])
					if err != nil {
						return nil, err
					}
					l.setType(n.Name, "list")
					l.noteElemAdd(n.Name, t.Args[0])
					return []map[string]any{assignStmt(n.Name, call("setArrayAppend", []any{st(n.Name), array([]any{ir})}))}, nil
				}
			}
			return nil, fmt.Errorf("append: expected var.append(value)")
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
		fns:     map[string]bool{},
		types:   map[string]string{},
		params:  map[string][]string{},
		pipes:   map[string][][]map[string]any{},
		ranges:  map[string][2]*big.Int{},
		setElemDom: map[string]string{},
		fnSites:   map[string][][]Expr{},
		fnRet:     map[string]string{},
		usedHoist: map[string]bool{},
		hoistSeq:  map[string]int{},
	}
	l.collectFuncs(stmts)
	irs, err := l.stmtsIR(stmts)
	if err != nil {
		return nil, err
	}
	// A2 var_types: every assigned variable, sorted by name ("big" vars
	// stay "Int" — the widthless kind the estree backend homes as an
	// exact-precision binding; the C-only Int64 object kind would wrap
	// assignments mod 2^64, breaking unbounded Python ints)
	byName := map[string]string{}
	for name, ty := range l.types {
		t := "Str"
		if ty == "int" || ty == "big" {
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
