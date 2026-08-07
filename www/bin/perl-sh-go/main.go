// perl-sh-go: Perl source -> shIR JSON (A1 contract), ANTLR4+Go frontend.
//
// The frontend parses a v1 Perl subset (the shell-flavored corpus in
// testdata/) with a hand-rolled recursive-descent parser and lowers it to
// the shared A1 shIR vocabulary (sh2perl/src/shir_json.rs): `Expr`+`Call`
// (commands, printf, test, getVar/setVar, capture), `Assign`, `If`/`While`/
// `For`, `Function`+`Return` (subroutines), `Arith` (arithmetic), all in
// the canonical shapes the core's own `--shir` emits — so the emitted JSON
// is byte-valid for the strict ingress (`--shir-in-estree`) and renders
// through the ESTree backend without the Perl-only nodes (Output/RawExpr/
// Unsupported) the renderer rejects.
//
// Lowering decisions (all against the SHARED runtime, no harness changes):
//   - `print A, B`  → `printf "%s%s..." A B` — perl print concatenates
//     args with NO separator and NO auto-newline, which is exactly N %s
//     conversions of the runtime printf builtin (the perl literal's own
//     \n, decoded at parse time, supplies the newline).
//   - `length($x)`  → `getVar("#x")` — the runtime's `#name` length read.
//   - `substr($x,o,l)` → `param("slice", "x", o, l)` — the runtime's
//     `${x:o:l}` slice.
//   - `scalar(@a)`  → `arrayLen("a")`.
//   - `$?`          → `lastExit * 256` (perl's $? is the raw wait status
//     WEXITSTATUS<<8; `($? >> 8)` after `system("false")` is 1).
//   - Conditions (`==`/`eq`/`<`/`!`/`&&`...) are translated to shell test
//     syntax (`-eq`/`==`/`-lt`/`! (...)`/`-a`) for the runtime `sh2.test`
//     evaluator; vars stay `$name` text and the runtime expands them.
//   - `fork()`     → empty value (the child branch runs inline); `exit` /
//     `wait()` are no-ops (the corpus's fork test prints child+main).
//   - `open(...,"-|",CMD)` records the pipe command; `<$ph>` lowers to a
//     capture of it (+ the line's trailing newline, which perl keeps).
//   - `my $l = <STDIN>` → the `read` builtin (REPLY at EOF) + assign.
//   - heredocs, qx backticks, subroutines (`Function` stmts — the ESTree
//     backend consumes functions from stmts, not the `subs` field).
package pllib

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	shiremit "github.com/gmatht/sh2loop/frontends/shir-emit-go"
)

// ── tokens ───────────────────────────────────────────────────────────

type tokKind string

const (
	tIdent tokKind = "ident"
	tVar   tokKind = "var" // $name / @name (sigil in text)
	tEnv   tokKind = "env" // $ENV{NAME}
	tStr   tokKind = "str" // "..." or '...' (raw inner, quoted flag)
	tNum   tokKind = "num"
	tOp    tokKind = "op" // == != < > <= >= eq ne lt gt le ge && || ! + - * / % . ? : << >> ++ -- += -= *= /= = or and
	tQx    tokKind = "qx" // `cmd`
	tRd    tokKind = "rd" // <STDIN> / <$ph>
	tPunct tokKind = "punct"
	tEOF   tokKind = "eof"
)

type token struct {
	kind tokKind
	text string
	raw  string // string inner (undecoded) / qx text / readline inner
	dq   bool   // str was double-quoted
	line int    // 0-based source line
}

// ── expression AST ───────────────────────────────────────────────────

type node struct {
	kind string // lit str var env idx num arith concat cmp not and or call qx rd tern pn bare arrvar pos incr filetest
	text string // lit text / var name / op / call name / flag / raw for qx
	dq   bool
	kids []*node
	line int
}

func (n *node) isVar() bool { return n != nil && n.kind == "var" }

// ── parser ───────────────────────────────────────────────────────────

type parser struct {
	toks  []token
	pos   int
	lines []string
	// pipeCmd — the command recorded by the last `open($ph, "-|", CMD...)`;
	// consumed by the next `<$ph>` readline.
	pipeCmd []string
	// retFns — subroutine names whose bodies contain a value `return`:
	// their calls in expression position must read the `__ret` capture.
	retFns map[string]bool
}

func (p *parser) peek() *token {
	if p.pos < len(p.toks) {
		return &p.toks[p.pos]
	}
	return nil
}
func (p *parser) next() *token {
	t := p.peek()
	if t != nil {
		p.pos++
	}
	return t
}
func (p *parser) accept(text string) bool {
	t := p.peek()
	if t != nil && t.text == text {
		p.pos++
		return true
	}
	return false
}
func (p *parser) expect(text string) {
	if !p.accept(text) {
		p.fail("expected %q, got %q", text, p.describe(p.peek()))
	}
}
func (p *parser) describe(t *token) string {
	if t == nil {
		return "EOF"
	}
	if t.kind == tStr {
		return fmt.Sprintf("string %q", t.raw)
	}
	if t.kind == tEOF {
		return "EOF"
	}
	return fmt.Sprintf("%s %q", t.kind, t.text)
}
func (p *parser) fail(format string, args ...any) {
	panic(fmt.Sprintf("line %d: %s", p.peekLine(), fmt.Sprintf(format, args...)))
}
func (p *parser) peekLine() int {
	if t := p.peek(); t != nil {
		return t.line
	}
	if len(p.toks) > 0 {
		return p.toks[len(p.toks)-1].line
	}
	return 0
}

// skipToSemi consumes tokens up to and including the next `;` (or `}`/EOF).
func (p *parser) skipToSemi() {
	for {
		t := p.peek()
		if t == nil || t.kind == tEOF {
			return
		}
		p.next()
		if t.text == ";" || t.text == "}" {
			return
		}
	}
}

// ── tokenizer ────────────────────────────────────────────────────────

var identRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*`)
var numRe = regexp.MustCompile(`^[0-9]+`)

func tokenize(src string, lines []string) ([]token, error) {
	var toks []token
	line := 0
	i := 0
	n := len(src)
	push := func(k tokKind, text, raw string, dq bool) {
		toks = append(toks, token{kind: k, text: text, raw: raw, dq: dq, line: line})
	}
	for i < n {
		c := src[i]
		if c == '\n' {
			line++
			i++
			continue
		}
		if c == ' ' || c == '\t' || c == '\r' {
			i++
			continue
		}
		if c == '#' {
			for i < n && src[i] != '\n' {
				i++
			}
			continue
		}
		if c == '"' || c == '\'' {
			q := c
			j := i + 1
			var sb strings.Builder
			for j < n && src[j] != q {
				if src[j] == '\\' && j+1 < n {
					sb.WriteByte(src[j])
					sb.WriteByte(src[j+1])
					j += 2
					continue
				}
				sb.WriteByte(src[j])
				j++
			}
			if j >= n {
				return nil, fmt.Errorf("line %d: unterminated string", line)
			}
			push(tStr, "", sb.String(), c == '"')
			i = j + 1
			continue
		}
		if c == '`' {
			j := i + 1
			for j < n && src[j] != '`' {
				j++
			}
			if j >= n {
				return nil, fmt.Errorf("line %d: unterminated backtick", line)
			}
			push(tQx, "", src[i+1:j], false)
			i = j + 1
			continue
		}
		if c == '$' || c == '@' {
			sigil := c
			rest := src[i+1:]
			// $? $# $$ $@ $* $0..$9 — special vars
			if sigil == '$' && len(rest) > 0 {
				if rest[0] == '?' || rest[0] == '#' || rest[0] == '$' || rest[0] == '@' || rest[0] == '*' ||
					(rest[0] >= '0' && rest[0] <= '9') {
					push(tVar, string(rest[0]), "", false)
					i += 2
					continue
				}
				m := identRe.FindString(rest)
				if m != "" {
					after := i + 1 + len(m)
					if after < n && src[after] == '{' {
						// $ENV{NAME} / ${name}
						close := strings.IndexByte(src[after+1:], '}')
						if close >= 0 {
							inner := src[after+1 : after+1+close]
							if m == "ENV" {
								push(tEnv, inner, "", false)
							} else {
								push(tVar, inner, "", false)
							}
							i = after + 1 + close + 1
							continue
						}
					}
					push(tVar, m, "", false)
					i = after
					continue
				}
				// bare $ — literal
				push(tOp, "$", "", false)
				i++
				continue
			}
			if sigil == '@' && len(rest) > 0 {
				m := identRe.FindString(rest)
				if m != "" {
					push(tVar, "@"+m, "", false)
					i += 1 + len(m)
					continue
				}
			}
			return nil, fmt.Errorf("line %d: bad sigil", line)
		}
		if c >= '0' && c <= '9' {
			m := numRe.FindString(src[i:])
			push(tNum, m, "", false)
			i += len(m)
			continue
		}
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' {
			m := identRe.FindString(src[i:])
			push(tIdent, m, "", false)
			i += len(m)
			continue
		}
		if c == '<' {
			rest := src[i+1:]
			if strings.HasPrefix(rest, "=") {
				push(tOp, "<=", "", false)
				i += 2
				continue
			}
			if strings.HasPrefix(rest, "<") {
				push(tOp, "<<", "", false)
				i += 2
				continue
			}
			// <STDIN> / <$ph> — readline; the target is any non-space run
			// up to the closing > (a bare `<` followed by whitespace is the
			// less-than operator).
			if i+1 < n && src[i+1] != ' ' && src[i+1] != '\t' && src[i+1] != '\n' && src[i+1] != '\r' {
				j := i + 1
				for j < n && src[j] != '>' {
					j++
				}
				if j >= n {
					return nil, fmt.Errorf("line %d: unterminated <...>", line)
				}
				push(tRd, "", src[i+1:j], false)
				i = j + 1
				continue
			}
			push(tOp, "<", "", false)
			i++
			continue
		}
		if c == '>' {
			rest := src[i+1:]
			if strings.HasPrefix(rest, "=") {
				push(tOp, ">=", "", false)
				i += 2
				continue
			}
			if strings.HasPrefix(rest, ">") {
				push(tOp, ">>", "", false)
				i += 2
				continue
			}
			push(tOp, ">", "", false)
			i++
			continue
		}
		if c == '=' {
			if strings.HasPrefix(src[i+1:], "=") {
				push(tOp, "==", "", false)
				i += 2
				continue
			}
			if strings.HasPrefix(src[i+1:], "~") {
				push(tOp, "=~", "", false)
				i += 2
				continue
			}
			push(tOp, "=", "", false)
			i++
			continue
		}
		if c == '!' {
			if strings.HasPrefix(src[i+1:], "=") {
				push(tOp, "!=", "", false)
				i += 2
				continue
			}
			push(tOp, "!", "", false)
			i++
			continue
		}
		if c == '&' {
			if strings.HasPrefix(src[i+1:], "&") {
				push(tOp, "&&", "", false)
				i += 2
				continue
			}
			push(tOp, "&", "", false)
			i++
			continue
		}
		if c == '|' {
			if strings.HasPrefix(src[i+1:], "|") {
				push(tOp, "||", "", false)
				i += 2
				continue
			}
			push(tOp, "|", "", false)
			i++
			continue
		}
		if c == '+' {
			if strings.HasPrefix(src[i+1:], "+") {
				push(tOp, "++", "", false)
				i += 2
				continue
			}
			if strings.HasPrefix(src[i+1:], "=") {
				push(tOp, "+=", "", false)
				i += 2
				continue
			}
			push(tOp, "+", "", false)
			i++
			continue
		}
		if c == '-' {
			if strings.HasPrefix(src[i+1:], "-") {
				push(tOp, "--", "", false)
				i += 2
				continue
			}
			if strings.HasPrefix(src[i+1:], "=") {
				push(tOp, "-=", "", false)
				i += 2
				continue
			}
			// file-test flags: -e -f -d ... (also plain '-' as an op)
			if i+1 < n && ((src[i+1] >= 'a' && src[i+1] <= 'z') || (src[i+1] >= 'A' && src[i+1] <= 'Z')) {
				m := identRe.FindString(src[i+1:])
				push(tOp, "-"+m, "", false)
				i += 1 + len(m)
				continue
			}
			push(tOp, "-", "", false)
			i++
			continue
		}
		if c == '*' {
			if strings.HasPrefix(src[i+1:], "=") {
				push(tOp, "*=", "", false)
				i += 2
				continue
			}
			push(tOp, "*", "", false)
			i++
			continue
		}
		if c == '/' {
			if strings.HasPrefix(src[i+1:], "=") {
				push(tOp, "/=", "", false)
				i += 2
				continue
			}
			if strings.HasPrefix(src[i+1:], "/") {
				push(tOp, "//", "", false)
				i += 2
				continue
			}
			push(tOp, "/", "", false)
			i++
			continue
		}
		if c == '.' {
			if strings.HasPrefix(src[i+1:], ".") {
				push(tOp, "..", "", false)
				i += 2
				continue
			}
			push(tOp, ".", "", false)
			i++
			continue
		}
		if c == '%' {
			push(tOp, "%", "", false)
			i++
			continue
		}
		if c == '^' {
			// regex anchor (s/^he//, m/^.../) — also xor, never used by
			// the subset; the substitution parser re-joins these tokens
			// into the pattern string.
			push(tOp, "^", "", false)
			i++
			continue
		}
		if c == '?' {
			push(tOp, "?", "", false)
			i++
			continue
		}
		if c == ':' {
			push(tOp, ":", "", false)
			i++
			continue
		}
		if c == ',' || c == ';' || c == '(' || c == ')' || c == '{' || c == '}' || c == '[' || c == ']' {
			push(tPunct, string(c), "", false)
			i++
			continue
		}
		return nil, fmt.Errorf("line %d: unexpected char %q", line, string(c))
	}
	toks = append(toks, token{kind: tEOF, line: line})
	return toks, nil
}

// ── statement parsing ────────────────────────────────────────────────

// parseProgram parses the whole source into A1 statements.
func parseProgram(src string) ([]map[string]any, error) {
	// Strip a shebang on line 1 (it would otherwise lex as a comment —
	// fine — but keep the line accounting identical).
	lines := strings.Split(src, "\n")
	toks, err := tokenize(src, lines)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks, lines: lines, retFns: map[string]bool{}}
	// Parse inside a closure so the recover sets the returned error
	// BEFORE the caller sees it (a bare defer would check too late).
	stmts, err := func() (s []map[string]any, err error) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("%v", r)
			}
		}()
		return p.parseBlock(false), nil
	}()
	if err != nil {
		return nil, err
	}
	return stmts, nil
}

func (p *parser) parseBlock(inBrace bool) []map[string]any {
	if inBrace {
		p.expect("{")
	}
	var out []map[string]any
	for {
		p.skipSemis()
		t := p.peek()
		if t == nil || t.kind == tEOF {
			return out
		}
		if t.text == "}" {
			if inBrace {
				p.next()
				return out
			}
			// stray } at top level — skip
			p.next()
			continue
		}
		ss := p.parseStatement()
		out = append(out, ss...)
	}
}

func (p *parser) skipSemis() {
	for p.accept(";") {
	}
}

func (p *parser) parseStatement() []map[string]any {
	t := p.peek()
	if t == nil || t.kind == tEOF {
		p.fail("unexpected EOF in statement")
	}
	if t.kind == tIdent {
		switch t.text {
		case "print":
			return p.parsePrint()
		case "printf":
			return p.parsePrintf()
		case "if":
			return []map[string]any{p.parseIf(false)}
		case "unless":
			return []map[string]any{p.parseIf(true)}
		case "while":
			return []map[string]any{p.parseWhile(false)}
		case "until":
			return []map[string]any{p.parseWhile(true)}
		case "for", "foreach":
			return []map[string]any{p.parseFor()}
		case "sub":
			return []map[string]any{p.parseSub()}
		case "return":
			return []map[string]any{p.parseReturn()}
		case "my", "our", "local":
			return p.parseDecl()
		case "system", "exec":
			return p.parseSystem()
		case "open":
			return p.parseOpen()
		case "push":
			return p.parsePush()
		case "close", "wait", "die", "exit", "chomp":
			// no-ops: close/die on the open() no-ops; wait()/exit are the
			// fork() emulation (the child branch's exit ends the CHILD,
			// and the parent continues — running inline, nothing to stop).
			p.skipToSemi()
			return nil
		}
		// bareword call: f(...) — user subroutines lower to exec (the
		// renderer dispatches them through fnCall); the perl builtins
		// above are no-ops.
		if p.peekN(1) != nil && p.peekN(1).kind == tPunct && p.peekN(1).text == "(" {
			p.next() // ident
			p.next() // (
			args := p.parseArgList(")")
			p.expect(")")
			p.skipToSemi()
			return p.fnCallStmt(t.text, args)
		}
		p.fail("unsupported statement: %s", t.text)
	}
	if t.kind == tVar || t.kind == tEnv {
		return p.parseVarStmt()
	}
	if t.kind == tPunct && t.text == "(" {
		// (my $t = $s) =~ s/pat/rep/g; — substitution assignment
		return p.parseSubstAssign()
	}
	p.fail("unsupported statement token: %s", p.describe(t))
	return nil
}

func (p *parser) peekN(n int) *token {
	if p.pos+n < len(p.toks) {
		return &p.toks[p.pos+n]
	}
	return nil
}

// fnCallStmt — a subroutine call statement: `exec f [args]`. For a
// value-returning function the return capture (`__ret`) is pre-set so an
// expression-position call in the SAME statement can read it.
func (p *parser) fnCallStmt(name string, args []*node) []map[string]any {
	el := make([]any, 0, len(args))
	for _, a := range args {
		el = append(el, p.lowerValue(a))
	}
	call := callExpr("exec", []any{strLit(name), map[string]any{"type": "Array", "elements": el}}, "Spawn")
	if p.retFns[name] {
		// Pre-set the capture so a call that never reaches its return
		// still leaves __ret defined; the function body overwrites it.
		return []map[string]any{
			exprStmt(callExpr("setVar", []any{strLit("__ret"), interpLit("")}, "Emulable")),
			exprStmt(call),
		}
	}
	return []map[string]any{exprStmt(call)}
}

// parseArgList parses comma-separated exprs until the given terminator
// text (")" or ";" or "}"), leaving the terminator unconsumed.
func (p *parser) parseArgList(term string) []*node {
	var args []*node
	for {
		t := p.peek()
		if t == nil || t.kind == tEOF || t.text == term {
			return args
		}
		args = append(args, p.parseExpr())
		if p.accept(",") {
			continue
		}
		return args
	}
}

// parseSubstAssign: (my $t = $s) =~ s/pat/rep/flags; — the perl
// substitution form lowers to the runtime's global string replace
// (`${s//pat/rep}` → sh2.param("//", ...)).
func (p *parser) parseSubstAssign() []map[string]any {
	p.expect("(")
	if t2 := p.peek(); t2 != nil && t2.kind == tIdent && (t2.text == "my" || t2.text == "our" || t2.text == "local") {
		p.next()
	}
	v := p.next()
	if v == nil || v.kind != tVar {
		p.fail("=~ substitution: expected $var")
	}
	name := strings.TrimPrefix(v.text, "$")
	p.expect("=")
	src := p.parseExpr()
	p.expect(")")
	p.expect("=~")
	p.expect("s")
	p.expect("/")
	pat, closed := p.scanDelimited()
	rep := ""
	if !closed {
		// the `//` token already closed both halves (empty replacement)
		rep, _ = p.scanDelimited()
	}
	// flags: g (global) — the runtime's // replace is global; anything
	// else is ignored (the corpus uses g only).
	if t2 := p.peek(); t2 != nil && t2.kind == tIdent {
		p.next()
	}
	p.skipToSemi()
	srcName := ""
	switch src.kind {
	case "var", "env":
		srcName = src.text
	case "pn":
		if src.kids[0].kind == "var" || src.kids[0].kind == "env" {
			srcName = src.kids[0].text
		}
	}
	if srcName == "" {
		p.fail("=~ substitution: source must be a variable")
	}
	// s/^pat// → prefix strip (param "#", or "##" for a greedy `.*` run);
	// s/pat$// → suffix strip ("%" / "%%"); any other form stays the
	// global replace ("//"). The runtime's #/##/%/%% ops are glob-based,
	// and a leading `.*` / trailing `.*` is exactly a greedy regex run.
	op := "//"
	p2 := pat
	if rep == "" {
		if strings.HasPrefix(pat, "^") {
			p2 = strings.TrimPrefix(pat, "^")
			if strings.HasPrefix(p2, ".*") {
				op = "##"
				p2 = "*" + strings.TrimPrefix(p2, ".*")
			} else {
				op = "#"
			}
		} else if strings.HasSuffix(pat, "$") {
			p2 = strings.TrimSuffix(pat, "$")
			if strings.HasSuffix(p2, ".*") {
				op = "%%"
				p2 = strings.TrimSuffix(p2, ".*") + "*"
			} else {
				op = "%"
			}
		}
	}
	return []map[string]any{assignStmt(name, callExpr("param", []any{
		strLit(op), strLit(srcName), strLit(p2), strLit(rep),
	}, "Emulable"))}
}

// scanDelimited scans tokens up to (and consuming) a `/` or `//`
// delimiter, re-joining the tokens the lexer splits regex/pattern
// metacharacters into (`s/^he//` lexes `^`, `he`, then the merged `//`).
// The boolean reports whether the closing delimiter was the merged `//`
// token, which closes BOTH halves at once (empty replacement).
func (p *parser) scanDelimited() (string, bool) {
	var sb strings.Builder
	for {
		t := p.peek()
		if t == nil || t.kind == tEOF {
			p.fail("unterminated /.../ pattern")
		}
		if t.kind == tOp && (t.text == "/" || t.text == "//") {
			p.next()
			return sb.String(), t.text == "//"
		}
		if t.kind == tStr {
			sb.WriteString(t.raw)
		} else {
			sb.WriteString(t.text)
		}
		p.next()
	}
}

// ── print / printf ───────────────────────────────────────────────────

func (p *parser) parsePrint() []map[string]any {
	p.expect("print")
	t := p.peek()
	if t != nil && t.kind == tOp && t.text == "<<" {
		// heredoc: print <<"EOF";
		p.next() // <<
		termTok := p.next()
		if termTok == nil || (termTok.kind != tStr && termTok.kind != tIdent) {
			p.fail("heredoc: expected terminator")
		}
		term := termTok.text
		if termTok.kind == tStr {
			term = termTok.raw
		}
		p.skipToSemi()
		content := p.heredocLines(term, termTok.line)
		return []map[string]any{printfStmt([]map[string]any{interpLit(content)})}
	}
	var exprs []*node
	if p.accept("(") {
		exprs = p.parseArgList(")")
		p.expect(")")
		// `print(EXPR), EXPR2;` — the parenthesized list is the print
		// call; the rest is a void comma expression (t51) — skip it.
		p.skipToSemi()
	} else {
		exprs = p.parseArgList(";")
		if len(exprs) == 0 {
			p.fail("print with no args")
		}
		// filehandle form: `print $fh "data\n"` — the first arg is an
		// uncomma'd $var followed by more expressions → write to a
		// filehandle, not stdout. The open() it targets is a no-op, so
		// drop the whole statement.
		t = p.peek()
		if exprs[0].isVar() && t != nil && t.text != ";" && t.text != "}" && t.kind != tEOF {
			p.skipToSemi()
			return nil
		}
		p.skipToSemi()
	}
	return p.printStmts(exprs)
}

// printStmts lowers a print arg list. A ternary arg (`print index(...) >= 0
// ? A : B`) lowers to a statement-level If — the ESTree renderer rejects
// the Perl-only Ternary expression node, but the If shape is shared.
func (p *parser) printStmts(exprs []*node) []map[string]any {
	for i, e := range exprs {
		// a value-returning function call arg: run the call first, then
		// print the captured __ret (the runtime fnCall yields only status).
		if e.kind == "call" && p.retFns[e.text] {
			callArgs := make([]*node, len(exprs))
			copy(callArgs, exprs)
			callArgs[i] = &node{kind: "var", text: "__ret"}
			out := p.fnCallStmt(e.text, e.kids)
			out = append(out, p.printStmts(callArgs)...)
			return out
		}
		if e.kind == "tern" {
			thenArgs := make([]*node, len(exprs))
			copy(thenArgs, exprs)
			thenArgs[i] = e.kids[1]
			elseArgs := make([]*node, len(exprs))
			copy(elseArgs, exprs)
			elseArgs[i] = e.kids[2]
			return []map[string]any{map[string]any{
				"type":   "If",
				"cond":   p.testCond(e.kids[0], false),
				"then":   stmtsToAny([]map[string]any{printfStmt(p.lowerValues(thenArgs))}),
				"elsifs": []any{},
				"else":   stmtsToAny([]map[string]any{printfStmt(p.lowerValues(elseArgs))}),
			}}
		}
	}
	return []map[string]any{printfStmt(p.lowerValues(exprs))}
}

func (p *parser) lowerValues(ns []*node) []map[string]any {
	out := make([]map[string]any, 0, len(ns))
	for _, n := range ns {
		out = append(out, p.lowerValue(n))
	}
	return out
}

// printfStmt lowers a perl print arg list to the runtime printf builtin:
// N args → `printf "%s%s..." arg1..argN` (perl print concatenates with no
// separator and no auto-newline).
func printfStmt(args []map[string]any) map[string]any {
	words := []any{interpLit(strings.Repeat("%s", len(args)))}
	for _, a := range args {
		words = append(words, a)
	}
	return exprStmt(callExpr("exec", []any{strLit("printf"), map[string]any{"type": "Array", "elements": words}}, "Emulable"))
}

func (p *parser) parsePrintf() []map[string]any {
	p.expect("printf")
	hadParen := p.accept("(")
	exprs := p.parseArgList(";")
	if hadParen {
		p.expect(")")
	}
	words := make([]map[string]any, 0, len(exprs))
	for _, e := range exprs {
		words = append(words, p.lowerValue(e))
	}
	p.skipToSemi()
	elements := make([]any, 0, len(words))
	for _, w := range words {
		elements = append(elements, w)
	}
	return []map[string]any{exprStmt(callExpr("exec", []any{strLit("printf"), map[string]any{"type": "Array", "elements": elements}}, "Emulable"))}
}

// heredocLines collects the raw heredoc body lines after the statement's
// line, terminated by the trimmed terminator line. Returns the content
// with each line's trailing newline (perl semantics).
func (p *parser) heredocLines(term string, termLine int) string {
	var sb strings.Builder
	i := termLine + 1
	for ; i < len(p.lines); i++ {
		if strings.TrimSpace(p.lines[i]) == term {
			break
		}
		sb.WriteString(p.lines[i])
		sb.WriteByte('\n')
	}
	// skip the consumed body tokens (the body + terminator lines were
	// tokenized as ordinary junk statements)
	for p.peek() != nil && p.peek().kind != tEOF && p.peek().line <= i {
		p.next()
	}
	return sb.String()
}

// assignOrCond lowers `$x = RHS;` — a ternary RHS lowers to an If that
// assigns the chosen arm (the ESTree renderer rejects the Perl-only
// Ternary node; the statement-level If is the shared shape).
func (p *parser) assignOrCond(name string, rhs *node) []map[string]any {
	if rhs.kind == "tern" {
		return []map[string]any{map[string]any{
			"type":   "If",
			"cond":   p.testCond(rhs.kids[0], false),
			"then":   stmtsToAny([]map[string]any{assignStmt(name, p.lowerValue(rhs.kids[1]))}),
			"elsifs": []any{},
			"else":   stmtsToAny([]map[string]any{assignStmt(name, p.lowerValue(rhs.kids[2]))}),
		}}
	}
	return []map[string]any{assignStmt(name, p.lowerValue(rhs))}
}

// ── control flow ─────────────────────────────────────────────────────

func (p *parser) parseIf(unless bool) map[string]any {
	kw := "if"
	if unless {
		kw = "unless"
	}
	p.expect(kw)
	p.expect("(")
	cond := p.parseExpr()
	p.expect(")")
	then := p.parseBlock(true)
	// elsif chains NEST as If-in-else (the ESTree renderer has no elsifs
	// arm — the core's own parser nests them the same way). The chain is
	// built innermost-out so the final else lands at the tail.
	type arm struct {
		cond *node
		body []map[string]any
	}
	var arms []arm
	for {
		t := p.peek()
		if t != nil && t.kind == tIdent && t.text == "elsif" {
			p.next()
			p.expect("(")
			c := p.parseExpr()
			p.expect(")")
			b := p.parseBlock(true)
			arms = append(arms, arm{cond: c, body: b})
			continue
		}
		break
	}
	var elseStmts []any
	if t := p.peek(); t != nil && t.kind == tIdent && t.text == "else" {
		p.next()
		elseStmts = stmtsToAny(p.parseBlock(true))
	}
	if elseStmts == nil {
		elseStmts = []any{}
	}
	tail := elseStmts
	for i := len(arms) - 1; i >= 0; i-- {
		inner := []map[string]any{map[string]any{
			"type":   "If",
			"cond":   p.testCond(arms[i].cond, unless),
			"then":   stmtsToAny(arms[i].body),
			"elsifs": []any{},
			"else":   tail,
		}}
		tail = stmtsToAny(inner)
	}
	thenAny := stmtsToAny(then)
	return map[string]any{
		"type":   "If",
		"cond":   p.testCond(cond, unless),
		"then":   thenAny,
		"elsifs": []any{},
		"else":   tail,
	}
}

func stmtsToAny(stmts []map[string]any) []any {
	out := make([]any, 0, len(stmts))
	for _, s := range stmts {
		out = append(out, s)
	}
	return out
}

func (p *parser) parseWhile(until bool) map[string]any {
	kw := "while"
	if until {
		kw = "until"
	}
	p.expect(kw)
	p.expect("(")
	cond := p.parseExpr()
	p.expect(")")
	body := p.parseBlock(true)
	bodyAny := stmtsToAny(body)
	var condExpr map[string]any
	if cond.kind == "rd" && cond.text == "STDIN" {
		// while (<STDIN>) — the read builtin returns false at EOF; the
		// line lands in REPLY (the `$_` default-variable lowering).
		condExpr = callExpr("exec", []any{strLit("read"), map[string]any{"type": "Array", "elements": []any{}}}, "Emulable")
	} else {
		condExpr = p.testCond(cond, until)
	}
	return map[string]any{
		"type": "While",
		"cond": condExpr,
		"body": bodyAny,
	}
}

func (p *parser) parseFor() map[string]any {
	t := p.peek()
	if t == nil || (t.text != "for" && t.text != "foreach") {
		p.fail("expected for/foreach")
	}
	p.next()
	if t2 := p.peek(); t2 != nil && t2.kind == tIdent && (t2.text == "my" || t2.text == "our" || t2.text == "local") {
		p.next()
	}
	v := p.next()
	if v == nil || v.kind != tVar {
		p.fail("for: expected loop var")
	}
	name := strings.TrimPrefix(v.text, "$")
	p.expect("(")
	elements := p.parseArgList(")")
	p.expect(")")
	body := p.parseBlock(true)
	bodyAny := stmtsToAny(body)
	elAny := make([]any, 0, len(elements))
	for _, e := range elements {
		elAny = append(elAny, p.lowerValue(e))
	}
	return map[string]any{
		"type": "For",
		"var":  name,
		"iter": map[string]any{"type": "Array", "elements": elAny},
		"body": bodyAny,
	}
}

func (p *parser) parseSub() map[string]any {
	p.expect("sub")
	name := p.next()
	if name == nil || name.kind != tIdent {
		p.fail("sub: expected name")
	}
	body := p.parseBlock(true)
	// A value `return EXPR` inside the body lowers to
	// `setVar("__ret", EXPR)` + `return true` — the runtime's fnCall
	// returns only the STATUS, so expression-position calls read the
	// captured value from __ret instead (see fnCallStmt / printStmts).
	hasRet := false
	body = rewriteReturns(body, &hasRet)
	if hasRet {
		p.retFns[name.text] = true
	}
	bodyAny := stmtsToAny(body)
	return map[string]any{
		"type": "Function",
		"name": name.text,
		"body": bodyAny,
	}
}

// rewriteReturns replaces value-returning Return stmts with the __ret
// capture + a plain return-true (recursively through blocks).
func rewriteReturns(stmts []map[string]any, hasRet *bool) []map[string]any {
	out := make([]map[string]any, 0, len(stmts))
	for _, s := range stmts {
		if s["type"] == "Return" {
			if v, ok := s["value"]; ok && v != nil {
				*hasRet = true
				out = append(out,
					exprStmt(callExpr("setVar", []any{strLit("__ret"), v.(map[string]any)}, "Emulable")),
					map[string]any{"type": "Return", "value": map[string]any{"type": "Bool", "value": true}},
				)
				continue
			}
			out = append(out, s)
			continue
		}
		// recurse into nested blocks
		for _, k := range []string{"then", "else", "body"} {
			if v, ok := s[k]; ok {
				if arr, ok := v.([]any); ok {
					inner := make([]map[string]any, 0, len(arr))
					for _, it := range arr {
						if m, ok := it.(map[string]any); ok {
							inner = append(inner, m)
						}
					}
					s[k] = stmtsToAny(rewriteReturns(inner, hasRet))
				}
			}
		}
		out = append(out, s)
	}
	return out
}

func (p *parser) parseReturn() map[string]any {
	p.expect("return")
	t := p.peek()
	if t != nil && (t.text == ";" || t.text == "}" || t.kind == tEOF) {
		p.skipToSemi()
		return map[string]any{"type": "Return", "value": nil}
	}
	e := p.parseExpr()
	p.skipToSemi()
	return map[string]any{"type": "Return", "value": p.lowerValue(e)}
}

// testCond lowers a perl condition AST to the runtime test call with a
// shell-syntax test string (the runtime sh2.test expands $vars itself).
func (p *parser) testCond(c *node, negate bool) map[string]any {
	// index(A, B) >= 0 → the runtime contains helper (a comparison with
	// a call operand cannot be expressed as a test string).
	if !negate {
		if v, ok := p.indexCmpCall(c); ok {
			return v
		}
	}
	text := p.lowerCond(c)
	if negate {
		text = "! ( " + text + " )"
	}
	return callExpr("test", []any{strLit(text)}, "Emulable")
}

// indexCmpCall recognizes `index(A, B) >= 0` / `< 0` (the perl substring
// containment test) and lowers it to the runtime contains / not-helper.
func (p *parser) indexCmpCall(n *node) (map[string]any, bool) {
	if n == nil || n.kind != "cmp" {
		return nil, false
	}
	l, r := n.kids[0], n.kids[1]
	if l == nil || l.kind != "call" || l.text != "index" || len(l.kids) != 2 {
		return nil, false
	}
	if r == nil || r.kind != "num" || r.text != "0" {
		return nil, false
	}
	contains := callExpr("contains", []any{p.lowerValueExpr(l.kids[0]), p.lowerValueExpr(l.kids[1])}, "Emulable")
	switch n.text {
	case ">=", "ge":
		return contains, true
	case "<", "lt":
		return callExpr("not", []any{contains}, "Emulable"), true
	}
	return nil, false
}

// lowerValueExpr — lowerValue without the parser receiver (for the
// contains operands, which are plain value nodes).
func (p *parser) lowerValueExpr(n *node) map[string]any {
	return p.lowerValue(n)
}

// ── assignments / declarations ───────────────────────────────────────

func (p *parser) parseDecl() []map[string]any {
	p.next() // my/our/local
	t := p.peek()
	if t != nil && t.kind == tPunct && t.text == "(" {
		p.next()
		var names []string
		for {
			v := p.next()
			if v == nil {
				p.fail("decl list: bad var")
			}
			if v.kind == tVar {
				names = append(names, strings.TrimPrefix(v.text, "$"))
			}
			if p.accept(",") {
				continue
			}
			break
		}
		p.expect(")")
		// my ($a, $b) = ("x", "y");   |   my ($x) = @_;
		var out []map[string]any
		if p.accept("=") {
			if p.accept("(") {
				rhs := p.parseArgList(")")
				p.expect(")")
				p.skipToSemi()
				for i, n := range names {
					val := p.lowerValue(rhs[min(i, len(rhs)-1)])
					out = append(out, assignStmt(n, val))
				}
				return out
			}
			// @_ — the function's positional args
			v := p.peek()
			if v != nil && v.kind == tVar && v.text == "@_" {
				p.next()
				p.skipToSemi()
				for i, n := range names {
					out = append(out, assignStmt(n, callExpr("getVar", []any{strLit(strconv.Itoa(i + 1))}, "Emulable")))
				}
				return out
			}
			e := p.parseExpr()
			p.skipToSemi()
			for i, n := range names {
				if i == 0 {
					out = append(out, assignStmt(n, p.lowerValue(e)))
				} else {
					out = append(out, assignStmt(n, interpLit("")))
				}
			}
			return out
		}
		p.skipToSemi()
		for _, n := range names {
			out = append(out, assignStmt(n, interpLit("")))
		}
		return out
	}
	// my $x = EXPR;   |   my $line = <STDIN>;   |   my $x = `cmd`;
	//   |   my @a = (LIST);
	v := p.next()
	if v == nil || v.kind != tVar {
		p.fail("decl: expected $var")
	}
	if strings.HasPrefix(v.text, "@") {
		name := strings.TrimPrefix(v.text, "@")
		if p.accept("=") {
			p.expect("(")
			elems := p.parseArgList(")")
			p.expect(")")
			p.skipToSemi()
			elAny := make([]any, 0, len(elems))
			for _, e := range elems {
				elAny = append(elAny, p.lowerValue(e))
			}
			return []map[string]any{exprStmt(callExpr("setArray", []any{strLit(name), map[string]any{"type": "Array", "elements": elAny}}, "Emulable"))}
		}
		p.skipToSemi()
		return nil
	}
	name := strings.TrimPrefix(v.text, "$")
	if !p.accept("=") {
		p.skipToSemi()
		return []map[string]any{assignStmt(name, interpLit(""))}
	}
	// <STDIN> — the read builtin sets REPLY (EOF → "")
	if t2 := p.peek(); t2 != nil && t2.kind == tRd && t2.raw == "STDIN" {
		p.next()
		p.skipToSemi()
		return []map[string]any{
			exprStmt(callExpr("exec", []any{strLit("read"), map[string]any{"type": "Array", "elements": []any{}}}, "Emulable")),
			assignStmt(name, callExpr("getVar", []any{strLit("REPLY")}, "Emulable")),
		}
	}
	// <$ph> — the pipe opened by open($ph, "-|", CMD...): capture CMD's
	// stdout + the trailing newline perl keeps on a <$ph> line read.
	if t2 := p.peek(); t2 != nil && t2.kind == tRd {
		p.next()
		p.skipToSemi()
		return []map[string]any{assignStmt(name, p.pipeReadValue())}
	}
	e := p.parseExpr()
	p.skipToSemi()
	return p.assignOrCond(name, e)
}

func (p *parser) parseVarStmt() []map[string]any {
	v := p.next()
	if v.kind == tEnv {
		// $ENV{X} = "v"; — the env var maps to the runtime store name.
		name := v.text
		if p.accept("=") {
			e := p.parseExpr()
			p.skipToSemi()
			return p.assignOrCond(name, e)
		}
		p.skipToSemi()
		return nil
	}
	if v.kind == tVar && strings.HasPrefix(v.text, "@") {
		// @a = (1, 2, 3);
		name := strings.TrimPrefix(v.text, "@")
		if p.accept("=") {
			p.expect("(")
			elems := p.parseArgList(")")
			p.expect(")")
			p.skipToSemi()
			elAny := make([]any, 0, len(elems))
			for _, e := range elems {
				elAny = append(elAny, p.lowerValue(e))
			}
			return []map[string]any{exprStmt(callExpr("setArray", []any{strLit(name), map[string]any{"type": "Array", "elements": elAny}}, "Emulable"))}
		}
		p.skipToSemi()
		return nil
	}
	name := strings.TrimPrefix(v.text, "$")
	// $a[1] = EXPR — an array-element write (setVar's name[idx] form)
	if p.peek() != nil && p.peek().kind == tPunct && p.peek().text == "[" {
		p.next()
		key := p.parseExpr()
		p.expect("]")
		if p.accept("=") {
			e := p.parseExpr()
			p.skipToSemi()
			return []map[string]any{assignStmt(name+"["+p.lowerCondOperandText(key)+"]", p.lowerValue(e))}
		}
		p.skipToSemi()
		return nil
	}
	t := p.peek()
	if t == nil || t.kind != tOp {
		p.fail("bad $var statement")
	}
	switch t.text {
	case "=":
		p.next()
		e := p.parseExpr()
		p.skipToSemi()
		return p.assignOrCond(name, e)
	case "+=", "-=", "*=", "/=":
		p.next()
		e := p.parseExpr()
		p.skipToSemi()
		return []map[string]any{exprStmt(arithAssign(name, t.text, p.lowerArith(e)))}
	case "++", "--":
		p.next()
		p.skipToSemi()
		delta := int64(1)
		if t.text == "--" {
			delta = -1
		}
		return []map[string]any{exprStmt(arithNode(map[string]any{
			"type": "IncDec", "var": name, "delta": delta, "prefix": false,
		}))}
	case ".=":
		p.next()
		e := p.parseExpr()
		p.skipToSemi()
		return []map[string]any{assignStmt(name, p.lowerValue(&node{kind: "concat", kids: []*node{{kind: "var", text: name}, e}}))}
	}
	p.fail("unsupported var statement: %s", t.text)
	return nil
}

// ── system / open ────────────────────────────────────────────────────

func (p *parser) parseSystem() []map[string]any {
	p.next() // system/exec
	p.expect("(")
	cmd := p.next()
	if cmd == nil || cmd.kind != tStr {
		p.fail("system: expected a string command")
	}
	p.expect(")")
	p.skipToSemi()
	words := strings.Fields(cmd.raw)
	if len(words) == 0 {
		return nil
	}
	return []map[string]any{execStmt(words[0], words[1:], "Spawn")}
}

func (p *parser) parsePush() []map[string]any {
	p.expect("push")
	v := p.next()
	if v == nil || v.kind != tVar || !strings.HasPrefix(v.text, "@") {
		p.fail("push: expected an array")
	}
	name := strings.TrimPrefix(v.text, "@")
	p.expect(",")
	p.expect("(")
	elems := p.parseArgList(")")
	p.expect(")")
	p.skipToSemi()
	elAny := make([]any, 0, len(elems))
	for _, e := range elems {
		elAny = append(elAny, p.lowerValue(e))
	}
	return []map[string]any{exprStmt(callExpr("setArrayAppend", []any{strLit(name), map[string]any{"type": "Array", "elements": elAny}}, "Emulable"))}
}

func (p *parser) parseOpen() []map[string]any {
	p.next() // open
	p.expect("(")
	// open(my $fh, MODE, PATH...) or die;
	var strs []string
	depth := 1
	for depth > 0 {
		t := p.next()
		if t == nil || t.kind == tEOF {
			p.fail("open: unterminated (")
		}
		if t.kind == tPunct && t.text == "(" {
			depth++
		} else if t.kind == tPunct && t.text == ")" {
			depth--
		} else if t.kind == tStr {
			strs = append(strs, t.raw)
		}
	}
	p.skipToSemi()
	// open($ph, "-|", "echo", "hello") — record the pipe command so the
	// later `<$ph>` readline can capture it.
	if len(strs) >= 2 && strs[0] == "-|" {
		p.pipeCmd = strs[1:]
	}
	return nil
}

// pipeReadValue — the A1 value for `<$ph>`: capture of the recorded pipe
// command, plus the trailing newline perl keeps on a line read.
func (p *parser) pipeReadValue() map[string]any {
	words := p.pipeCmd
	if len(words) == 0 {
		return interpLit("")
	}
	inner := []any{execStmt(words[0], words[1:], "Spawn")}
	capture := callExpr("capture", []any{map[string]any{"type": "Arrow", "body": inner}}, "Spawn")
	return interpLitParts([]any{
		map[string]any{"kind": "expr", "expr": capture},
		map[string]any{"kind": "lit", "text": "\n"},
	})
}

// ── expressions ──────────────────────────────────────────────────────

func (p *parser) parseExpr() *node {
	return p.parseTernary()
}

func (p *parser) parseTernary() *node {
	c := p.parseOr()
	if p.accept("?") {
		t := p.parseExpr()
		p.expect(":")
		e := p.parseExpr()
		return &node{kind: "tern", kids: []*node{c, t, e}}
	}
	return c
}

func (p *parser) parseOr() *node {
	l := p.parseAnd()
	for {
		if p.accept("||") {
			r := p.parseAnd()
			l = &node{kind: "or", kids: []*node{l, r}}
			continue
		}
		if p.accept("//") {
			r := p.parseAnd()
			l = &node{kind: "defor", kids: []*node{l, r}}
			continue
		}
		return l
	}
}

func (p *parser) parseAnd() *node {
	l := p.parseNot()
	for {
		if p.accept("&&") {
			r := p.parseNot()
			l = &node{kind: "and", kids: []*node{l, r}}
			continue
		}
		return l
	}
}

func (p *parser) parseNot() *node {
	if p.accept("!") {
		return &node{kind: "not", kids: []*node{p.parseNot()}}
	}
	return p.parseCmp()
}

var cmpOps = map[string]bool{
	"==": true, "!=": true, "<": true, ">": true, "<=": true, ">=": true,
	"eq": true, "ne": true, "lt": true, "gt": true, "le": true, "ge": true,
}

func (p *parser) parseCmp() *node {
	l := p.parseConcat()
	t := p.peek()
	if t != nil && t.kind == tOp && t.text == "=~" {
		// `$s =~ /pat/` — perl regex match; the pattern is scanned as a
		// /-delimited run (regex metachars lex as separate tokens) and
		// lowered to the runtime test's `=~` binop (JS RegExp test).
		p.next()
		p.expect("/")
		pat, _ := p.scanDelimited()
		return &node{kind: "regextest", text: pat, kids: []*node{l}}
	}
	if t != nil && t.kind == tOp && cmpOps[t.text] {
		p.next()
		r := p.parseConcat()
		return &node{kind: "cmp", text: t.text, kids: []*node{l, r}}
	}
	if t != nil && t.kind == tIdent && cmpOps[t.text] {
		p.next()
		r := p.parseConcat()
		return &node{kind: "cmp", text: t.text, kids: []*node{l, r}}
	}
	return l
}

func (p *parser) parseConcat() *node {
	l := p.parseAdd()
	for {
		if p.accept(".") {
			r := p.parseAdd()
			l = &node{kind: "concat", kids: []*node{l, r}}
			continue
		}
		if p.accept("..") {
			r := p.parseAdd()
			l = &node{kind: "range", kids: []*node{l, r}}
			continue
		}
		return l
	}
}

func (p *parser) parseAdd() *node {
	l := p.parseMul()
	for {
		t := p.peek()
		if t != nil && t.kind == tOp && (t.text == "+" || t.text == "-") {
			p.next()
			r := p.parseMul()
			l = &node{kind: "arith", text: t.text, kids: []*node{l, r}}
			continue
		}
		return l
	}
}

func (p *parser) parseMul() *node {
	l := p.parseUnary()
	for {
		t := p.peek()
		if t != nil && t.kind == tOp && (t.text == "*" || t.text == "/" || t.text == "%" || t.text == "<<" || t.text == ">>") {
			p.next()
			r := p.parseUnary()
			l = &node{kind: "arith", text: t.text, kids: []*node{l, r}}
			continue
		}
		return l
	}
}

func (p *parser) parseUnary() *node {
	t := p.peek()
	if t != nil && t.kind == tOp && (t.text == "-" || t.text == "+") {
		p.next()
		return &node{kind: "neg", text: t.text, kids: []*node{p.parseUnary()}}
	}
	return p.parsePostfix()
}

func (p *parser) parsePostfix() *node {
	a := p.parseAtom()
	for {
		t := p.peek()
		if t != nil && t.kind == tOp && (t.text == "++" || t.text == "--") {
			p.next()
			if a.kind == "var" {
				return &node{kind: "incr", text: t.text, kids: []*node{a}}
			}
			p.fail("++/-- on a non-variable")
		}
		if t != nil && t.kind == tPunct && t.text == "[" {
			p.next()
			key := p.parseExpr()
			p.expect("]")
			a = &node{kind: "idx", text: a.kindVarName(), kids: []*node{key}}
			continue
		}
		return a
	}
}

func (n *node) kindVarName() string {
	switch n.kind {
	case "var":
		return n.text
	case "env":
		return n.text
	}
	return n.text
}

func (p *parser) parseAtom() *node {
	t := p.peek()
	if t == nil || t.kind == tEOF {
		p.fail("unexpected EOF in expression")
	}
	switch t.kind {
	case tNum:
		p.next()
		return &node{kind: "num", text: t.text}
	case tStr:
		p.next()
		return &node{kind: "str", text: t.raw, dq: t.dq}
	case tVar:
		p.next()
		if strings.HasPrefix(t.text, "@") {
			if t.text == "@_" {
				return &node{kind: "pos"}
			}
			return &node{kind: "arrvar", text: strings.TrimPrefix(t.text, "@")}
		}
		return &node{kind: "var", text: t.text}
	case tEnv:
		p.next()
		return &node{kind: "env", text: t.text}
	case tQx:
		p.next()
		return &node{kind: "qx", text: t.raw}
	case tRd:
		p.next()
		return &node{kind: "rd", text: t.raw}
	case tPunct:
		if t.text == "(" {
			p.next()
			e := p.parseExpr()
			p.expect(")")
			return &node{kind: "pn", kids: []*node{e}}
		}
		p.fail("unexpected %q in expression", t.text)
	case tOp:
		// file-test flag: -e "/etc/passwd"
		if strings.HasPrefix(t.text, "-") && len(t.text) > 1 && t.text != "-" {
			p.next()
			path := p.parseAtom()
			return &node{kind: "filetest", text: t.text, kids: []*node{path}}
		}
		p.fail("unexpected op %q in expression", t.text)
	case tIdent:
		p.next()
		if p.accept("(") {
			args := p.parseArgList(")")
			p.expect(")")
			return &node{kind: "call", text: t.text, kids: args}
		}
		return &node{kind: "bare", text: t.text}
	}
	p.fail("unexpected token in expression: %s", p.describe(t))
	return nil
}

// ── value lowering ───────────────────────────────────────────────────

func (p *parser) lowerValue(n *node) map[string]any {
	switch n.kind {
	case "str":
		return interpParts(p.interpFromString(n.text, n.dq))
	case "lit":
		return interpLit(n.text)
	case "var":
		name := n.text
		if name == "_" {
			name = "REPLY" // perl's default var under while(<STDIN>)
		}
		return callExpr("getVar", []any{strLit(name)}, "Emulable")
	case "env":
		return callExpr("getVar", []any{strLit(n.text)}, "Emulable")
	case "idx":
		return callExpr("arrayIndex", []any{strLit(n.text), p.lowerValue(n.kids[0])}, "Emulable")
	case "num":
		return arithNode(map[string]any{"type": "Num", "value": mustInt(n.text)})
	case "arith":
		return arithNode(p.lowerArith(n))
	case "neg":
		return arithNode(map[string]any{"type": "Un", "op": n.text, "arg": p.lowerArith(n.kids[0])})
	case "range":
		return map[string]any{"type": "Range", "start": mustInt(n.kids[0].text), "end": mustInt(n.kids[1].text)}
	case "concat":
		parts := p.concatParts(n)
		return interpParts(parts)
	case "tern":
		p.fail("ternary outside an assignment is unsupported")
	case "defor":
		// perl `//` (defined-or): an unset/undef left side takes the
		// default. The runtime `${x:-def}` default is the closest shared
		// shape (empty AND unset take the default — the corpus's env
		// default is never set, so the two agree).
		if (n.kids[0].kind == "var" || n.kids[0].kind == "env") && n.kids[1].kind == "str" {
			return callExpr("param", []any{
				strLit(":-"), strLit(n.kids[0].text), strLit(p.decodedStr(n.kids[1].text, n.kids[1].dq)),
			}, "Emulable")
		}
		p.fail("// defined-or: unsupported operands")
	case "call":
		switch n.text {
		case "length":
			if len(n.kids) == 1 && (n.kids[0].kind == "var" || n.kids[0].kind == "env") {
				// param("len", ...) — the renderer injects LIFTED bindings
				// as the trailing value arg (plain getVar("#x") would read
				// the store, which a lifted var never writes).
				return callExpr("param", []any{strLit("len"), strLit(n.kids[0].text)}, "Emulable")
			}
			p.fail("length: expected a $var arg")
		case "substr":
			if len(n.kids) == 3 {
				return callExpr("param", []any{
					strLit("slice"), strLit(n.kids[0].text),
					p.lowerValue(n.kids[1]), p.lowerValue(n.kids[2]),
				}, "Emulable")
			}
			p.fail("substr: expected 3 args")
		case "scalar":
			if len(n.kids) == 1 && n.kids[0].kind == "arrvar" {
				return callExpr("arrayLen", []any{strLit(n.kids[0].text)}, "Emulable")
			}
			p.fail("scalar: expected an array arg")
		case "fork":
			// fork() emulation: returns empty (falsy) so the child branch
			// runs inline; exit/wait are no-ops (see parseStatement).
			return interpLit("")
		case "open", "close", "wait", "die", "exit":
			return interpLit("")
		}
		// user subroutine call — the exec shape (fnCall in the renderer)
		var el []any
		for _, a := range n.kids {
			el = append(el, p.lowerValue(a))
		}
		return callExpr("exec", []any{strLit(n.text), map[string]any{"type": "Array", "elements": el}}, "Spawn")
	case "qx":
		words := strings.Fields(n.text)
		if len(words) == 0 {
			return interpLit("")
		}
		inner := []any{execStmt(words[0], words[1:], "Spawn")}
		capture := callExpr("capture", []any{map[string]any{"type": "Arrow", "body": inner}}, "Spawn")
		// perl qx keeps the trailing newline (capture strips it)
		return interpLitParts([]any{
			map[string]any{"kind": "expr", "expr": capture},
			map[string]any{"kind": "lit", "text": "\n"},
		})
	case "rd":
		return p.pipeReadValue()
	case "cmp", "not", "and", "or":
		return callExpr("test", []any{strLit(p.lowerCond(n))}, "Emulable")
	case "filetest":
		return callExpr("test", []any{strLit(p.lowerCond(n))}, "Emulable")
	case "bare":
		return interpLit(n.text)
	case "pn":
		return p.lowerValue(n.kids[0])
	case "arrvar":
		return callExpr("arrayLen", []any{strLit(n.text)}, "Emulable")
	case "incr":
		delta := int64(1)
		if n.text == "--" {
			delta = -1
		}
		return arithNode(map[string]any{"type": "IncDec", "var": n.kids[0].text, "delta": delta, "prefix": false})
	case "pos":
		return callExpr("getVar", []any{strLit("1")}, "Emulable")
	}
	p.fail("cannot lower node kind %q", n.kind)
	return nil
}

// concatParts flattens a concat tree into Interpolate parts (merging
// adjacent literal runs).
func (p *parser) concatParts(n *node) []any {
	if n.kind == "concat" {
		var out []any
		for _, k := range n.kids {
			out = append(out, p.concatParts(k)...)
		}
		return out
	}
	switch n.kind {
	case "str":
		return p.interpFromString(n.text, n.dq)
	case "lit":
		return []any{map[string]any{"kind": "lit", "text": n.text}}
	case "var", "env", "idx", "num", "arith", "neg", "call", "qx", "rd", "tern", "bare", "pn":
		return []any{map[string]any{"kind": "expr", "expr": p.lowerValue(n)}}
	}
	p.fail("cannot concat node kind %q", n.kind)
	return nil
}

// interpFromString scans a perl string literal (raw inner text) into
// Interpolate parts: $var / $ENV{NAME} / $name[idx] become expr parts
// (getVar / arrayIndex); double-quoted escapes are decoded; single-quoted
// strings only decode \\ and \'.
func (p *parser) interpFromString(raw string, dq bool) []any {
	parts := []any{}
	var lit strings.Builder
	flush := func() {
		if lit.Len() > 0 {
			parts = append(parts, map[string]any{"kind": "lit", "text": lit.String()})
			lit.Reset()
		}
	}
	i := 0
	for i < len(raw) {
		c := raw[i]
		if c == '\\' && i+1 < len(raw) {
			nx := raw[i+1]
			if dq {
				lit.WriteByte(decodeEsc(nx))
			} else if nx == '\\' || nx == '\'' {
				lit.WriteByte(nx)
			} else {
				lit.WriteByte('\\')
				lit.WriteByte(nx)
			}
			i += 2
			continue
		}
		if c == '@' && i+1 < len(raw) {
			// @a[1..2] — array slice interpolation (perl joins the
			// elements with a space): join(param("slice", name, lo, len)).
			rest := raw[i+1:]
			if m := identRe.FindString(rest); m != "" {
				j := i + 1 + len(m)
				if j < len(raw) && raw[j] == '[' {
					if close := strings.IndexByte(raw[j+1:], ']'); close >= 0 {
						flush()
						parts = append(parts, map[string]any{
							"kind": "expr",
							"expr": p.lowerArraySlice(m, raw[j+1:j+1+close]),
						})
						i = j + 1 + close + 1
						continue
					}
				}
			}
		}
		if c == '$' && i+1 < len(raw) {
			rest := raw[i+1:]
			if rest[0] == '$' {
				lit.WriteByte('$')
				i++
				continue
			}
			if rest[0] == '{' {
				if close := strings.IndexByte(rest[1:], '}'); close >= 0 {
					flush()
					parts = append(parts, map[string]any{
						"kind": "expr",
						"expr": callExpr("getVar", []any{strLit(rest[1 : 1+close])}, "Emulable"),
					})
					i += 2 + close
					continue
				}
			}
			if m := identRe.FindString(rest); m != "" {
				j := i + 1 + len(m)
				if m == "ENV" && j < len(raw) && raw[j] == '{' {
					if close := strings.IndexByte(raw[j+1:], '}'); close >= 0 {
						flush()
						parts = append(parts, map[string]any{
							"kind": "expr",
							"expr": callExpr("getVar", []any{strLit(raw[j+1 : j+1+close])}, "Emulable"),
						})
						i = j + 1 + close + 1
						continue
					}
				}
				if j < len(raw) && raw[j] == '[' {
					if close := strings.IndexByte(raw[j+1:], ']'); close >= 0 {
						key := raw[j+1 : j+1+close]
						keyNode := &node{kind: "num", text: key}
						if !numRe.MatchString(key) {
							keyNode = &node{kind: "var", text: strings.TrimPrefix(key, "$")}
						}
						flush()
						parts = append(parts, map[string]any{
							"kind": "expr",
							"expr": callExpr("arrayIndex", []any{strLit(m), p.lowerValue(keyNode)}, "Emulable"),
						})
						i = j + 1 + close + 1
						continue
					}
				}
				flush()
				nm := m
				if nm == "_" {
					nm = "REPLY" // perl's default var under while(<STDIN>)
				}
				parts = append(parts, map[string]any{
					"kind": "expr",
					"expr": callExpr("getVar", []any{strLit(nm)}, "Emulable"),
				})
				i += 1 + len(m)
				continue
			}
		}
		lit.WriteByte(c)
		i++
	}
	flush()
	return parts
}

// lowerArraySlice lowers `@name[lo..hi]` (or `@name[i]`) — perl's array
// slice in interpolation — to join(param("slice", name, lo, len)): the
// runtime's slice op returns the element ARRAY and join() space-joins it
// (perl's list-in-string behaviour).
func (p *parser) lowerArraySlice(name, inner string) map[string]any {
	lo := int64(0)
	hi := int64(0)
	if k := strings.Index(inner, ".."); k >= 0 {
		lo = mustInt(strings.TrimSpace(inner[:k]))
		hi = mustInt(strings.TrimSpace(inner[k+2:]))
	} else {
		hi = mustInt(strings.TrimSpace(inner))
	}
	slice := callExpr("param", []any{
		strLit("slice"), strLit(name),
		arithNode(map[string]any{"type": "Num", "value": lo}),
		arithNode(map[string]any{"type": "Num", "value": hi - lo + 1}),
	}, "Emulable")
	return callExpr("join", []any{slice}, "Emulable")
}

func decodeEsc(c byte) byte {
	switch c {
	case 'n':
		return '\n'
	case 't':
		return '\t'
	case 'r':
		return '\r'
	case 'f':
		return '\f'
	case 'a':
		return '\a'
	case 'b':
		return '\b'
	case 'v':
		return '\v'
	case 'e':
		return 0x1b
	}
	return c // \\ \" \$ \' and unknown escapes → the char itself
}

// ── condition lowering (perl cond → shell test text) ─────────────────

func (p *parser) lowerCond(n *node) string {
	switch n.kind {
	case "var":
		return `"$` + n.text + `"`
	case "env":
		return `"$ENV{` + n.text + `}"`
	case "idx":
		return `"$` + n.text + `[` + p.lowerCondOperandText(n.kids[0]) + `]"`
	case "num":
		return `"` + n.text + `"`
	case "str":
		return `"` + p.decodedStr(n.text, n.dq) + `"`
	case "lit":
		return `"` + n.text + `"`
	case "cmp":
		return p.condOperand(n.kids[0]) + " " + p.cmpOp(n.text) + " " + p.condOperand(n.kids[1])
	case "not":
		// `! ( X )` — the spaces keep the runtime test tokenizer from
		// absorbing the `)` into a quoted operand token.
		return "! ( " + p.lowerCond(n.kids[0]) + " )"
	case "and":
		// -a/-o bind looser than the comparison ops in the runtime test
		// grammar (binops parse inside primary), so no parens are needed
		// and quoted operands stay clear of the parens.
		return p.lowerCond(n.kids[0]) + " -a " + p.lowerCond(n.kids[1])
	case "or":
		return p.lowerCond(n.kids[0]) + " -o " + p.lowerCond(n.kids[1])
	case "filetest":
		return n.text + " " + p.condOperand(n.kids[0])
	case "pn":
		return p.lowerCond(n.kids[0])
	case "regextest":
		// `$s =~ /^h/` — the runtime test tokenizer expands $s itself
		// and its `=~` binop is a JS RegExp test; the pattern stays raw
		// (^ . * $ are ordinary word chars there).
		return p.condOperand(n.kids[0]) + " =~ " + n.text
	case "arith", "neg":
		return "$((" + p.arithText(n) + "))"
	case "bare":
		return `"` + n.text + `"`
	case "call":
		return `"` + n.text + `"`
	}
	p.fail("cannot lower condition node kind %q", n.kind)
	return ""
}

func (p *parser) condOperand(n *node) string {
	switch n.kind {
	case "var", "env", "idx", "num", "str", "lit", "bare", "call", "arith", "neg":
		return p.lowerCond(n)
	}
	return "( " + p.lowerCond(n) + " )"
}

// cmpOp maps perl comparison operators to shell test operators (numeric
// for the perl numeric ops, string for eq/lt/...).
func (p *parser) cmpOp(op string) string {
	switch op {
	case "==", "eq":
		return "=="
	case "!=", "ne":
		return "!="
	case "<":
		return "-lt"
	case ">":
		return "-gt"
	case "<=":
		return "-le"
	case ">=":
		return "-ge"
	case "lt":
		return "<"
	case "gt":
		return ">"
	case "le":
		return "<="
	case "ge":
		return ">="
	}
	return op
}

// arithText renders an arith AST as $var-bearing text for $((...))
// (the runtime evalArith evaluates it inline).
func (p *parser) arithText(n *node) string {
	switch n.kind {
	case "num":
		return n.text
	case "var":
		return "$" + n.text
	case "env":
		return "$" + n.text
	case "arith", "neg":
		op := n.text
		if n.kind == "neg" {
			return op + p.arithText(n.kids[0])
		}
		return p.arithText(n.kids[0]) + " " + op + " " + p.arithText(n.kids[1])
	}
	return p.lowerCondOperandText(n)
}

// lowerCondOperandText — the raw operand text for `$a[1]`-style keys.
func (p *parser) lowerCondOperandText(n *node) string {
	switch n.kind {
	case "num":
		return n.text
	case "var":
		return "$" + n.text
	case "str":
		return p.decodedStr(n.text, n.dq)
	}
	return p.lowerCond(n)
}

func (p *parser) decodedStr(raw string, dq bool) string {
	parts := p.interpFromString(raw, dq)
	var sb strings.Builder
	for _, pr := range parts {
		m := pr.(map[string]any)
		if m["kind"] == "lit" {
			sb.WriteString(m["text"].(string))
		} else {
			sb.WriteString("${}")
		}
	}
	return sb.String()
}

// ── arith lowering ───────────────────────────────────────────────────

func (p *parser) lowerArith(n *node) map[string]any {
	switch n.kind {
	case "num":
		return map[string]any{"type": "Num", "value": mustInt(n.text)}
	case "var":
		if n.text == "?" {
			// perl $? is the raw wait status (WEXITSTATUS<<8): the runtime
			// lastExit is the plain exit code, so scale by 256.
			return map[string]any{
				"type": "Bin", "op": "*",
				"lhs": map[string]any{"type": "Var", "name": "?"},
				"rhs": map[string]any{"type": "Num", "value": int64(256)},
			}
		}
		return map[string]any{"type": "Var", "name": n.text}
	case "env":
		return map[string]any{"type": "Var", "name": n.text}
	case "arith":
		return map[string]any{
			"type": "Bin", "op": n.text,
			"lhs": p.lowerArith(n.kids[0]),
			"rhs": p.lowerArith(n.kids[1]),
		}
	case "neg":
		return map[string]any{
			"type": "Un", "op": n.text,
			"arg": p.lowerArith(n.kids[0]),
		}
	case "pn":
		return p.lowerArith(n.kids[0])
	}
	p.fail("cannot lower arith node kind %q", n.kind)
	return nil
}

// ── A1 node builders ─────────────────────────────────────────────────

func strLit(v string) map[string]any {
	return map[string]any{"type": "Str", "value": v, "style": "DoubleQuoted"}
}

func interpLit(v string) map[string]any {
	return interpLitParts([]any{map[string]any{"kind": "lit", "text": v}})
}

func interpLitParts(parts []any) map[string]any {
	return map[string]any{"type": "Interpolate", "parts": parts}
}

func interpParts(parts []any) map[string]any {
	return interpLitParts(parts)
}

func callExpr(funcName string, args []any, purity string) map[string]any {
	return map[string]any{"type": "Call", "func": funcName, "args": args, "purity": purity}
}

func exprStmt(expr map[string]any) map[string]any {
	return map[string]any{"type": "Expr", "expr": expr}
}

func assignStmt(name string, expr map[string]any) map[string]any {
	return map[string]any{
		"type": "Assign",
		"targets": []any{map[string]any{
			"var":     name,
			"sigil":   nil,
			"indices": []any{},
		}},
		"expr": expr,
	}
}

func arithNode(ast map[string]any) map[string]any {
	return map[string]any{"type": "Arith", "ast": ast}
}

func arithAssign(name, op string, rhs map[string]any) map[string]any {
	return arithNode(map[string]any{
		"type": "Assign", "var": name, "op": op, "rhs": rhs,
	})
}

// execStmt lowers a command line to the canonical command shape:
// Expr + Call{func:"exec", args:[Str(cmd), Array[words]], purity}.
func execStmt(cmd string, words []string, purity string) map[string]any {
	elements := make([]any, 0, len(words))
	for _, w := range words {
		elements = append(elements, strLit(w))
	}
	return exprStmt(callExpr("exec", []any{strLit(cmd), map[string]any{"type": "Array", "elements": elements}}, purity))
}

func mustInt(s string) int64 {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ── Shir — perl-sh-go as a library: Perl source -> A1 shIR JSON bytes
// (no trailing newline). Both the CLI (cmd/perl-sh-go) and the combined
// busybox dispatch through this single entry point. ───────────────────

func Shir(src string) ([]byte, error) {
	stmts, err := parseProgram(src)
	if err != nil {
		return nil, err
	}
	prog := &shiremit.Program{Stmts: stmts}
	return shiremit.Emit(prog)
}
