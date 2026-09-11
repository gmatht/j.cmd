// Package batshgo — Windows batch (.bat) source -> A1 shIR JSON.
//
// Frontends parse; they do not optimize. This frontend emits the
// language-neutral A1 contract (frontends/plan.md §0); the core consumes
// it (shir_json_in.rs) and the backends render. The core does NOT parse
// batch, so the go-sh style oracle applies: the emitted JSON must be
// accepted by the core's deserializer (--shir-in-estree) and render/run
// correctly through the backends — see Makefile `test`.
//
// v1 subset (REFUSE > GUESS — anything unlisted errors loudly):
//
//	@echo off, rem/:: comments, :label / goto, echo [text] / echo. /
//	echo:, set VAR=value / set "VAR=value" / set VAR= (empty),
//	set /a VAR=expr (Int + - * / % parens, %var% operands),
//	%var% expansion (case-insensitive), %1..%9, %*, %% literal,
//	%errorlevel% (mapped to the shell's $? — getVar("?")),
//	if [not] A==B (cmd) [else (cmd)] — else only with the parenthesized
//	form (real cmd requires the else on the closing-paren line),
//	for %%v in (word list) do cmd|(cmd), `&` statement separators.
//
// v1.2: `&&` / `||` conjunctions (the A1 BinOp And/Or shape), `|`
// pipelines (the A1 pipeline Call), `shift`, and the `ren *.EXT *.NEW`
// extension-change pattern form (For + SH2GLOB + basename capture).
//
// Deliberately NOT in v1 (refuse loud): delayed expansion !var!, call,
// setlocal/endlocal, pause, start, set /p, for /d /r, for /f with
// skip=/eol=/usebackq, ^ inline escapes.
package batshgo

import (
	"fmt"
	"strings"

	shiremit "github.com/gmatht/sh2loop/frontends/shir-emit-go"
)

// Shir — the fleet entry point (src → A1 shIR JSON bytes), the same
// contract every other frontend (c/fish/go/py/zsh/…) exposes to the
// merged busybox dispatcher. bat-sh-go upstream refactored to the
// library Parse → shared shir-emit-go Emit split; this thin adapter
// keeps the busybox merge uniform (one Shir per frontend).
func Shir(src string) ([]byte, error) {
	prog, err := Parse(src)
	if err != nil {
		return nil, err
	}
	return shiremit.Emit(prog)
}

// Parse parses batch source into an A1 shIR program.
func Parse(src string) (*shiremit.Program, error) {
	lines := strings.Split(src, "\n")
	main, subs, gotoTargets := splitSections(lines)
	// main flow (label sections NOT in the called-subroutine set stay
	// inline — batch falls through labels, so goto-targets must remain)
	p := newParser(main, gotoTargets)
	mainStmts, err := p.parseBlock(false)
	if err != nil {
		return nil, err
	}
	// called subroutines -> A1 Function stmts BEFORE the main flow (the
	// estree renders them as registrations; the main flow runs after)
	var fnStmts []map[string]any
	for _, sub := range subs {
		name, bodyLines := sub[0], sub[1]
		sp := newParser(strings.Split(bodyLines, "\n"), gotoTargets)
		sp.inSub = true
		body, err := sp.parseBlock(false)
		if err != nil {
			return nil, fmt.Errorf("subroutine %s: %v", name, err)
		}
		fnStmts = append(fnStmts, map[string]any{
			"type": "Function", "name": name, "body": body,
		})
	}
	return &shiremit.Program{Stmts: append(fnStmts, mainStmts...)}, nil
}

// splitSections — top-level `:label` lines partition the file into the
// main flow and subroutine sections. Only labels that are `call :label`
// targets are extracted (subs); the rest stay inline in main. `^`
// continuations are joined first; paren depth is tracked so a `:x`
// inside a `( ... )` block is not a label.
func splitSections(lines []string) (main []string, subs [][2]string, gotoTargets map[string]bool) {
	gotoTargets = map[string]bool{}
	// join ^ continuations (mirror the parser: skip empty lines)
	var joined []string
	for _, l := range lines {
		if len(joined) > 0 && strings.HasSuffix(strings.TrimSpace(joined[len(joined)-1]), "^") {
			// cmd's `^`+CRLF escapes the newline with NO separator — the
			// continued line's own leading whitespace is preserved
			// (echo one^ + two -> "onetwo"; echo one^ + " two" -> "one two")
			joined[len(joined)-1] = strings.TrimSuffix(joined[len(joined)-1], "^") + l
			continue
		}
		joined = append(joined, l)
	}
	// label boundaries at paren depth 0, plus the called-label set
	var bounds []int
	var names []string
	called := map[string]bool{}
	depth := 0
	for i, l := range joined {
		ln := strings.TrimSpace(l)
		if ln != "" && strings.HasPrefix(ln, ":") && !strings.HasPrefix(ln, "::") && depth == 0 {
			bounds = append(bounds, i)
			names = append(names, strings.ToLower(strings.TrimSpace(ln[1:])))
			continue
		}
		// scan the line for `call :label` and `goto label` references
		low := strings.ToLower(ln)
		for {
			k := strings.Index(low, "call :")
			g := strings.Index(low, "goto ")
			if k < 0 && g < 0 {
				break
			}
			if g >= 0 && (k < 0 || g < k) {
				// goto <name> (not :eof); `goto :name` — the colon is optional
				// in batch and stripped for the target key
				j := g + len("goto ")
				if j < len(low) && low[j] == ':' {
					j++
				}
				e := j
				for e < len(low) && isNameChar(low[e]) {
					e++
				}
				if e > j {
					tgt := low[j:e]
					if tgt != "eof" {
						gotoTargets[tgt] = true
					}
				}
				low = low[e:]
			} else {
				j := k + len("call :")
				e := j
				for e < len(low) && (isNameChar(low[e]) || low[e] == ':') {
					e++
				}
				if e > j {
					called[low[j:e]] = true
				}
				low = low[e:]
			}
		}
		depth += strings.Count(ln, "(") - strings.Count(ln, ")")
	}
	// walk the sections: pre-first-label lines + non-called sections
	// inline; called sections extracted. A called section CONSUMES the
	// immediately following goto-target sections into its function body:
	// batch falls through labels, so `call :power` enters the setup lines
	// and then `goto :power_loop` loops INSIDE the function — the classic
	// function-with-inner-loop shape (`call :power 2 4` / `:power` /
	// `setlocal` / ... / `:power_loop` / `if ... goto :power_loop`).
	// Leaving the loop section inline in main would make it dead code
	// after the main flow's own `goto :eof` (t51 shift test).
	start := 0
	for bi, b := range bounds {
		if start >= len(joined) {
			break // a called section swallowed through EOF — nothing left
		}
		main = append(main, joined[start:b]...)
		name := names[bi]
		sectionEnd := len(joined)
		if bi+1 < len(bounds) {
			sectionEnd = bounds[bi+1]
		}
		if called[name] {
			// swallow following goto-target sections (their label lines
			// become Label stmts inside the function via parseLine)
			end := bi + 1
			for end < len(bounds) && gotoTargets[names[end]] {
				end++
			}
			// end == len(bounds) means the function swallows to EOF —
			// RESET the earlier bounds[bi+1] default (the bug that left
			// :loopargs' body empty when its loop label is the LAST section)
			sectionEnd = len(joined)
			if end < len(bounds) {
				sectionEnd = bounds[end]
			}
			bodyLines := joined[b+1 : sectionEnd]
			subs = append(subs, [2]string{name, strings.Join(bodyLines, "\n")})
			start = sectionEnd
			// NOTE: the consumed sections' labels now live inside the
			// function only — a `goto` from main to one of them would be
			// a cross-scope jump the restructure pass cannot honor (not
			// observed in the corpus; refuse > guess if it appears).
			continue
		}
		bodyLines := joined[b+1 : sectionEnd]
		main = append(main, joined[b])
		main = append(main, bodyLines...)
		start = sectionEnd
	}
	if len(bounds) == 0 {
		main = joined
	} else {
		main = append(main, joined[start:]...)
	}
	return main, subs, gotoTargets
}

type parser struct {
	lines       []string
	idx         int
	forVars     map[string]bool
	gotoTargets map[string]bool // labels that `goto` targets (others are fall-through no-ops)
	inSub       bool            // parsing a called-subroutine body (goto :eof -> Return)
}

func newParser(lines []string, gotoTargets map[string]bool) *parser {
	if gotoTargets == nil {
		gotoTargets = map[string]bool{}
	}
	return &parser{lines: lines, forVars: map[string]bool{}, gotoTargets: gotoTargets}
}

// parseBlock reads statements until EOF, or until a bare `)` line when
// inBlock. Each line may hold several `&`-separated commands.
func (p *parser) parseBlock(inBlock bool) ([]map[string]any, error) {
	var out []map[string]any
	for p.idx < len(p.lines) {
		line := strings.TrimSpace(p.lines[p.idx])
		p.idx++
		if line == "" {
			continue
		}
		if inBlock && line == ")" {
			return out, nil
		}
		// `^` end-of-line continuation (v1.1): joins the next non-empty
		// line; comments are exempt; inline `^` escapes refuse.
		for strings.HasSuffix(line, "^") &&
			!strings.HasPrefix(line, "::") &&
			!strings.HasPrefix(strings.ToLower(line), "rem ") && line != "rem" {
			line = strings.TrimSuffix(line, "^")
			for p.idx < len(p.lines) {
				next := strings.TrimSpace(p.lines[p.idx])
				p.idx++
				if next != "" {
					line += " " + next
					break
				}
			}
		}
		st, err := p.parseLine(line)
		if err != nil {
			return nil, err
		}
		out = append(out, st...)
	}
	if inBlock {
		return nil, fmt.Errorf("unterminated ( block")
	}
	return out, nil
}

// parseLine handles a full line: comments, labels, @-prefix, then the
// `&`-separated commands.
func (p *parser) parseLine(line string) ([]map[string]any, error) {
	if strings.HasPrefix(line, "@") {
		line = strings.TrimSpace(line[1:])
	}
	if line == "" {
		return nil, nil
	}
	if strings.HasPrefix(line, "::") || strings.HasPrefix(strings.ToLower(line), "rem ") || strings.ToLower(line) == "rem" {
		return nil, nil
	}
	if strings.HasPrefix(line, ":") {
		name := strings.ToLower(strings.TrimSpace(line[1:]))
		if name != "eof" && p.gotoTargets[name] {
			return []map[string]any{{"type": "Label", "name": name}}, nil
		}
		// fall-through marker — nothing jumps here: no-op (the following
		// lines stay inline, matching batch's fall-through semantics)
		return nil, nil
	}
	var out []map[string]any
	rest := line
	prevOp := "" // the operator that connected the last segment to the next
	first := true
	for {
		rest = strings.TrimSpace(rest)
		if rest == "" {
			break
		}
		var st []map[string]any
		var op, after string
		low := strings.ToLower(rest)
		if strings.HasPrefix(rest, "(") || strings.HasPrefix(low, "for ") {
			// atomic forms: a leading ( compound group, or a `for` line
			// whose /f 'command' may contain &/| at "top level" (`for /f
			// %%i in ('a ^& b')`). parseAtomic splits at TOP-LEVEL pipes
			// only (" and ' aware), so the quoted /f command survives; the
			// operator AFTER the group/for comes back on the remainder.
			var err error
			st, op, after, err = p.parseAtomic(rest)
			if err != nil {
				return nil, err
			}
			rest = strings.TrimSpace(after)
		} else {
			seg, op0, after0 := cutCompound(rest)
			op, after = op0, after0
			var err error
			st, err = p.parseSegment(seg)
			if err != nil {
				return nil, err
			}
			rest = strings.TrimSpace(after)
		}
		if first {
			out = append(out, st...)
			first = false
		} else if prevOp == "&" {
			out = append(out, st...)
		} else if prevOp == "&&" || prevOp == "||" {
			// the A1 conjunction shape (BinOp And/Or between exec Calls —
			// byte-identical to the core's `a && b` / `a || b` emission);
			// both sides must be plain commands (refuse > guess).
			if len(st) != 1 {
				return nil, fmt.Errorf("unsupported: %s right operand must be a single command", prevOp)
			}
			if len(out) == 0 {
				return nil, fmt.Errorf("unsupported: %s with no left operand", prevOp)
			}
			combined, ok := andOrStmt(prevOp, out[len(out)-1], st[0])
			if !ok {
				return nil, fmt.Errorf("unsupported: %s operands must be plain commands (no blocks/redirects/pipelines)", prevOp)
			}
			out[len(out)-1] = combined
		} else {
			return nil, fmt.Errorf("unexpected operator %q", prevOp)
		}
		prevOp = op
	}
	if prevOp != "" && !first {
		return nil, fmt.Errorf("trailing operator %q", prevOp)
	}
	return out, nil
}

// parseSegment — parse one operator-free segment (which may contain `|`
// pipelines). A single stage is a plain command; multiple stages become
// the A1 pipeline Call (the core's `a | b` shape). Each stage must be
// exactly one plain command (a redirect or paren stage would need the
// redirect/pipeline composition the A1 cannot express — refuse > guess).
func (p *parser) parseSegment(seg string) ([]map[string]any, error) {
	seg = strings.TrimSpace(seg)
	if seg == "" {
		return nil, fmt.Errorf("empty command")
	}
	stages := splitPipes(seg)
	if len(stages) == 1 {
		st, rem, err := p.parseCommand(stages[0])
		if err != nil {
			return nil, err
		}
		if rem != "" {
			return nil, fmt.Errorf("trailing text after command: %q", rem)
		}
		return st, nil
	}
	var perStage [][]map[string]any
	for _, s := range stages {
		s = strings.TrimSpace(s)
		if s == "" {
			return nil, fmt.Errorf("empty pipeline stage")
		}
		st, rem, err := p.parseCommand(s)
		if err != nil {
			return nil, err
		}
		if rem != "" {
			return nil, fmt.Errorf("pipeline stage must be one command: %q", s)
		}
		perStage = append(perStage, st)
	}
	pl, err := pipelineStmt(perStage)
	if err != nil {
		return nil, err
	}
	return []map[string]any{pl}, nil
}

// parseAtomic — parse a leading-( group or a `for` line: split at
// top-level pipes (quote-aware for " and '), parse each stage as one
// command. The LAST stage's parseCommand remainder carries the operator
// after the atomic (cutOp), which the caller folds. Returns the
// statements, the operator and the rest after it.
func (p *parser) parseAtomic(rest string) ([]map[string]any, string, string, error) {
	stages := splitPipes(rest)
	var perStage [][]map[string]any
	op, after := "", ""
	for i, s := range stages {
		s = strings.TrimSpace(s)
		if s == "" {
			return nil, "", "", fmt.Errorf("empty pipeline stage")
		}
		st, rem, err := p.parseCommand(s)
		if err != nil {
			return nil, "", "", err
		}
		if i == len(stages)-1 {
			op, after = cutOp(rem)
		} else if rem != "" {
			return nil, "", "", fmt.Errorf("pipeline stage must be one command: %q", s)
		}
		perStage = append(perStage, st)
	}
	if len(perStage) == 1 {
		return perStage[0], op, after, nil
	}
	pl, err := pipelineStmt(perStage)
	if err != nil {
		return nil, "", "", err
	}
	return []map[string]any{pl}, op, after, nil
}

// pipelineStmt — the A1 pipeline Call over per-stage statement lists;
// each stage must be exactly one plain Expr(exec) statement (the core's
// `a | b` shape — probed with `otranspilerl-cli --shir`).
func pipelineStmt(perStage [][]map[string]any) (map[string]any, error) {
	var arrows []map[string]any
	for _, st := range perStage {
		if len(st) != 1 || st[0]["type"] != "Expr" {
			return nil, fmt.Errorf("pipeline stage must be a plain command (no blocks/redirects)")
		}
		arrows = append(arrows, map[string]any{"type": "Arrow", "body": st})
	}
	return map[string]any{
		"type": "Expr",
		"expr": map[string]any{
			"type": "Call", "func": "pipeline",
			"args":   []any{map[string]any{"type": "Array", "elements": arrows}},
			"purity": "Spawn",
		},
	}, nil
}

// parseCommand parses one command; returns its statements and the
// unconsumed remainder of the line (after `&`/`else` handling).
func (p *parser) parseCommand(s string) ([]map[string]any, string, error) {
	if s == "" {
		return nil, "", nil
	}
	if strings.HasPrefix(s, "(") {
		// bare ( block )
		inner, rest, err := p.parseParenBlock(s)
		if err != nil {
			return nil, "", err
		}
		return []map[string]any{{"type": "Block", "body": inner}}, rest, nil
	}
	word, rest := splitWord(s)
	w := strings.ToLower(word)
	if strings.HasPrefix(w, "echo") && len(w) > 4 {
		if c := w[4]; c == '.' || c == ':' || c == '\\' {
			// `echo.` / `echo:` / `echo\` — blank-line forms (the dot/colon
			// is glued to the command in batch)
			return []map[string]any{execStmt([]map[string]any{str("echo")}, "Emulable")}, "", nil
		}
	}
	switch w {
	case "echo":
		return p.parseEcho(rest)
	case "set":
		return p.parseSet(rest)
	case "if":
		return p.parseIf(rest)
	case "for":
		return p.parseFor(rest)
	case "goto":
		t := strings.TrimSpace(rest)
		if strings.EqualFold(t, ":eof") {
			// goto :eof — end of the current subroutine (Return) or the
			// whole file at top level (Exit with the current status)
			if p.inSub {
				return []map[string]any{{"type": "Return", "value": nil}}, "", nil
			}
			return []map[string]any{{"type": "Exit", "value": nil}}, "", nil
		}
		return []map[string]any{{"type": "Goto", "name": strings.ToLower(strings.TrimPrefix(t, ":"))}}, "", nil
	case "exit":
		return p.parseExit(rest)
	case "rem":
		return nil, "", nil
	case "call":
		rest = strings.TrimSpace(rest)
		if strings.HasPrefix(rest, ":") {
			// call :label [args] — a subroutine call: exec the (sanitized)
			// function name with the args; the estree runner binds them to
			// %%1..%%9 via the positional array before running the body.
			name, args := splitWord(rest[1:])
			name = strings.ToLower(name)
			words := []map[string]any{str(name)}
			if a, err := splitWords(args, p.forVars); err != nil {
				return nil, "", err
			} else {
				words = append(words, a...)
			}
			return []map[string]any{execStmt(words, "Emulable")}, "", nil
		}
		return nil, "", fmt.Errorf("unsupported: call <file> (v1.1 supports call :label only)")
	case "shift":
	// shift — move the positional args along (%1 becomes %2, ...; %* is
	// unaffected). The core's own bash `shift` lowers to exactly this
	// exec Call (probed: `otranspilerl-cli --shir` emits exec "shift"), and the
	// estree runner's shift builtin shifts the CALL-scoped positional
	// array (a call :label pushes a fresh scope), matching cmd.
	return []map[string]any{execStmt([]map[string]any{str("shift")}, "Emulable")}, "", nil
case "setlocal", "endlocal", "pause", "start", "pushd", "popd":
		return nil, "", fmt.Errorf("unsupported batch command %q (v1 subset)", strings.ToLower(word))
	default:
		// external command: batch builtin -> POSIX name mapping (names +
		// common flags), then simple `> file` / `2>> file` redirects.
		wl := strings.ToLower(word)
		if wl == "cls" || wl == "title" {
			return nil, "", nil // no-op outside Windows
		}
		// `copy a b & echo x` — the statement operator splits the args
		before, op, after := cutCompound(rest)
		rem := ""
		if strings.TrimSpace(after) != "" {
			rem = op + " " + strings.TrimSpace(after)
		}
		rest = before
		if mapped, ok := batchToPosix[wl]; ok {
			// real batch writes paths with `\` separators (cmd's `/` is the
			// flag prefix — `copy batcmd/a.txt` parses `/a` as a switch);
			// normalize to `/` for the POSIX targets, scoped to mapped
			// builtins only (echo text etc. keeps backslashes verbatim).
			rest = normalizeBatchPaths(rest)
			if wl == "ren" || wl == "rename" {
				// the wildcard pattern form `ren *.cxx *.cpp` — a For loop
				// with a basename-derived destination (v1.2, the user-asked
				// subset; everything else refuses below)
				if loop, isPattern, err := p.renPatternLoop(rest); err != nil {
					return nil, rem, err
				} else if isPattern {
					return loop, rem, nil
				}
			}
			word, rest = translateBatchCmd(wl, mapped, rest)
			// batch `ren OLD newname` — the bare destination resolves
			// relative to OLD's directory (mv would drop it in the cwd)
			if wl == "ren" || wl == "rename" {
				if dir, base, ok := strings.Cut(rest, " "); ok && !strings.Contains(base, "/") {
					if i := strings.LastIndex(dir, "/"); i >= 0 {
						rest = dir + " " + dir[:i+1] + base
					}
				}
			}
			w = mapped
		} else if wl == "find" && rest != "" {
			// batch `find "text" files...` (literal-string search) -> grep -F.
			// cmd strips the enclosing quotes from the search term when it
			// builds the argv (`find "beta"` searches beta) — strip a
			// leading quoted segment here too, or grep would match the
			// literal quote characters and find nothing (t52 pipeline).
			t := strings.TrimSpace(rest)
			if strings.HasPrefix(t, "\"") {
				if qe := strings.Index(t[1:], "\""); qe >= 0 {
					t = t[1:1+qe] + t[1+qe+1:]
				}
			}
			word, rest = "grep", "-F "+t
		} else if wl == "robocopy" {
			// robocopy SRC DST [file...] [options] — an approximation (like
			// xcopy): /S /E -> cp -r; /MIR /PURGE -> rsync -a --delete
			rest = normalizeBatchPaths(rest)
			var err error
			word, rest, err = translateRobocopy(rest)
			if err != nil {
				return nil, rem, err
			}
		}
		words, err := splitWords(word+" "+rest, p.forVars)
		if err != nil {
			return nil, rem, err
		}
		if red, ok := wrapRedirect(words); ok {
			return red, rem, nil
		}
		return []map[string]any{execStmt(words, "Spawn")}, rem, nil
	}
}

// renPatternLoop — the `ren *.cxx *.cpp` extension-change pattern form
// (v1.2). Both arguments must be wildcard patterns of the exact shape
// `*.EXT` (a single leading `*`, then `.EXT` with no further wildcards,
// no path separators, no quotes). Lowering — the A1 loop
//
//	for f in *.cxx; do mv "$f" "$(basename "$f" .cxx).cpp"; done
//
// (a SH2GLOB-wrapped For iter so BOTH backends glob, and a basename
// capture for the destination: basename strips the LAST suffix, the
// exact cmd rule — `a.cxx.cxx` renames to `a.cxx.cpp`, not `a.cpp.cxx`
// — where a first-occurrence replace would diverge). Returns
// (stmts, isPattern, err): isPattern=false means the bare-file form (the
// caller's existing path); isPattern=true with err!=nil means a wildcard
// form OUTSIDE the pinned subset — refuse loudly (refuse > guess; cmd's
// positional-* / `?` mapping for `ren *old* *new*` / `ren file?.txt
// file?.md` is not reproduced).
func (p *parser) renPatternLoop(rest string) ([]map[string]any, bool, error) {
	src, rest2 := splitWord(rest)
	dst, rest3 := splitWord(rest2)
	if strings.TrimSpace(rest3) != "" {
		// more than two arguments — refuse (a quoted pattern would also
		// land here with the quote as a leading char of dst/rest3)
		if strings.ContainsAny(src, "*?") || strings.ContainsAny(dst, "*?") {
			return nil, true, fmt.Errorf("unsupported ren pattern form (v1.2 pins `ren *.EXT *.NEW` with exactly two patterns)")
		}
		return nil, false, nil
	}
	if !strings.ContainsAny(src, "*?") || !strings.ContainsAny(dst, "*?") {
		return nil, false, nil // bare-file form — existing path
	}
	sExt, ok := extPattern(src)
	if !ok {
		return nil, true, fmt.Errorf("unsupported ren source pattern %q (v1.2 pins `ren *.EXT *.NEW`)", src)
	}
	dExt, ok := extPattern(dst)
	if !ok {
		return nil, true, fmt.Errorf("unsupported ren destination pattern %q (v1.2 pins `ren *.EXT *.NEW`)", dst)
	}
	lv := "f"
	destExpr := map[string]any{
		"type": "Interpolate",
		"parts": []any{
			map[string]any{"kind": "expr", "expr": map[string]any{
				"type": "Call", "func": "capture",
				"args": []any{map[string]any{"type": "Arrow", "body": []any{
					execStmt([]map[string]any{str("basename"), getVar(lv), str("." + sExt)}, "Emulable"),
				}}},
				"purity": "Spawn",
			}},
			map[string]any{"kind": "lit", "text": "." + dExt},
		},
	}
	body := []map[string]any{execStmt([]map[string]any{str("mv"), getVar(lv), destExpr}, "Spawn")}
	loop := map[string]any{
		"type": "For",
		"var":  lv,
		"iter": map[string]any{"type": "Array", "elements": []any{str("\x01SH2GLOB\x01" + src)}},
		"body": body,
	}
	return []map[string]any{loop}, true, nil
}

// extPattern — match the `*.EXT` shape: a single leading `*`, a `.`, then
// extension letters with no further wildcards, separators or quotes.
// Returns the extension text (without the dot).
func extPattern(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if len(s) < 3 || s[0] != '*' {
		return "", false
	}
	if s[1] != '.' {
		return "", false
	}
	ext := s[2:]
	if ext == "" {
		return "", false
	}
	for i := 0; i < len(ext); i++ {
		c := ext[i]
		if c == '*' || c == '?' || c == '/' || c == '\\' || c == '"' || c == ' ' || c == '\t' {
			return "", false
		}
	}
	return ext, true
}

// batchToPosix — batch builtin commands -> their POSIX equivalents (the
// names differ; the flags are translated by translateBatchCmd). The
// estree runner's exec allowlist derives from the SOURCE text, so a
// batch script using these should mention the posix names in a comment.
var batchToPosix = map[string]string{
	"copy": "cp", "del": "rm", "erase": "rm", "type": "cat",
	"move": "mv", "ren": "mv", "rename": "mv", "rd": "rmdir",
	"md": "mkdir", "dir": "ls", "where": "which", "xcopy": "cp",
	"ver": "uname",
}

// isRedirectTok — is this a redirect operator token (`>f`, `>>f`,
// `2>f`)? Flag-argument consumers must stop at them.
func isRedirectTok(tok string) bool {
	if strings.HasPrefix(tok, ">") {
		return true
	}
	return len(tok) > 1 && tok[0] >= '0' && tok[0] <= '9' && tok[1] == '>'
}

// translateRobocopy — robocopy SRC DST [file...] [options] -> rsync
// (a documented approximation, like xcopy — robocopy's own status output
// is silenced with `>nul` in the corpus).
//   /S /E             -> rsync -a SRC/ DST              (recursive copy)
//   /MIR /PURGE       -> rsync -a --delete SRC/ DST     (mirror/purge)
//   (no recursion)    -> rsync -a --exclude='*/' --include='*' SRC/ DST
//                       (top-level files only — robocopy's default)
//   /MOV /MOVE        -> rsync -a --remove-source-files SRC/ DST
//                       (/MOVE leaves the emptied source dirs behind)
//   /L                -> rsync -an (dry run; nothing is copied)
//   file filters      -> --include=F... --include='*/' --exclude='*'
//                       (recursive filtered copy — robocopy's
//                       top-level-only filtered form is not reproduced)
//   /XD dirs /XF files-> --exclude=... per item
//   /LOG:file         -> --log-file=file (robocopy's log format differs)
// Retry/wait/thread/attribute and output-quiet flags are dropped (they do
// not change the copied result); redirect tokens (`>nul`) pass through to
// splitWords/wrapRedirect; anything semantics-changing refuses.
func translateRobocopy(rest string) (string, string, error) {
	var pos []string
	var redirects []string
	var xd, xf []string
	var logFile string
	recursive := false
	mirror := false
	move := false
	dryRun := false
	toks := strings.Fields(rest)
	for i := 0; i < len(toks); i++ {
		tok := toks[i]
		low := strings.ToLower(tok)
		switch {
		case strings.HasPrefix(tok, "/") && len(tok) > 1:
			switch {
			case low == "/s" || low == "/e":
				recursive = true
			case low == "/mir" || low == "/purge":
				mirror = true
			case low == "/mov" || low == "/move":
				move = true
			case low == "/l":
				dryRun = true
			case low == "/xd":
				for i+1 < len(toks) && !strings.HasPrefix(toks[i+1], "/") &&
					!isRedirectTok(toks[i+1]) {
					i++
					xd = append(xd, toks[i])
				}
			case low == "/xf":
				for i+1 < len(toks) && !strings.HasPrefix(toks[i+1], "/") &&
					!isRedirectTok(toks[i+1]) {
					i++
					xf = append(xf, toks[i])
				}
			case strings.HasPrefix(low, "/log:"):
				logFile = tok[len("/log:"):]
			case strings.HasPrefix(low, "/log+:"):
				logFile = tok[len("/log+:"):] // append mode — rsync truncates (approximation)
			case strings.HasPrefix(tok, "/R:") || strings.HasPrefix(tok, "/W:") ||
				strings.HasPrefix(tok, "/MT:") || strings.HasPrefix(tok, "/COPY:") ||
				strings.HasPrefix(tok, "/DCOPY:"):
				// retries / wait / threads / attribute-copy flags — no effect
				// on the copied file set
			case tok == "/Z" || tok == "/B" || tok == "/IS" || tok == "/IT" ||
				tok == "/XJ" || tok == "/NFL" || tok == "/NDL" || tok == "/NJH" ||
				tok == "/NJS" || tok == "/NP" || tok == "/NC" || tok == "/NS" ||
				tok == "/NJ":
				// restartable / backup / quiet flags — no effect on the result
			default:
				return "", "", fmt.Errorf("unsupported robocopy option %q (v1.1: /S /E /MIR /PURGE /MOV /MOVE /L /XD /XF /LOG + retry/quiet flags)", tok)
			}
		case strings.HasPrefix(tok, ">") || (len(tok) > 1 && tok[0] >= '0' && tok[0] <= '9' && tok[1] == '>'):
			redirects = append(redirects, tok)
		default:
			pos = append(pos, tok)
		}
	}
	if len(pos) < 2 {
		return "", "", fmt.Errorf("robocopy needs SRC and DST: %q", rest)
	}
	src, dst := pos[0], pos[1]
	filters := pos[2:]

	flags := []string{"-a"}
	if mirror {
		flags = append(flags, "--delete")
	}
	if move {
		flags = append(flags, "--remove-source-files")
	}
	if dryRun {
		flags = append(flags, "-n")
	}
	// file filters: copy only the named patterns (recursive — the
	// traversal include must come after the pattern includes)
	if len(filters) > 0 {
		for _, f := range filters {
			flags = append(flags, "--include="+f)
		}
		flags = append(flags, "--include=*/", "--exclude=*")
	} else if !recursive && !mirror {
		// robocopy's default (and /MOV without /S): top-level files
		// only — explicit filter rules to skip subdirectories (rsync
		// --no-recursive skips the source dir itself, so filter rules
		// are required)
		flags = append(flags, "--exclude=*/", "--include=*")
	}
	// /XD dirs /XF files -> rsync excludes
	for _, d := range xd {
		flags = append(flags, "--exclude="+d)
	}
	for _, f := range xf {
		flags = append(flags, "--exclude="+f)
	}
	if logFile != "" {
		flags = append(flags, "--log-file="+logFile)
	}
	suffix := ""
	if len(redirects) > 0 {
		suffix = " " + strings.Join(redirects, " ")
	}
	// rsync for all modes: the estree runtime's cp builtin is a
	// single-file fs.copyFile (no -r), so recursive copy needs the real
	// rsync binary (allowlisted via the source text's posix comment).
	return "rsync", strings.Join(flags, " ") + " " + strings.TrimSuffix(src, "/") + "/ " + dst + suffix, nil
}

// normalizeBatchPaths — `\` path separators -> `/` in the non-flag
// tokens of a mapped builtin's args (cmd parses `/x` as a switch, so
// real batch paths use backslashes; the POSIX targets need slashes).
func normalizeBatchPaths(s string) string {
	var out []string
	for _, tok := range strings.Fields(s) {
		if strings.HasPrefix(tok, "/") && len(tok) > 1 {
			out = append(out, tok)
		} else {
			out = append(out, strings.ReplaceAll(tok, "\\", "/"))
		}
	}
	return strings.Join(out, " ")
}

// translateBatchCmd maps a mapped command's batch flags to POSIX
// equivalents (`dir /b` -> `ls -1`, `del /q` -> `rm -f`, ...). Unknown
// flags pass through untouched (conservative — never guess).
func translateBatchCmd(batch, posix, rest string) (string, string) {
	var out []string
	for _, tok := range strings.Fields(rest) {
		if strings.HasPrefix(tok, "/") && len(tok) > 1 {
			f := tok[1:]
			switch batch {
			case "dir":
				switch f {
				case "b":
					out = append(out, "-1")
				case "s":
					out = append(out, "-R")
				case "a":
					out = append(out, "-a")
				case "w":
					out = append(out, "-C")
				default:
					out = append(out, tok)
				}
			case "del", "erase":
				switch f {
				case "q", "f":
					out = append(out, "-f")
				case "s":
					out = append(out, "-r")
				default:
					out = append(out, tok)
				}
			case "copy", "move", "xcopy":
				switch f {
				case "y":
					out = append(out, "-f")
				case "s", "e":
					if batch == "xcopy" {
						out = append(out, "-r")
					} else {
						out = append(out, tok)
					}
				default:
					out = append(out, tok)
				}
			default:
				out = append(out, tok)
			}
		} else {
			out = append(out, tok)
		}
	}
	return posix, strings.Join(out, " ")
}

// splitWord splits the first whitespace-delimited word off s.
// wrapRedirect — if the word list contains a `>` / `>>` / `N>` / `N>>`
// token, wrap the exec in a Redirect stmt (batch's file-op workhorse).
// Handles `> file` (target as the next word), the glued `>file` /
// `>>file` / `2>nul` forms (cmd ECHOES the trailing space before a
// spaced `>` — `echo one >f` writes "one " — so canonical batch writes
// the no-space `echo one>f`), and `%var%` targets (`echo hi>%f%`).
// Returns (stmts, redirected).
func wrapRedirect(words []map[string]any) ([]map[string]any, bool) {
	for i := 0; i < len(words); i++ {
		fd, mode, target, ok := parseRedirectToken(words[i])
		if !ok {
			continue
		}
		if target == nil {
			if i+1 >= len(words) {
				continue // bare `>` — leave to the runtime/external
			}
			target = words[i+1]
		}
		target = normalizeRedirectTarget(target)
		return []map[string]any{{
			"type":  "Redirect",
			"inner": []any{execStmt(words[:i], "Spawn")},
			"redirects": []any{map[string]any{
				"fd": fd, "interpolate": true, "mode": mode, "target": target,
			}},
		}}, true
	}
	return nil, false
}

// parseRedirectToken — does w carry a redirect operator at the START of
// its literal text (`>f`, `>>f`, `2>f`, `>%var%`)? Returns the fd, mode
// and the target word (Str / Interpolate / a getVar expr); a nil target
// means the `> file` separate-word form. w may be a Str or an
// Interpolate — a %var% target glues the operator into its first lit
// part (`>%f%` -> [lit ">", expr f]). splitWords has already split any
// arg glued before the operator.
func parseRedirectToken(w map[string]any) (int, string, map[string]any, bool) {
	var t string
	var rest []map[string]any
	if w["type"] == "Interpolate" {
		parts := partsList(w)
		if len(parts) == 0 {
			return 0, "", nil, false
		}
		first := parts[0]
		if first["kind"] != "lit" {
			return 0, "", nil, false
		}
		t = first["text"].(string)
		rest = append(rest, parts[1:]...)
	} else {
		s, is := w["value"].(string)
		if !is || findTopLevelGT(s) != 0 {
			return 0, "", nil, false
		}
		t = s
	}
	if findTopLevelGT(t) != 0 {
		return 0, "", nil, false
	}
	fd := 1
	red := t
	if len(red) > 1 && red[0] >= '0' && red[0] <= '9' && red[1] == '>' {
		fd = int(red[0] - '0')
		red = red[1:]
	}
	mode := "w"
	if strings.HasPrefix(red, ">>") {
		mode = "a"
		red = red[2:]
	} else if strings.HasPrefix(red, ">") {
		red = red[1:]
	} else {
		return 0, "", nil, false
	}
	// target: the operator's remainder + the later Interpolate parts
	var tparts []map[string]any
	if red != "" {
		tparts = append(tparts, map[string]any{"kind": "lit", "text": red})
	}
	tparts = append(tparts, rest...)
	if len(tparts) == 0 {
		return fd, mode, nil, true
	}
	return fd, mode, partsToWord(tparts), true
}

func partsList(w map[string]any) []map[string]any {
	if a, ok := w["parts"].([]any); ok {
		out := make([]map[string]any, len(a))
		for i, p := range a {
			out[i] = p.(map[string]any)
		}
		return out
	}
	if m, ok := w["parts"].([]map[string]any); ok {
		return m
	}
	return nil
}

func partsToWord(parts []map[string]any) map[string]any {
	if len(parts) == 0 {
		return nil
	}
	if len(parts) == 1 && parts[0]["kind"] == "lit" {
		return str(parts[0]["text"].(string))
	}
	if len(parts) == 1 && parts[0]["kind"] == "expr" {
		return parts[0]["expr"].(map[string]any)
	}
	return map[string]any{"type": "Interpolate", "parts": parts}
}

func normalizeRedirectTarget(t map[string]any) map[string]any {
	if t["type"] == "Interpolate" {
		for _, pm := range partsList(t) {
			if pm["kind"] == "lit" {
				pm["text"] = strings.ReplaceAll(pm["text"].(string), "\\", "/")
			}
		}
		return t
	}
	if s, ok := t["value"].(string); ok {
		// batch path separators + the `nul` device (cmd's discard
		// target — `copy a b >nul` silences the status line; POSIX's
		// equivalent is /dev/null, which the estree runtime
		// special-cases as a discard target).
		s = strings.ReplaceAll(s, "\\", "/")
		if strings.EqualFold(s, "nul") || s == "/dev/null" {
			s = "/dev/null"
		}
		return str(s)
	}
	return t
}

func splitWord(s string) (string, string) {
	s = strings.TrimLeft(s, " \t")
	i := 0
	for i < len(s) && s[i] != ' ' && s[i] != '\t' {
		i++
	}
	return s[:i], strings.TrimLeft(s[i:], " \t")
}

// ── echo ────────────────────────────────────────────────────────────

func (p *parser) parseEcho(rest string) ([]map[string]any, string, error) {
	// `echo a & echo b` — cut the statement operator off the text
	before, op, after := cutCompound(rest)
	rem := ""
	if strings.TrimSpace(after) != "" {
		rem = op + " " + strings.TrimSpace(after)
	}
	rest = strings.TrimSpace(before)
	if rest == "" {
		// bare `echo` — prints a blank line
		return []map[string]any{execStmt([]map[string]any{str("echo")}, "Emulable")}, rem, nil
	}
	if strings.EqualFold(rest, "off") || strings.EqualFold(rest, "on") {
		// echo-control directive — no runtime effect on the transpiled output
		return nil, rem, nil
	}
	if rest == "." || rest == ":" {
		// `echo.` / `echo:` — blank line
		return []map[string]any{execStmt([]map[string]any{str("echo")}, "Emulable")}, rem, nil
	}
	words, err := splitWords(rest, p.forVars)
	if err != nil {
		return nil, rem, err
	}
	all := append([]map[string]any{str("echo")}, words...)
	if red, ok := wrapRedirect(all); ok {
		return red, rem, nil
	}
	return []map[string]any{execStmt(all, "Emulable")}, rem, nil
}

// ── set ─────────────────────────────────────────────────────────────

// cutAmp — split at the first top-level `&` (cmd's statement
// separator; `cmd1 & cmd2` runs both). An `&` inside double quotes is
// literal text (`echo "a & b"` prints it). Returns the text and the
// rest after the `&` (empty when there is none).
//
// cutCompound — split at the first top-level statement operator: `&`,
// `&&` or `||` (cmd's unconditional / positive / negative conjunctions).
// An operator inside double quotes is literal text (`echo "a & b"`
// prints it). Returns the text before the operator, the operator itself
// ("", "&", "&&" or "||") and the rest after it. Parens do NOT
// protect operators in the middle of a line (cmd splits `echo (a & b)`
// at the &) — a leading ( is handled by parseLine's paren branch.
func cutCompound(s string) (string, string, string) {
	inQ := false
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			inQ = !inQ
		case '&':
			if !inQ {
				if i+1 < len(s) && s[i+1] == '&' {
					return s[:i], "&&", s[i+2:]
			}
			return s[:i], "&", s[i+1:]
		}
		case '|':
			if !inQ && i+1 < len(s) && s[i+1] == '|' {
				return s[:i], "||", s[i+2:]
			}
		}
	}
	return s, "", ""
}

// cutOp — if s starts with a statement operator, return it and the rest
// (the paren-branch twin of cutCompound: `(a & b) && c` — parseCommand
// consumes the block, the remainder starts with the operator).
func cutOp(s string) (string, string) {
	s = strings.TrimSpace(s)
	switch {
	case strings.HasPrefix(s, "&&"):
		return "&&", s[2:]
	case strings.HasPrefix(s, "||"):
		return "||", s[2:]
	case strings.HasPrefix(s, "&"):
		return "&", s[1:]
	}
	return "", s
}

// splitPipes — split a segment at top-level `|` pipe operators, quote
// aware for BOTH " and ' (`for /f %i in ('a | b')` keeps the pipe inside
// the single quotes — it is the /f command delimiter, not a pipe). `||`
// never reaches here (cutCompound consumes it). Returns the stages.
func splitPipes(s string) []string {
	var stages []string
	inQ := byte(0)
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inQ != 0 {
			if c == inQ {
				inQ = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			inQ = c
		case '|':
			if i+1 < len(s) && s[i+1] == '|' {
				i++
				continue
			}
			stages = append(stages, s[start:i])
			start = i + 1
		}
	}
	stages = append(stages, s[start:])
	return stages
}

// andOrStmt — build the A1 conjunction (the core's `a && b` / `a || b`
// shape: Expr(BinOp And/Or(exec, exec))). Both operands must be plain
// exec Exprs (probed with `otranspilerl-cli --shir` — the estree renderer lowers
// the And/Or to a lastExit check, the sh renderer to `&&`/`||`).
func andOrStmt(op string, lhs, rhs map[string]any) (map[string]any, bool) {
	l, ok1 := plainExec(lhs)
	r, ok2 := plainExec(rhs)
	if !ok1 || !ok2 {
		return nil, false
	}
	binop := "And"
	if op == "||" {
		binop = "Or"
	}
	return map[string]any{
		"type": "Expr",
		"expr": map[string]any{"type": "BinOp", "op": binop, "lhs": l, "rhs": r},
	}, true
}

// plainExec — extract the exec Call from an Expr statement if it is a
// plain single command (no redirects, no block, no pipeline).
func plainExec(st map[string]any) (map[string]any, bool) {
	if st["type"] != "Expr" {
		return nil, false
	}
	e, ok := st["expr"].(map[string]any)
	if !ok || e["type"] != "Call" || e["func"] != "exec" {
		return nil, false
	}
	return e, true
}

func (p *parser) parseSet(rest string) ([]map[string]any, string, error) {
	// `set a=1 & echo b` — the statement operator splits the value off
	before, op, after := cutCompound(rest)
	rem := ""
	if strings.TrimSpace(after) != "" {
		rem = op + " " + strings.TrimSpace(after)
	}
	rest = strings.TrimSpace(before)
	if rest == "" {
		return nil, rem, fmt.Errorf("unsupported: bare `set` (variable listing)")
	}
	if strings.HasPrefix(strings.ToLower(rest), "/a ") {
		st, _, err := p.parseSetA(strings.TrimSpace(rest[3:]))
		return st, rem, err
	}
	if strings.HasPrefix(strings.ToLower(rest), "/p ") || strings.HasPrefix(strings.ToLower(rest), "/p") {
		return nil, rem, fmt.Errorf("unsupported: set /p (interactive prompt)")
	}
	// set "name=value" — the quotes may wrap name=value; otherwise the
	// whole rest is name=value.
	body := rest
	if strings.HasPrefix(body, "\"") {
		end := strings.Index(body[1:], "\"")
		if end < 0 {
			return nil, rem, fmt.Errorf("unterminated quote in set: %q", rest)
		}
		body = body[1 : 1+end]
	}
	eq := strings.Index(body, "=")
	if eq < 0 {
		return nil, rem, fmt.Errorf("set without '=': %q", rest)
	}
	name := strings.ToLower(strings.TrimSpace(body[:eq]))
	value := body[eq+1:]
	expr, err := expandWord(value, p.forVars)
	if err != nil {
		return nil, rem, err
	}
	return []map[string]any{assignStmt(name, expr)}, rem, nil
}

// set /a VAR=expr — mini arithmetic parser (Int + - * / % parens).
func (p *parser) parseSetA(rest string) ([]map[string]any, string, error) {
	eq := strings.Index(rest, "=")
	if eq < 0 {
		return nil, "", fmt.Errorf("set /a without '=': %q", rest)
	}
	name := strings.ToLower(strings.TrimSpace(rest[:eq]))
	// `%%` in a batch file is a literal `%` (the modulo operator) —
	// collapse it before parsing, so `10%%3` parses as `10 % 3`
	expr := strings.ReplaceAll(rest[eq+1:], "%%", "%")
	ap := &arithParser{src: expr}
	ast, err := ap.parseExpr()
	if err != nil {
		return nil, "", err
	}
	if ap.i < len(ap.src) {
		return nil, "", fmt.Errorf("set /a trailing text: %q", ap.src[ap.i:])
	}
	return []map[string]any{assignStmt(name, map[string]any{"type": "Arith", "ast": ast})}, "", nil
}

// ── if ──────────────────────────────────────────────────────────────

func (p *parser) parseIf(rest string) ([]map[string]any, string, error) {
	rest = strings.TrimSpace(rest)
	neg := false
	if strings.HasPrefix(strings.ToLower(rest), "not ") {
		neg = true
		rest = strings.TrimSpace(rest[4:])
	}
	// condition: up to the first `(` (block form) or, in the command
	// form, up to the first unquoted space. v1.1 keyword conditions
	// (`defined VAR` / `exist FILE` / `errorlevel N`) are two-part — the
	// operand ends at the block/cmd.
	var cond, cmd string
	var isBlock bool
	var err error
	low := strings.ToLower(rest)
	switch {
	case strings.HasPrefix(low, "defined "):
		cond, cmd, isBlock, err = splitCondition(rest[len("defined "):])
		if err != nil {
			return nil, "", err
		}
		cond = "-n \"$" + strings.ToLower(cond) + "\""
	case strings.HasPrefix(low, "exist "):
		cond, cmd, isBlock, err = splitCondition(rest[len("exist "):])
		if err != nil {
			return nil, "", err
		}
		// real batch paths use `\` separators — normalize for `-e`
		cond = "-e " + normalizeBatchPaths(cond)
	case strings.HasPrefix(low, "errorlevel"):
		cond, cmd, isBlock, err = splitCondition(rest[len("errorlevel"):])
		if err != nil {
			return nil, "", err
		}
		cond = "$? -ge " + strings.TrimSpace(cond)
	default:
		cond, cmd, isBlock, err = splitCondition(rest)
		if err != nil {
			return nil, "", err
		}
	}
	if cond == "" {
		return nil, "", fmt.Errorf("if with empty condition: %q", rest)
	}
	testText := cond
	if neg {
		testText = "!" + testText
	}
	condExpr := testCall(batchTestToShell(testText))

	var thenStmts []map[string]any
	elseStmts := []map[string]any{}
	var rem string
	if isBlock {
		thenStmts, rem, err = p.parseParenBlock(cmd)
		if err != nil {
			return nil, "", err
		}
	} else {
		thenStmts, rem, err = p.parseCommand(cmd)
		if err != nil {
			return nil, "", err
		}
	}
	// optional else — only meaningful with the parenthesized form
	// (real cmd requires `) else (` on the same line)
	rem = strings.TrimSpace(rem)
	if strings.HasPrefix(strings.ToLower(rem), "else") {
		rem = strings.TrimSpace(rem[4:])
		if strings.HasPrefix(rem, "(") {
			elseStmts, rem, err = p.parseParenBlock(rem)
			if err != nil {
				return nil, "", err
			}
		} else {
			elseStmts, rem, err = p.parseCommand(rem)
			if err != nil {
				return nil, "", err
			}
		}
	}
	if rem != "" {
		return nil, "", fmt.Errorf("if trailing text: %q", rem)
	}
	return []map[string]any{{
		"type":   "If",
		"cond":   condExpr,
		"then":   thenStmts,
		"elsifs": []any{},
		"else":   elseStmts,
	}}, "", nil
}

// splitCondition splits "A==B (cmd)" into (cond, rest, isBlock).
// The condition runs to the first `(` (block form) or the first
// unquoted space (command form).
func splitCondition(s string) (string, string, bool, error) {
	s = strings.TrimLeft(s, " \t")
	inQuote := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inQuote != 0 {
			if c == inQuote {
				inQuote = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			inQuote = c
		case '(':
			return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i:]), true, nil
		case ' ':
			return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i:]), false, nil
		}
	}
	return strings.TrimSpace(s), "", false, nil
}

// batchTestToShell adapts a batch if-condition to the shell-flavored
// test text the A1 test call carries: %var% -> $var, %1..%9 / %* ->
// $1..$9 / $* (positionals have NO closing % in batch), == stays ==.
func batchTestToShell(t string) string {
	var b strings.Builder
	for i := 0; i < len(t); i++ {
		if t[i] == '%' {
			if j := strings.IndexByte(t[i+1:], '%'); j >= 0 && !strings.ContainsAny(t[i+1:i+1+j], " \t\"") {
				name := t[i+1 : i+1+j]
				b.WriteString("$" + strings.ToLower(name))
				i += j + 1
				continue
			}
			// %1..%9 / %* — positionals without a closing % (batch form)
			if i+1 < len(t) && (t[i+1] >= '1' && t[i+1] <= '9' || t[i+1] == '*') {
				b.WriteString("$" + string(t[i+1]))
				i++
				continue
			}
		}
		b.WriteByte(t[i])
	}
	return b.String()
}

// parseParenBlock parses "( ... )" — content on the same line, or
// spanning subsequent lines until a bare `)`. Returns the inner stmts
// and the remainder after the closing paren.
func (p *parser) parseParenBlock(s string) ([]map[string]any, string, error) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "(") {
		return nil, "", fmt.Errorf("expected '(': %q", s)
	}
	// same-line close?
	if end := findMatchingParen(s); end >= 0 {
		inner := strings.TrimSpace(s[1:end])
		rem := strings.TrimSpace(s[end+1:])
		if inner == "" {
			return []map[string]any{}, rem, nil
		}
		// the inner text may hold several commands (possibly with their
		// own nested parens); reuse parseLine for the & splitting.
		st, err := p.parseLine(inner)
		if err != nil {
			return nil, "", err
		}
		return st, rem, nil
	}
	// multi-line block: consume lines until one starting with `)`
	// (which may carry `else ( ... )` after it — real cmd requires the
	// else on the closing-paren line)
	var st []map[string]any
	rem := ""
	for p.idx < len(p.lines) {
		line := strings.TrimSpace(p.lines[p.idx])
		p.idx++
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, ")") {
			rem = strings.TrimSpace(line[1:])
			return st, rem, nil
		}
		more, err := p.parseLine(line)
		if err != nil {
			return nil, "", err
		}
		st = append(st, more...)
	}
	return nil, "", fmt.Errorf("unterminated ( block")
}

// findMatchingParen finds the index of the ')' matching the first '(' of
// s (s must start with '('). Returns -1 if unbalanced.
func findMatchingParen(s string) int {
	depth := 0
	inQuote := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inQuote != 0 {
			if c == inQuote {
				inQuote = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			inQuote = c
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// ── for ─────────────────────────────────────────────────────────────

func (p *parser) parseFor(rest string) ([]map[string]any, string, error) {
	rest = strings.TrimSpace(rest)
	if strings.HasPrefix(rest, "/") {
		if strings.HasPrefix(rest, "/l") || strings.HasPrefix(rest, "/L") {
			return p.parseForL(rest[2:])
		}
		if strings.HasPrefix(rest, "/f") || strings.HasPrefix(rest, "/F") {
			return p.parseForF(rest[2:])
		}
		return nil, "", fmt.Errorf("unsupported: for /%c (v1.1: plain word-list, /l, /f)", rest[1])
	}
	if !strings.HasPrefix(rest, "%%") {
		return nil, "", fmt.Errorf("expected %%var in for: %q", rest)
	}
	sp := strings.IndexByte(rest[2:], ' ')
	if sp < 0 {
		return nil, "", fmt.Errorf("malformed for: %q", rest)
	}
	varName := strings.ToLower(rest[2 : 2+sp])
	rest = strings.TrimSpace(rest[2+sp:])
	if !strings.HasPrefix(strings.ToLower(rest), "in ") {
		return nil, "", fmt.Errorf("expected 'in' in for: %q", rest)
	}
	rest = strings.TrimSpace(rest[3:])
	items, rest, err := p.parseParenList(rest)
	if err != nil {
		return nil, "", err
	}
	rest = strings.TrimSpace(rest)
	if !strings.HasPrefix(strings.ToLower(rest), "do ") {
		return nil, "", fmt.Errorf("expected 'do' in for: %q", rest)
	}
	rest = strings.TrimSpace(rest[3:])
	// inside the body, `%%v` reads the loop var (batch's only scoped name)
	p.forVars[varName] = true
	var body []map[string]any
	if strings.HasPrefix(rest, "(") {
		body, rest, err = p.parseParenBlock(rest)
		if err != nil {
			return nil, "", err
		}
	} else {
		body, rest, err = p.parseCommand(rest)
		if err != nil {
			delete(p.forVars, varName)
			return nil, "", err
		}
	}
	delete(p.forVars, varName)
	if rest != "" {
		return nil, "", fmt.Errorf("for trailing text: %q", rest)
	}
	return []map[string]any{{
		"type": "For",
		"var":  varName,
		"iter": map[string]any{"type": "Array", "elements": items},
		"body": body,
	}}, "", nil
}

// for /l — numeric loop over the A1 Range iterable (unit step only).
func (p *parser) parseForL(rest string) ([]map[string]any, string, error) {
	rest = strings.TrimSpace(rest)
	if !strings.HasPrefix(rest, "%%") {
		return nil, "", fmt.Errorf("expected %%var in for /l: %q", rest)
	}
	sp := strings.IndexByte(rest[2:], ' ')
	if sp < 0 {
		return nil, "", fmt.Errorf("malformed for /l: %q", rest)
	}
	varName := strings.ToLower(rest[2 : 2+sp])
	rest = strings.TrimSpace(rest[2+sp:])
	if !strings.HasPrefix(strings.ToLower(rest), "in ") {
		return nil, "", fmt.Errorf("expected 'in' in for /l: %q", rest)
	}
	rest = strings.TrimSpace(rest[3:])
	bounds, rest, err := p.parseParenList(rest)
	if err != nil {
		return nil, "", err
	}
	if len(bounds) != 3 {
		return nil, "", fmt.Errorf("for /l needs (start step end): got %d bounds", len(bounds))
	}
	start, ok1 := constInt(bounds[0])
	step, ok2 := constInt(bounds[1])
	end, ok3 := constInt(bounds[2])
	if !ok1 || !ok2 || !ok3 {
		return nil, "", fmt.Errorf("for /l bounds must be constant integers (no %%var%%): %q", rest)
	}
	if step != 1 {
		return nil, "", fmt.Errorf("for /l step %d unsupported (the A1 Range iterable is unit-step only)", step)
	}
	rest = strings.TrimSpace(rest)
	if !strings.HasPrefix(strings.ToLower(rest), "do ") {
		return nil, "", fmt.Errorf("expected 'do' in for /l: %q", rest)
	}
	rest = strings.TrimSpace(rest[3:])
	p.forVars[varName] = true
	var body []map[string]any
	if strings.HasPrefix(rest, "(") {
		body, rest, err = p.parseParenBlock(rest)
		if err != nil {
			return nil, "", err
		}
	} else {
		body, rest, err = p.parseCommand(rest)
		if err != nil {
			return nil, "", err
		}
	}
	delete(p.forVars, varName)
	if rest != "" {
		return nil, "", fmt.Errorf("for /l trailing text: %q", rest)
	}
	return []map[string]any{{
		"type": "For",
		"var":  varName,
		"iter": map[string]any{"type": "Range", "start": start, "end": end},
		"body": body,
	}}, "", nil
}

// for /f — line/token iteration: for /f "options" %%v in (source) do body
// (v1.1: options delims=X, tokens=1[,N...] / tokens=*; sources (file),
// (literal words...), ('command'); skip=/eol=/usebackq refuse).
func (p *parser) parseForF(rest string) ([]map[string]any, string, error) {
	rest = strings.TrimSpace(rest)
	// the "options" string is optional (`for /f %%v in (...) do ...`)
	opts := ""
	if strings.HasPrefix(rest, "\"") {
		qe := strings.Index(rest[1:], "\"")
		if qe < 0 {
			return nil, "", fmt.Errorf("for /f: unterminated options: %q", rest)
		}
		opts = rest[1 : 1+qe]
		rest = strings.TrimSpace(rest[qe+2:])
	}
	if !strings.HasPrefix(rest, "%%") {
		return nil, "", fmt.Errorf("expected %%var in for /f: %q", rest)
	}
	sp := strings.IndexByte(rest[2:], ' ')
	if sp < 0 {
		return nil, "", fmt.Errorf("malformed for /f: %q", rest)
	}
	firstVar := strings.ToLower(rest[2 : 2+sp])
	rest = strings.TrimSpace(rest[2+sp:])
	if !strings.HasPrefix(strings.ToLower(rest), "in ") {
		return nil, "", fmt.Errorf("expected 'in' in for /f: %q", rest)
	}
	rest = strings.TrimSpace(rest[3:])
	if !strings.HasPrefix(rest, "(") {
		return nil, "", fmt.Errorf("expected '(' source in for /f: %q", rest)
	}
	pe := findMatchingParen(rest)
	if pe < 0 {
		return nil, "", fmt.Errorf("unterminated for /f source: %q", rest)
	}
	src := strings.TrimSpace(rest[1:pe])
	rest = strings.TrimSpace(rest[pe+1:])
	if !strings.HasPrefix(strings.ToLower(rest), "do ") {
		return nil, "", fmt.Errorf("expected 'do' in for /f: %q", rest)
	}
	rest = strings.TrimSpace(rest[3:])

	// options
	delims := "" // default: whitespace (the runtime's IFS default)
	tokens := "1"
	for _, o := range strings.Fields(opts) {
		switch {
		case strings.HasPrefix(o, "delims="):
			delims = o[len("delims="):]
		case strings.HasPrefix(o, "tokens="):
			tokens = o[len("tokens="):]
		case strings.HasPrefix(o, "skip="), strings.HasPrefix(o, "eol="), o == "usebackq":
			return nil, "", fmt.Errorf("unsupported for /f option %q (v1.1: delims + tokens only)", o)
		default:
			return nil, "", fmt.Errorf("unknown for /f option %q", o)
		}
	}
	if tokens != "*" && tokens != "1" && !strings.HasPrefix(tokens, "1,") {
		return nil, "", fmt.Errorf("unsupported for /f tokens %q (v1.1: tokens=1[,N...] or *)", tokens)
	}
	// cmd's token sets must be CONSECUTIVE (tokens=1,3 skips token 2 —
	// %%b would bind it in the read lowering; refuse rather than guess)
	if tokens != "*" && tokens != "1" {
		prev := 0
		for _, p := range strings.Split(tokens, ",") {
			n := 0
			ok := true
			for _, c := range p {
				if c < '0' || c > '9' {
					ok = false
					break
				}
				n = n*10 + int(c-'0')
			}
			if !ok || n != prev+1 {
				return nil, "", fmt.Errorf("unsupported for /f tokens %q (v1.1: consecutive sets starting at 1)", tokens)
			}
			prev = n
		}
	}
	// token vars: tokens=1 -> firstVar; tokens=1,2,3 -> firstVar + the
	// next letters (batch's %%a %%b %%c scheme); tokens=* -> firstVar.
	readVars := []string{firstVar}
	if tokens != "*" && tokens != "1" {
		last := firstVar
		for range strings.Split(tokens, ",") {
			last = nextVarName(last)
			readVars = append(readVars, last)
		}
	} else if tokens == "1" || tokens == "" {
		// tokens=1: the read builtin's LAST var gets the remainder — a
		// single var would swallow the whole line. Add a discard var so
		// firstVar receives only the first field (batch's tokens=1).
		readVars = append(readVars, "__frest")
	}
	for _, v := range readVars {
		p.forVars[v] = true
	}

	// the source -> fd0: (file) redirects mode "r"; literal words and
	// ('command') feed the read loop via a herestring (the runtime's
	// string-source fd0).
	var redirects []any
	if strings.HasPrefix(src, "'") && strings.HasSuffix(src, "'") && len(src) > 1 {
		// ('command') — capture its stdout, feed as herestring content
		cmdText := strings.TrimSpace(src[1 : len(src)-1])
		cmdWord, cmdRest := splitWord(cmdText)
		cmdWords, err := splitWords(cmdWord+" "+cmdRest, p.forVars)
		if err != nil {
			return nil, "", err
		}
		capture := map[string]any{
			"type": "Call", "func": "capture", "purity": "Spawn",
			"args": []any{map[string]any{"type": "Arrow", "body": []any{execStmt(cmdWords, "Spawn")}}},
		}
		redirects = []any{map[string]any{
			"fd": 0, "interpolate": true, "mode": "herestring", "target": capture,
		}}
	} else if strings.HasPrefix(src, "\"") && strings.HasSuffix(src, "\"") && len(src) > 1 {
		// ("string") — cmd's quoted literal: the WHOLE string is ONE
		// line (tokenized by the read loop, not split into words)
		redirects = []any{map[string]any{
			"fd": 0, "interpolate": true, "mode": "herestring",
			"target": map[string]any{
				"type":  "Interpolate",
				"parts": []any{map[string]any{"kind": "lit", "text": src[1 : len(src)-1]}},
			},
		}}
	} else if len(strings.Fields(src)) <= 1 {
		// (file) — the single word is a path (real batch uses `\`)
		redirects = []any{map[string]any{
			"fd": 0, "interpolate": true, "mode": "r",
			"target": str(strings.ReplaceAll(src, "\\", "/")),
		}}
	} else {
		// (literal words...) — each word is a "line" for /f
		lines := strings.Join(strings.Fields(src), "\n") // the runtime adds the trailing \n
		redirects = []any{map[string]any{
			"fd": 0, "interpolate": true, "mode": "herestring",
			"target": map[string]any{
				"type":  "Interpolate",
				"parts": []any{map[string]any{"kind": "lit", "text": lines}},
			},
		}}
	}

	// the read loop: While{ cond: read -r v1 v2 ... (IFS=delims) }
	readArgs := []any{str("-r")}
	for _, v := range readVars {
		readArgs = append(readArgs, str(v))
	}
	condArgs := []any{str("read"), map[string]any{"type": "Array", "elements": readArgs}}
	if delims != "" {
		condArgs = append(condArgs, map[string]any{
			"type":       "Object",
			"properties": []any{map[string]any{"key": "IFS", "value": str(delims)}},
		})
	}
	cond := map[string]any{
		"type": "Call", "func": "exec", "purity": "Emulable", "args": condArgs,
	}
	var body []map[string]any
	var err error
	if strings.HasPrefix(rest, "(") {
		body, rest, err = p.parseParenBlock(rest)
	} else {
		body, rest, err = p.parseCommand(rest)
	}
	for _, v := range readVars {
		delete(p.forVars, v)
	}
	if err != nil {
		return nil, "", err
	}
	if rest != "" {
		return nil, "", fmt.Errorf("for /f trailing text: %q", rest)
	}
	return []map[string]any{{
		"type": "Redirect",
		"inner": []any{map[string]any{
			"type": "While", "cond": cond, "body": body,
		}},
		"redirects": redirects,
	}}, "", nil
}

// nextVarName — batch's token-var naming scheme: `tokens=1,2 %%a` gives
// %%a and %%b; a→b, b→c, ...
func nextVarName(prev string) string {
	c := prev[len(prev)-1]
	if c == 'z' {
		return prev + "x" // degenerate (batch wraps to aa) — rare
	}
	return prev[:len(prev)-1] + string(c+1)
}

// constInt — extract a constant integer from an A1 Int expr node or a
// numeric Str node (parseParenList emits Str for literal items).
func constInt(n map[string]any) (int, bool) {
	switch n["type"] {
	case "Int":
		if v, ok := n["value"].(float64); ok {
			return int(v), true
		}
	case "Str":
		if s, ok := n["value"].(string); ok {
			var v int
			if _, err := fmt.Sscanf(s, "%d", &v); err == nil {
				return v, true
			}
		}
	}
	return 0, false
}

// parseParenList parses "( item1 item2 ... )" — whitespace-split words.
func (p *parser) parseParenList(s string) ([]map[string]any, string, error) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "(") {
		return nil, "", fmt.Errorf("expected '(' in for list: %q", s)
	}
	end := findMatchingParen(s)
	if end < 0 {
		return nil, "", fmt.Errorf("unterminated for list: %q", s)
	}
	inner := strings.TrimSpace(s[1:end])
	rem := strings.TrimSpace(s[end+1:])
	var items []map[string]any
	for _, w := range strings.Fields(inner) {
		e, err := expandWord(w, p.forVars)
		if err != nil {
			return nil, "", err
		}
		items = append(items, e)
	}
	return items, rem, nil
}

func (p *parser) parseExit(rest string) ([]map[string]any, string, error) {
	rest = strings.TrimSpace(rest)
	if strings.HasPrefix(strings.ToLower(rest), "/b") {
		rest = strings.TrimSpace(rest[2:])
	}
	// exit /b [N] — the direct IrStmt::Exit statement form (all backends
	// render it: estree -> process.exit, sh -> exit, perl -> exit).
	// `exit` without a code exits with the last status (lastExit).
	if rest == "" {
		return []map[string]any{{"type": "Exit", "value": nil}}, "", nil
	}
	var n int
	if _, err := fmt.Sscanf(rest, "%d", &n); err != nil {
		return nil, "", fmt.Errorf("exit /b code not an integer: %q", rest)
	}
	return []map[string]any{{"type": "Exit", "value": map[string]any{"type": "Int", "value": n}}}, "", nil
}

// ── words & expansion ───────────────────────────────────────────────

// splitWords splits a command argument string into words on whitespace
// (v1: no quoting-aware grouping — batch quotes are mostly cosmetic in
// echo; refinement is a worker item).
// findTopLevelGT — index of the first `>` outside double quotes
// (cmd parses it as a redirect operator; inside quotes it's literal).
func findTopLevelGT(s string) int {
	inQ := false
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			inQ = !inQ
		case '>':
			if !inQ {
				return i
			}
		}
	}
	return -1
}

func splitWords(s string, forVars map[string]bool) ([]map[string]any, error) {
	var out []map[string]any
	for _, w := range strings.Fields(s) {
		// split a redirect operator glued to an arg: `x>f` -> "x", ">f"
		// (cmd's no-space form; `x2>f` keeps the fd digit on the token —
		// cmd parses `2>` as a fd-2 redirect, so the arg is "x")
		if k := findTopLevelGT(w); k > 0 {
			fdStart := k
			for fdStart > 0 && w[fdStart-1] >= '0' && w[fdStart-1] <= '9' {
				fdStart--
			}
			arg := w[:fdStart]
			if arg != "" {
				e, err := expandWord(arg, forVars)
				if err != nil {
					return nil, err
				}
				out = append(out, e)
			}
			w = w[fdStart:]
		}
		e, err := expandWord(w, forVars)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// expandWord turns a batch word into an A1 expr: plain -> Str, with
// %var% refs -> Interpolate (or a bare getVar for a single ref). forVars
// are the active `for %%v` loop vars: inside a for body, `%%v` is the
// loop-var read, not an escaped literal %.
func expandWord(w string, forVars map[string]bool) (map[string]any, error) {
	if !strings.Contains(w, "%") {
		return str(w), nil
	}
	var parts []map[string]any
	var lit strings.Builder
	flush := func() {
		if lit.Len() > 0 {
			parts = append(parts, map[string]any{"kind": "lit", "text": lit.String()})
			lit.Reset()
		}
	}
	for i := 0; i < len(w); i++ {
		if w[i] != '%' {
			lit.WriteByte(w[i])
			continue
		}
		// %% -> literal %, EXCEPT inside a for body where `%%v` is the
		// loop-var read
		if i+1 < len(w) && w[i+1] == '%' {
			j := i + 2
			for j < len(w) && isNameChar(w[j]) {
				j++
			}
			name := strings.ToLower(w[i+2 : j])
			if name != "" && forVars[name] {
				flush()
				parts = append(parts, map[string]any{"kind": "expr", "expr": getVar(name)})
				i = j - 1
				continue
			}
			lit.WriteByte('%')
			i++
			continue
		}
		// %1..%9 / %* — positionals WITHOUT a closing % (batch form)
		if i+1 < len(w) && (w[i+1] >= '1' && w[i+1] <= '9' || w[i+1] == '*') {
			flush()
			parts = append(parts, map[string]any{"kind": "expr", "expr": getVar(strings.ToLower(string(w[i+1])))})
			i++
			continue
		}
		// %name% (no whitespace/quotes in the name)
		j := strings.IndexByte(w[i+1:], '%')
		if j < 0 {
			// stray % — keep literal (echo % is legal-ish)
			lit.WriteByte('%')
			continue
		}
		name := w[i+1 : i+1+j]
		if name == "" || strings.ContainsAny(name, " \t\"") {
			lit.WriteByte('%')
			continue
		}
		flush()
		parts = append(parts, map[string]any{"kind": "expr", "expr": getVarFor(name)})
		i += j + 1
	}
	flush()
	if len(parts) == 0 {
		return str(w), nil
	}
	if len(parts) == 1 && parts[0]["kind"] == "expr" {
		return parts[0]["expr"].(map[string]any), nil
	}
	return map[string]any{"type": "Interpolate", "parts": parts}, nil
}

// getVarFor maps a batch %name% to the shell-flavored A1 read:
// %errorlevel% -> $? (getVar("?")), %1..%9 / %* positionals -> getVar.
func getVarFor(name string) map[string]any {
	n := strings.ToLower(name)
	if n == "errorlevel" {
		n = "?"
	}
	return getVar(n)
}

func isNameChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_'
}

// ── A1 node builders ────────────────────────────────────────────────

func str(s string) map[string]any {
	return map[string]any{"type": "Str", "value": s, "style": "DoubleQuoted"}
}

func getVar(name string) map[string]any {
	return map[string]any{
		"type": "Call", "func": "getVar",
		"args": []any{str(name)}, "purity": "Emulable",
	}
}

func execStmt(words []map[string]any, purity string) map[string]any {
	return map[string]any{
		"type": "Expr",
		"expr": map[string]any{
			"type": "Call", "func": "exec",
			"args":   []any{words[0], map[string]any{"type": "Array", "elements": words[1:]}},
			"purity": purity,
		},
	}
}

func assignStmt(name string, expr map[string]any) map[string]any {
	return map[string]any{
		"type": "Assign",
		"expr": expr,
		"targets": []any{
			map[string]any{"var": name, "sigil": nil, "indices": []any{}},
		},
	}
}

func testCall(text string) map[string]any {
	return map[string]any{
		"type": "Call", "func": "test",
		"args":   []any{str(text), str("[[")},
		"purity": "Emulable",
	}
}

// ── set /a arithmetic ───────────────────────────────────────────────

type arithParser struct {
	src string
	i   int
}

func (a *arithParser) parseExpr() (map[string]any, error) {
	lhs, err := a.parseTerm()
	if err != nil {
		return nil, err
	}
	for a.i < len(a.src) {
		c := a.src[a.i]
		if c == '+' || c == '-' {
			a.i++
			rhs, err := a.parseTerm()
			if err != nil {
				return nil, err
			}
			lhs = map[string]any{"type": "Bin", "op": string(c), "lhs": lhs, "rhs": rhs}
		} else {
			break
		}
	}
	return lhs, nil
}

func (a *arithParser) parseTerm() (map[string]any, error) {
	lhs, err := a.parseFactor()
	if err != nil {
		return nil, err
	}
	for a.i < len(a.src) {
		c := a.src[a.i]
		if c == '*' || c == '/' || c == '%' {
			a.i++
			rhs, err := a.parseFactor()
			if err != nil {
				return nil, err
			}
			lhs = map[string]any{"type": "Bin", "op": string(c), "lhs": lhs, "rhs": rhs}
		} else {
			break
		}
	}
	return lhs, nil
}

func (a *arithParser) parseFactor() (map[string]any, error) {
	for a.i < len(a.src) && a.src[a.i] == ' ' {
		a.i++
	}
	if a.i >= len(a.src) {
		return nil, fmt.Errorf("set /a: unexpected end of expression")
	}
	if a.src[a.i] == '(' {
		a.i++
		inner, err := a.parseExpr()
		if err != nil {
			return nil, err
		}
		for a.i < len(a.src) && a.src[a.i] == ' ' {
			a.i++
		}
		if a.i >= len(a.src) || a.src[a.i] != ')' {
			return nil, fmt.Errorf("set /a: missing ')'")
		}
		a.i++
		return inner, nil
	}
	if a.src[a.i] == '-' {
		// unary minus — rendered as 0 - x (the Bin op the backends already
		// handle; precedence falls out naturally: -2*3 -> (0-2)*3)
		a.i++
		inner, err := a.parseFactor()
		if err != nil {
			return nil, err
		}
		return map[string]any{"type": "Bin", "op": "-", "lhs": map[string]any{"type": "Num", "value": 0}, "rhs": inner}, nil
	}
	if a.src[a.i] == '%' {
		end := strings.IndexByte(a.src[a.i+1:], '%')
		if end < 0 {
			return nil, fmt.Errorf("set /a: unterminated %%var%%")
		}
		name := strings.ToLower(a.src[a.i+1 : a.i+1+end])
		a.i += end + 2
		return map[string]any{"type": "Var", "name": name}, nil
	}
	// number
	j := a.i
	for j < len(a.src) && (a.src[j] >= '0' && a.src[j] <= '9') {
		j++
	}
	if j == a.i {
		return nil, fmt.Errorf("set /a: unexpected char %q", a.src[a.i])
	}
	var n int
	fmt.Sscanf(a.src[a.i:j], "%d", &n)
	a.i = j
	return map[string]any{"type": "Num", "value": n}, nil
}
