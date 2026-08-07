// fish-sh-go: fish source -> shIR JSON (A1 contract), ANTLR4+Go.
//
// Hand-rolled recursive-descent parser for the v1 fish subset covered by
// testdata/ (echo, set [-l|-g|-x], external commands incl. `command`,
// read/printf/string/math/count, `$var`/`$var[i]`/`$status`/`$argv`,
// "interp $var" strings, 'literal' strings, `(cmd)` command substitution,
// if/else if/else, while, for-in, switch/case, function/end, `|` pipes,
// `>` redirects, `<<EOF` heredocs, `&` background, `; and` / `; or` and
// `not` conditions). The full antlr4-generated fish parser
// (grammars/FishLexer.g4 + FishParser.g4) is the WORKER's job.
//
// EMISSION CONSTRAINT: emit only the renderer-safe A1 subset — the exact
// node shapes the core itself emits for the bash analogs (verified shape-
// by-shape against `debashc --shir`): Expr(Call("exec"|"getVar"|...)),
// Assign (Str/Interpolate/setArray/capture/Arith sources), If/While/For/
// Function/Case/Redirect/Background, Interpolate parts, Arrow capture
// bodies, BinOp And/Or/Not conditions, pipeline calls. The ESTree
// renderer panics on Perl-only nodes (Output/Declare/...), so the
// frontend must not emit them.
//
// FISH BUILTIN LOWERING: fish builtins with no external binary
// (math/string/count) lower to the core's own bash-analog shapes:
//
//	set x (math 1 + 2)     →  Assign x = Arith        (`x=$((1+2))`)
//	math "$i * 2"          →  exec echo [Arith]       (`echo $((i*2))`)
//	string length $s       →  exec echo [arrayLen s]  (`${#s}`)
//	string sub -s 1 -l 2 $s→  exec echo [param slice] (`${s:0:2}`)
//	string replace [-a] o n→  echo TEXT | sed s/o/n/g  (literal)
//	string replace -r p r  →  echo TEXT | sed s/p/r/   (ERE→BRE)
//	string upper           →  exec tr a-z A-Z
//	count $a               →  exec echo [arrayLen a]  (`${#a[@]}`)
//
// FISH VARIABLE MAPPING: `$status` → getVar("?") (the core's `$?`),
// `$argv` → the positionals (getVar("1").. = the core's `$1`..), and
// `$a[i]` → arrayIndex(a, i-1) (fish arrays are 1-indexed). `$a[2..3]`
// (1-based inclusive slices) → join(param slice) — the quoted-bash
// `${arr[@]:off:len}` shape; `pre{a,b}post` brace expansion → the core's
// sh2.brace call shape.
package fishlib

import (
	"fmt"
	"strconv"
	"strings"

	shiremit "github.com/gmatht/sh2loop/frontends/shir-emit-go"
)

// ── tokens ────────────────────────────────────────────────────────────

type tokKind int

const (
	tWord   tokKind = iota // bare word (may contain $expansions)
	tDQuote                // "..." — raw inner text (interpolation at parse time)
	tSQuote                // '...' — raw inner text (literal)
	tSub                   // (cmd) — command substitution inner source
	tNL
	tSemi
	tAmp     // &
	tPipe    // |
	tGT      // >
	tGTGT    // >>
	tLL      // <<
	tFDRedir // 2> / 2>> — digit word adjacent to a redirect op
	tEOF
)

type token struct {
	kind tokKind
	text string
	fd   int    // tFDRedir: the target fd (2 for `2>`)
	mode string // tFDRedir: "w" | "a"
	gap  bool   // whitespace preceded this token (fish word adjacency)
	line int
}

type lexer struct {
	src  string
	pos  int
	line int
}

func (l *lexer) nextTok() token {
	gap := false
	for l.pos < len(l.src) {
		c := l.src[l.pos]
		switch {
		case c == ' ' || c == '\t' || c == '\r':
			l.pos++
			gap = true
		case c == '\n':
			l.pos++
			l.line++
			return token{kind: tNL, line: l.line}
		case c == '#':
			// comment to end of line (also swallows the #! shebang)
			for l.pos < len(l.src) && l.src[l.pos] != '\n' {
				l.pos++
			}
			gap = false
		default:
			t := l.scanTok()
			t.gap = gap
			return t
		}
	}
	return token{kind: tEOF, line: l.line}
}

// scanTok lexes one token at l.pos (nextTok has consumed any leading
// whitespace). A digit word immediately followed by `>` (no space) is an
// fd redirect (`2>/dev/null`), not an argument — fish/bash both require
// adjacency (`2 >f` is an arg plus stdout redirect), so the parser sees
// one tFDRedir token instead of word+gt.
func (l *lexer) scanTok() token {
	c := l.src[l.pos]
	switch {
	case c == ';':
		l.pos++
		return token{kind: tSemi, line: l.line}
	case c == '&':
		l.pos++
		return token{kind: tAmp, line: l.line}
	case c == '|':
		l.pos++
		return token{kind: tPipe, line: l.line}
	case c == '>':
		l.pos++
		if l.pos < len(l.src) && l.src[l.pos] == '>' {
			l.pos++
			return token{kind: tGTGT, line: l.line}
		}
		return token{kind: tGT, line: l.line}
	case c == '<':
		l.pos++
		if l.pos < len(l.src) && l.src[l.pos] == '<' {
			l.pos++
		}
		return token{kind: tLL, line: l.line}
	case c >= '0' && c <= '9':
		t := l.scanWord()
		if t.kind == tWord && allDigits(t.text) && l.pos < len(l.src) && l.src[l.pos] == '>' {
			fd, _ := strconv.Atoi(t.text)
			l.pos++
			mode := "w"
			if l.pos < len(l.src) && l.src[l.pos] == '>' {
				l.pos++
				mode = "a"
			}
			return token{kind: tFDRedir, text: t.text, fd: fd, mode: mode, line: t.line}
		}
		return t
	case c == '"' || c == '\'':
		return l.scanQuote(c)
	case c == '(':
		return l.scanSub()
	default:
		return l.scanWord()
	}
}

func (l *lexer) scanQuote(q byte) token {
	line := l.line
	l.pos++ // opening quote
	start := l.pos
	for l.pos < len(l.src) && l.src[l.pos] != q {
		l.pos++
	}
	text := l.src[start:l.pos]
	if l.pos < len(l.src) {
		l.pos++ // closing quote
	}
	if q == '"' {
		return token{kind: tDQuote, text: text, line: line}
	}
	return token{kind: tSQuote, text: text, line: line}
}

func (l *lexer) scanSub() token {
	line := l.line
	l.pos++ // (
	start := l.pos
	depth := 1
	for l.pos < len(l.src) {
		c := l.src[l.pos]
		if c == '(' {
			depth++
		} else if c == ')' {
			depth--
			if depth == 0 {
				break
			}
		} else if c == '\n' {
			l.line++
		}
		l.pos++
	}
	text := l.src[start:l.pos]
	if l.pos < len(l.src) {
		l.pos++ // )
	}
	return token{kind: tSub, text: text, line: line}
}

func (l *lexer) scanWord() token {
	line := l.line
	start := l.pos
	for l.pos < len(l.src) {
		c := l.src[l.pos]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' ||
			c == ';' || c == '&' || c == '|' || c == '>' || c == '<' ||
			c == '(' || c == ')' || c == '"' || c == '\'' {
			break
		}
		l.pos++
	}
	return token{kind: tWord, text: l.src[start:l.pos], line: line}
}

// allDigits reports whether s is a non-empty string of ASCII digits.
func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// sedBreakEscape escapes a literal string for use as a BRE pattern (fish
// `string replace` patterns are literals — no regex metachars) and the
// s/// delimiter.
func sedBreakEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	for _, c := range []string{".", "[", "]", "^", "$", "*"} {
		s = strings.ReplaceAll(s, c, `\`+c)
	}
	return strings.ReplaceAll(s, "/", `\/`)
}

// sedReplEscape escapes a literal replacement for sed's s/// (the `&`
// whole-match reference and the delimiter).
func sedReplEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "&", `\&`)
	return strings.ReplaceAll(s, "/", `\/`)
}

// readHeredoc consumes raw source lines after the `<<TERM` line until a
// line whose trimmed text equals TERM, returning the body (with trailing
// newline). The lexer position is left after the terminator line.
func (l *lexer) readHeredoc(term string) (string, error) {
	for l.pos < len(l.src) && l.src[l.pos] != '\n' {
		l.pos++
	}
	if l.pos < len(l.src) {
		l.pos++ // consume the <<TERM line's newline
	}
	l.line++
	var lines []string
	for {
		var line string
		if nl := strings.IndexByte(l.src[l.pos:], '\n'); nl < 0 {
			line = l.src[l.pos:]
			l.pos = len(l.src)
		} else {
			line = l.src[l.pos : l.pos+nl]
			l.pos += nl + 1
		}
		l.line++
		if strings.TrimSpace(line) == term {
			return strings.Join(lines, "\n") + "\n", nil
		}
		lines = append(lines, line)
	}
}

// ── parser ────────────────────────────────────────────────────────────

type parser struct {
	lex    *lexer
	peeked *token
}

func (p *parser) next() token {
	if p.peeked != nil {
		t := *p.peeked
		p.peeked = nil
		return t
	}
	return p.lex.nextTok()
}

func (p *parser) peek() token {
	if p.peeked == nil {
		t := p.lex.nextTok()
		p.peeked = &t
	}
	return *p.peeked
}

func (p *parser) parseProgram() ([]map[string]any, error) {
	var out []map[string]any
	for {
		t := p.peek()
		if t.kind == tEOF {
			return out, nil
		}
		if t.kind == tNL {
			p.next()
			continue
		}
		stmts, err := p.parseStmt()
		if err != nil {
			return nil, err
		}
		out = append(out, stmts...)
	}
}

// parseBlock parses statements until one of the terminator words
// (consumed and returned) or EOF.
func (p *parser) parseBlock(terms map[string]bool) ([]map[string]any, string, error) {
	out := []map[string]any{}
	for {
		t := p.peek()
		if t.kind == tEOF {
			return nil, "", fmt.Errorf("line %d: unexpected EOF inside a block (missing 'end'?)", t.line)
		}
		if t.kind == tNL {
			p.next()
			continue
		}
		if t.kind == tWord && terms[t.text] {
			p.next()
			return out, t.text, nil
		}
		stmts, err := p.parseStmt()
		if err != nil {
			return nil, "", err
		}
		out = append(out, stmts...)
	}
}

func (p *parser) parseStmt() ([]map[string]any, error) {
	t := p.peek()
	if t.kind == tWord {
		switch t.text {
		case "if":
			return p.parseIf()
		case "while":
			return p.parseWhile()
		case "for":
			return p.parseFor()
		case "switch":
			return p.parseSwitch()
		case "function":
			return p.parseFunction()
		case "end", "else", "case":
			return nil, fmt.Errorf("line %d: unexpected %q", t.line, t.text)
		}
	}
	return p.parseSimpleLine()
}

func (p *parser) parseIf() ([]map[string]any, error) {
	p.next() // "if"
	cond, err := p.parseCond()
	if err != nil {
		return nil, err
	}
	then, term, err := p.parseBlock(map[string]bool{"end": true, "else": true})
	if err != nil {
		return nil, err
	}
	head := map[string]any{"type": "If", "cond": cond, "then": then, "elsifs": []any{}, "else": []any{}}
	cur := head
	for term == "else" {
		t := p.peek()
		if t.kind == tWord && t.text == "if" {
			// else if → nested If in else (the core's elif shape)
			p.next()
			c, err := p.parseCond()
			if err != nil {
				return nil, err
			}
			body, term2, err := p.parseBlock(map[string]bool{"end": true, "else": true})
			if err != nil {
				return nil, err
			}
			nested := map[string]any{"type": "If", "cond": c, "then": body, "elsifs": []any{}, "else": []any{}}
			cur["else"] = []any{nested}
			cur = nested
			term = term2
		} else {
			body, term2, err := p.parseBlock(map[string]bool{"end": true})
			if err != nil {
				return nil, err
			}
			cur["else"] = body
			term = term2
		}
	}
	return []map[string]any{head}, nil
}

func (p *parser) parseWhile() ([]map[string]any, error) {
	p.next() // "while"
	cond, err := p.parseCond()
	if err != nil {
		return nil, err
	}
	body, _, err := p.parseBlock(map[string]bool{"end": true})
	if err != nil {
		return nil, err
	}
	return []map[string]any{{"type": "While", "cond": cond, "body": body}}, nil
}

func (p *parser) parseFor() ([]map[string]any, error) {
	p.next() // "for"
	nt := p.next()
	name, err := p.plainWord(nt, "for variable")
	if err != nil {
		return nil, err
	}
	it := p.next()
	if it.kind != tWord || it.text != "in" {
		return nil, fmt.Errorf("line %d: expected 'in' after for variable", it.line)
	}
	var elems []any
	for {
		t := p.peek()
		if t.kind == tWord || t.kind == tDQuote || t.kind == tSQuote || t.kind == tSub {
			p.next()
			e, err := p.valueExpr(t)
			if err != nil {
				return nil, err
			}
			// fish `for i in (cmd)` word-splits the capture like bash's
			// unquoted `$(...)` — the core's captureWords shape (plain
			// capture would concat the raw string into ONE element)
			if e["type"] == "Call" && e["func"] == "capture" {
				e = callExpr("captureWords", e["args"].([]any))
			}
			elems = append(elems, e)
			continue
		}
		break
	}
	body, _, err := p.parseBlock(map[string]bool{"end": true})
	if err != nil {
		return nil, err
	}
	return []map[string]any{{
		"type": "For",
		"var":  name,
		"iter": map[string]any{"type": "Array", "elements": elems},
		"body": body,
	}}, nil
}

func (p *parser) parseSwitch() ([]map[string]any, error) {
	p.next() // "switch"
	dt := p.next()
	disc, err := p.valueExpr(dt)
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		if t.kind == tWord || t.kind == tDQuote || t.kind == tSQuote || t.kind == tSub {
			p.next() // ignore extra tokens on the switch line (subset)
			continue
		}
		break
	}
	var clauses []any
	// The first "case" is consumed here; each subsequent one is consumed
	// by parseBlock's terminator scan (patterns follow it directly).
	t := p.peek()
	for t.kind == tNL {
		p.next()
		t = p.peek()
	}
	if t.kind == tWord && t.text == "end" {
		p.next()
		return []map[string]any{{"type": "Case", "discriminant": disc, "clauses": clauses}}, nil
	}
	if t.kind != tWord || t.text != "case" {
		return nil, fmt.Errorf("line %d: expected 'case' or 'end'", t.line)
	}
	p.next() // "case"
	for {
		var pats []string
		for {
			t := p.peek()
			if t.kind == tWord || t.kind == tDQuote || t.kind == tSQuote {
				p.next()
				pats = append(pats, t.text)
				continue
			}
			break
		}
		body, term, err := p.parseBlock(map[string]bool{"case": true, "end": true})
		if err != nil {
			return nil, err
		}
		clauses = append(clauses, map[string]any{"patterns": pats, "body": body})
		if term == "end" {
			break
		}
	}
	return []map[string]any{{"type": "Case", "discriminant": disc, "clauses": clauses}}, nil
}

func (p *parser) parseFunction() ([]map[string]any, error) {
	p.next() // "function"
	nt := p.next()
	name, err := p.plainWord(nt, "function name")
	if err != nil {
		return nil, err
	}
	body, _, err := p.parseBlock(map[string]bool{"end": true})
	if err != nil {
		return nil, err
	}
	return []map[string]any{{"type": "Function", "name": name, "body": body}}, nil
}

// parseCond parses an if/while condition: a command, optionally chained
// with `; and` / `; or`, optionally prefixed with `not`.
func (p *parser) parseCond() (map[string]any, error) {
	not := false
	if t := p.peek(); t.kind == tWord && t.text == "not" {
		p.next()
		not = true
	}
	e, err := p.parseCondCmd()
	if err != nil {
		return nil, err
	}
	for {
		if p.peek().kind != tSemi {
			break
		}
		p.next() // ;
		w := p.next()
		if w.kind != tWord || (w.text != "and" && w.text != "or") {
			return nil, fmt.Errorf("line %d: expected 'and' or 'or' after ';'", w.line)
		}
		rhs, err := p.parseCondCmd()
		if err != nil {
			return nil, err
		}
		op := "And"
		if w.text == "or" {
			op = "Or"
		}
		e = map[string]any{"type": "BinOp", "op": op, "lhs": e, "rhs": rhs}
	}
	if not {
		// the core's `! cmd` shape: BinOp Not with the operand on both sides
		e = map[string]any{"type": "BinOp", "op": "Not", "lhs": e, "rhs": e}
	}
	return e, nil
}

// parseCondCmd parses an if/while/until condition: a command, optionally
// a `|` pipeline with `>` / `>>` / `2>` / `<<` redirects and `&`. Lowered
// to the cond expr shapes the core itself emits for the bash analogs: a
// plain exec call; Call("pipeline", [Array([Arrow(...), ...])]) for
// pipelines; and Call("redirect", [Arrow([Expr(exec)]), Array(specs)]) for
// the last stage when redirects are present — the exact shape the core's
// `contains` lift (shir.rs try_lift_grep_contains) recognizes, so
// `if echo x | grep p >/dev/null 2>/dev/null` lowers to a pure substring
// test. `set`/`math`/`string`/`count` lowering does NOT apply in test
// position (fish `if set -q x` stays a plain exec call).
func (p *parser) parseCondCmd() (map[string]any, error) {
	var args []token
	for {
		t := p.peek()
		if t.kind == tWord || t.kind == tDQuote || t.kind == tSQuote || t.kind == tSub {
			args = append(args, p.next())
			continue
		}
		break
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("line %d: expected a condition command", p.peek().line)
	}
	name, err := p.plainWord(args[0], "condition command")
	if err != nil {
		return nil, err
	}
	// fish `set -q x` — "is x set": the runner has no `test -v`, so the
	// cond lowers to the getVar reads (unset → "" → falsy). Several
	// names chain with the core's And shape.
	if name == "set" && len(args) > 2 {
		if f, err := p.plainWord(args[1], "set flag"); err == nil && (f == "-q" || f == "--query") {
			var e map[string]any
			for _, a := range args[2:] {
				vname, err := p.plainWord(a, "set -q variable")
				if err != nil {
					return nil, err
				}
				g := getVarExpr(fishVarName(vname))
				if e == nil {
					e = g
				} else {
					e = map[string]any{"type": "BinOp", "op": "And", "lhs": e, "rhs": g}
				}
			}
			return e, nil
		}
	}
	elems := make([]any, 0, len(args)-1)
	for _, run := range mergeRuns(args[1:]) {
		e, err := p.runValue(run)
		if err != nil {
			return nil, err
		}
		elems = append(elems, e)
	}
	stage := []map[string]any{exprStmt(callExpr("exec", []any{strExpr(name), map[string]any{"type": "Array", "elements": elems}}))}
	stages, redirects, background, err := p.parseLineTail(stage)
	if err != nil {
		return nil, err
	}
	if len(stages) == 1 && len(redirects) == 0 && !background {
		return stage[0]["expr"].(map[string]any), nil
	}
	// attach the redirects to the last stage (`a | b >f` redirects the
	// pipeline's tail) as the expression-form redirect the core emits
	if len(redirects) > 0 {
		specs := make([]any, 0, len(redirects))
		for _, r := range redirects {
			specs = append(specs, map[string]any{"type": "Object", "properties": []any{
				map[string]any{"key": "fd", "value": map[string]any{"type": "Int", "value": r["fd"]}},
				map[string]any{"key": "mode", "value": strExpr(r["mode"].(string))},
				map[string]any{"key": "target", "value": r["target"]},
				map[string]any{"key": "interpolate", "value": map[string]any{"type": "Bool", "value": r["interpolate"]}},
			}})
		}
		stages[len(stages)-1] = []map[string]any{exprStmt(callExpr("redirect", []any{
			map[string]any{"type": "Arrow", "body": stages[len(stages)-1]},
			map[string]any{"type": "Array", "elements": specs},
		}))}
	}
	var expr map[string]any
	if len(stages) == 1 {
		expr = stages[0][0]["expr"].(map[string]any)
	} else {
		elems := make([]any, 0, len(stages))
		for _, s := range stages {
			elems = append(elems, map[string]any{"type": "Arrow", "body": s})
		}
		expr = callExpr("pipeline", []any{map[string]any{"type": "Array", "elements": elems}})
	}
	if background {
		expr = callExpr("background", []any{map[string]any{"type": "Arrow", "body": []map[string]any{exprStmt(expr)}}})
	}
	return expr, nil
}

// parseSimpleLine parses a simple command line: a command, `|` stages,
// `>` / `>>` / `2>` / `<<` redirects and a trailing `&`.
func (p *parser) parseSimpleLine() ([]map[string]any, error) {
	stage, err := p.parseStage()
	if err != nil {
		return nil, err
	}
	stages, redirects, background, err := p.parseLineTail(stage)
	if err != nil {
		return nil, err
	}
	var stmts []map[string]any
	if len(stages) == 1 {
		stmts = stages[0]
	} else {
		elems := make([]any, 0, len(stages))
		for _, s := range stages {
			elems = append(elems, map[string]any{"type": "Arrow", "body": s})
		}
		stmts = []map[string]any{exprStmt(callExpr("pipeline", []any{map[string]any{"type": "Array", "elements": elems}}))}
	}
	if len(redirects) > 0 {
		stmts = []map[string]any{{"type": "Redirect", "inner": stmts, "redirects": redirects}}
	}
	if background {
		stmts = []map[string]any{{"type": "Background", "body": stmts}}
	}
	return stmts, nil
}

// parseLineTail continues a command line after its first stage: `|`
// stages, `>` / `>>` / `2>` / `<<` redirects and a trailing `&`. Returns
// the stages (each a stmt list), the redirect specs and the background
// flag. Stops at tNL / tSemi / tEOF without consuming them (the caller
// decides — parseCond chains `; and` / `; or` on the leftover semis).
func (p *parser) parseLineTail(first []map[string]any) ([][]map[string]any, []map[string]any, bool, error) {
	stages := [][]map[string]any{first}
	var redirects []map[string]any
	background := false
	for {
		t := p.peek()
		switch t.kind {
		case tPipe:
			p.next()
			s, err := p.parseStage()
			if err != nil {
				return nil, nil, false, err
			}
			stages = append(stages, s)
		case tGT, tGTGT, tFDRedir:
			p.next()
			tgt, err := p.parseTarget()
			if err != nil {
				return nil, nil, false, err
			}
			fd, mode := 1, "w"
			if t.kind == tGTGT {
				mode = "a"
			} else if t.kind == tFDRedir {
				fd, mode = t.fd, t.mode
			}
			redirects = append(redirects, map[string]any{"fd": fd, "mode": mode, "target": tgt, "interpolate": true})
		case tLL:
			p.next()
			term := p.next()
			if term.kind != tWord {
				return nil, nil, false, fmt.Errorf("line %d: heredoc requires a terminator word", term.line)
			}
			body, err := p.lex.readHeredoc(term.text)
			if err != nil {
				return nil, nil, false, err
			}
			redirects = append(redirects, map[string]any{"fd": 0, "mode": "heredoc", "target": strExpr(body), "interpolate": true})
		case tAmp:
			p.next()
			background = true
		default:
			// tNL / tSemi / tEOF — end of the command line
			return stages, redirects, background, nil
		}
	}
}

// mergeRuns groups collected arg tokens into fish words: consecutive
// tokens with NO whitespace between them concatenate into one argument
// (`"a"$b`, `'x'$y`, `"p"(cmd)`) — fish treats adjacent quoted and
// unquoted segments as a single word.
func mergeRuns(toks []token) [][]token {
	var runs [][]token
	for _, t := range toks {
		if len(runs) > 0 && !t.gap {
			runs[len(runs)-1] = append(runs[len(runs)-1], t)
		} else {
			runs = append(runs, []token{t})
		}
	}
	return runs
}

// runValue lowers a merged token run (one fish word) to a single value
// expr: single tokens keep their natural shape; multi-piece runs flatten
// into one Interpolate (Str → lit part, any other expr → expr part).
func (p *parser) runValue(run []token) (map[string]any, error) {
	if len(run) == 1 {
		return p.valueExpr(run[0])
	}
	var parts []any
	for _, t := range run {
		e, err := p.valueExpr(t)
		if err != nil {
			return nil, err
		}
		switch e["type"] {
		case "Interpolate":
			if ps, ok := e["parts"].([]any); ok {
				parts = append(parts, ps...)
			}
		case "Str":
			parts = append(parts, map[string]any{"kind": "lit", "text": e["value"]})
		default:
			parts = append(parts, map[string]any{"kind": "expr", "expr": e})
		}
	}
	if len(parts) == 1 {
		if pm, ok := parts[0].(map[string]any); ok && pm["kind"] == "expr" {
			if e, ok := pm["expr"].(map[string]any); ok {
				return e, nil
			}
		}
	}
	return map[string]any{"type": "Interpolate", "parts": parts}, nil
}

// parseStage parses one command: its name and arguments. A control
// keyword in stage position (`cmd | while ...`, `cmd | if ...`) parses
// the compound command instead — the core lowers `x | while ...` the
// same way (the compound stmt sits inside the stage's Arrow).
func (p *parser) parseStage() ([]map[string]any, error) {
	if t := p.peek(); t.kind == tWord {
		switch t.text {
		case "if":
			return p.parseIf()
		case "while":
			return p.parseWhile()
		case "for":
			return p.parseFor()
		case "switch":
			return p.parseSwitch()
		case "function":
			return p.parseFunction()
		case "end", "else", "case":
			return nil, fmt.Errorf("line %d: unexpected %q", t.line, t.text)
		}
	}
	var args []token
	for {
		t := p.peek()
		if t.kind == tWord || t.kind == tDQuote || t.kind == tSQuote || t.kind == tSub {
			args = append(args, p.next())
			continue
		}
		break
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("line %d: expected a command", p.peek().line)
	}
	name, err := p.plainWord(args[0], "command name")
	if err != nil {
		return nil, err
	}
	if name == "command" {
		// fish `command NAME ARGS` — run the external command
		if len(args) < 2 {
			return nil, fmt.Errorf("line %d: 'command' requires a command name", args[0].line)
		}
		name, err = p.plainWord(args[1], "command name after 'command'")
		if err != nil {
			return nil, err
		}
		args = args[1:]
	}
	if name == "set" {
		return p.setStmts(args)
	}
	// fish builtins with no external binary: lower to core A1 shapes (the
	// bash analogs — see the header) or fall back to the generic exec.
	if name == "math" || name == "string" || name == "count" {
		if stmts, ok := p.lowerBuiltinStmt(name, args[1:]); ok {
			return stmts, nil
		}
	}
	elems := make([]any, 0, len(args)-1)
	for _, run := range mergeRuns(args[1:]) {
		e, err := p.runValue(run)
		if err != nil {
			return nil, err
		}
		elems = append(elems, e)
	}
	return []map[string]any{exprStmt(callExpr("exec", []any{strExpr(name), map[string]any{"type": "Array", "elements": elems}}))}, nil
}

// setStmts lowers `set [-l|-g|-x|-a] NAME VALUE...`:
// single value → Assign(Str/Interpolate/capture); several → setArray;
// `-a`/`--append` → setArrayAppend; `NAME[i]` → the core's `a[0]`
// element-write shape (fish 1-based → canonical 0-based).
func (p *parser) setStmts(args []token) ([]map[string]any, error) {
	i := 1
	appendMode := false
	for i < len(args) && args[i].kind == tWord && strings.HasPrefix(args[i].text, "-") {
		if args[i].text == "-a" || args[i].text == "--append" {
			appendMode = true
		}
		// -l / -g / -x / -e / ... options (scope/export) dropped in v1
		i++
	}
	if i >= len(args) {
		return nil, fmt.Errorf("line %d: set requires NAME", args[0].line)
	}
	name, err := p.plainWord(args[i], "set target")
	if err != nil {
		return nil, err
	}
	// fish `set NAME[i] VALUE` — an indexed element write, lowered to
	// the core's own `a[1]=X` shape (the var string carries the
	// subscript, canonical 0-based)
	targetVar := name
	if b := strings.IndexByte(name, '['); b > 0 && strings.HasSuffix(name, "]") {
		inner := name[b+1 : len(name)-1]
		if allDigits(inner) {
			targetVar = name[:b] + "[" + fishIndex(inner) + "]"
		}
	}
	vals := args[i+1:]
	if len(vals) == 0 {
		return nil, fmt.Errorf("line %d: set %s requires a value", args[0].line, name)
	}
	target := map[string]any{"var": targetVar, "sigil": nil, "indices": []any{}}
	var expr map[string]any
	if appendMode {
		elems := make([]any, 0, len(vals))
		for _, v := range vals {
			e, err := p.valueExpr(v)
			if err != nil {
				return nil, err
			}
			elems = append(elems, e)
		}
		expr = callExpr("setArrayAppend", []any{strExpr(name), map[string]any{"type": "Array", "elements": elems}})
	} else if len(vals) == 1 {
		expr, err = p.valueExpr(vals[0])
		if err != nil {
			return nil, err
		}
	} else {
		elems := make([]any, 0, len(vals))
		for _, v := range vals {
			e, err := p.valueExpr(v)
			if err != nil {
				return nil, err
			}
			elems = append(elems, e)
		}
		expr = callExpr("setArray", []any{strExpr(name), map[string]any{"type": "Array", "elements": elems}})
	}
	return []map[string]any{{"type": "Assign", "targets": []any{target}, "expr": expr}}, nil
}

// parseTarget parses the target word of a `>` redirect.
func (p *parser) parseTarget() (map[string]any, error) {
	t := p.next()
	if t.kind != tWord {
		return nil, fmt.Errorf("line %d: redirect requires a target", t.line)
	}
	return strExpr(t.text), nil
}

// plainWord requires a bare word without expansions (command names, set
// targets, for variables, function names).
func (p *parser) plainWord(t token, what string) (string, error) {
	if t.kind != tWord || strings.ContainsRune(t.text, '$') {
		return "", fmt.Errorf("line %d: expected %s, got %q", t.line, what, t.text)
	}
	return t.text, nil
}

// ── fish builtin lowering (math / string / count) ───────────────────
// fish's math/string/count builtins have no external binaries, so the
// frontend lowers them into the core A1 vocabulary (see the header). Any
// shape outside the supported subset falls back to the generic exec /
// capture emission (conservative — the emitted A1 stays valid).

// mathTok is one math-expression token: a number ('n'), a variable
// reference ('v') or an operator/paren ('o').
// mathAST is the parsed expression tree, rendered as the A1 Arith ast.
type mathTok struct {
	kind byte // 'n' | 'v' | 'o'
	num  int64
	name string
	op   string
}

type mathAST struct {
	kind string // "num" | "var" | "un" | "bin"
	num  int64
	name string
	op   string
	lhs  *mathAST
	rhs  *mathAST
}

func mathASTJSON(a *mathAST) map[string]any {
	switch a.kind {
	case "num":
		return map[string]any{"type": "Num", "value": a.num}
	case "var":
		return map[string]any{"type": "Var", "name": a.name}
	case "un":
		return map[string]any{"type": "Un", "op": a.op, "arg": mathASTJSON(a.rhs)}
	default: // "bin"
		return map[string]any{"type": "Bin", "op": a.op, "lhs": mathASTJSON(a.lhs), "rhs": mathASTJSON(a.rhs)}
	}
}

// arithExpr is the A1 Arith node carrying a parsed math AST (the exact
// shape debashc emits for bash `$((...))`).
func arithExpr(a *mathAST) map[string]any {
	return map[string]any{"type": "Arith", "ast": mathASTJSON(a)}
}

// lexMath tokenizes one math expression text (numbers, identifiers,
// + - * / % and parentheses).
func lexMath(text string) ([]mathTok, error) {
	var toks []mathTok
	i := 0
	for i < len(text) {
		c := text[i]
		switch {
		case c == ' ' || c == '\t':
			i++
		case c >= '0' && c <= '9':
			j := i
			for j < len(text) && text[j] >= '0' && text[j] <= '9' {
				j++
			}
			n, err := strconv.ParseInt(text[i:j], 10, 64)
			if err != nil {
				return nil, fmt.Errorf("math: bad number %q", text[i:j])
			}
			toks = append(toks, mathTok{kind: 'n', num: n})
			i = j
		case isNameStart(c):
			j := i + 1
			for j < len(text) && isNameChar(text[j]) {
				j++
			}
			toks = append(toks, mathTok{kind: 'v', name: text[i:j]})
			i = j
		case strings.ContainsRune("+-*/%()", rune(c)):
			toks = append(toks, mathTok{kind: 'o', op: string(c)})
			i++
		default:
			return nil, fmt.Errorf("math: unexpected %q", string(c))
		}
	}
	return toks, nil
}

// mathTokensFromIR flattens the IR argument expressions of a `math` call
// into math tokens. A getVar expands to a Var token (fish expands $var to
// its value before math parses it; the Arith Var read reproduces that for
// numeric values), Interpolate parts lex their literal text and inline
// variable refs.
func mathTokensFromIR(elems []any) ([]mathTok, error) {
	var toks []mathTok
	for _, el := range elems {
		m, ok := el.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("math: bad argument")
		}
		switch m["type"] {
		case "Str":
			t, err := lexMath(m["value"].(string))
			if err != nil {
				return nil, err
			}
			toks = append(toks, t...)
		case "Call":
			if m["func"] == "getVar" {
				if args, ok := m["args"].([]any); ok && len(args) == 1 {
					if s, ok := args[0].(map[string]any); ok && s["type"] == "Str" {
						toks = append(toks, mathTok{kind: 'v', name: s["value"].(string)})
						continue
					}
				}
			}
			return nil, fmt.Errorf("math: unsupported expansion")
		case "Interpolate":
			parts, ok := m["parts"].([]any)
			if !ok {
				return nil, fmt.Errorf("math: bad interpolation")
			}
			for _, part := range parts {
				pm, ok := part.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("math: bad interpolation part")
				}
				switch pm["kind"] {
				case "lit":
					t, err := lexMath(pm["text"].(string))
					if err != nil {
						return nil, err
					}
					toks = append(toks, t...)
				case "expr":
					em, ok := pm["expr"].(map[string]any)
					if !ok || em["type"] != "Call" || em["func"] != "getVar" {
						return nil, fmt.Errorf("math: unsupported interpolation")
					}
					if args, ok := em["args"].([]any); ok && len(args) == 1 {
						if s, ok := args[0].(map[string]any); ok && s["type"] == "Str" {
							toks = append(toks, mathTok{kind: 'v', name: s["value"].(string)})
							continue
						}
					}
					return nil, fmt.Errorf("math: unsupported interpolation")
				}
			}
		default:
			return nil, fmt.Errorf("math: unsupported argument")
		}
	}
	return toks, nil
}

// mathParser: expr := term (('+'|'-') term)*; term := factor
// (('*'|'/'|'%') factor)*; factor := ('-'|'+') factor | '(' expr ')'
// | number | variable.
type mathParser struct {
	toks []mathTok
	pos  int
}

func (mp *mathParser) peek() (mathTok, bool) {
	if mp.pos < len(mp.toks) {
		return mp.toks[mp.pos], true
	}
	return mathTok{}, false
}

func (mp *mathParser) next() (mathTok, bool) {
	t, ok := mp.peek()
	if ok {
		mp.pos++
	}
	return t, ok
}

func (mp *mathParser) parseExpr() (*mathAST, error) {
	lhs, err := mp.parseTerm()
	if err != nil {
		return nil, err
	}
	for {
		t, ok := mp.peek()
		if !ok || (t.op != "+" && t.op != "-") {
			return lhs, nil
		}
		mp.next()
		rhs, err := mp.parseTerm()
		if err != nil {
			return nil, err
		}
		lhs = &mathAST{kind: "bin", op: t.op, lhs: lhs, rhs: rhs}
	}
}

func (mp *mathParser) parseTerm() (*mathAST, error) {
	lhs, err := mp.parseFactor()
	if err != nil {
		return nil, err
	}
	for {
		t, ok := mp.peek()
		if !ok || (t.op != "*" && t.op != "/" && t.op != "%") {
			return lhs, nil
		}
		mp.next()
		rhs, err := mp.parseFactor()
		if err != nil {
			return nil, err
		}
		lhs = &mathAST{kind: "bin", op: t.op, lhs: lhs, rhs: rhs}
	}
}

func (mp *mathParser) parseFactor() (*mathAST, error) {
	t, ok := mp.next()
	if !ok {
		return nil, fmt.Errorf("math: unexpected end of expression")
	}
	switch t.kind {
	case 'n':
		return &mathAST{kind: "num", num: t.num}, nil
	case 'v':
		return &mathAST{kind: "var", name: fishVarName(t.name)}, nil
	case 'o':
		switch t.op {
		case "-", "+":
			arg, err := mp.parseFactor()
			if err != nil {
				return nil, err
			}
			if t.op == "-" && arg.kind == "num" {
				return &mathAST{kind: "num", num: -arg.num}, nil
			}
			return &mathAST{kind: "un", op: t.op, rhs: arg}, nil
		case "(":
			inner, err := mp.parseExpr()
			if err != nil {
				return nil, err
			}
			c, ok := mp.next()
			if !ok || c.op != ")" {
				return nil, fmt.Errorf("math: missing ')'")
			}
			return inner, nil
		}
	}
	return nil, fmt.Errorf("math: unexpected token")
}

// sedRegexEscape converts an ERE pattern (fish `string replace -r`) to
// the BRE form the runtime's sed emulation understands (its s///
// patterns go through breToJs): the ERE operators ( ) { } + ? | are
// literals in BRE and get backslash-escaped; the inverse escapes
// (`\(` in ERE = a literal paren) become plain BRE characters; the
// s/// delimiter is escaped.
func sedRegexEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\\' && i+1 < len(s) {
			d := s[i+1]
			switch d {
			case '(', ')', '{', '}', '+', '?', '|':
				b.WriteByte(d) // ERE literal → BRE plain
			default:
				b.WriteByte('\\')
				b.WriteByte(d)
			}
			i++
			continue
		}
		switch c {
		case '(', ')', '{', '}', '+', '?', '|':
			b.WriteByte('\\')
		case '/':
			b.WriteByte('\\') // s/// delimiter
		}
		b.WriteByte(c)
	}
	return b.String()
}

// sedReplFish converts a fish `string replace -r` replacement text for
// sed's s///: fish references capture groups as `$N`, sed as `\N`; the
// `&` whole-match and the delimiter are escaped like the literal path.
func sedReplFish(s string) string {
	s = sedReplEscape(s)
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '$' && i+1 < len(s) && s[i+1] >= '1' && s[i+1] <= '9' {
			b.WriteByte('\\')
			b.WriteByte(s[i+1])
			i++
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// echoStmt wraps a VALUE expression as `echo VALUE` — the fish builtin
// statement form (fish math/string/count print their result).
func echoStmt(v map[string]any) map[string]any {
	return exprStmt(callExpr("exec", []any{strExpr("echo"), map[string]any{"type": "Array", "elements": []any{v}}}))
}

// irArg helpers: pull a Str value / getVar name out of an IR expression.
func irStr(e map[string]any) (string, bool) {
	if e["type"] == "Str" {
		if s, ok := e["value"].(string); ok {
			return s, true
		}
	}
	return "", false
}

func irGetVarName(e map[string]any) (string, bool) {
	if e["type"] == "Call" && e["func"] == "getVar" {
		if args, ok := e["args"].([]any); ok && len(args) == 1 {
			if s, ok := args[0].(map[string]any); ok && s["type"] == "Str" {
				if n, ok := s["value"].(string); ok {
					return n, true
				}
			}
		}
	}
	return "", false
}

// irSingleLit returns the text of a literal-only Interpolate.
func irSingleLit(e map[string]any) (string, bool) {
	if e["type"] == "Interpolate" {
		if parts, ok := e["parts"].([]any); ok && len(parts) == 1 {
			if pm, ok := parts[0].(map[string]any); ok && pm["kind"] == "lit" {
				if s, ok := pm["text"].(string); ok {
					return s, true
				}
			}
		}
	}
	return "", false
}

// stringLenFromIR lowers `string length X` / `count X` to the core's
// arrayLen call (`${#x}` / `${#arr[@]}`): arrayLen counts array elements
// and falls back to the string length for scalars. Literals fold.
func stringLenFromIR(e map[string]any) (map[string]any, bool) {
	if n, ok := irGetVarName(e); ok {
		return callExpr("arrayLen", []any{strExpr(n)}), true
	}
	if s, ok := irStr(e); ok {
		return strExpr(strconv.Itoa(len(s))), true
	}
	if s, ok := irSingleLit(e); ok {
		return strExpr(strconv.Itoa(len(s))), true
	}
	return nil, false
}

// stringCaseFromIR lowers `string upper|lower X` (arg form) to the core's
// param case-op call (`${x^^}` / `${x,,}`). Literals fold.
func stringCaseFromIR(e map[string]any, upper bool) (map[string]any, bool) {
	if n, ok := irGetVarName(e); ok {
		op := ",,"
		if upper {
			op = "^^"
		}
		return callExpr("param", []any{strExpr(op), strExpr(n)}), true
	}
	if s, ok := irStr(e); ok {
		if upper {
			return strExpr(strings.ToUpper(s)), true
		}
		return strExpr(strings.ToLower(s)), true
	}
	if s, ok := irSingleLit(e); ok {
		if upper {
			return strExpr(strings.ToUpper(s)), true
		}
		return strExpr(strings.ToLower(s)), true
	}
	return nil, false
}

// stringSubFromIR lowers `string sub -s N -l L X` to the core's
// param slice call (`${X:N-1:L}` — bash offsets are 0-based, fish
// 1-based). A missing -l means to the end; a missing -s starts at 1.
// Literals fold with Go string slicing.
func stringSubFromIR(e map[string]any, start, length string) (map[string]any, bool) {
	startIdx := 0
	if start != "" {
		n, err := strconv.ParseInt(start, 10, 64)
		if err != nil || n < 1 {
			return nil, false
		}
		startIdx = int(n - 1)
	}
	if n, ok := irGetVarName(e); ok {
		return callExpr("param", []any{strExpr("slice"), strExpr(n), strExpr(strconv.Itoa(startIdx)), strExpr(length)}), true
	}
	s, ok := irStr(e)
	if !ok {
		s, ok = irSingleLit(e)
	}
	if ok {
		lo := startIdx
		if lo > len(s) {
			lo = len(s)
		}
		hi := len(s)
		if length != "" {
			l, err := strconv.ParseInt(length, 10, 64)
			if err != nil || l < 0 {
				return nil, false
			}
			if lo+int(l) < hi {
				hi = lo + int(l)
			}
		}
		return strExpr(s[lo:hi]), true
	}
	return nil, false
}

// builtinCaptureValue detects a command substitution whose body is a
// single fish builtin call (math/string/count) and returns the lowered
// VALUE expression (the core's `$((...))` / `${#x}` / `${x:o:l}` shapes)
// — the value of `(math ...)` / `(string ...)` / `(count ...)` is the
// command's stdout, which these builtins print as exactly their result.
func builtinCaptureValue(inner []map[string]any) (map[string]any, bool) {
	if len(inner) != 1 {
		return nil, false
	}
	if inner[0]["type"] != "Expr" {
		return nil, false
	}
	call, ok := inner[0]["expr"].(map[string]any)
	if !ok || call["type"] != "Call" || call["func"] != "exec" {
		return nil, false
	}
	args, ok := call["args"].([]any)
	if !ok || len(args) != 2 {
		return nil, false
	}
	name, ok := irStr(args[0].(map[string]any))
	if !ok {
		return nil, false
	}
	arr, ok := args[1].(map[string]any)
	if !ok || arr["type"] != "Array" {
		return nil, false
	}
	elems, ok := arr["elements"].([]any)
	if !ok {
		return nil, false
	}
	// The statement-level lowering turns the builtin call into
	// `echo <value>` (the fish builtin prints its result); a capture of
	// that echo is the same VALUE — unwrap it back to the core value
	// shape (`set x (math 1 + 2)` → Assign x = Arith, the core's
	// `x=$((1+2))`). Only the builtin-lowered value shapes unwrap;
	// `(echo hello)` / `(echo $x)` keep the capture.
	if name == "echo" && len(elems) == 1 {
		if v, ok := elems[0].(map[string]any); ok {
			if v["type"] == "Arith" {
				return v, true
			}
			if v["type"] == "Call" && (v["func"] == "arrayLen" || v["func"] == "param") {
				return v, true
			}
		}
	}
	switch name {
	case "math":
		toks, err := mathTokensFromIR(elems)
		if err != nil {
			return nil, false
		}
		mp := &mathParser{toks: toks}
		ast, err := mp.parseExpr()
		if err != nil {
			return nil, false
		}
		if _, more := mp.peek(); more {
			return nil, false
		}
		return arithExpr(ast), true
	case "seq":
		// `(seq A B)` — the core's own Range lift for the bash
		// `for i in $(seq A B)` idiom (Range is a frontend-constructed
		// bounded iterable). One arg = 1..N; a step (`seq A S B`) has no
		// Range field and keeps the capture.
		var nums []int64
		for _, el := range elems {
			s, ok := irStr(el.(map[string]any))
			if !ok {
				return nil, false
			}
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil {
				return nil, false
			}
			nums = append(nums, n)
		}
		switch len(nums) {
		case 1:
			return map[string]any{"type": "Range", "start": 1, "end": nums[0]}, true
		case 2:
			return map[string]any{"type": "Range", "start": nums[0], "end": nums[1]}, true
		}
		return nil, false
	case "count":
		if len(elems) == 1 {
			if v, ok := stringLenFromIR(elems[0].(map[string]any)); ok {
				return v, true
			}
		}
		// count counts ARGUMENTS (fish `$a` in command position expands to
		// one arg per element — covered by the arrayLen path above).
		return strExpr(strconv.Itoa(len(elems))), true
	case "string":
		if len(elems) < 2 {
			return nil, false
		}
		sub, ok := irStr(elems[0].(map[string]any))
		if !ok {
			return nil, false
		}
		rest := elems[1:]
		switch sub {
		case "length":
			if len(rest) != 1 {
				return nil, false
			}
			return stringLenFromIR(rest[0].(map[string]any))
		case "upper", "lower":
			if len(rest) != 1 {
				return nil, false
			}
			return stringCaseFromIR(rest[0].(map[string]any), sub == "upper")
		case "sub":
			start, length := "", ""
			i := 0
			for i < len(rest) {
				f, ok := irStr(rest[i].(map[string]any))
				if !ok || !strings.HasPrefix(f, "-") || f == "-" {
					break
				}
				switch f {
				case "-s", "--start", "-l", "--length":
					i++
					if i >= len(rest) {
						return nil, false
					}
					v, ok := irStr(rest[i].(map[string]any))
					if !ok {
						return nil, false
					}
					if f == "-s" || f == "--start" {
						start = v
					} else {
						length = v
					}
				default:
					return nil, false
				}
				i++
			}
			if i != len(rest)-1 {
				return nil, false
			}
			return stringSubFromIR(rest[i].(map[string]any), start, length)
		}
	}
	return nil, false
}

// lowerBuiltinStmt lowers a statement-level fish builtin call
// (math/string/count) into its core-A1 statement form; returns ok=false
// to fall back to the generic exec emission.
func (p *parser) lowerBuiltinStmt(name string, args []token) ([]map[string]any, bool) {
	elems, err := p.argsIR(args)
	if err != nil {
		return nil, false
	}
	switch name {
	case "math":
		toks, err := mathTokensFromIR(elems)
		if err != nil {
			return nil, false
		}
		mp := &mathParser{toks: toks}
		ast, err := mp.parseExpr()
		if err != nil {
			return nil, false
		}
		if _, more := mp.peek(); more {
			return nil, false
		}
		return []map[string]any{echoStmt(arithExpr(ast))}, true
	case "count":
		if len(elems) == 1 {
			if v, ok := stringLenFromIR(elems[0].(map[string]any)); ok {
				return []map[string]any{echoStmt(v)}, true
			}
		}
		return []map[string]any{echoStmt(strExpr(strconv.Itoa(len(elems))))}, true
	case "string":
		if len(elems) < 1 {
			return nil, false
		}
		sub, ok := irStr(elems[0].(map[string]any))
		if !ok {
			return nil, false
		}
		rest := elems[1:]
		switch sub {
		case "length":
			if len(rest) != 1 {
				return nil, false
			}
			v, ok := stringLenFromIR(rest[0].(map[string]any))
			if !ok {
				return nil, false
			}
			return []map[string]any{echoStmt(v)}, true
		case "upper", "lower":
			if len(rest) == 0 {
				// stdin form: `string upper` translates stdin like `tr`
				// (the core's own `echo X | tr a-z A-Z` shape).
				set1, set2 := "a-z", "A-Z"
				if sub == "lower" {
					set1, set2 = "A-Z", "a-z"
				}
				return []map[string]any{exprStmt(callExpr("exec", []any{strExpr("tr"), map[string]any{"type": "Array", "elements": []any{strExpr(set1), strExpr(set2)}}}))}, true
			}
			if len(rest) != 1 {
				return nil, false
			}
			v, ok := stringCaseFromIR(rest[0].(map[string]any), sub == "upper")
			if !ok {
				return nil, false
			}
			return []map[string]any{echoStmt(v)}, true
		case "sub":
			start, length := "", ""
			i := 0
			for i < len(rest) {
				f, ok := irStr(rest[i].(map[string]any))
				if !ok || !strings.HasPrefix(f, "-") || f == "-" {
					break
				}
				switch f {
				case "-s", "--start", "-l", "--length":
					i++
					if i >= len(rest) {
						return nil, false
					}
					v, ok := irStr(rest[i].(map[string]any))
					if !ok {
						return nil, false
					}
					if f == "-s" || f == "--start" {
						start = v
					} else {
						length = v
					}
				default:
					return nil, false
				}
				i++
			}
			if i != len(rest)-1 {
				return nil, false
			}
			v, ok := stringSubFromIR(rest[i].(map[string]any), start, length)
			if !ok {
				return nil, false
			}
			return []map[string]any{echoStmt(v)}, true
		case "replace":
			// `string replace [-a] [-i] [-r] OLD NEW [--] TEXT` — a literal
			// or ERE-regex substring replace, lowered to the core's own
			// `echo TEXT | sed s/OLD/NEW/g` shape (BRE/repl escapes applied
			// so a literal pattern can't leak regex metachars; -r patterns
			// are converted ERE→BRE — the runtime sed understands BRE).
			all := false
			regex := false
			ignoreCase := false
			// `--` ends option parsing wherever it appears (fish splits
			// flags from operands at the first `--`; the operands
			// themselves stay before it)
			pos := len(rest)
			for j, r := range rest {
				if f, ok := irStr(r.(map[string]any)); ok && f == "--" {
					pos = j
					break
				}
			}
			i := 0
			for i < pos {
				f, ok := irStr(rest[i].(map[string]any))
				if !ok || !strings.HasPrefix(f, "-") || f == "-" {
					break
				}
				switch f {
				case "-a", "--all":
					all = true
				case "-i", "--ignore-case":
					ignoreCase = true
				case "-r", "--regex":
					regex = true
				default:
					return nil, false
				}
				i++
			}
			positionals := append([]any{}, rest[i:pos]...)
			positionals = append(positionals, rest[pos+1:]...)
			if len(positionals) < 3 {
				return nil, false
			}
			old, ok1 := irStr(positionals[0].(map[string]any))
			new, ok2 := irStr(positionals[1].(map[string]any))
			if !ok1 || !ok2 {
				return nil, false
			}
			flag := ""
			if all {
				flag += "g"
			}
			if ignoreCase {
				flag += "i"
			}
			pat, repl := old, new
			if regex {
				pat = sedRegexEscape(old)
				repl = sedReplFish(new)
			} else {
				pat = sedBreakEscape(old)
				repl = sedReplEscape(new)
			}
			script := "s/" + pat + "/" + repl + "/" + flag
			// OLD NEW [TEXT...] — fish replaces in EVERY text argument and
			// prints each result on its own line; one echo|sed pipeline per
			// argument reproduces that (sed's per-line first-match/global
			// flags are the per-argument semantics).
			var stmts []map[string]any
			for _, ta := range positionals[2:] {
				pipe := callExpr("pipeline", []any{map[string]any{"type": "Array", "elements": []any{
					map[string]any{"type": "Arrow", "body": []map[string]any{exprStmt(callExpr("exec", []any{strExpr("echo"), map[string]any{"type": "Array", "elements": []any{ta}}}))}},
					map[string]any{"type": "Arrow", "body": []map[string]any{exprStmt(callExpr("exec", []any{strExpr("sed"), map[string]any{"type": "Array", "elements": []any{strExpr(script)}}}))}},
				}}})
				stmts = append(stmts, exprStmt(pipe))
			}
			return stmts, true
		}
	}
	return nil, false
}

// argsIR converts a token list to IR expressions (the same valueExpr the
// generic exec path uses for its argument array).
func (p *parser) argsIR(args []token) ([]any, error) {
	out := make([]any, 0, len(args))
	for _, a := range args {
		e, err := p.valueExpr(a)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// ── expression building (mirrors the core's node shapes) ──────────────

func (p *parser) valueExpr(t token) (map[string]any, error) {
	switch t.kind {
	case tWord:
		return wordExpr(t.text), nil
	case tDQuote:
		return map[string]any{"type": "Interpolate", "parts": splitInterp(t.text)}, nil
	case tSQuote:
		return strExpr(t.text), nil
	case tSub:
		inner, err := parseProgramText(t.text, t.line)
		if err != nil {
			return nil, err
		}
		// `(math ...)` / `(string ...)` / `(count ...)` — the value is the
		// builtin's printed result; lower to the core value shapes instead
		// of a capture of a non-existent external binary.
		if v, ok := builtinCaptureValue(inner); ok {
			return v, nil
		}
		return callExpr("capture", []any{map[string]any{"type": "Arrow", "body": inner}}), nil
	}
	return nil, fmt.Errorf("line %d: unexpected token", t.line)
}

func strExpr(v string) map[string]any {
	return map[string]any{"type": "Str", "value": v, "style": "DoubleQuoted"}
}

func exprStmt(e map[string]any) map[string]any {
	return map[string]any{"type": "Expr", "expr": e}
}

func callExpr(fn string, args []any) map[string]any {
	return map[string]any{"type": "Call", "func": fn, "args": args, "purity": purityOf(fn, args)}
}

func getVarExpr(n string) map[string]any {
	return callExpr("getVar", []any{strExpr(n)})
}

// fishVarName maps a fish variable to its A1 name: `$status` is the exit
// code (`?` — the core's `$?` read), `$argv` is the positional list
// (`@`). All other names pass through.
func fishVarName(n string) string {
	switch n {
	case "status":
		return "?"
	case "argv":
		return "@"
	}
	return n
}

// fishIndex converts a 1-based fish array index to the 0-based key the
// A1 arrayIndex call reads (`$a[2]` is the second element).
func fishIndex(idx string) string {
	n, err := strconv.ParseInt(idx, 10, 64)
	if err != nil || n < 1 {
		return idx // malformed subscript: pass through
	}
	return strconv.FormatInt(n-1, 10)
}

func arrayIndexExpr(n, idx string) map[string]any {
	return callExpr("arrayIndex", []any{strExpr(n), strExpr(idx)})
}

// fishSliceExpr lowers a fish 1-based inclusive array slice `$a[S..E]`
// to the core's quoted-`${arr[@]:off:len}` shape (a param slice wrapped
// in join — the array result must join with spaces for `echo`; the
// standalone param call would String()-join with commas). Literal
// bounds only: `[S..]` / `[S..-1]` mean "to the end" (empty length),
// `[..E]` starts at the first element, negative ends pass through JS
// slice semantics (`$a[2..-2]` = slice(1,-2)). Untranslatable forms
// (steps, mixed-sign ranges) return ok=false → the caller keeps the
// literal text.
func fishSliceExpr(n, slice string) (map[string]any, bool) {
	parts := strings.Split(slice, "..")
	if len(parts) != 2 {
		return nil, false
	}
	startS := parts[0]
	endS := parts[1]
	parse := func(s string) (int64, bool) {
		if s == "" {
			return 0, true
		}
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return 0, false
		}
		return v, true
	}
	start, ok1 := parse(startS)
	end, ok2 := parse(endS)
	if !ok1 || !ok2 {
		return nil, false
	}
	toEnd := endS == "" || (ok2 && end == -1)
	if startS == "" {
		start = 1 // `[..E]` — from the first element
	}
	// a negative start only translates when slicing to the end
	if start < 0 && !toEnd {
		return nil, false
	}
	var off string
	if start < 0 {
		off = startS // JS slice counts from the end
	} else {
		if start < 1 {
			return nil, false // fish indices are 1-based
		}
		off = strconv.FormatInt(start-1, 10)
	}
	length := ""
	if !toEnd {
		length = strconv.FormatInt(end-start+1, 10)
	}
	return callExpr("join", []any{callExpr("param", []any{
		strExpr("slice"), strExpr(fishVarName(n)), strExpr(off), strExpr(length),
	})}), true
}

// subscriptExpr lowers a parsed `$name[idx]` subscript (digit index or
// fish slice range) to its A1 read call; ok=false for subscripts the A1
// vocabulary can't express (the caller keeps the literal text).
func subscriptExpr(name, idx string) (map[string]any, bool) {
	if strings.Contains(idx, "..") {
		return fishSliceExpr(name, idx)
	}
	if name == "argv" {
		return getVarExpr(idx), true
	}
	return arrayIndexExpr(name, fishIndex(idx)), true
}

// bash SYNC_BUILTINS — the core's Emulable set for `exec` calls.
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

func purityOf(fn string, args []any) string {
	switch fn {
	case "exec":
		if len(args) > 0 {
			if s, ok := args[0].(map[string]any); ok && s["type"] == "Str" {
				if n, ok := s["value"].(string); ok && syncBuiltins[n] {
					return "Emulable"
				}
			}
		}
		return "Spawn"
	case "capture", "captureWords", "pipeline", "redirect", "background":
		return "Spawn"
	}
	return "Emulable"
}

func isNameStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isNameChar(c byte) bool {
	return isNameStart(c) || (c >= '0' && c <= '9')
}

// sliceSubAt parses fish slice syntax `$a[START..END]` (1-based,
// inclusive; either bound may be empty: `[..3]`, `[2..]`) at text[k]=='['.
// Returns the raw slice text ("2..3") and the position after ']'.
func sliceSubAt(text string, k int) (string, int, bool) {
	m := k + 1
	// start bound: -?digits (may be empty)
	s := m
	if s < len(text) && text[s] == '-' {
		s++
	}
	t := s
	for t < len(text) && text[t] >= '0' && text[t] <= '9' {
		t++
	}
	// the `..` must follow immediately
	if t+1 >= len(text) || text[t] != '.' || text[t+1] != '.' {
		return "", k, false
	}
	// end bound: -?digits (may be empty)
	e := t + 2
	if e < len(text) && text[e] == '-' {
		e++
	}
	u := e
	for u < len(text) && text[u] >= '0' && text[u] <= '9' {
		u++
	}
	if u < len(text) && text[u] == ']' {
		return text[k+1 : u], u + 1, true
	}
	return "", k, false
}

// varNameAt parses `$name` / `$name[digits]` / `$name[START..END]` at
// text[i] ('$'). A slice subscript is returned verbatim ("2..3").
func varNameAt(text string, i int) (name, idx string, next int) {
	j := i + 1
	if j >= len(text) || !isNameStart(text[j]) {
		return "", "", i + 1
	}
	k := j + 1
	for k < len(text) && isNameChar(text[k]) {
		k++
	}
	name = text[j:k]
	if k < len(text) && text[k] == '[' {
		m := k + 1
		for m < len(text) && text[m] >= '0' && text[m] <= '9' {
			m++
		}
		if m > k+1 && m < len(text) && text[m] == ']' {
			idx = text[k+1 : m]
			k = m + 1
		} else if sl, next, ok := sliceSubAt(text, k); ok {
			idx = sl
			k = next
		}
	}
	return name, idx, k
}

// wholeVar reports whether text is exactly one `$name` / `$name[i]`.
func wholeVar(text string) (name, idx string, ok bool) {
	if len(text) < 2 || text[0] != '$' {
		return "", "", false
	}
	n, i, next := varNameAt(text, 0)
	if next != len(text) {
		return "", "", false
	}
	return n, i, true
}

// braceParts parses fish brace expansion in a literal (no `$`) word:
// `pre{a,b}post` → prefix "pre", groups [["a","b"]], middles [], suffix
// "post". Only comma-list groups expand (fish has no numeric ranges);
// multiple groups combine (`{a,b}{c,d}` → 4 words); nested or escaped
// braces stay literal. ok=false keeps the word a plain literal.
func braceParts(text string) (prefix string, groups [][]string, middles []string, suffix string, ok bool) {
	lastEnd := 0
	i := 0
	for i < len(text) {
		if text[i] == '\\' && i+1 < len(text) {
			i += 2
			continue
		}
		if text[i] != '{' {
			i++
			continue
		}
		j := i + 1
		for j < len(text) && text[j] != '}' {
			if text[j] == '{' || text[j] == '\\' {
				return "", nil, nil, "", false // nested/escaped: literal
			}
			j++
		}
		if j >= len(text) {
			return "", nil, nil, "", false // unterminated: literal
		}
		items := strings.Split(text[i+1:j], ",")
		if len(items) < 2 {
			return "", nil, nil, "", false // no comma: fish keeps the braces
		}
		if len(groups) == 0 {
			prefix = text[:i]
		} else {
			middles = append(middles, text[lastEnd:i])
		}
		groups = append(groups, items)
		lastEnd = j + 1
		i = j + 1
	}
	if len(groups) == 0 {
		return "", nil, nil, "", false
	}
	return prefix, groups, middles, text[lastEnd:], true
}

// braceValueExpr emits the core's sh2.brace shape — the exact
// `Call("brace", [prefix, Json(groups), Json(middles), suffix])` form
// debashc emits for bash `echo pre{a,b}post` (the ESTree backend
// expands it at emit time).
func braceValueExpr(prefix string, groups [][]string, middles []string, suffix string) map[string]any {
	gj := make([]any, 0, len(groups))
	for _, g := range groups {
		items := make([]any, 0, len(g))
		for _, it := range g {
			items = append(items, it)
		}
		gj = append(gj, items)
	}
	mj := make([]any, 0, len(middles))
	for _, m := range middles {
		mj = append(mj, m)
	}
	return callExpr("brace", []any{
		strExpr(prefix),
		map[string]any{"type": "Json", "value": gj},
		map[string]any{"type": "Json", "value": mj},
		strExpr(suffix),
	})
}

// wordExpr: a bare word → Str, single getVar/arrayIndex/slice, brace
// expansion, or Interpolate. `$argv[i]` lowers to the positional read
// getVar("i") (fish argv[1] is the first function argument = the
// core's `$1`); other `$a[i]` lower to arrayIndex with the 0-based key;
// `$a[2..3]` lowers to the core's `${arr[@]:off:len}` slice shape.
func wordExpr(text string) map[string]any {
	if strings.IndexByte(text, '$') < 0 {
		if pre, groups, middles, suf, ok := braceParts(text); ok {
			return braceValueExpr(pre, groups, middles, suf)
		}
		return strExpr(text)
	}
	if n, idx, ok := wholeVar(text); ok {
		if idx != "" {
			if e, ok := subscriptExpr(n, idx); ok {
				return e
			}
			// untranslatable subscript (`$a[1..5..2]`): keep the literal
			return strExpr(text)
		}
		return getVarExpr(fishVarName(n))
	}
	return map[string]any{"type": "Interpolate", "parts": splitInterp(text)}
}

// splitInterp splits text on $expansions into Interpolate parts. Empty
// literal pieces are dropped (the core's `"$x$y"` shape); a text with no
// expansions yields one lit part (the core's `"plain"` / `""` shape).
// An untranslatable subscript (`$a[1..5..2]`) stays literal.
func splitInterp(text string) []any {
	var parts []any
	litStart := 0
	i := 0
	for i < len(text) {
		if text[i] == '$' {
			name, idx, next := varNameAt(text, i)
			if next > i+1 {
				var e map[string]any
				needExpr := true
				if idx != "" {
					var ok bool
					e, ok = subscriptExpr(name, idx)
					if !ok {
						needExpr = false
					}
				} else {
					e = getVarExpr(fishVarName(name))
				}
				if needExpr {
					if litStart < i {
						parts = append(parts, map[string]any{"kind": "lit", "text": text[litStart:i]})
					}
					parts = append(parts, map[string]any{"kind": "expr", "expr": e})
				} else {
					parts = append(parts, map[string]any{"kind": "lit", "text": text[litStart:next]})
				}
				litStart = next
				i = next
				continue
			}
		}
		i++
	}
	if litStart < len(text) {
		parts = append(parts, map[string]any{"kind": "lit", "text": text[litStart:]})
	}
	if len(parts) == 0 {
		parts = append(parts, map[string]any{"kind": "lit", "text": ""})
	}
	return parts
}

func parseProgramText(src string, line int) ([]map[string]any, error) {
	p := &parser{lex: &lexer{src: src, line: line}}
	return p.parseProgram()
}

// ── Shir — fish-sh-go as a library: fish source -> A1 shIR JSON bytes
// (no trailing newline). Both the CLI (cmd/fish-sh-go) and the combined
// busybox dispatch through this single entry point. ───────────────────

func Shir(src string) ([]byte, error) {
	stmts, err := parseProgramText(src, 1)
	if err != nil {
		return nil, err
	}
	prog := &shiremit.Program{Stmts: stmts}
	return shiremit.Emit(prog)
}
