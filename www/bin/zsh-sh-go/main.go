// zsh-sh-go: zsh source -> shIR JSON (A1 contract), ANTLR4+Go.
//
// WORKER REWRITE (2026-08-06): the hand-rolled stub parser is replaced by a
// faithful port of the core's shell frontend (sh2perl/src/parser/* +
// src/shir.rs lowering + src/ir.rs optimize_stmts + A2 var-type analysis).
// The emitted JSON must be BYTE-IDENTICAL to `debashc --shir FILE --raw`
// (optimized lowering + A2 annotations, no trailing newline). The core is
// the source of truth: every rule below mirrors a specific core function.
package zshlib

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────
// Words (mirror ast_words.rs Word / StringPart)
// ─────────────────────────────────────────────────────────────────────

type Word struct {
	Kind string // "lit" "interp" "var" "pe" "arith" "cs" "array" "mapaccess" "mapkeys" "maplen" "arrayslice" "brace"
	// lit
	Text   string
	Quoted bool // single-quoted origin (ann == Some) — suppresses GLOB tag
	// interp
	Parts []Part
	// var
	VarName string
	// pe
	PEOp    string
	PEVar   string
	PEExtra []string
	// arith / cs
	Raw   string
	CSCmd *Command // pre-parsed single command (backtick substitutions)
	// array
	ArrayName  string
	ArrayElems []string
	// map access
	MapName string
	MapKey  string
	// array slice
	SliceOff string
	SliceLen *string
	// brace
	BracePrefix string
	BraceItems  []BraceItem
	BraceSuffix string
}

type BraceItem struct {
	IsRange bool
	Text    string
	Start   string
	End     string
	Step    *string
	Nested  []BraceItem
}

type Part struct {
	IsLit    bool
	Lit      string
	Var      string
	PE       *Word // pe shape (Kind=="pe")
	CSRaw    string
	CSCmd    *Command // pre-parsed single command (DQ backtick parts)
	ArithRaw string
	MapName  string
	MapKey   string
	MapKind  string // "access" "keys" "len" "slice"
	SliceOff string
	SliceLen *string
}

// ─────────────────────────────────────────────────────────────────────
// AST commands (mirror ast.rs Command)
// ─────────────────────────────────────────────────────────────────────

type EnvVar struct {
	Name string
	Val  *Word
}

type Redirect struct {
	FD     *int
	Op     string // "in" "out" "append" "inout" "outerr" "inerr" "heredoc" "heredoc-tabs" "herestring"
	Target *Word
	// heredoc: delimiter + captured body (the core's heredoc_body);
	// HeredocQuoted = `<<'EOF'` / `<<"EOF"` → interpolate:false.
	HeredocBody   string
	HeredocQuoted bool
}

type Command struct {
	Kind string // "simple" "builtin" "assign" "if" "while" "for" "pipeline" "and" "or" "not"
	// "block" "background" "subshell" "redirect" "test" "arith" "break" "continue" "return"
	Name     *Word
	Args     []*Word
	EnvVars  []EnvVar // sorted by name
	Redirect []*Redirect
	// assign
	AssignVar string
	AssignOp  string // "=" "+=" "-=" "*=" "/=" "%="
	AssignVal *Word
	// function definition (name() { ... })
	FuncName string
	// if
	Cond *Command
	Then []*Command
	Else *Command
	// while
	Until bool
	Body  []*Command
	// for
	ForVar  string
	Items   []*Word
	ForBody []*Command
	// pipeline / and / or
	Op     string
	Stages []*Command
	Lhs    *Command
	Rhs    *Command
	// block/background/subshell/not
	BodyCmds []*Command
	// redirect-wrapped
	Inner *Command
	// test
	TestExpr string
	// ((...))
	ArithRaw string
	// return value word
	RetVal *Word
	// case
	CaseWord    *Word
	CaseClauses []CaseClause
}

type CaseClause struct {
	Patterns []string
	Body     []*Command
}

// ─────────────────────────────────────────────────────────────────────
// Parser (char-level scanner; mirrors the core lexer+parser)
// ─────────────────────────────────────────────────────────────────────

type Parser struct {
	src string
	pos int
}

func (p *Parser) eof() bool { return p.pos >= len(p.src) }
func (p *Parser) peek() byte {
	if p.eof() {
		return 0
	}
	return p.src[p.pos]
}
func (p *Parser) peekAt(off int) byte {
	if p.pos+off >= len(p.src) {
		return 0
	}
	return p.src[p.pos+off]
}
func (p *Parser) starts(s string) bool {
	return strings.HasPrefix(p.src[p.pos:], s)
}

func isWS(c byte) bool { return c == ' ' || c == '\t' }
func isNL(c byte) bool { return c == '\n' || c == '\r' }

func (p *Parser) skipInlineWS() {
	for !p.eof() && isWS(p.peek()) {
		p.pos++
	}
}
func (p *Parser) skipWSAndComments() {
	for !p.eof() {
		c := p.peek()
		if isWS(c) || isNL(c) {
			p.pos++
		} else if c == '#' {
			for !p.eof() && p.peek() != '\n' {
				p.pos++
			}
		} else {
			break
		}
	}
}
func (p *Parser) skipInlineWSAndComments() {
	for !p.eof() {
		c := p.peek()
		if isWS(c) {
			p.pos++
		} else if c == '#' {
			for !p.eof() && p.peek() != '\n' {
				p.pos++
			}
		} else {
			break
		}
	}
}

// identifier char set: the core's Identifier regex [a-zA-Z_][a-zA-Z0-9_*?\-]*
func isIdentStart(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}
func isIdentChar(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9') || c == '*' || c == '?' || c == '-'
}
func isPlainIdentChar(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}
func isDigit(c byte) bool { return c >= '0' && c <= '9' }

var keywords = []string{
	"if", "then", "elif", "else", "fi", "while", "until", "do", "done",
	"for", "in", "case", "esac", "function", "select",
}

var builtinKeywords = []string{
	"set", "unset", "export", "readonly", "declare", "typeset", "local",
	"shift", "eval", "exec", "source", "trap", "wait", "shopt", "exit",
	"return", "break", "continue",
}

// atKeyword: an identifier-shaped keyword at pos, not part of a longer word.
func (p *Parser) atKeyword(kw string) bool {
	if !p.starts(kw) {
		return false
	}
	if p.pos > 0 {
		prev := p.src[p.pos-1]
		if isIdentChar(prev) {
			return false
		}
	}
	after := p.peekAt(len(kw))
	return !isIdentChar(after)
}

func (p *Parser) peekKeyword() string {
	for _, kw := range keywords {
		if p.atKeyword(kw) {
			return kw
		}
	}
	return ""
}

// scanIdentRun — the raw identifier run [a-zA-Z_][a-zA-Z0-9_*?\-]* at pos.
func (p *Parser) scanIdentRun() string {
	start := p.pos
	for !p.eof() && isIdentChar(p.peek()) {
		p.pos++
	}
	return p.src[start:p.pos]
}

// plainIdentPrefix — the [A-Za-z0-9_]+ prefix of an identifier run.
func plainIdentPrefix(run string) string {
	end := 0
	for end < len(run) && isPlainIdentChar(run[end]) {
		end++
	}
	return run[:end]
}

// ── word scanning ────────────────────────────────────────────────────

// bareWordChar: chars that continue a bare (unquoted) word token run.
// Mirrors the core combine loop's continuation token set.
func isBareWordChar(c byte) bool {
	switch {
	case isPlainIdentChar(c):
		return true
	case c == '/' || c == '.' || c == ':' || c == '+' || c == ',' ||
		c == '%' || c == '=' || c == '^' || c == '[' || c == ']' ||
		c == '*' || c == '?' || c == '-':
		return true
	}
	return false
}

// isVarRefNext: `$` followed by identifier/number → variable reference
// (the combine loop breaks at it).
func (p *Parser) isVarRefNext() bool {
	c := p.peekAt(1)
	return isIdentStart(c) || isDigit(c)
}

// parseWord — one shell word (mirrors parse_word + combine loop +
// merge_contiguous_quoted_fragments).
func (p *Parser) parseWord() (*Word, error) {
	// backtick command substitution first (parse_pipeline_from_text: ONE
	// command; the rest is dropped; on error → Literal("`...`"))
	if p.peek() == '`' {
		content, ok := p.scanBacktick()
		if !ok {
			return nil, fmt.Errorf("unterminated backtick at %d", p.pos)
		}
		sub := &Parser{src: content}
		cmd, err := sub.parseCommand()
		if err != nil {
			w := &Word{Kind: "lit", Text: "`" + content + "`"}
			p.mergeFragments(w)
			p.skipInlineWSAndComments()
			return w, nil
		}
		w := &Word{Kind: "cs", Raw: content, CSCmd: cmd}
		p.mergeFragments(w)
		p.skipInlineWSAndComments()
		return w, nil
	}
	// @-prefixed word: `@b` — At + Ident/Number/$ combine
	if p.peek() == '@' {
		var sb strings.Builder
		for !p.eof() {
			c := p.peek()
			if c == '@' || isIdentStart(c) || isDigit(c) || c == '$' {
				if c == '$' {
					if !p.isVarRefNext() {
						break
					}
					sb.WriteByte('$')
					p.pos++
					sb.WriteString(p.scanIdentRun())
					continue
				}
				sb.WriteByte(c)
				p.pos++
			} else {
				break
			}
		}
		if sb.Len() > 0 {
			w := &Word{Kind: "lit", Text: sb.String()}
			p.mergeFragments(w)
			p.skipInlineWSAndComments()
			return w, nil
		}
	}
	if p.peek() == '$' {
		w, err := p.parseDollarExpansion()
		if err != nil {
			return nil, err
		}
		p.mergeFragments(w)
		p.skipInlineWSAndComments()
		return w, nil
	}
	if p.peek() == '"' {
		qpos := p.pos
		parts, err := p.scanDoubleQuoted()
		if err != nil {
			// unterminated quote: bare-DoubleQuote fallback → Literal of the
			// remaining input text (the core's scan_double_quoted_string
			// fallback scans to the end of input)
			text := ""
			if qpos+1 <= len(p.src) {
				text = p.src[qpos+1:]
			}
			p.pos = len(p.src)
			w := &Word{Kind: "lit", Text: text}
			p.mergeFragments(w)
			p.skipInlineWSAndComments()
			return w, nil
		}
		w := &Word{Kind: "interp", Parts: parts}
		p.mergeFragments(w)
		p.skipInlineWSAndComments()
		return w, nil
	}
	if p.peek() == '\'' {
		qpos := p.pos
		inner, ok := p.scanSingleQuoted()
		if !ok {
			// unterminated single quote: scan to EOF (the core's SingleQuote
			// arm) and keep the content; scanSingleQuoted already consumed
			// the opening quote
			text := ""
			if qpos+1 <= len(p.src) {
				text = p.src[qpos+1:]
			}
			p.pos = len(p.src)
			w := &Word{Kind: "lit", Text: text, Quoted: true}
			p.mergeFragments(w)
			p.skipInlineWSAndComments()
			return w, nil
		}
		w := &Word{Kind: "lit", Text: inner, Quoted: true}
		p.mergeFragments(w)
		p.skipInlineWSAndComments()
		return w, nil
	}
	if p.peek() == '{' {
		// `{a,b}` at word start (mirrors parse_word's BraceOpen branch)
		be, err := p.parseBraceExpansion()
		if err != nil {
			return nil, err
		}
		p.mergeFragments(be)
		p.skipInlineWSAndComments()
		return be, nil
	}
	// bare combine loop
	var sb strings.Builder
	if p.peek() == '!' || p.peek() == '~' {
		// Bang/Tilde tokens in word position → literal chars
		sb.WriteByte(p.peek())
		p.pos++
	}
	for !p.eof() {
		c := p.peek()
		if c == '$' {
			if p.isVarRefNext() {
				break
			}
			if p.peekAt(1) == '{' || p.peekAt(1) == '(' {
				break
			}
			sb.WriteByte('$')
			p.pos++
			continue
		}
		if c == '\\' {
			sb.WriteByte('\\')
			p.pos++
			if !p.eof() {
				sb.WriteByte(p.peek())
				p.pos++
			}
			continue
		}
		if isBareWordChar(c) {
			sb.WriteByte(c)
			p.pos++
			continue
		}
		break
	}
	if sb.Len() == 0 {
		return nil, fmt.Errorf("parse_word: no word at %d", p.pos)
	}
	// `x{a,b}` — the combined literal becomes the brace prefix
	// (mirrors the combine branch: returns directly, no fragment merge)
	if p.peek() == '{' {
		be, err := p.parseBraceExpansion()
		if err != nil {
			return nil, err
		}
		be.BracePrefix = sb.String() + be.BracePrefix
		p.skipInlineWSAndComments()
		return be, nil
	}
	w := &Word{Kind: "lit", Text: sb.String()}
	p.mergeFragments(w)
	p.skipInlineWSAndComments()
	return w, nil
}

// mergeFragments — merge_contiguous_quoted_fragments: glued fragments
// (no whitespace gap) merge into the current word.
func (p *Parser) mergeFragments(w *Word) {
	for {
		if p.eof() {
			return
		}
		c := p.peek()
		switch {
		case c == '\'':
			qpos := p.pos
			inner, ok := p.scanSingleQuoted()
			if !ok {
				// bare SingleQuote (unterminated): rewind; a new word
				p.pos = qpos
				return
			}
			if !appendPlainText(w, inner) {
				return
			}
		case c == '"':
			qpos := p.pos
			parts, err := p.scanDoubleQuoted()
			if err != nil {
				// bare DoubleQuote (unterminated): the merge loop has no arm for
				// it — rewind; the quote becomes a new word
				p.pos = qpos
				return
			}
			frag := &Word{Kind: "interp", Parts: parts}
			if text, ok := plainTextOfWord(frag); ok {
				if !appendPlainText(w, text) {
					return
				}
			} else {
				// non-plain fragment: REPLACE word parts with
				// [Lit(concat current literal text)] + frag.parts; word ends.
				var lit string
				switch w.Kind {
				case "lit":
					lit = w.Text
				case "interp":
					for _, pt := range w.Parts {
						if pt.IsLit {
							lit += pt.Lit
						}
					}
				}
				newParts := []Part{}
				if lit != "" {
					newParts = append(newParts, Part{IsLit: true, Lit: lit})
				}
				newParts = append(newParts, frag.Parts...)
				*w = Word{Kind: "interp", Parts: newParts}
				return
			}
		case c == '`':
			// the core's merge loop has NO backtick arm: word ends; the
			// backtick becomes a new word (consumed, content dropped)
			return
		case c == '$':
			if p.isVarRefNext() || p.peekAt(1) == '{' || p.peekAt(1) == '(' {
				exp, err := p.parseDollarExpansion()
				if err != nil {
					return
				}
				if !mergeExpansionIntoWord(w, exp) {
					return
				}
				continue
			}
			if !appendPlainText(w, "$") {
				return
			}
			p.pos++
		case c == '\\':
			// append_raw_token_text: consume the escape, append raw text;
			// continue on success, word ends on failure
			p.pos++
			ok := true
			if !p.eof() {
				ok = appendPlainText(w, "\\"+string(p.peek()))
				p.pos++
			} else {
				ok = appendPlainText(w, "\\")
			}
			if !ok {
				return
			}
		case c == '{':
			// the core's merge loop has NO BraceOpen arm → word ends; the
			// brace is a new word (merged at lowering — merged_words_ir)
			return
		case isBareWordChar(c):
			// append_raw_token_text: consumed even when the append fails
			p.pos++
			if !appendPlainText(w, string(c)) {
				return
			}
		default:
			return
		}
	}
}

func plainTextOfWord(w *Word) (string, bool) {
	switch w.Kind {
	case "lit":
		return w.Text, true
	case "interp":
		var sb strings.Builder
		for _, pt := range w.Parts {
			if pt.IsLit {
				sb.WriteString(pt.Lit)
			} else {
				return "", false
			}
		}
		return sb.String(), true
	}
	return "", false
}

func appendPlainText(w *Word, frag string) bool {
	switch w.Kind {
	case "lit":
		w.Text += frag
		return true
	case "interp":
		if n := len(w.Parts); n > 0 && w.Parts[n-1].IsLit {
			w.Parts[n-1].Lit += frag
		} else {
			w.Parts = append(w.Parts, Part{IsLit: true, Lit: frag})
		}
		return true
	case "var":
		w.Kind = "interp"
		w.Parts = []Part{{IsLit: false, Var: w.VarName}, {IsLit: true, Lit: frag}}
		return true
	}
	return false
}

func expansionIntoParts(exp *Word) []Part {
	switch exp.Kind {
	case "var":
		return []Part{{IsLit: false, Var: exp.VarName}}
	case "pe":
		return []Part{{IsLit: false, PE: exp}}
	case "arith":
		return []Part{{IsLit: false, ArithRaw: exp.Raw}}
	case "cs":
		return []Part{{IsLit: false, CSRaw: exp.Raw}}
	case "mapaccess":
		return []Part{{IsLit: false, MapName: exp.MapName, MapKey: exp.MapKey, MapKind: "access"}}
	case "mapkeys":
		return []Part{{IsLit: false, MapName: exp.MapName, MapKind: "keys"}}
	case "maplen":
		return []Part{{IsLit: false, MapName: exp.MapName, MapKind: "len"}}
	case "arrayslice":
		return []Part{{IsLit: false, MapName: exp.MapName, MapKind: "slice", SliceOff: exp.SliceOff, SliceLen: exp.SliceLen}}
	case "interp":
		return exp.Parts
	}
	return nil
}

func mergeExpansionIntoWord(w *Word, exp *Word) bool {
	parts := expansionIntoParts(exp)
	if parts == nil {
		return false
	}
	switch w.Kind {
	case "lit":
		lit := w.Text
		w.Kind = "interp"
		w.Parts = append([]Part{{IsLit: true, Lit: lit}}, parts...)
		return true
	case "var":
		w.Kind = "interp"
		w.Parts = append([]Part{{IsLit: false, Var: w.VarName}}, parts...)
		return true
	case "interp":
		if n := len(w.Parts); n > 0 && w.Parts[n-1].IsLit && len(parts) > 0 && parts[0].IsLit {
			w.Parts[n-1].Lit += parts[0].Lit
			w.Parts = append(w.Parts, parts[1:]...)
		} else {
			w.Parts = append(w.Parts, parts...)
		}
		return true
	}
	return false
}

// parseDollarExpansion — `$var` `${...}` `$((...))` `$(...)` `$'...'` `$?` ...
func (p *Parser) parseDollarExpansion() (*Word, error) {
	// p.pos at '$'
	if p.starts("$((") {
		content, ok := p.scanArithParens()
		if !ok {
			return nil, fmt.Errorf("unterminated $(( at %d", p.pos)
		}
		return &Word{Kind: "arith", Raw: content}, nil
	}
	if p.starts("$(") {
		content, ok := p.scanCmdSub()
		if !ok {
			return nil, fmt.Errorf("unterminated $( at %d", p.pos)
		}
		return &Word{Kind: "cs", Raw: content}, nil
	}
	if p.starts("${") {
		content, ok := p.scanBraced()
		if !ok {
			return nil, fmt.Errorf("unterminated ${ at %d", p.pos)
		}
		return parseBracedContent(content), nil
	}
	if p.starts("$'") {
		// ANSI-C quoted string: consumed raw (rare in the corpus)
		start := p.pos
		p.pos += 2
		for !p.eof() && p.peek() != '\'' {
			if p.peek() == '\\' && p.peekAt(1) != 0 {
				p.pos++
			}
			p.pos++
		}
		if p.eof() {
			return nil, fmt.Errorf("unterminated $' at %d", start)
		}
		p.pos++ // closing '
		inner := p.src[start+2 : p.pos-1]
		return &Word{Kind: "lit", Text: inner, Quoted: true}, nil
	}
	p.pos++ // consume $
	if p.eof() {
		return &Word{Kind: "lit", Text: "$"}, nil
	}
	c := p.peek()
	if isIdentStart(c) {
		// consume only the plain [A-Za-z0-9_]+ name — suffix chars
		// (`*?-`) remain for the merge loop (the core truncates the
		// Identifier token and re-lexes the suffix)
		start := p.pos
		for !p.eof() && isPlainIdentChar(p.peek()) {
			p.pos++
		}
		name := p.src[start:p.pos]
		// `$name[...]` — bare array/map index (mirrors the core's
		// parse_variable_expansion MapAccess branch: `$a[2]` lowers to
		// arrayIndex("a","2"), not getVar + literal `[2]`).
		if p.peek() == '[' {
			p.pos++
			var idx strings.Builder
			depth := 1
			for !p.eof() && depth > 0 {
				ch := p.peek()
				if ch == '[' {
					depth++
				}
				if ch == ']' {
					depth--
					if depth == 0 {
						p.pos++
						break
					}
				}
				idx.WriteByte(ch)
				p.pos++
			}
			return &Word{Kind: "mapaccess", MapName: name, MapKey: idx.String()}, nil
		}
		return &Word{Kind: "var", VarName: name}, nil
	}
	if isDigit(c) {
		// `$1b` → name "1" — the Number token is digits-only (the core's
		// merge loop re-lexes the `b` as literal text)
		start := p.pos
		for !p.eof() && isDigit(p.peek()) {
			p.pos++
		}
		return &Word{Kind: "var", VarName: p.src[start:p.pos]}, nil
	}
	switch c {
	case '?', '$', '@', '*', '#', '-', '!':
		p.pos++
		return &Word{Kind: "var", VarName: string(c)}, nil
	}
	// bare `$`
	return &Word{Kind: "lit", Text: "$"}, nil
}

// parseBracedContent — parse_braced_variable_name content → Word.
// Mirror of parse_variable_expansion's braced chain in parser/words.rs.
func parseBracedContent(content string) *Word {
	// ${#...} / ${!...} — the lexer's DollarBraceHash/DollarBraceBang tokens
	// keep the prefix in the variable name
	// ${#x} / ${!x} — the scanner keeps the leading `#`/`!` in the
	// content (the core's DollarBraceHash/DollarBraceBang tokens prefix it
	// onto the parsed name)
	if strings.HasPrefix(content, "#") {
		if bs := strings.Index(content, "["); bs > 0 && strings.Contains(content, "]") {
			return &Word{Kind: "maplen", MapName: content[1:bs]}
		}
		return &Word{Kind: "var", VarName: content}
	}
	if strings.HasPrefix(content, "!") {
		if bs := strings.Index(content, "["); bs > 1 && strings.Contains(content, "]") {
			return &Word{Kind: "mapkeys", MapName: content[1:bs]}
		}
		if strings.HasSuffix(content, "@") || strings.HasSuffix(content, "*") {
			return &Word{Kind: "mapkeys", MapName: content[1 : len(content)-1]}
		}
		return &Word{Kind: "var", VarName: content}
	}
	// ${var::offset} — substring with empty offset (check BEFORE :-)
	if idx := strings.Index(content, "::"); idx >= 0 {
		return &Word{Kind: "arrayslice", MapName: content[:idx], SliceOff: "0", SliceLen: strp(content[idx+2:])}
	}
	// colon-prefix operators
	if idx := strings.Index(content, ":-"); idx >= 0 {
		return peWord(content[:idx], ":-", content[idx+2:])
	}
	if idx := strings.Index(content, ":="); idx >= 0 {
		return peWord(content[:idx], ":=", content[idx+2:])
	}
	if idx := strings.Index(content, ":+"); idx >= 0 {
		return peWord(content[:idx], ":-", content[idx+2:])
	}
	if idx := strings.Index(content, ":?"); idx >= 0 {
		return peWord(content[:idx], ":?", content[idx+2:])
	}
	// ${var:offset[:length]}
	if idx := strings.Index(content, ":"); idx >= 0 {
		rest := content[idx+1:]
		if sidx := strings.Index(rest, ":"); sidx >= 0 {
			return &Word{Kind: "arrayslice", MapName: content[:idx], SliceOff: rest[:sidx], SliceLen: strp(rest[sidx+1:])}
		}
		return &Word{Kind: "arrayslice", MapName: content[:idx], SliceOff: rest, SliceLen: nil}
	}
	// map/array access ${map[foo]}
	if bs := strings.Index(content, "["); bs >= 0 {
		if be := strings.LastIndex(content, "]"); be > bs {
			mapName := content[:bs]
			if !strings.ContainsAny(mapName, "#%/") {
				key := content[bs+1 : be]
				after := content[be+1:]
				if key == "@" {
					if strings.HasPrefix(after, ":") {
						slice := after[1:]
						if sidx := strings.Index(slice, ":"); sidx >= 0 {
							return &Word{Kind: "arrayslice", MapName: mapName, SliceOff: slice[:sidx], SliceLen: strp(slice[sidx+1:])}
						}
						return &Word{Kind: "arrayslice", MapName: mapName, SliceOff: slice, SliceLen: nil}
					}
					return &Word{Kind: "mapaccess", MapName: mapName, MapKey: "@"}
				}
				return &Word{Kind: "mapaccess", MapName: mapName, MapKey: key}
			}
		}
	}
	// pattern operators (longest first)
	if strings.HasSuffix(content, "^^") {
		return peWord(strings.TrimSuffix(content, "^^"), "^^", "")
	}
	if strings.HasSuffix(content, ",,") {
		return peWord(strings.TrimSuffix(content, ",,"), ",,", "")
	}
	if strings.HasSuffix(content, "^") {
		return peWord(strings.TrimSuffix(content, "^"), "^", "")
	}
	if strings.HasSuffix(content, "##*/") && !strings.HasSuffix(content, "###*/") {
		return peWord(strings.TrimSuffix(content, "##*/"), "basename", "")
	}
	if strings.HasSuffix(content, "%/*") && !strings.HasSuffix(content, "%%/*") {
		return peWord(strings.TrimSuffix(content, "%/*"), "dirname", "")
	}
	if strings.Contains(content, "##") && !strings.HasSuffix(content, "##*/") {
		if parts := strings.Split(content, "##"); len(parts) == 2 {
			return peWord(parts[0], "##", parts[1])
		}
		return &Word{Kind: "var", VarName: content}
	}
	if strings.Contains(content, "%%") && !(strings.HasSuffix(content, "%/*") && !strings.HasSuffix(content, "%%/*")) {
		if parts := strings.Split(content, "%%"); len(parts) == 2 {
			return peWord(parts[0], "%%", parts[1])
		}
		return &Word{Kind: "var", VarName: content}
	}
	if strings.Contains(content, "#") && !strings.Contains(content, "##") {
		if parts := strings.SplitN(content, "#", 2); len(parts) == 2 {
			return peWord(parts[0], "#", parts[1])
		}
		return &Word{Kind: "var", VarName: content}
	}
	if strings.Contains(content, "%") && !strings.Contains(content, "%%") &&
		!(strings.HasSuffix(content, "%/*") && !strings.HasSuffix(content, "%%/*")) {
		if parts := strings.SplitN(content, "%", 2); len(parts) == 2 {
			return peWord(parts[0], "%", parts[1])
		}
		return &Word{Kind: "var", VarName: content}
	}
	if strings.Contains(content, "//") {
		if parts := strings.Split(content, "//"); len(parts) == 3 {
			return peWord(parts[0], "//", parts[1], parts[2])
		}
		return &Word{Kind: "var", VarName: content}
	}
	if strings.Contains(content, "/") && !strings.Contains(content, "//") {
		if parts := strings.Split(content, "/"); len(parts) == 3 {
			return peWord(parts[0], "//", parts[1], parts[2])
		}
		return &Word{Kind: "var", VarName: content}
	}
	if idx := strings.Index(content, "-"); idx > 0 {
		return peWord(content[:idx], ":-", content[idx+1:])
	}
	if idx := strings.Index(content, "+"); idx > 0 {
		return peWord(content[:idx], ":-", content[idx+1:])
	}
	if idx := strings.Index(content, "?"); idx > 0 {
		return peWord(content[:idx], ":?", content[idx+1:])
	}
	if idx := strings.Index(content, "="); idx > 0 {
		return peWord(content[:idx], ":=", content[idx+1:])
	}
	return &Word{Kind: "var", VarName: content}
}

// parsePEContent — mirrors parse_parameter_expansion_content: the braced
// content inside a DOUBLE-QUOTED string always becomes a ParameterExpansion
// part (op None keeps the whole content as the variable name).
func parsePEContent(content string) *Word {
	// ${#arr[@]} — array length (the # stays in the variable name; param_ir's
	// len arm strips it)
	if strings.HasPrefix(content, "#") && strings.Contains(content, "[") && strings.Contains(content, "]") {
		if bs := strings.Index(content, "["); bs > 0 {
			return &Word{Kind: "pe", PEVar: content[:bs], PEOp: "slice", PEExtra: []string{"@", ""}}
		}
	}
	// ${!map[@]} — map keys
	if strings.HasPrefix(content, "!") && strings.Contains(content, "[") && strings.Contains(content, "]") {
		if bs := strings.Index(content, "["); bs > 1 {
			return &Word{Kind: "pe", PEVar: "!" + content[1:bs], PEOp: "slice", PEExtra: []string{"@", ""}}
		}
	}
	// ${var::length}
	if idx := strings.Index(content, "::"); idx >= 0 {
		return &Word{Kind: "pe", PEVar: content[:idx], PEOp: "slice", PEExtra: []string{"0", content[idx+2:]}}
	}
	if idx := strings.Index(content, ":-"); idx >= 0 {
		return peWord(content[:idx], ":-", content[idx+2:])
	}
	if idx := strings.Index(content, ":="); idx >= 0 {
		return peWord(content[:idx], ":=", content[idx+2:])
	}
	if idx := strings.Index(content, ":+"); idx >= 0 {
		return peWord(content[:idx], ":-", content[idx+2:])
	}
	if idx := strings.Index(content, ":?"); idx >= 0 {
		return peWord(content[:idx], ":?", content[idx+2:])
	}
	// ${var//pattern/replacement}
	if strings.Contains(content, "//") {
		parts := strings.SplitN(content, "//", 2)
		if len(parts) == 2 {
			if sp := strings.Index(parts[1], "/"); sp >= 0 {
				return peWord(parts[0], "//", parts[1][:sp], parts[1][sp+1:])
			}
		}
	}
	// ${var/pattern/replacement}
	if strings.Contains(content, "/") {
		parts := strings.SplitN(content, "/", 3)
		if len(parts) == 3 {
			return peWord(parts[0], "//", parts[1], parts[2])
		}
	}
	// array/map access (must come AFTER // and /)
	if bs := strings.Index(content, "["); bs >= 0 {
		if be := strings.LastIndex(content, "]"); be > bs {
			varName := content[:bs]
			key := content[bs+1 : be]
			rest := content[be+1:]
			if key == "@" {
				if strings.HasPrefix(rest, ":") {
					slice := rest[1:]
					if sp := strings.Index(slice, ":"); sp >= 0 {
						return &Word{Kind: "pe", PEVar: varName, PEOp: "slice", PEExtra: []string{slice[:sp], slice[sp+1:]}}
					}
					return &Word{Kind: "pe", PEVar: varName, PEOp: "slice", PEExtra: []string{slice, ""}}
				}
				return &Word{Kind: "pe", PEVar: varName, PEOp: "slice", PEExtra: []string{"@", ""}}
			}
			vk := varName + "[" + key + "]"
			switch {
			case strings.HasPrefix(rest, "##"):
				return peWord(vk, "##", rest[2:])
			case strings.HasPrefix(rest, "#"):
				return peWord(vk, "#", rest[1:])
			case strings.HasPrefix(rest, "%%"):
				return peWord(vk, "%%", rest[2:])
			case strings.HasPrefix(rest, "%"):
				return peWord(vk, "%", rest[1:])
			case rest == "^^":
				return peWord(vk, "^^")
			case rest == ",,":
				return peWord(vk, ",,")
			case rest == "^":
				return peWord(vk, "^")
			}
			return &Word{Kind: "pe", PEVar: vk, PEOp: ""}
		}
	}
	// ${var:offset[:length]} — no brackets or operator chars
	if strings.Contains(content, ":") && !strings.Contains(content, "[") && !strings.Contains(content, "]") &&
		!strings.Contains(content, "::") && !strings.Contains(content, ":-") && !strings.Contains(content, ":=") &&
		!strings.Contains(content, ":+") && !strings.Contains(content, ":?") &&
		!strings.Contains(content, "%") && !strings.Contains(content, "#") &&
		!strings.Contains(content, "/") && !strings.Contains(content, "^") && !strings.Contains(content, ",") {
		if cp := strings.Index(content, ":"); cp > 0 {
			rest := content[cp+1:]
			if sp := strings.Index(rest, ":"); sp >= 0 {
				return &Word{Kind: "pe", PEVar: content[:cp], PEOp: "slice", PEExtra: []string{rest[:sp], rest[sp+1:]}}
			}
			return &Word{Kind: "pe", PEVar: content[:cp], PEOp: "slice", PEExtra: []string{rest, ""}}
		}
	}
	if strings.HasSuffix(content, "^^") {
		return peWord(strings.TrimSuffix(content, "^^"), "^^")
	}
	if strings.HasSuffix(content, ",,") {
		return peWord(strings.TrimSuffix(content, ",,"), ",,")
	}
	if strings.HasSuffix(content, "^") {
		return peWord(strings.TrimSuffix(content, "^"), "^")
	}
	if strings.HasSuffix(content, "##*/") {
		return peWord(strings.TrimSuffix(content, "##*/"), "basename")
	}
	if strings.HasSuffix(content, "%/*") && !strings.HasSuffix(content, "%%/*") {
		return peWord(strings.TrimSuffix(content, "%/*"), "dirname")
	}
	if strings.Contains(content, "##") && !strings.HasSuffix(content, "##*/") {
		if parts := strings.Split(content, "##"); len(parts) == 2 {
			return peWord(parts[0], "##", parts[1])
		}
		return &Word{Kind: "pe", PEVar: content, PEOp: ""}
	}
	if strings.Contains(content, "%%") && !(strings.HasSuffix(content, "%/*") && !strings.HasSuffix(content, "%%/*")) {
		if parts := strings.Split(content, "%%"); len(parts) == 2 {
			return peWord(parts[0], "%%", parts[1])
		}
		return &Word{Kind: "pe", PEVar: content, PEOp: ""}
	}
	if strings.Contains(content, "#") && !strings.HasPrefix(content, "#") && !strings.Contains(content, "##") {
		if parts := strings.Split(content, "#"); len(parts) == 2 {
			return peWord(parts[0], "#", parts[1])
		}
		return &Word{Kind: "pe", PEVar: content, PEOp: ""}
	}
	if strings.Contains(content, "%") && !strings.Contains(content, "%%") &&
		!(strings.HasSuffix(content, "%/*") && !strings.HasSuffix(content, "%%/*")) {
		if parts := strings.Split(content, "%"); len(parts) == 2 {
			return peWord(parts[0], "%", parts[1])
		}
		return &Word{Kind: "pe", PEVar: content, PEOp: ""}
	}
	if strings.Contains(content, "-") && !strings.Contains(content, "%") && !strings.Contains(content, "#") &&
		!strings.Contains(content, "/") && !strings.Contains(content, "!") && !strings.Contains(content, ":") {
		if parts := strings.SplitN(content, "-", 2); len(parts) == 2 && parts[0] != "" {
			return peWord(parts[0], ":-", parts[1])
		}
		return &Word{Kind: "pe", PEVar: content, PEOp: ""}
	}
	if strings.Contains(content, "=-") {
		if parts := strings.SplitN(content, "=-", 2); len(parts) == 2 && parts[0] != "" &&
			!strings.Contains(parts[0], "%") && !strings.Contains(parts[0], "#") {
			return peWord(parts[0], ":=", parts[1])
		}
		return &Word{Kind: "pe", PEVar: content, PEOp: ""}
	}
	return &Word{Kind: "pe", PEVar: content, PEOp: ""}
}

func peWord(vars ...string) *Word {
	w := &Word{Kind: "pe", PEVar: vars[0], PEOp: vars[1]}
	if len(vars) > 2 {
		w.PEExtra = vars[2:]
	}
	return w
}

func strp(s string) *string { return &s }

// scanDoubleQuoted — the DQ token; returns StringInterpolation parts.
// Mirrors parse_string_interpolation: capture the raw token text, apply the
// global escape pre-replacement (\" → ", \\ → \, \<newline> → ""), then
// split into parts. An all-empty scan yields [Literal(content)] (so `""`
// is Interpolate([Lit("")])).
func (p *Parser) scanDoubleQuoted() ([]Part, error) {
	p.pos++ // consume "
	start := p.pos
	for !p.eof() {
		c := p.peek()
		if c == '\\' && p.peekAt(1) != 0 {
			p.pos += 2
			continue
		}
		if c == '"' {
			break
		}
		if c == '$' && p.peekAt(1) == '(' {
			// keep $(...) intact (nested quotes inside)
			if _, ok := p.scanCmdSub(); !ok {
				return nil, fmt.Errorf("unterminated $( at %d", p.pos)
			}
			continue
		}
		if c == '`' {
			if _, ok := p.scanBacktick(); !ok {
				return nil, fmt.Errorf("unterminated backtick at %d", p.pos)
			}
			continue
		}
		p.pos++
	}
	if p.eof() {
		return nil, fmt.Errorf("unterminated double quote")
	}
	raw := p.src[start:p.pos]
	p.pos++ // closing "
	// global pre-replacement (parse_string_interpolation)
	content := raw
	content = strings.ReplaceAll(content, "\\\"", "\"")
	content = strings.ReplaceAll(content, "\\\\", "\\")
	content = strings.ReplaceAll(content, "\\\n", "")
	content = strings.ReplaceAll(content, "\\\r\n", "")

	parts := []Part{}
	var buf strings.Builder
	flush := func() {
		if buf.Len() > 0 {
			parts = append(parts, Part{IsLit: true, Lit: buf.String()})
			buf.Reset()
		}
	}
	i := 0
	for i < len(content) {
		c := content[i]
		if i+1 < len(content) && content[i] == '\\' && content[i+1] == '`' {
			// \` escaped backtick: CS part if a closing \` exists, else a
			// literal "\\`" part (mirrors parse_string_interpolation)
			flush()
			j := i + 2
			for j+1 < len(content) && !(content[j] == '\\' && content[j+1] == '`') {
				j++
			}
			if j+1 < len(content) {
				parts = append(parts, Part{CSRaw: content[i+2 : j]})
				i = j + 2
			} else {
				parts = append(parts, Part{IsLit: true, Lit: "\\`"})
				i = i + 2
			}
			continue
		}
		if c == '`' {
			// backtick command substitution part (full parse; first command;
			// empty → echo placeholder; error → Literal("`...`"))
			flush()
			j := i + 1
			for j < len(content) && content[j] != '`' {
				if content[j] == '\\' && j+1 < len(content) {
					j += 2
					continue
				}
				j++
			}
			if j >= len(content) {
				parts = append(parts, Part{IsLit: true, Lit: "`"})
				i++
				continue
			}
			raw := content[i+1 : j]
			sub := &Parser{src: raw}
			cmds, err := sub.parseProgram()
			if err != nil || len(cmds) == 0 {
				if err != nil {
					parts = append(parts, Part{IsLit: true, Lit: "`" + raw + "`"})
				} else {
					parts = append(parts, Part{CSRaw: raw, CSCmd: echoPlaceholderCmd(raw)})
				}
			} else {
				parts = append(parts, Part{CSRaw: raw, CSCmd: cmds[0]})
			}
			i = j + 1
			continue
		}
		if i+1 < len(content) && strings.HasPrefix(content[i:], "\\$") {
			// escaped dollar \$ -> literal $
			buf.WriteByte('$')
			i += 2
			continue
		}
		if c == '$' {
			if strings.HasPrefix(content[i:], "$((") {
				// arithmetic — plain paren-depth scan; content TRIMMED
				flush()
				j := i + 3
				depth := 2
				for j < len(content) && depth > 0 {
					if content[j] == '(' {
						depth++
					} else if content[j] == ')' {
						depth--
					}
					j++
				}
				if depth == 0 {
					parts = append(parts, Part{ArithRaw: strings.TrimSpace(content[i+3 : j-2])})
					i = j
					continue
				}
			}
			if i+1 < len(content) && content[i+1] == '(' {
				// $(...) — quote-aware paren scan
				flush()
				j := i + 2
				paren := 1
				inSq, inDq := false, false
				for j < len(content) && paren > 0 {
					cc := content[j]
					if cc == '\\' && j+1 < len(content) {
						j += 2
						continue
					}
					if cc == '"' {
						inDq = !inDq
					} else if cc == '\'' && !inDq {
						inSq = !inSq
					} else if cc == '(' && !inSq {
						paren++
					} else if cc == ')' && !inSq {
						paren--
					}
					j++
				}
				if paren == 0 {
					parts = append(parts, Part{CSRaw: content[i+2 : j-1]})
					i = j
					continue
				}
			}
			if i+1 < len(content) && content[i+1] == '{' {
				flush()
				j := i + 2
				depth := 1
				for j < len(content) && depth > 0 {
					if content[j] == '{' {
						depth++
					} else if content[j] == '}' {
						depth--
					}
					j++
				}
				if depth == 0 {
					// parse_parameter_expansion_content: `${x}` in a DQ string
					// is ALWAYS a ParameterExpansion part (op None → param("", x))
					parts = append(parts, Part{PE: parsePEContent(content[i+2 : j-1])})
					i = j
					continue
				}
			}
			if i+1 < len(content) && (isIdentStart(content[i+1]) || isDigit(content[i+1])) {
				flush()
				j := i + 1
				// `$1b` → "1b" in DQ context (unlike word context: the DQ
				// parser consumes the whole [A-Za-z0-9_]+ run)
				for j < len(content) && isPlainIdentChar(content[j]) {
					j++
				}
				parts = append(parts, Part{Var: content[i+1 : j]})
				i = j
				continue
			}
			if i+1 < len(content) && strings.ContainsRune("?$@*#-!", rune(content[i+1])) {
				flush()
				parts = append(parts, Part{Var: string(content[i+1])})
				i += 2
				continue
			}
			// literal $
			buf.WriteByte('$')
			i++
			continue
		}
		buf.WriteByte(c)
		i++
	}
	flush()
	if len(parts) == 0 {
		parts = append(parts, Part{IsLit: true, Lit: content})
	}
	return parts, nil
}

func mapKindOf(w *Word) string {
	switch w.Kind {
	case "mapaccess":
		return "access"
	case "mapkeys":
		return "keys"
	case "maplen":
		return "len"
	case "arrayslice":
		return "slice"
	}
	return ""
}

func (p *Parser) scanSingleQuoted() (string, bool) {
	p.pos++ // consume '
	start := p.pos
	for !p.eof() {
		if p.peek() == '\'' {
			inner := p.src[start:p.pos]
			p.pos++
			return inner, true
		}
		p.pos++
	}
	return "", false
}

func (p *Parser) scanBacktick() (string, bool) {
	p.pos++ // consume `
	start := p.pos
	for !p.eof() {
		if p.peek() == '`' {
			content := p.src[start:p.pos]
			p.pos++
			return content, true
		}
		if p.peek() == '\\' && p.peekAt(1) != 0 {
			p.pos += 2
			continue
		}
		p.pos++
	}
	return "", false
}

// scanBraced — `${...}` raw content (to the first unescaped `}`).
func (p *Parser) scanBraced() (string, bool) {
	p.pos += 2 // consume ${
	start := p.pos
	depth := 0
	for !p.eof() {
		c := p.peek()
		if c == '\\' && p.peekAt(1) != 0 {
			p.pos += 2
			continue
		}
		if c == '{' {
			depth++
		} else if c == '}' {
			if depth == 0 {
				content := p.src[start:p.pos]
				p.pos++
				return content, true
			}
			depth--
		}
		p.pos++
	}
	return "", false
}

// scanCmdSub — `$(...)` raw content (paren-depth + quote aware).
func (p *Parser) scanCmdSub() (string, bool) {
	p.pos += 2 // consume $(
	start := p.pos
	depth := 1
	for !p.eof() {
		c := p.peek()
		if c == '\\' && p.peekAt(1) != 0 {
			p.pos += 2
			continue
		}
		if c == '\'' {
			if _, ok := p.scanSingleQuoted(); !ok {
				return "", false
			}
			continue
		}
		if c == '"' {
			if _, err := p.scanDoubleQuoted(); err != nil {
				return "", false
			}
			continue
		}
		if c == '`' {
			if _, ok := p.scanBacktick(); !ok {
				return "", false
			}
			continue
		}
		if c == '(' {
			depth++
		} else if c == ')' {
			depth--
			if depth == 0 {
				content := p.src[start:p.pos]
				p.pos++
				return content, true
			}
		}
		p.pos++
	}
	return "", false
}

// scanArithParens — `$((...))` raw content (depth starts at 2).
func (p *Parser) scanArithParens() (string, bool) {
	p.pos += 3 // consume $((
	start := p.pos
	depth := 2
	for !p.eof() {
		c := p.peek()
		if c == '\'' {
			if _, ok := p.scanSingleQuoted(); !ok {
				return "", false
			}
			continue
		}
		if c == '"' {
			if _, err := p.scanDoubleQuoted(); err != nil {
				return "", false
			}
			continue
		}
		if c == '(' {
			depth++
		} else if c == ')' {
			depth--
			if depth == 0 {
				content := p.src[start : p.pos-1]
				p.pos++
				return content, true
			}
		}
		p.pos++
	}
	return "", false
}

// ── brace expansion ──────────────────────────────────────────────────

// parseBraceExpansion — `{a,b}` / `{1..3}` / nested braces (mirrors
// parse_brace_expansion).
func (p *Parser) parseBraceExpansion() (*Word, error) {
	p.pos++ // consume {
	be := &Word{Kind: "brace"}
	var items []BraceItem
	var acc strings.Builder
	flushAcc := func() {
		if acc.Len() > 0 {
			items = append(items, BraceItem{Text: acc.String()})
			acc.Reset()
		}
	}
	for !p.eof() {
		c := p.peek()
		switch {
		case c == '}':
			flushAcc()
			p.pos++
			be.BraceItems = items
			// suffix glued after }
			for !p.eof() {
				sc := p.peek()
				if isBareWordChar(sc) {
					acc.WriteByte(sc)
					p.pos++
				} else if sc == '\\' {
					acc.WriteByte('\\')
					p.pos++
					if !p.eof() {
						acc.WriteByte(p.peek())
						p.pos++
					}
				} else {
					break
				}
			}
			be.BraceSuffix = acc.String()
			return be, nil
		case c == ',':
			flushAcc()
			p.pos++
		case c == '{':
			flushAcc()
			nested, err := p.parseBraceExpansion()
			if err != nil {
				return nil, err
			}
			items = append(items, BraceItem{Nested: nested.BraceItems})
		case isDigit(c), isIdentStart(c):
			// possible range: num..num / a..z / ..step (the core checks for
			// a following Range token on Number and Identifier items)
			start := p.pos
			for !p.eof() && (isDigit(p.peek()) || isIdentStart(p.peek())) {
				p.pos++
			}
			num := p.src[start:p.pos]
			if p.starts("..") {
				flushAcc()
				p.pos += 2
				s2 := p.pos
				for !p.eof() && (isDigit(p.peek()) || isIdentStart(p.peek())) {
					p.pos++
				}
				end := p.src[s2:p.pos]
				item := BraceItem{IsRange: true, Start: num, End: end}
				if p.starts("..") {
					p.pos += 2
					s3 := p.pos
					for !p.eof() && isDigit(p.peek()) {
						p.pos++
					}
					step := p.src[s3:p.pos]
					item.Step = &step
				}
				items = append(items, item)
			} else {
				acc.WriteString(num)
			}
		default:
			if isIdentStart(c) || isBareWordChar(c) || c == '.' || c == '-' {
				acc.WriteByte(c)
				p.pos++
			} else if c == '\\' {
				acc.WriteByte('\\')
				p.pos++
				if !p.eof() {
					acc.WriteByte(p.peek())
					p.pos++
				}
			} else {
				return nil, fmt.Errorf("brace: unexpected char %q at %d", string(c), p.pos)
			}
		}
	}
	return nil, fmt.Errorf("brace: missing }")
}

// ── statement parsing ────────────────────────────────────────────────

// parseProgram — the top-level command list (mirrors parse_commands:
// `;;` and `)` truncate back to the start of the current line).
func (p *Parser) parseProgram() ([]*Command, error) {
	var cmds []*Command
	lineStart := 0
	for {
		p.skipWSAndComments()
		if p.eof() {
			break
		}
		if p.peek() == ')' || p.starts(";;") {
			cmds = cmds[:lineStart]
			break
		}
		if p.peek() == ';' {
			p.pos++
			continue
		}
		cmd, err := p.parseCommand()
		if err != nil {
			return nil, err
		}
		cmds = append(cmds, cmd)
		// separators
		skip := true
		for skip {
			p.skipInlineWSAndComments()
			switch {
			case p.eof():
				skip = false
			case isNL(p.peek()):
				for !p.eof() && isNL(p.peek()) {
					p.pos++
				}
				lineStart = len(cmds)
				skip = false
			case p.peek() == ';':
				if p.starts(";;") {
					cmds = cmds[:lineStart]
					return cmds, nil
				}
				p.pos++
				skip = false
			case p.peek() == '&' && p.peekAt(1) != '&':
				if len(cmds) > 0 {
					last := cmds[len(cmds)-1]
					cmds[len(cmds)-1] = &Command{Kind: "background", BodyCmds: []*Command{last}}
				}
				p.pos++
				p.skipInlineWSAndComments()
				skip = false
			case p.peek() == ')':
				cmds = cmds[:lineStart]
				return cmds, nil
			default:
				skip = false
			}
		}
	}
	return cmds, nil
}

// parseCommand — one statement (mirrors parse_command: dispatch +
// parse_command_redirects + background/and-or continuation).
func (p *Parser) parseCommand() (*Command, error) {
	p.skipInlineWSAndComments()
	if p.eof() {
		return nil, fmt.Errorf("parse_command: unexpected EOF")
	}
	if p.peek() == ';' {
		p.pos++
		return p.parseCommand()
	}
	base, err := p.parseCommandBase()
	if err != nil {
		return nil, err
	}
	cmd, err := p.parseCommandRedirects(base)
	if err != nil {
		return nil, err
	}
	p.skipInlineWSAndComments()
	if p.peek() == '&' && p.peekAt(1) != '&' {
		p.pos++
		return &Command{Kind: "background", BodyCmds: []*Command{cmd}}, nil
	}
	if p.starts("&&") || p.starts("||") || (p.peek() == '|' && p.peekAt(1) != '|') {
		return p.parseAndOrCont(cmd)
	}
	return cmd, nil
}

// parseCommandBase — the dispatch (mirrors parse_command's inner match and
// parse_pipeline_segment for the simple case).
func (p *Parser) parseCommandBase() (*Command, error) {
	switch p.peekKeyword() {
	case "if":
		return p.parseIf()
	case "while":
		return p.parseWhile(false)
	case "until":
		return p.parseWhile(true)
	case "for":
		return p.parseFor()
	case "case":
		return p.parseCase()
	case "function", "select":
		return nil, fmt.Errorf("unsupported construct %q at %d", p.peekKeyword(), p.pos)
	}
	if p.starts("[[") && isWordDelim(p.peekAt(2)) {
		return p.parseBracketTest(true)
	}
	if p.peek() == '[' {
		return p.parseBracketTest(false)
	}
	if p.starts("((") {
		return p.parseArithEval()
	}
	if p.peek() == '(' {
		return p.parseSubshell()
	}
	if p.peek() == '{' {
		return p.parseBlock()
	}
	// break/continue/return — dedicated statements
	if p.atKeyword("break") {
		p.pos += 5
		return &Command{Kind: "break"}, nil
	}
	if p.atKeyword("continue") {
		p.pos += 8
		return &Command{Kind: "continue"}, nil
	}
	if p.atKeyword("return") {
		p.pos += 6
		return p.parseReturnTail(), nil
	}
	if p.isAssignmentStart() {
		return p.parseStandaloneAssignment()
	}
	return p.parsePipelineSegment()
}

// isAssignmentStart — Identifier immediately followed by `=`/`+=` (a
// plain, non-keyword identifier): parse_command dispatches these to
// parse_standalone_assignment. `ident[..]=` (array-element write, the
// index baked into the name) also counts.
func (p *Parser) isAssignmentStart() bool {
	if p.eof() || !isIdentStart(p.peek()) {
		return false
	}
	save := p.pos
	run := p.scanIdentRun()
	for _, kw := range keywords {
		if run == kw {
			p.pos = save
			return false
		}
	}
	if p.peek() == '[' {
		// consume the bracket index (zsh-normalized — see scanBracketName)
		p.scanBracketName(run)
	}
	// the operator must IMMEDIATELY follow the name
	// (scanIdentRun/scanBracketName advanced p.pos — measure from there)
	after := byte(0)
	if p.pos < len(p.src) {
		after = p.src[p.pos]
	}
	if after == '=' {
		p.pos = save
		return true
	}
	if after == '+' || after == '/' || after == '%' {
		if p.pos+1 < len(p.src) && p.src[p.pos+1] == '=' {
			p.pos = save
			return true
		}
	}
	p.pos = save
	return false
}

// scanBracketName — `ident[...]`: consume the bracket index and return
// the full assignment-target name with the index baked in (`a[2]`). The
// index is zsh-normalized (positive integer literal → 0-based) per the
// v12 array-base decision — reads already normalize via zshIndexKey, and
// writes must too (the runner's setVar/assign index is 0-based for
// every language). Caller guarantees p.peek() == '['.
func (p *Parser) scanBracketName(run string) string {
	p.pos++ // consume [
	var idx strings.Builder
	depth := 1
	for !p.eof() && depth > 0 {
		ch := p.peek()
		if ch == '[' {
			depth++
		}
		if ch == ']' {
			depth--
			if depth == 0 {
				p.pos++
				break
			}
		}
		idx.WriteByte(ch)
		p.pos++
	}
	return run + "[" + zshIndexKey(idx.String()) + "]"
}

// parseStandaloneAssignment — mirrors parse_standalone_assignment: env
// assignments at statement start; a following command uses the
// is_command_name_token list.
func (p *Parser) parseStandaloneAssignment() (*Command, error) {
	var envs []EnvVar
	envOps := map[string]string{}
	for {
		run := p.scanIdentRun()
		name := run
		if p.peek() == '[' {
			name = p.scanBracketName(run) // `a[2]=X` — array-element write
		}
		op := "="
		if p.starts("+=") || p.starts("/=") || p.starts("%=") {
			op = p.src[p.pos : p.pos+2]
			p.pos += 2
		} else {
			p.pos++
		}
		var val *Word
		if p.eof() || isWS(p.peek()) || isNL(p.peek()) || p.peek() == ';' || p.peek() == '&' ||
			p.peek() == ')' || p.peek() == '|' {
			val = &Word{Kind: "lit", Text: ""}
		} else if p.peek() == '(' {
			elems, err := p.parseArrayElems()
			if err != nil {
				return nil, err
			}
			val = &Word{Kind: "array", ArrayName: name, ArrayElems: elems}
		} else {
			v, err := p.parseWord()
			if err != nil {
				return nil, err
			}
			val = v
		}
		envs = append(envs, EnvVar{Name: name, Val: val})
		envOps[name] = op
		p.skipInlineWSAndComments()
		if !p.isAssignmentStart() {
			break
		}
	}
	if p.hasFollowingCommandStandalone() {
		cmd, err := p.parseCommand()
		if err != nil {
			return nil, err
		}
		if cmd.Kind == "simple" {
			cmd.EnvVars = mergeEnvVars(envs, cmd.EnvVars)
			return cmd, nil
		}
		return &Command{Kind: "block", BodyCmds: []*Command{
			{Kind: "simple", Name: &Word{Kind: "lit", Text: "true"}, EnvVars: envs},
			cmd,
		}}, nil
	}
	sort.Slice(envs, func(i, j int) bool { return envs[i].Name < envs[j].Name })
	var assigns []*Command
	for _, ev := range envs {
		op := envOps[ev.Name]
		if op == "" {
			op = "="
		}
		assigns = append(assigns, &Command{Kind: "assign", AssignVar: ev.Name, AssignOp: op, AssignVal: ev.Val})
	}
	if len(assigns) == 1 {
		return assigns[0], nil
	}
	return &Command{Kind: "block", BodyCmds: assigns}, nil
}

// hasFollowingCommandStandalone — mirrors is_command_name_token.
func (p *Parser) hasFollowingCommandStandalone() bool {
	if p.eof() {
		return false
	}
	if isIdentStart(p.peek()) {
		save := p.pos
		run := p.scanIdentRun()
		isKw := false
		for _, kw := range keywords {
			if run == kw {
				isKw = true
				break
			}
		}
		if !isKw && (p.peek() == '=' || p.starts("+=") || p.starts("/=") || p.starts("%=")) {
			p.pos = save
			return false
		}
		p.pos = save
		return true
	}
	if p.peek() == '[' || p.peek() == '(' || p.peek() == '{' || p.peek() == '!' {
		return true
	}
	switch p.peekKeyword() {
	case "if", "then", "else", "elif", "fi", "while", "until", "for", "do",
		"done", "in", "function", "case", "esac", "select":
		return true
	}
	for _, b := range builtinKeywords {
		if p.atKeyword(b) {
			return true
		}
	}
	if p.atKeyword("true") || p.atKeyword("false") || p.atKeyword("shopt") {
		return true
	}
	return false
}

func (p *Parser) parseReturnTail() *Command {
	p.skipInlineWSAndComments()
	if p.eof() || isNL(p.peek()) || p.peek() == ';' || p.peek() == '|' || p.peek() == '&' {
		return &Command{Kind: "return"}
	}
	w, err := p.parseWord()
	if err != nil {
		return &Command{Kind: "return"}
	}
	return &Command{Kind: "return", RetVal: w}
}

func isWordDelim(c byte) bool {
	return c == 0 || isWS(c) || isNL(c) || strings.ContainsRune(";|&<>(){}", rune(c))
}

// parseCase — `case WORD in PAT) cmds ;; ... esac` (mirrors
// parse_case_statement).
func (p *Parser) parseCase() (*Command, error) {
	p.pos += 4 // "case"
	// discriminant: words until the `in` keyword
	var wordParts []*Word
	for {
		p.skipWSAndComments()
		if p.eof() {
			return nil, fmt.Errorf("case: expected in")
		}
		if p.atKeyword("in") {
			p.pos += 2
			break
		}
		w, err := p.parseWord()
		if err != nil {
			return nil, err
		}
		wordParts = append(wordParts, w)
	}
	var disc *Word
	if len(wordParts) == 0 {
		disc = &Word{Kind: "lit", Text: ""}
	} else if len(wordParts) == 1 {
		disc = wordParts[0]
	} else {
		// merge multiple parts into a StringInterpolation
		var parts []Part
		for _, w := range wordParts {
			switch w.Kind {
			case "lit":
				parts = append(parts, Part{IsLit: true, Lit: w.Text})
			case "var":
				parts = append(parts, Part{Var: w.VarName})
			case "cs":
				parts = append(parts, Part{CSRaw: w.Raw})
			case "interp":
				parts = append(parts, w.Parts...)
			case "pe":
				parts = append(parts, Part{PE: w})
			default:
				parts = append(parts, Part{IsLit: true, Lit: w.Text})
			}
		}
		disc = &Word{Kind: "interp", Parts: parts}
	}
	cmd := &Command{Kind: "case", CaseWord: disc}
	p.skipWSAndComments()
	for {
		p.skipWSAndComments()
		if p.eof() {
			return nil, fmt.Errorf("case: expected esac")
		}
		if p.atKeyword("esac") {
			p.pos += 4
			return cmd, nil
		}
		// patterns until `)` at depth 0
		var patterns []string
		var cur strings.Builder
		depth := 0
		for !p.eof() {
			c := p.peek()
			if c == ')' && depth == 0 {
				if strings.TrimSpace(cur.String()) != "" {
					patterns = append(patterns, strings.TrimSpace(cur.String()))
				}
				p.pos++
				break
			}
			if c == '|' && depth == 0 {
				if strings.TrimSpace(cur.String()) != "" {
					patterns = append(patterns, strings.TrimSpace(cur.String()))
				}
				cur.Reset()
				p.pos++
				p.skipInlineWS()
				continue
			}
			if c == '(' && depth == 0 && strings.TrimSpace(cur.String()) == "" {
				// optional wrapper paren
				p.pos++
				continue
			}
			if c == '(' {
				depth++
				cur.WriteByte('(')
				p.pos++
				continue
			}
			if c == ')' {
				if depth > 0 {
					depth--
					cur.WriteByte(')')
				}
				p.pos++
				continue
			}
			if c == '\\' {
				cur.WriteByte('\\')
				p.pos++
				if !p.eof() {
					cur.WriteByte(p.peek())
					p.pos++
				}
				continue
			}
			if p.starts("$(") {
				cur.WriteString("$(")
				if raw, ok := p.scanCmdSub(); ok {
					cur.WriteString(raw)
				}
				cur.WriteByte(')')
				continue
			}
			if isWS(c) {
				cur.WriteByte(' ')
				p.pos++
				continue
			}
			cur.WriteByte(c)
			p.pos++
		}
		if len(patterns) == 0 {
			return nil, fmt.Errorf("case: expected ) after pattern")
		}
		// body commands until `;;` or `esac`
		p.skipWSAndComments()
		var bodyCmds []*Command
		for {
			p.skipWSAndComments()
			if p.eof() {
				return nil, fmt.Errorf("case: expected ;; or esac")
			}
			if p.starts(";;") || p.atKeyword("esac") {
				break
			}
			if p.peek() == ';' {
				p.pos++
				continue
			}
			bc, err := p.parseCommand()
			if err != nil {
				return nil, err
			}
			bodyCmds = append(bodyCmds, bc)
		}
		if p.starts(";;") {
			p.pos += 2
		}
		cmd.CaseClauses = append(cmd.CaseClauses, CaseClause{Patterns: patterns, Body: bodyCmds})
	}
}

// parseIf — `if cond; then ...; elif ...; else ...; fi` (mirrors
// parse_if_statement: all elif branches collect, then the else, then the
// single fi; the nested If chain is built from the last elif backwards).
func (p *Parser) parseIf() (*Command, error) {
	p.pos += 2 // "if"
	cond, err := p.parseCommand()
	if err != nil {
		return nil, err
	}
	p.skipInlineWSAndComments()
	if p.peek() == ';' || isNL(p.peek()) {
		p.pos++
	}
	p.skipWSAndComments()
	if !p.atKeyword("then") {
		return nil, fmt.Errorf("if: expected then at %d", p.pos)
	}
	p.pos += 4
	p.skipWSAndComments()
	then, err := p.parseCommandListUntil([]string{"elif", "else", "fi"})
	if err != nil {
		return nil, err
	}
	type elifPair struct{ cond, then *Command }
	var elifs []elifPair
	var elseCmds []*Command
	for {
		p.skipWSAndComments()
		switch p.peekKeyword() {
		case "elif":
			p.pos += 4
			ec, err := p.parseCommand()
			if err != nil {
				return nil, err
			}
			p.skipInlineWSAndComments()
			if p.peek() == ';' || isNL(p.peek()) {
				p.pos++
			}
			p.skipWSAndComments()
			if !p.atKeyword("then") {
				return nil, fmt.Errorf("elif: expected then at %d", p.pos)
			}
			p.pos += 4
			p.skipWSAndComments()
			ebody, err := p.parseCommandListUntil([]string{"elif", "else", "fi"})
			if err != nil {
				return nil, err
			}
			elifs = append(elifs, elifPair{ec, &Command{Kind: "block", BodyCmds: ebody}})
		case "else":
			p.pos += 4
			p.skipWSAndComments()
			elseCmds, err = p.parseCommandListUntil([]string{"fi"})
			if err != nil {
				return nil, err
			}
		default:
			goto fiDone
		}
	}
fiDone:
	if !p.atKeyword("fi") {
		return nil, fmt.Errorf("if: expected fi at %d", p.pos)
	}
	p.pos += 2
	// build the nested elif chain: last elif's else = elseCmds
	var cur *Command
	if elseCmds == nil {
		cur = &Command{Kind: "block", BodyCmds: nil}
	} else {
		cur = &Command{Kind: "block", BodyCmds: elseCmds}
	}
	for i := len(elifs) - 1; i >= 0; i-- {
		cur = &Command{Kind: "if", Cond: elifs[i].cond, Then: elifs[i].then.BodyCmds, Else: cur}
	}
	return &Command{Kind: "if", Cond: cond, Then: then, Else: cur}, nil
}

// parseCommandListUntil — parse commands until a terminator keyword,
// consuming separators (; newline &) between them.
func (p *Parser) parseCommandListUntil(terms []string) ([]*Command, error) {
	var cmds []*Command
	for {
		p.skipWSAndComments()
		if p.eof() {
			break
		}
		kw := p.peekKeyword()
		stop := false
		for _, t := range terms {
			if kw == t {
				stop = true
				break
			}
		}
		if stop {
			break
		}
		if p.peek() == ')' {
			break
		}
		cmd, err := p.parseCommand()
		if err != nil {
			return nil, err
		}
		cmds = append(cmds, cmd)
		// separators
		p.skipInlineWSAndComments()
		switch {
		case p.peek() == ';':
			p.pos++
		case p.peek() == '&' && p.peekAt(1) != '&':
			if len(cmds) > 0 {
				last := cmds[len(cmds)-1]
				cmds[len(cmds)-1] = &Command{Kind: "background", BodyCmds: []*Command{last}}
			}
			p.pos++
		case isNL(p.peek()):
			for !p.eof() && isNL(p.peek()) {
				p.pos++
			}
		default:
		}
	}
	return cmds, nil
}

// parseWhile — `while cond; do body; done` / `until cond; do body; done`
func (p *Parser) parseWhile(until bool) (*Command, error) {
	if until {
		p.pos += 5 // "until"
	} else {
		p.pos += 5 // "while"
	}
	cond, err := p.parseCommand()
	if err != nil {
		return nil, err
	}
	p.skipInlineWSAndComments()
	if p.peek() == ';' || isNL(p.peek()) {
		p.pos++
	}
	p.skipWSAndComments()
	if !p.atKeyword("do") {
		return nil, fmt.Errorf("while: expected do at %d", p.pos)
	}
	p.pos += 2
	p.skipWSAndComments()
	body, err := p.parseCommandListUntil([]string{"done"})
	if err != nil {
		return nil, err
	}
	if !p.atKeyword("done") {
		return nil, fmt.Errorf("while: expected done at %d", p.pos)
	}
	p.pos += 4
	return &Command{Kind: "while", Cond: cond, Until: until, Body: body}, nil
}

// parseFor — `for var [in words]; do body; done`
func (p *Parser) parseFor() (*Command, error) {
	p.pos += 3 // "for"
	p.skipInlineWSAndComments()
	if !isIdentStart(p.peek()) {
		return nil, fmt.Errorf("for: expected variable at %d", p.pos)
	}
	name := plainIdentPrefix(p.scanIdentRun())
	var items []*Word
	p.skipInlineWSAndComments()
	if p.atKeyword("in") {
		p.pos += 2
		p.skipInlineWSAndComments()
		for !p.eof() {
			if p.peek() == ';' || isNL(p.peek()) || p.peek() == '&' || p.peek() == ')' {
				break
			}
			if p.atKeyword("do") {
				break
			}
			w, err := p.parseWord()
			if err != nil {
				return nil, err
			}
			items = append(items, w)
			p.skipInlineWSAndComments()
		}
	}
	p.skipInlineWSAndComments()
	if p.peek() == ';' || isNL(p.peek()) {
		p.pos++
	}
	p.skipWSAndComments()
	if !p.atKeyword("do") {
		return nil, fmt.Errorf("for: expected do at %d", p.pos)
	}
	p.pos += 2
	p.skipWSAndComments()
	body, err := p.parseCommandListUntil([]string{"done"})
	if err != nil {
		return nil, err
	}
	if !p.atKeyword("done") {
		return nil, fmt.Errorf("for: expected done at %d", p.pos)
	}
	p.pos += 4
	return &Command{Kind: "for", ForVar: name, Items: items, ForBody: body}, nil
}

// testOpSpaces — the lexer's test-operator tokens map to text with a
// TRAILING space in the test expression (mirror parse_test_expression).
var testOpSpaces = map[string]bool{
	"-f": true, "-d": true, "-e": true, "-r": true, "-w": true,
	"-x": true, "-s": true, "-L": true, "-h": true, "-p": true,
	"-S": true, "-b": true, "-c": true, "-g": true, "-k": true,
	"-u": true, "-O": true, "-G": true, "-N": true, "-nt": true,
	"-ot": true, "-ef": true,
}

// testOpBothSpaces — tokens that map to text with spaces BOTH sides
// (-eq/-ne/-lt/-le/-gt/-ge from Lt/Le/Gt/Ge/Eq/Ne; -n/-z from NonZero/Zero).
var testOpBothSpaces = map[string]bool{
	"-eq": true, "-ne": true, "-lt": true, "-le": true, "-gt": true,
	"-ge": true, "-n": true, "-z": true, "-a": true, "-o": true,
}

// parseBracketTest — `[ expr ]` / `[[ expr ]]` → test expression built
// from TOKEN TEXTS (whitespace dropped; mirrors parse_test_expression).
func (p *Parser) parseBracketTest(dbl bool) (*Command, error) {
	if dbl {
		p.pos += 2
	} else {
		p.pos++
	}
	var sb strings.Builder
	push := func(s string) { sb.WriteString(s) }
	for !p.eof() {
		if dbl && p.starts("]]") {
			p.pos += 2
			return &Command{Kind: "test", TestExpr: sb.String()}, nil
		}
		if !dbl && p.peek() == ']' {
			p.pos++
			return &Command{Kind: "test", TestExpr: sb.String()}, nil
		}
		c := p.peek()
		if isWS(c) || isNL(c) {
			p.pos++
			continue
		}
		if c == '#' {
			for !p.eof() && p.peek() != '\n' {
				p.pos++
			}
			continue
		}
		if c == '\\' {
			push("\\")
			p.pos++
			if !p.eof() {
				push(string(p.peek()))
				p.pos++
			}
			continue
		}
		if c == '\'' {
			// raw SQ token text (quotes included)
			start := p.pos
			p.pos++
			for !p.eof() && p.peek() != '\'' {
				p.pos++
			}
			if p.eof() {
				return nil, fmt.Errorf("test: unterminated quote")
			}
			p.pos++
			push(p.src[start:p.pos])
			continue
		}
		if c == '"' {
			// raw DQ token text (quotes + escapes as written)
			start := p.pos
			p.pos++
			for !p.eof() {
				cc := p.peek()
				if cc == '\\' && p.peekAt(1) != 0 {
					p.pos += 2
					continue
				}
				if cc == '"' {
					p.pos++
					break
				}
				if cc == '$' && p.peekAt(1) == '(' {
					if _, ok := p.scanCmdSub(); !ok {
						return nil, fmt.Errorf("test: unterminated $(")
					}
					continue
				}
				p.pos++
			}
			if p.eof() {
				return nil, fmt.Errorf("test: unterminated quote")
			}
			push(p.src[start:p.pos])
			continue
		}
		if c == '$' {
			if p.peekAt(1) == '{' {
				start := p.pos
				if _, ok := p.scanBraced(); !ok {
					return nil, fmt.Errorf("test: unterminated ${")
				}
				push(p.src[start:p.pos])
				continue
			}
			if p.starts("$(") {
				start := p.pos
				if _, ok := p.scanCmdSub(); !ok {
					return nil, fmt.Errorf("test: unterminated $(")
				}
				push(p.src[start:p.pos])
				continue
			}
			p.pos++ // $
			if !p.eof() && (isIdentStart(p.peek()) || isDigit(p.peek())) {
				push("$" + p.scanIdentRun())
			} else if !p.eof() && strings.ContainsRune("@*#?$!-", rune(p.peek())) {
				push("$" + string(p.peek()))
				p.pos++
			} else {
				push("$")
			}
			continue
		}
		if p.starts("&&") {
			push(" -a ")
			p.pos += 2
			continue
		}
		if p.starts("||") {
			push(" -o ")
			p.pos += 2
			continue
		}
		if p.starts("==") {
			push("==")
			p.pos += 2
			continue
		}
		if p.starts("=~") {
			push("=~")
			p.pos += 2
			continue
		}
		if c == '=' {
			push("=")
			p.pos++
			continue
		}
		if c == '<' || c == '>' {
			// -lt / -gt style single ops: lexer Lt/Gt tokens map to " -lt " etc.
			if p.starts("<=") {
				push(" -le ")
				p.pos += 2
			} else if p.starts(">=") {
				push(" -ge ")
				p.pos += 2
			} else if c == '<' {
				push(" -lt ")
				p.pos++
			} else {
				push(" -gt ")
				p.pos++
			}
			continue
		}
		if isIdentStart(c) || isDigit(c) {
			start := p.pos
			for !p.eof() && (isIdentChar(p.peek()) || isDigit(p.peek())) {
				p.pos++
			}
			tok := p.src[start:p.pos]
			if testOpSpaces[tok] {
				push(tok + " ")
			} else if testOpBothSpaces[tok] {
				push(" " + tok + " ")
			} else {
				push(tok)
			}
			continue
		}
		if c == '-' {
			// `-f` etc. — the lexer's test-operator tokens map to text with
			// a trailing space (parse_test_expression File/Directory/...).
			start := p.pos
			p.pos++
			for !p.eof() && isPlainIdentChar(p.peek()) {
				p.pos++
			}
			tok := p.src[start:p.pos]
			if testOpSpaces[tok] {
				push(tok + " ")
			} else if testOpBothSpaces[tok] {
				push(" " + tok + " ")
			} else {
				push(tok)
			}
			continue
		}
		// single-char tokens: ., /, +, *, ?, :, ,, [, ], !, ^, %, ~, @
		push(string(c))
		p.pos++
	}
	return nil, fmt.Errorf("test: missing closing bracket")
}

// parseArithEval — `(( expr ))` → exec let with the raw expression.
func (p *Parser) parseArithEval() (*Command, error) {
	p.pos += 2 // ((
	start := p.pos
	depth := 2
	for !p.eof() {
		c := p.peek()
		if c == '(' {
			depth++
		} else if c == ')' {
			depth--
			if depth == 0 {
				content := strings.TrimSpace(p.src[start : p.pos-1])
				p.pos++
				return &Command{Kind: "arith", ArithRaw: content}, nil
			}
		}
		p.pos++
	}
	return nil, fmt.Errorf("((: missing ))")
}

// parseSubshell — `( cmds )`
func (p *Parser) parseSubshell() (*Command, error) {
	p.pos++ // (
	p.skipWSAndComments()
	var cmds []*Command
	for {
		p.skipWSAndComments()
		if p.eof() {
			return nil, fmt.Errorf("subshell: missing )")
		}
		if p.peek() == ')' {
			p.pos++
			break
		}
		if p.peek() == ';' {
			p.pos++
			continue
		}
		cmd, err := p.parseCommand()
		if err != nil {
			return nil, err
		}
		cmds = append(cmds, cmd)
	}
	return &Command{Kind: "subshell", BodyCmds: cmds}, nil
}

// isFunctionDefAhead — non-consuming lookahead for the POSIX function
// definition `ident WS* ( WS* ) WS* {` (mirrors parse_command's
// implicit-function-definition check: identifier followed by `()` and a
// brace-open body). Only the `name() {` form is recognized — a bare
// `f()` without a brace body is not a function def.
func (p *Parser) isFunctionDefAhead() bool {
	i := p.pos
	if i >= len(p.src) || !isIdentStart(p.src[i]) {
		return false
	}
	for i < len(p.src) && isIdentChar(p.src[i]) {
		i++
	}
	for i < len(p.src) && (isWS(p.src[i]) || isNL(p.src[i])) {
		i++
	}
	if i >= len(p.src) || p.src[i] != '(' {
		return false
	}
	i++
	for i < len(p.src) && (isWS(p.src[i]) || isNL(p.src[i])) {
		i++
	}
	if i >= len(p.src) || p.src[i] != ')' {
		return false
	}
	i++
	for i < len(p.src) && (isWS(p.src[i]) || isNL(p.src[i])) {
		i++
	}
	return i < len(p.src) && p.src[i] == '{'
}

// parseFunctionDef — `name() { body }` (mirrors parse_posix_function:
// identifier, `( )`, brace-wrapped command list). The body uses the same
// brace loop as parseBlock; the returned Command carries the function
// name and the body command list.
func (p *Parser) parseFunctionDef() (*Command, error) {
	name, err := p.parseWord()
	if err != nil {
		return nil, err
	}
	// SI with a single literal part collapses to a Literal (same as the
	// command-name handling in parseSimpleCommand)
	if name.Kind == "interp" && len(name.Parts) == 1 && name.Parts[0].IsLit {
		name = &Word{Kind: "lit", Text: name.Parts[0].Lit}
	}
	if name.Kind != "lit" {
		return nil, fmt.Errorf("function: name must be a literal at %d", p.pos)
	}
	p.skipWSAndComments()
	if p.peek() != '(' {
		return nil, fmt.Errorf("function: expected '(' at %d", p.pos)
	}
	p.pos++
	p.skipWSAndComments()
	if p.peek() != ')' {
		return nil, fmt.Errorf("function: expected ')' at %d", p.pos)
	}
	p.pos++
	p.skipWSAndComments()
	body, err := p.parseBlock()
	if err != nil {
		return nil, err
	}
	return &Command{Kind: "function", FuncName: name.Text, BodyCmds: body.BodyCmds}, nil
}

// parseBlock — `{ cmds; }`
func (p *Parser) parseBlock() (*Command, error) {
	p.pos++ // {
	p.skipWSAndComments()
	var cmds []*Command
	for {
		p.skipWSAndComments()
		if p.eof() {
			return nil, fmt.Errorf("block: missing }")
		}
		if p.peek() == '}' {
			p.pos++
			break
		}
		if p.peek() == ';' {
			p.pos++
			continue
		}
		cmd, err := p.parseCommand()
		if err != nil {
			return nil, err
		}
		cmds = append(cmds, cmd)
	}
	return &Command{Kind: "block", BodyCmds: cmds}, nil
}

// parsePipelineSegment — one `|` stage (mirrors parse_pipeline_segment).
func (p *Parser) parsePipelineSegment() (*Command, error) {
	p.skipWSAndComments()
	switch p.peekKeyword() {
	case "if":
		return p.parseIf()
	case "while":
		return p.parseWhile(false)
	case "until":
		return p.parseWhile(true)
	case "for":
		return p.parseFor()
	case "case":
		return p.parseCase()
	case "function", "select":
		return nil, fmt.Errorf("unsupported construct %q", p.peekKeyword())
	}
	if p.peek() == '!' {
		p.pos++
		inner, err := p.parsePipelineSegment()
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "not", BodyCmds: []*Command{inner}}, nil
	}
	if p.starts("((") {
		return p.parseArithEval()
	}
	if p.peek() == '(' {
		return p.parseSubshell()
	}
	if p.peek() == '{' {
		return p.parseBlock()
	}
	if p.peek() == '[' {
		return p.parseBracketTest(false)
	}
	if p.starts("[[") && isWordDelim(p.peekAt(2)) {
		return p.parseBracketTest(true)
	}
	if p.atKeyword("break") {
		p.pos += 5
		return &Command{Kind: "break"}, nil
	}
	if p.atKeyword("continue") {
		p.pos += 8
		return &Command{Kind: "continue"}, nil
	}
	if p.atKeyword("return") {
		p.pos += 6
		return p.parseReturnTail(), nil
	}
	// redirect-only command: `> out`
	if p.peek() == '>' || p.peek() == '<' {
		rd, err := p.parseRedirect()
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "redirect", Inner: &Command{
			Kind: "simple", Name: &Word{Kind: "lit", Text: ""}}, Redirect: []*Redirect{rd}}, nil
	}
	return p.parseSimpleCommand()
}

// parseAndOrCont — mirrors parse_pipeline_from_command: `|` segments and
// left-associative `&&`/`||` continuation after a base command.
func (p *Parser) parseAndOrCont(first *Command) (*Command, error) {
	var result *Command
	pipeCmds := []*Command{first}
	for {
		p.skipInlineWSAndComments()
		if p.eof() {
			break
		}
		if p.peek() == '|' && p.peekAt(1) != '|' {
			p.pos++
			p.skipWSAndComments()
			seg, err := p.parsePipelineSegment()
			if err != nil {
				return nil, err
			}
			seg, err = p.parseCommandRedirects(seg)
			if err != nil {
				return nil, err
			}
			pipeCmds = append(pipeCmds, seg)
			continue
		}
		if p.starts("&&") || p.starts("||") {
			op := "&&"
			if p.starts("||") {
				op = "||"
			}
			kind := "and"
			if op == "||" {
				kind = "or"
			}
			p.pos += 2
			p.skipWSAndComments()
			var left *Command
			if len(pipeCmds) == 0 {
				left = result
			} else {
				left = flushPipeSequence(pipeCmds)
				if result != nil {
					left = &Command{Kind: kind, Op: op, Lhs: result, Rhs: left}
				}
			}
			// right side: one pipe-sequence (no further &&/||)
			seg, err := p.parsePipelineSegment()
			if err != nil {
				return nil, err
			}
			seg, err = p.parseCommandRedirects(seg)
			if err != nil {
				return nil, err
			}
			right := []*Command{seg}
			for {
				p.skipWSAndComments()
				if p.peek() == '|' && p.peekAt(1) != '|' {
					p.pos++
					p.skipWSAndComments()
					seg2, err := p.parsePipelineSegment()
					if err != nil {
						return nil, err
					}
					seg2, err = p.parseCommandRedirects(seg2)
					if err != nil {
						return nil, err
					}
					right = append(right, seg2)
				} else {
					break
				}
			}
			result = &Command{Kind: kind, Op: op, Lhs: left, Rhs: flushPipeSequence(right)}
			pipeCmds = nil
			continue
		}
		break
	}
	if result != nil {
		return result, nil
	}
	return flushPipeSequence(pipeCmds), nil
}

func flushPipeSequence(cmds []*Command) *Command {
	if len(cmds) == 1 {
		return cmds[0]
	}
	return &Command{Kind: "pipeline", Stages: cmds}
}

// parseCommandRedirects — mirrors parse_command_redirects: trailing
// redirects (fd numbers without an operator → parse error) + additional
// arguments for Simple commands.
func (p *Parser) parseCommandRedirects(cmd *Command) (*Command, error) {
	var redirects []*Redirect
	// trailing redirects
	for {
		p.skipInlineWSAndComments()
		if p.eof() {
			break
		}
		c := p.peek()
		if c == '>' || c == '<' {
			rd, err := p.parseRedirect()
			if err != nil {
				return nil, err
			}
			redirects = append(redirects, rd)
			continue
		}
		if isDigit(c) {
			rd, err := p.parseRedirect() // errors if no operator follows
			if err != nil {
				return nil, err
			}
			redirects = append(redirects, rd)
			continue
		}
		break
	}
	// additional arguments on the same line (Simple commands only)
	if cmd.Kind == "simple" {
		for {
			p.skipInlineWSAndComments()
			if p.eof() {
				break
			}
			c := p.peek()
			if isNL(c) || c == ')' || c == '}' {
				break
			}
			if c == '|' || c == '&' || c == ';' {
				break
			}
			if c == '>' || c == '<' {
				rd, err := p.parseRedirect()
				if err != nil {
					return nil, err
				}
				redirects = append(redirects, rd)
				continue
			}
			// statement-starting keywords stop the arg run
			kw := p.peekKeyword()
			switch kw {
			case "if", "case", "while", "until", "for", "function", "select",
				"then", "do", "fi", "else", "elif", "done", "esac":
				break
			default:
				goto additionalArgs
			}
			break
		additionalArgs:
			if isDigit(c) {
				// Number followed by a redirect op → fd redirect
				j := p.pos
				for j < len(p.src) && isDigit(p.src[j]) {
					j++
				}
				if j < len(p.src) && (p.src[j] == '>' || p.src[j] == '<') {
					rd, err := p.parseRedirect()
					if err != nil {
						return nil, err
					}
					redirects = append(redirects, rd)
					continue
				}
			}
			if isIdentStart(c) {
				// break if this identifier begins a standalone assignment
				save := p.pos
				run := p.scanIdentRun()
				isKw2 := false
				for _, kw2 := range keywords {
					if run == kw2 {
						isKw2 = true
						break
					}
				}
				if !isKw2 {
					pp := plainIdentPrefix(run)
					if len(pp) == len(run) && (p.peek() == '=' || p.starts("+=")) {
						p.pos = save
						break
					}
				}
				// break on a second local/declare/export command
				if run == "local" || run == "declare" || run == "export" {
					p.pos = save
					break
				}
				p.pos = save
			}
			w, err := p.parseWord()
			if err != nil {
				return nil, err
			}
			cmd.Args = append(cmd.Args, w)
		}
	}
	if len(redirects) == 0 {
		return cmd, nil
	}
	if cmd.Kind == "simple" {
		cmd.Redirect = append(cmd.Redirect, redirects...)
		return cmd, nil
	}
	return &Command{Kind: "redirect", Inner: cmd, Redirect: redirects}, nil
}

// parseSimpleCommand — env assignments + name + args + redirects
// (mirrors parse_simple_command / parse_standalone_assignment).
func (p *Parser) parseSimpleCommand() (*Command, error) {
	p.skipWSAndComments()
	// env assignment loop
	var envs []EnvVar
	envOps := map[string]string{}
	for {
		save := p.pos
		if !isIdentStart(p.peek()) {
			break
		}
		run := p.scanIdentRun()
		isKw := false
		for _, kw := range keywords {
			if run == kw {
				isKw = true
				break
			}
		}
		if isKw {
			p.pos = save
			break
		}
		name := run
		if p.peek() == '[' {
			name = p.scanBracketName(run) // `a[2]=X` — array-element write
		}
		if !(p.peek() == '=' || p.starts("+=") || p.starts("/=") || p.starts("%=")) {
			p.pos = save
			break
		}
		op := "="
		if p.starts("+=") || p.starts("/=") || p.starts("%=") {
			op = p.src[p.pos : p.pos+2]
			p.pos += 2
		} else {
			p.pos++
		}
		// value (empty when a separator follows)
		var val *Word
		if p.eof() || isWS(p.peek()) || isNL(p.peek()) || p.peek() == ';' || p.peek() == '&' ||
			p.peek() == ')' || p.peek() == '|' {
			val = &Word{Kind: "lit", Text: ""}
		} else if p.peek() == '(' {
			elems, err := p.parseArrayElems()
			if err != nil {
				return nil, err
			}
			val = &Word{Kind: "array", ArrayName: name, ArrayElems: elems}
		} else {
			v, err := p.parseWord()
			if err != nil {
				return nil, err
			}
			val = v
		}
		envs = append(envs, EnvVar{Name: name, Val: val})
		envOps[name] = op
		p.skipInlineWSAndComments()
	}
	// implicit function definition: `name() { body }` (mirrors
	// parse_command/parse_pipeline_segment's identifier lookahead →
	// parse_posix_function). Runs BEFORE the env-var handling: env
	// assignments prefixing a function def wrap into a Block, exactly
	// like the core (Block[Assignment..., Function]).
	if isIdentStart(p.peek()) && p.isFunctionDefAhead() {
		fn, err := p.parseFunctionDef()
		if err != nil {
			return nil, err
		}
		if len(envs) > 0 {
			sort.Slice(envs, func(i, j int) bool { return envs[i].Name < envs[j].Name })
			var cmds []*Command
			for _, ev := range envs {
				op := envOps[ev.Name]
				if op == "" {
					op = "="
				}
				cmds = append(cmds, &Command{Kind: "assign", AssignVar: ev.Name, AssignOp: op, AssignVal: ev.Val})
			}
			cmds = append(cmds, fn)
			return &Command{Kind: "block", BodyCmds: cmds}, nil
		}
		return fn, nil
	}
	if len(envs) > 0 {
		if p.hasFollowingCommand() {
			cmd, err := p.parseCommand()
			if err != nil {
				return nil, err
			}
			if cmd.Kind == "simple" || cmd.Kind == "builtin" {
				cmd.EnvVars = mergeEnvVars(envs, cmd.EnvVars)
				return cmd, nil
			}
			// non-simple command → Block[exec(true, envs), cmd]
			return &Command{Kind: "block", BodyCmds: []*Command{
				{Kind: "simple", Name: &Word{Kind: "lit", Text: "true"}, EnvVars: envs},
				cmd,
			}}, nil
		}
		// standalone assignments: single → assign; multiple → Block
		// (envs iterate in BTreeMap order — sorted by name)
		sort.Slice(envs, func(i, j int) bool { return envs[i].Name < envs[j].Name })
		var assigns []*Command
		for _, ev := range envs {
			op := envOps[ev.Name]
			if op == "" {
				op = "="
			}
			assigns = append(assigns, &Command{Kind: "assign", AssignVar: ev.Name, AssignOp: op, AssignVal: ev.Val})
		}
		if len(assigns) == 1 {
			return assigns[0], nil
		}
		return &Command{Kind: "block", BodyCmds: assigns}, nil
	}
	// command name
	name, err := p.parseWord()
	if err != nil {
		return nil, err
	}
	// SI with a single literal part collapses to a Literal (mirrors
	// parse_simple_command's name handling)
	if name.Kind == "interp" && len(name.Parts) == 1 && name.Parts[0].IsLit {
		name = &Word{Kind: "lit", Text: name.Parts[0].Lit}
	}
	cmd := &Command{Kind: "simple", Name: name}
	if name.Kind == "lit" {
		if isBuiltinCommandName(name.Text) {
			cmd.Kind = "builtin"
		}
	}
	var args []*Word
	var redirects []*Redirect
	if cmd.Kind == "builtin" && (name.Text == "local" || name.Text == "declare" ||
		name.Text == "typeset" || name.Text == "export") {
		args, redirects, err = p.parseLocalDeclArgs(name.Text)
		if err != nil {
			return nil, err
		}
	} else if cmd.Kind == "builtin" {
		args, redirects, err = p.parseBuiltinArgs()
		if err != nil {
			return nil, err
		}
	} else {
		args, redirects, err = p.parseSimpleArgs()
		if err != nil {
			return nil, err
		}
	}
	cmd.Args = args
	cmd.Redirect = redirects
	if cmd.Kind == "simple" || cmd.Kind == "builtin" {
		normalizeFlags(cmd)
	}
	return cmd, nil
}

// parseSimpleArgs — the main simple-command arg loop (breaks at redirects;
// the continuation runs in parseCommandRedirects).
func (p *Parser) parseSimpleArgs() ([]*Word, []*Redirect, error) {
	var args []*Word
	var redirects []*Redirect
	for {
		p.skipInlineWSAndComments()
		if p.eof() {
			break
		}
		c := p.peek()
		if isNL(c) || c == ')' {
			break
		}
		if c == '|' || c == ';' || c == '&' {
			break
		}
		if c == '>' || c == '<' {
			rd, err := p.parseRedirect()
			if err != nil {
				return nil, nil, err
			}
			redirects = append(redirects, rd)
			continue
		}
		if isDigit(c) {
			j := p.pos
			for j < len(p.src) && isDigit(p.src[j]) {
				j++
			}
			if j < len(p.src) && (p.src[j] == '>' || p.src[j] == '<') {
				rd, err := p.parseRedirect()
				if err != nil {
					return nil, nil, err
				}
				redirects = append(redirects, rd)
				continue
			}
		}
		w, err := p.parseWord()
		if err != nil {
			return nil, nil, err
		}
		args = append(args, w)
	}
	return args, redirects, nil
}

// parseBuiltinArgs — the builtin arg loop (mirrors the "Parse as builtin
// command" loop).
func (p *Parser) parseBuiltinArgs() ([]*Word, []*Redirect, error) {
	var args []*Word
	var redirects []*Redirect
	for {
		p.skipInlineWSAndComments()
		if p.eof() {
			break
		}
		c := p.peek()
		if isNL(c) || c == ')' {
			break
		}
		if c == '|' || c == ';' || c == '&' {
			break
		}
		if c == '>' || c == '<' {
			rd, err := p.parseRedirect()
			if err != nil {
				return nil, nil, err
			}
			redirects = append(redirects, rd)
			continue
		}
		if isDigit(c) {
			j := p.pos
			for j < len(p.src) && isDigit(p.src[j]) {
				j++
			}
			if j < len(p.src) && (p.src[j] == '>' || p.src[j] == '<') {
				rd, err := p.parseRedirect()
				if err != nil {
					return nil, nil, err
				}
				redirects = append(redirects, rd)
				continue
			}
		}
		w, err := p.parseWord()
		if err != nil {
			return nil, nil, err
		}
		args = append(args, w)
	}
	return args, redirects, nil
}

// parseLocalDeclArgs — the local/declare/typeset/export arg loop with
// name=value splitting (mirrors the builtin path in parse_simple_command).
func (p *Parser) parseLocalDeclArgs(cname string) ([]*Word, []*Redirect, error) {
	var args []*Word
	var redirects []*Redirect
	for {
		p.skipInlineWSAndComments()
		if p.eof() {
			break
		}
		c := p.peek()
		if isNL(c) || c == ')' {
			break
		}
		if c == '|' || c == ';' || c == '&' {
			break
		}
		if c == '>' || c == '<' {
			rd, err := p.parseRedirect()
			if err != nil {
				return nil, nil, err
			}
			redirects = append(redirects, rd)
			continue
		}
		if isDigit(c) {
			j := p.pos
			for j < len(p.src) && isDigit(p.src[j]) {
				j++
			}
			if j < len(p.src) && (p.src[j] == '>' || p.src[j] == '<') {
				rd, err := p.parseRedirect()
				if err != nil {
					return nil, nil, err
				}
				redirects = append(redirects, rd)
				continue
			}
		}
		if isIdentStart(c) {
			save := p.pos
			run := p.scanIdentRun()
			if p.peek() == '=' || p.starts("+=") {
				// assignment-style arg
				isKw := false
				for _, kw := range keywords {
					if run == kw {
						isKw = true
						break
					}
				}
				if !isKw && (p.peek() == '=' || p.starts("+=") || p.starts("/=") || p.starts("%=")) {
					varName := run
					if p.starts("+=") || p.starts("/=") || p.starts("%=") {
						p.pos += 2
					} else {
						p.pos++
					}
					// value
					var valueWord *Word
					if p.peek() == '(' {
						elems, err := p.parseArrayElems()
						if err != nil {
							return nil, nil, err
						}
						valueWord = &Word{Kind: "array", ArrayName: varName, ArrayElems: elems}
					} else if p.peek() == '$' {
						// `local x=$y` / `local x=$1` — kept LITERAL
						p.pos++
						if !p.eof() && (isIdentStart(p.peek()) || isDigit(p.peek())) {
							start := p.pos
							for !p.eof() && isPlainIdentChar(p.peek()) {
								p.pos++
							}
							valueWord = &Word{Kind: "lit", Text: "$" + p.src[start:p.pos]}
						} else {
							return nil, nil, fmt.Errorf("local: expected identifier after $")
						}
					} else if p.eof() || isWS(p.peek()) || isNL(p.peek()) || p.peek() == ';' || p.peek() == '&' {
						valueWord = &Word{Kind: "lit", Text: ""}
					} else {
						v, err := p.parseWord()
						if err != nil {
							return nil, nil, err
						}
						valueWord = v
					}
					switch valueWord.Kind {
					case "cs", "pe", "interp", "var", "arith":
						args = append(args, &Word{Kind: "lit", Text: varName + "="})
						args = append(args, valueWord)
					case "array":
						args = append(args, valueWord)
					default:
						args = append(args, &Word{Kind: "lit", Text: varName + "=" + valueWord.Text})
					}
					continue
				}
				p.pos = save
			} else {
				p.pos = save
			}
			_ = cname
		}
		w, err := p.parseWord()
		if err != nil {
			return nil, nil, err
		}
		args = append(args, w)
	}
	return args, redirects, nil
}

func isBuiltinCommandName(name string) bool {
	for _, b := range builtinKeywords {
		if name == b {
			return true
		}
	}
	return false
}

// hasFollowingCommand — mirrors the is_command_name_token check
// (parse_standalone_assignment's list).
func (p *Parser) hasFollowingCommand() bool {
	if p.eof() {
		return false
	}
	c := p.peek()
	if isIdentStart(c) {
		save := p.pos
		run := p.scanIdentRun()
		isKw := false
		for _, kw := range keywords {
			if run == kw {
				isKw = true
				break
			}
		}
		// plain identifier + = / += → another assignment → NOT a command
		if !isKw && (p.peek() == '=' || p.starts("+=") || p.starts("/=") || p.starts("%=")) {
			p.pos = save
			return false
		}
		p.pos = save
		return true
	}
	switch c {
	case '"', '\'', '$', '`', '/', '.', '-', '+', '*', '%', '\\', ':', ',',
		'~', '!', '[', '{', '(':
		return true
	}
	kw := p.peekKeyword()
	switch kw {
	case "if", "case", "while", "until", "for", "function", "select":
		return true
	}
	// builtin keywords
	if p.atKeyword("set") || p.atKeyword("unset") || p.atKeyword("export") ||
		p.atKeyword("readonly") || p.atKeyword("declare") || p.atKeyword("typeset") ||
		p.atKeyword("local") || p.atKeyword("shift") || p.atKeyword("eval") ||
		p.atKeyword("exec") || p.atKeyword("source") || p.atKeyword("trap") ||
		p.atKeyword("wait") || p.atKeyword("exit") || p.atKeyword("true") ||
		p.atKeyword("false") {
		return true
	}
	return false
}

func mergeEnvVars(a, b []EnvVar) []EnvVar {
	m := map[string]*Word{}
	for _, ev := range a {
		m[ev.Name] = ev.Val
	}
	for _, ev := range b {
		m[ev.Name] = ev.Val
	}
	var names []string
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	out := make([]EnvVar, 0, len(names))
	for _, n := range names {
		out = append(out, EnvVar{Name: n, Val: m[n]})
	}
	return out
}

// parseArrayElems — `(a b c)` array literal elements.
func (p *Parser) parseArrayElems() ([]string, error) {
	p.pos++ // (
	var elems []string
	for {
		p.skipInlineWSAndComments()
		if p.eof() {
			return nil, fmt.Errorf("array: missing )")
		}
		if p.peek() == ')' {
			p.pos++
			return elems, nil
		}
		w, err := p.parseWord()
		if err != nil {
			return nil, err
		}
		elems = append(elems, w.Text)
	}
}

// parseRedirect — one redirect (mirrors parse_redirect_header).
func (p *Parser) parseRedirect() (*Redirect, error) {
	var fd *int
	if isDigit(p.peek()) {
		start := p.pos
		for !p.eof() && isDigit(p.peek()) {
			p.pos++
		}
		if p.eof() || (p.peek() != '>' && p.peek() != '<') {
			return nil, fmt.Errorf("Invalid redirect operator")
		}
		n, _ := strconv.Atoi(p.src[start:p.pos])
		fd = &n
	}
	op := ""
	switch {
	case p.starts(">>"):
		op = "append"
		p.pos += 2
	case p.starts("<<-"):
		op = "heredoc-tabs"
		p.pos += 3
		rd, err := p.parseHeredoc(true)
		if err != nil {
			return nil, err
		}
		rd.Op = op
		return rd, nil
	case p.starts("<<<"):
		op = "herestring"
		p.pos += 3
	case p.starts("<<"):
		op = "heredoc"
		p.pos += 2
		rd, err := p.parseHeredoc(false)
		if err != nil {
			return nil, err
		}
		rd.Op = op
		return rd, nil
	case p.starts(">&"):
		op = "outerr"
		p.pos += 2
	case p.starts("<&"):
		op = "inerr"
		p.pos += 2
	case p.starts("<>"):
		op = "inout"
		p.pos += 2
	case p.peek() == '>':
		op = "out"
		p.pos++
	case p.peek() == '<':
		op = "in"
		p.pos++
	default:
		return nil, fmt.Errorf("Invalid redirect operator")
	}
	p.skipWSAndComments()
	// dup target: `2>&1` — the `&` is glued to the target digits
	if p.peek() == '&' {
		p.pos++
		start := p.pos
		for !p.eof() && (isDigit(p.peek()) || isIdentStart(p.peek())) {
			p.pos++
		}
		txt := p.src[start:p.pos]
		return &Redirect{FD: fd, Op: op, Target: &Word{Kind: "lit", Text: txt}}, nil
	}
	target, err := p.parseWord()
	if err != nil {
		return nil, err
	}
	return &Redirect{FD: fd, Op: op, Target: target}, nil
}

// parseHeredoc — `<<DELIM` body capture (mirrors the core's
// parse_heredoc_body + parse_heredoc). Called with p.pos right after the
// `<<` / `<<-` operator. The delimiter is parsed as a word on the current
// line; the body then runs from the next line until a line whose trimmed
// text equals the delimiter (the delimiter line is consumed, trailing
// newline included). For `<<-` leading tabs are stripped from each body
// line. Quoted delimiters (`<<'EOF'`, `<<"EOF"`) mark the body as
// non-interpolating.
func (p *Parser) parseHeredoc(stripTabs bool) (*Redirect, error) {
	p.skipInlineWSAndComments()
	delimWord, err := p.parseWord()
	if err != nil {
		return nil, err
	}
	delim := ""
	if text, ok := plainTextOfWord(delimWord); ok {
		delim = text
	} else {
		delim = delimWord.Text
	}
	quoted := delimWord.Quoted || delimWord.Kind == "interp"
	// consume the rest of the redirect line (incl. its newline)
	for !p.eof() && p.peek() != '\n' {
		p.pos++
	}
	if !p.eof() {
		p.pos++
	}
	// capture body lines until the delimiter line
	var body strings.Builder
	for !p.eof() {
		lineStart := p.pos
		for !p.eof() && p.peek() != '\n' {
			p.pos++
		}
		line := p.src[lineStart:p.pos]
		if strings.TrimSpace(line) == delim {
			// consume the delimiter line's trailing newline
			if !p.eof() && p.peek() == '\n' {
				p.pos++
			}
			break
		}
		if stripTabs {
			line = strings.TrimLeft(line, "\t")
		}
		body.WriteString(line)
		if !p.eof() {
			body.WriteByte('\n')
			p.pos++
		}
	}
	return &Redirect{FD: nil, Op: "heredoc", Target: delimWord, HeredocBody: body.String(), HeredocQuoted: quoted}, nil
}

// normalizeFlags — mirror parser/normalize.rs normalize_combined_flags.
var flagValueChars = map[string]string{
	"rm": "", "wc": "", "comm": "", "chmod": "", "chown": "", "cp": "",
	"mv": "", "ln": "", "rmdir": "", "tee": "", "diff": "",
	"ls": "w", "set": "o", "uniq": "fs", "head": "nc", "tail": "nc",
	"sort": "kto", "cut": "dfc", "grep": "efmABC", "egrep": "efmABC",
	"fgrep": "efmABC", "cmp": "n", "xargs": "n", "mkdir": "m", "touch": "dtr",
}

func normalizeFlags(cmd *Command) {
	if cmd.Name == nil || cmd.Name.Kind != "lit" {
		return
	}
	vf, ok := flagValueChars[cmd.Name.Text]
	if !ok {
		return
	}
	var out []*Word
	afterDD := false
	for _, arg := range cmd.Args {
		if arg.Kind != "lit" {
			out = append(out, arg)
			continue
		}
		s := arg.Text
		if afterDD {
			out = append(out, arg)
			continue
		}
		if strings.HasPrefix(s, "--") {
			if s == "--" {
				afterDD = true
			}
			out = append(out, arg)
			continue
		}
		if s == "-" || !strings.HasPrefix(s, "-") || len(s) < 2 {
			out = append(out, arg)
			continue
		}
		chars := []byte(s[1:])
		allDigits := true
		for _, ch := range chars {
			if !isDigit(ch) {
				allDigits = false
				break
			}
		}
		if allDigits {
			out = append(out, arg)
			continue
		}
		i := 0
		for i < len(chars) {
			ch := chars[i]
			if strings.ContainsRune(vf, rune(ch)) {
				out = append(out, &Word{Kind: "lit", Text: "-" + string(ch)})
				if i+1 < len(chars) {
					out = append(out, &Word{Kind: "lit", Text: string(chars[i+1:])})
				}
				i = len(chars)
			} else {
				out = append(out, &Word{Kind: "lit", Text: "-" + string(ch)})
				i++
			}
		}
	}
	cmd.Args = out
}
