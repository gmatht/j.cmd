package zshlib

import (
	"strconv"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────
// IR expressions / statements (mirror shir_json.rs shapes)
// ─────────────────────────────────────────────────────────────────────

type Expr interface{}

type StrE struct{ Value, Style string } // style: DoubleQuoted|SingleQuoted|Command|Heredoc
type IntE struct{ Value int64 }
type BoolE struct{ Value bool }
type VarE struct{ Name string } // not produced by word lowering (only analysis)
type CallE struct {
	Func string
	Args []Expr
}
type InterpE struct{ Parts []InterpPartE }
type InterpPartE struct {
	IsLit bool
	Lit   string
	Expr  Expr
}
type ArrayE struct{ Elems []Expr }
type ObjectE struct {
	Props []PropE // sorted by key (BTreeMap order)
}
type PropE struct {
	Key string
	Val Expr
}
type ArrowE struct{ Body []Stmt }
type RangeE struct{ Start, End int64 } // numeric-range For.iterable (the seq_range_for transform)
type ArithE struct{ Ast ArithAst }
type JsonE struct{ Value interface{} }
type BinOpE struct {
	Op       string
	Lhs, Rhs Expr
}

type Stmt interface{}

type AssignS struct {
	Var  string
	Expr Expr
}
type ExprS struct{ Expr Expr }
type IfS struct {
	Cond   Expr
	Then   []Stmt
	Elsifs [][2]interface{} // always empty in our lowering
	Else   []Stmt
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
type RedirectS struct {
	Inner     []Stmt
	Redirects []RedirectIR
}
type BlockS struct{ Body []Stmt }
type BackgroundS struct{ Body []Stmt }
type SubshellS struct{ Body []Stmt }
type FunctionS struct {
	Name string
	Body []Stmt
}
type ReturnS struct{ Value Expr } // nil → null
type CaseS struct {
	Disc    Expr
	Clauses []CaseClauseIR
}
type CaseClauseIR struct {
	Patterns []string
	Body     []Stmt
}

type RedirectIR struct {
	FD          int
	Mode        string
	Target      Expr
	Interpolate bool
}

// ─────────────────────────────────────────────────────────────────────
// sh2.* namespace purity (mirror shir_json.rs call_purity)
// ─────────────────────────────────────────────────────────────────────

var syncBuiltins = map[string]bool{
	".": true, ":": true, "basename": true, "break": true, "cat": true,
	"cd": true, "cmp": true, "comm": true, "continue": true, "cut": true,
	"declare": true, "dirname": true, "echo": true, "eval": true, "exit": true,
	"export": true, "false": true, "grep": true, "head": true, "let": true,
	"local": true, "mapfile": true, "mktemp": true, "printf": true, "pwd": true,
	"read": true, "readarray": true, "readonly": true, "return": true, "seq": true,
	"sed": true, "set": true, "shift": true, "sort": true, "source": true,
	"stat": true, "tail": true, "test": true, "touch": true, "tr": true,
	"trap": true, "true": true, "type": true, "typeset": true, "uniq": true,
	"unset": true, "wc": true,
}

func callPurity(fn string, args []Expr) string {
	switch fn {
	case "contains", "join", "brace", "idiv", "imod", "arith", "arithEval",
		"trimCapture", "dirname", "basename", "not", "guard", "caseMatch",
		"split", "param", "callDirect":
		return "PureCpu"
	case "getVar", "setVar", "setLastExit", "assign", "test", "grepText",
		"listVar", "setArray", "setArrayAppend", "arrayItems", "arrayKeys",
		"arrayLen", "arrayIndex", "fnCall", "define", "forLoop", "whileLoop",
		"block", "shopt", "builtin", "bcSqrt":
		return "Emulable"
	case "exec":
		if len(args) > 0 {
			if s, ok := args[0].(*StrE); ok && syncBuiltins[s.Value] {
				return "Emulable"
			}
		}
		return "Spawn"
	case "capture", "captureWords", "pipeline", "redirect", "subshell",
		"background", "callUndefined", "unsupported":
		return "Spawn"
	case "return", "break", "continue", "exit":
		return "Control"
	}
	if strings.HasPrefix(fn, "fs.") {
		return "Fs"
	}
	return "Spawn"
}

func call(fn string, args []Expr) *CallE { return &CallE{Func: fn, Args: args} }
func st(s string) *StrE                  { return &StrE{Value: s, Style: "DoubleQuoted"} }

// ── seq-range-for transform (mirror transforms/seq_range_for.rs) ─────
// `for i in $(seq A B)` → native numeric range loop: rewrites the
// captureWords for-item to a bare Range iterable. Runs after
// optimizeStmts, before the A2 analyses (mirror ast_to_ir).

const maxSafeInt = int64(1) << 53
const maxSeqSpan = int64(1_000_000)

func applyTransforms(stmts []Stmt) bool {
	changed := false
	for _, s := range stmts {
		changed = transformStmt(s) || changed
	}
	return changed
}

func transformStmts(stmts []Stmt) bool {
	changed := false
	for _, s := range stmts {
		changed = transformStmt(s) || changed
	}
	return changed
}

func transformStmt(st Stmt) bool {
	switch t := st.(type) {
	case *ForS:
		changed := transformStmts(t.Body)
		if start, end, ok := seqRangeBounds(t.Iter); ok && !stmtsWriteVar(t.Body, t.Var) {
			// A BARE Range — the shIR contract's numeric-range For.iterable
			// shape (PLAN §5.6): the backend matches Range directly.
			t.Iter = &RangeE{Start: start, End: end}
			changed = true
		}
		return changed
	case *WhileS:
		return transformStmts(t.Body)
	case *BlockS:
		return transformStmts(t.Body)
	case *SubshellS:
		return transformStmts(t.Body)
	case *BackgroundS:
		return transformStmts(t.Body)
	case *FunctionS:
		return transformStmts(t.Body)
	case *IfS:
		changed := transformStmts(t.Then) || transformStmts(t.Else)
		for _, pair := range t.Elsifs {
			if b, ok := pair[1].([]Stmt); ok {
				changed = transformStmts(b) || changed
			}
		}
		return changed
	case *PipelineS:
		changed := false
		for _, stage := range t.Stages {
			changed = transformStmts(stage) || changed
		}
		return changed
	case *RedirectS:
		return transformStmts(t.Inner)
	case *CaseS:
		changed := false
		for _, cl := range t.Clauses {
			changed = transformStmts(cl.Body) || changed
		}
		return changed
	case *ExprS:
		return transformExpr(t.Expr)
	case *AssignS:
		return transformExpr(t.Expr)
	}
	return false
}

func transformExpr(e Expr) bool {
	switch t := e.(type) {
	case *ArrowE:
		return transformStmts(t.Body)
	case *CallE:
		changed := false
		for _, a := range t.Args {
			changed = transformExpr(a) || changed
		}
		return changed
	case *ArrayE:
		changed := false
		for _, a := range t.Elems {
			changed = transformExpr(a) || changed
		}
		return changed
	case *ObjectE:
		changed := false
		for _, p := range t.Props {
			changed = transformExpr(p.Val) || changed
		}
		return changed
	}
	return false
}

// seqRangeBounds — the `[lo, hi]` integer bounds when `iter` is the
// `$(seq …)` capture shape: `Array([captureWords(Arrow([Expr(exec("seq",
// args))]))])` (for-items array wrapping a single command-substitution
// item) or the bare call. Nothing else matches.
func seqRangeBounds(iter Expr) (int64, int64, bool) {
	var call *CallE
	switch t := iter.(type) {
	case *ArrayE:
		if len(t.Elems) != 1 {
			return 0, 0, false
		}
		c, ok := t.Elems[0].(*CallE)
		if !ok {
			return 0, 0, false
		}
		call = c
	case *CallE:
		call = t
	default:
		return 0, 0, false
	}
	if call.Func != "captureWords" {
		return 0, 0, false
	}
	// exactly one statement in the capture: `exec("seq", args)`
	if len(call.Args) != 1 {
		return 0, 0, false
	}
	arrow, ok := call.Args[0].(*ArrowE)
	if !ok || len(arrow.Body) != 1 {
		return 0, 0, false
	}
	es, ok := arrow.Body[0].(*ExprS)
	if !ok {
		return 0, 0, false
	}
	ec, ok := es.Expr.(*CallE)
	if !ok || ec.Func != "exec" {
		return 0, 0, false
	}
	// bare exec: name + arg array only (env/redirects disqualify)
	if len(ec.Args) != 2 {
		return 0, 0, false
	}
	name, ok := ec.Args[0].(*StrE)
	if !ok || name.Value != "seq" {
		return 0, 0, false
	}
	seqArgs, ok := ec.Args[1].(*ArrayE)
	if !ok {
		return 0, 0, false
	}
	vals := make([]int64, 0, len(seqArgs.Elems))
	for _, a := range seqArgs.Elems {
		v, ok := seqArgInt(a)
		if !ok {
			return 0, 0, false
		}
		vals = append(vals, v)
	}
	switch len(vals) {
	case 1: // `seq LAST` — GNU seq starts at 1
		return rangeBounds(1, vals[0])
	case 2: // `seq FIRST LAST` — default step 1
		return rangeBounds(vals[0], vals[1])
	}
	// 3-arg step forms (`seq A S B`), flags, >3 args: keep the runtime
	// path (a step would need a stride the Range node lacks)
	return 0, 0, false
}

func rangeBounds(start, end int64) (int64, int64, bool) {
	span := end - start
	if span < 0 {
		span = -span
	}
	if span <= maxSeqSpan {
		return start, end, true
	}
	return 0, 0, false
}

// A seq argument must be a plain integer literal: no floats (locale
// formatting), no leading zeros (GNU seq pads `01 02 …`; bash arithmetic
// reads `010` as OCTAL 8), no flags, within double-precision exactness.
func seqArgInt(a Expr) (int64, bool) {
	var s string
	switch t := a.(type) {
	case *StrE:
		s = t.Value
	case *IntE:
		u := t.Value
		if u < 0 {
			u = -u
		}
		if u <= maxSafeInt {
			return t.Value, true
		}
		return 0, false
	default:
		return 0, false
	}
	if s == "" || (len(s) > 1 && strings.HasPrefix(s, "0")) {
		return 0, false
	}
	if strings.HasPrefix(s, "-") && len(s) > 2 && strings.HasPrefix(s, "-0") {
		return 0, false // -01: same octal/padding concern
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	u := v
	if u < 0 {
		u = -u
	}
	if u <= maxSafeInt {
		return v, true
	}
	return 0, false
}

// ── body-write scan: a counter loop's `i++` re-reads the binding, so a
// body that writes the loop var would derail the sequence (the
// materialized word list re-iterates regardless — bash semantics).
// Conservative: any assignment / store write / store-writing builtin
// mentioning the var.

func stmtsWriteVar(stmts []Stmt, v string) bool {
	for _, s := range stmts {
		if stmtWritesVar(s, v) {
			return true
		}
	}
	return false
}

func stmtWritesVar(st Stmt, v string) bool {
	switch t := st.(type) {
	case *AssignS:
		return t.Var == v // plain scalar targets only (indices empty by construction)
	case *ExprS:
		return exprWritesVar(t.Expr, v)
	case *IfS:
		return stmtsWriteVar(t.Then, v) || stmtsWriteVar(t.Else, v)
	case *WhileS:
		return stmtsWriteVar(t.Body, v)
	case *BlockS:
		return stmtsWriteVar(t.Body, v)
	case *SubshellS:
		return stmtsWriteVar(t.Body, v)
	case *BackgroundS:
		return stmtsWriteVar(t.Body, v)
	case *FunctionS:
		return stmtsWriteVar(t.Body, v)
	case *ForS:
		// a nested `for var in …` REASSIGNS var in bash (the inner
		// iteration clobbers the outer binding) — count the loop-var
		// binding itself as a write
		return t.Var == v || stmtsWriteVar(t.Body, v)
	case *CaseS:
		for _, cl := range t.Clauses {
			if stmtsWriteVar(cl.Body, v) {
				return true
			}
		}
		return false
	case *PipelineS:
		for _, stage := range t.Stages {
			if stmtsWriteVar(stage, v) {
				return true
			}
		}
		return false
	case *RedirectS:
		return stmtsWriteVar(t.Inner, v)
	}
	return false
}

func exprWritesVar(e Expr, v string) bool {
	switch t := e.(type) {
	case *CallE:
		// store write: sh2.setVar("var", …)
		if t.Func == "setVar" && len(t.Args) > 0 {
			if n, ok := t.Args[0].(*StrE); ok && n.Value == v {
				return true
			}
		}
		// store-writing builtins: `read i`, `unset i`, `let i=i+1`, …
		if (t.Func == "exec" || t.Func == "builtin") && len(t.Args) > 0 {
			if n, ok := t.Args[0].(*StrE); ok {
				switch n.Value {
				case "read", "readarray", "mapfile", "unset", "let", "eval",
					"declare", "typeset", "local":
					if len(t.Args) > 1 {
						if wargs, ok := t.Args[1].(*ArrayE); ok {
							for _, a := range wargs.Elems {
								if w, ok := a.(*StrE); ok {
									if n.Value == "let" || n.Value == "eval" {
										if containsIdent(w.Value, v) {
											return true
										}
									} else if w.Value == v {
										return true
									}
								}
							}
						}
					}
				}
			}
		}
		for _, a := range t.Args {
			if exprWritesVar(a, v) {
				return true
			}
		}
		return false
	case *ArrowE:
		return stmtsWriteVar(t.Body, v)
	}
	return false
}

// containsIdent — does `s` contain `var` as a standalone identifier
// (word-boundary delimited)? For `let 'i=i+1'` / `eval 'i=$x'` arg strings.
func containsIdent(s, v string) bool {
	if v == "" {
		return false
	}
	for _, c := range v {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	i := 0
	b := []byte(s)
	for i < len(b) {
		c := b[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' {
			start := i
			for i < len(b) && (b[i] >= 'a' && b[i] <= 'z' || b[i] >= 'A' && b[i] <= 'Z' || b[i] >= '0' && b[i] <= '9' || b[i] == '_') {
				i++
			}
			if string(b[start:i]) == v {
				return true
			}
		} else {
			i++
		}
	}
	return false
}

// ─────────────────────────────────────────────────────────────────────
// quote removal (mirror shell_quote_removal)
// ─────────────────────────────────────────────────────────────────────

var quoteKeep = map[byte]bool{
	'n': true, '"': true, 'x': true, 'u': true, 't': true, '(': true,
	'v': true, 'r': true, 'f': true, 'b': true, 'a': true, '\\': true,
	')': true, '0': true, '1': true, '2': true, '3': true, '4': true,
	'5': true, '6': true, '7': true, '8': true, '9': true,
}

func shellQuoteRemoval(s string) string {
	var sb strings.Builder
	i := 0
	for i < len(s) {
		c := s[i]
		if c == '\\' {
			if i+1 < len(s) {
				n := s[i+1]
				if quoteKeep[n] {
					sb.WriteByte('\\')
					sb.WriteByte(n)
				} else {
					sb.WriteByte(n)
				}
				i += 2
			} else {
				i++ // trailing backslash dropped
			}
			continue
		}
		sb.WriteByte(c)
		i++
	}
	return sb.String()
}

const globMagic = "\u0001SH2GLOB\u0001"

func hasGlobChars(s string) bool {
	bytes := []byte(s)
	i := 0
	for i < len(bytes) {
		if bytes[i] == '$' && i+1 < len(bytes) && bytes[i+1] == '{' {
			depth := 1
			j := i + 2
			for j < len(bytes) && depth > 0 {
				if bytes[j] == '{' {
					depth++
				} else if bytes[j] == '}' {
					depth--
				}
				j++
			}
			i = j
			continue
		}
		if bytes[i] == '*' || bytes[i] == '?' || bytes[i] == '[' {
			return true
		}
		i++
	}
	return false
}

// ─────────────────────────────────────────────────────────────────────
// word → IR (mirror word_ir / arg_word_ir / for_item_ir / part_ir / param_ir)
// ─────────────────────────────────────────────────────────────────────

func paramIR(pe *Word) Expr {
	op := ""
	var extra []Expr
	switch pe.PEOp {
	case "^^":
		op = "^^"
	case ",,":
		op = ",,"
	case "^":
		op = "^"
	case "##":
		op = "##"
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
	case "#":
		op = "#"
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
	case "%%":
		op = "%%"
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
	case "%":
		op = "%"
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
	case "//":
		op = "//"
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
		if len(pe.PEExtra) > 1 {
			extra = append(extra, st(pe.PEExtra[1]))
		}
	case ":-":
		op = ":-"
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
	case ":=":
		op = ":="
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
	case ":?":
		op = ":?"
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
	case "basename":
		op = "basename"
	case "dirname":
		op = "dirname"
	case "slice":
		op = "slice"
		if len(pe.PEExtra) > 0 {
			extra = append(extra, st(pe.PEExtra[0]))
		}
		if len(pe.PEExtra) > 1 {
			extra = append(extra, st(pe.PEExtra[1]))
		} else {
			extra = append(extra, st(""))
		}
	case "len":
		op = "len"
	default:
		op = ""
	}
	args := []Expr{st(op), st(pe.PEVar)}
	args = append(args, extra...)
	return call("param", args)
}

// parseBracedContent → pe with operator resolved; compute the param args.
func bracedParamIR(pe *Word) Expr {
	// ${#name} — length: the parser keeps `#` in the variable name
	if pe.PEOp == "" && len(pe.PEVar) > 1 && strings.HasPrefix(pe.PEVar, "#") {
		return call("param", []Expr{st("len"), st(pe.PEVar[1:])})
	}
	return paramIR(pe)
}

// parseCmdList — parse command-substitution content into a command list
// (mirrors the core's $(...) content parse: pipeline parse first; if it
// consumes everything → that command; else the full command list; on
// failure → echo placeholder). Returns ok=false when unparseable.
func parseCmdList(raw string) ([]*Command, bool) {
	p := &Parser{src: raw}
	cmd, err := p.parseCommand()
	if err == nil {
		p.skipWSAndComments()
		if p.eof() {
			return []*Command{cmd}, true
		}
	}
	p2 := &Parser{src: raw}
	cmds, err2 := p2.parseProgram()
	if err2 != nil || len(cmds) == 0 {
		return nil, false
	}
	return cmds, true
}

func echoPlaceholderCmd(raw string) *Command {
	return &Command{
		Kind: "simple",
		Name: &Word{Kind: "lit", Text: "echo"},
		Args: []*Word{{Kind: "lit", Text: raw}},
	}
}

func echoPlaceholder(raw string) []*Command {
	return []*Command{echoPlaceholderCmd(raw)}
}

// zshIndexKey — canonical 0-based A1 subscript (PLAN v12): a 1-based
// positive literal becomes n-1; "@"/"*"/negative/dynamic subscripts pass
// through raw (a negative index counts from the end in BOTH bases —
// base-invariant). The executor is language-blind since the frontend
// normalizes at emit.
func zshIndexKey(key string) string {
	if n, err := strconv.Atoi(key); err == nil && n >= 1 {
		return strconv.Itoa(n - 1)
	}
	return key
}

// zshSliceKey — `a,b` (zsh 1-based INCLUSIVE substring range, e.g.
// `${s[2,3]}`) → the bash-shaped 0-based param("slice", name, off, len)
// form every backend understands (off = a-1, len = b-a+1). Returns
// ok=false when key is not a comma-range (or is degenerate — zsh renders
// those empty, and so does the executor's bad-subscript path).
func zshSliceKey(name, key string) (Expr, bool) {
	comma := strings.IndexByte(key, ',')
	if comma < 0 {
		return nil, false
	}
	a, errA := strconv.Atoi(key[:comma])
	b, errB := strconv.Atoi(key[comma+1:])
	if errA != nil || errB != nil || a < 1 || b < a {
		return nil, false
	}
	// wrapped in join like the core's partIR slice: a plain-name slice is
	// ambiguous (array or scalar at runtime) — the runtime join handles
	// both (arrays join with space, scalars are identity)
	slice := call("param", []Expr{st("slice"), st(name), st(strconv.Itoa(a - 1)), st(strconv.Itoa(b - a + 1))})
	return call("join", []Expr{slice}), true
}

// partIR — StringPart → IR (mirror part_ir).
func partIR(part *Part, cmds map[string][]*Command) Expr {
	if part.IsLit {
		panic("Literal parts handled in interpolateIR")
	}
	switch {
	case part.Var != "":
		return call("getVar", []Expr{st(part.Var)})
	case part.PE != nil:
		if part.PE.PEOp == "slice" {
			return call("join", []Expr{bracedParamIR(part.PE)})
		}
		return bracedParamIR(part.PE)
	case part.ArithRaw != "":
		return arithWordIR(part.ArithRaw)
	case part.CSRaw != "":
		if part.CSCmd != nil {
			return call("capture", []Expr{&ArrowE{Body: commandArrowStmts([]*Command{part.CSCmd})}})
		}
		body, ok := parseCmdList(part.CSRaw)
		if !ok {
			return st("$(" + part.CSRaw + ")")
		}
		return call("capture", []Expr{&ArrowE{Body: commandArrowStmts(body)}})
	case part.MapKind == "access":
		if slice, ok := zshSliceKey(part.MapName, part.MapKey); ok {
			return call("join", []Expr{slice})
		}
		inner := call("arrayIndex", []Expr{st(part.MapName), st(zshIndexKey(part.MapKey))})
		if part.MapKey == "@" || part.MapKey == "*" {
			return call("join", []Expr{inner})
		}
		return inner
	case part.MapKind == "keys":
		return call("join", []Expr{call("arrayItems", []Expr{st(part.MapName)})})
	case part.MapKind == "len":
		return call("arrayLen", []Expr{st(part.MapName)})
	case part.MapKind == "slice":
		ln := ""
		if part.SliceLen != nil {
			ln = *part.SliceLen
		}
		return call("join", []Expr{call("param", []Expr{st("slice"), st(part.MapName), st(part.SliceOff), st(ln)})})
	}
	return call("unsupported", []Expr{st("part")})
}

// purePart — the single non-literal part of a one-part interpolation.
func purePart(parts []Part) *Part {
	var nonLit *Part
	for i := range parts {
		pt := &parts[i]
		if pt.IsLit {
			if pt.Lit != "" {
				return nil
			}
			continue
		}
		if nonLit != nil {
			return nil
		}
		nonLit = pt
	}
	return nonLit
}

func interpolateIR(parts []Part, cmds map[string][]*Command) Expr {
	out := &InterpE{Parts: []InterpPartE{}}
	for i := range parts {
		pt := &parts[i]
		if pt.IsLit {
			out.Parts = append(out.Parts, InterpPartE{IsLit: true, Lit: pt.Lit})
		} else {
			out.Parts = append(out.Parts, InterpPartE{IsLit: false, Expr: partIR(pt, cmds)})
		}
	}
	return out
}

func partIRFlat(part *Part, cmds map[string][]*Command) Expr {
	switch {
	case part.Var == "@" || part.Var == "*":
		return call("listVar", []Expr{st(part.Var)})
	case part.PE != nil:
		return bracedParamIR(part.PE)
	}
	return partIR(part, cmds)
}

// braceItemsJSON — mirror brace_items_json.
func braceItemsJSON(items []BraceItem) []interface{} {
	out := make([]interface{}, 0, len(items))
	for _, it := range items {
		if it.IsRange {
			step := interface{}(nil)
			if it.Step != nil {
				step = *it.Step
			}
			out = append(out, map[string]interface{}{"range": []interface{}{it.Start, it.End, step, nil}})
		} else if it.Nested != nil {
			out = append(out, map[string]interface{}{"nested": braceItemsJSON(it.Nested)})
		} else {
			out = append(out, it.Text)
		}
	}
	return out
}

func braceIR(be *Word) Expr {
	groups := []interface{}{braceItemsJSON(be.BraceItems)}
	return call("brace", []Expr{
		st(be.BracePrefix),
		&JsonE{Value: groups},
		&JsonE{Value: []interface{}{}},
		st(be.BraceSuffix),
	})
}

// mergedWordsIR — mirror merged_words_ir: consecutive brace expansions
// merge into a single cross-product brace call.
func mergedWordsIR(words []*Word, single func(*Word) Expr) []Expr {
	var out []Expr
	i := 0
	for i < len(words) {
		if words[i].Kind == "brace" {
			var groups []interface{}
			middles := []interface{}{}
			suffix := words[i].BraceSuffix
			prefix := words[i].BracePrefix
			groups = append(groups, braceItemsJSON(words[i].BraceItems))
			i++
			for i < len(words) && words[i].Kind == "brace" {
				middles = append(middles, suffix+words[i].BracePrefix)
				groups = append(groups, braceItemsJSON(words[i].BraceItems))
				suffix = words[i].BraceSuffix
				i++
			}
			magicPrefix := prefix
			if hasGlobChars(prefix) || hasGlobChars(suffix) || beItemsContainGlob(groups) {
				magicPrefix = globMagic + prefix
			}
			out = append(out, call("brace", []Expr{
				st(magicPrefix),
				&JsonE{Value: groups},
				&JsonE{Value: middles},
				st(suffix),
			}))
		} else {
			out = append(out, single(words[i]))
			i++
		}
	}
	return out
}

func beItemsContainGlob(groups []interface{}) bool {
	var found bool
	var collect func(v interface{})
	collect = func(v interface{}) {
		switch t := v.(type) {
		case string:
			if hasGlobChars(t) {
				found = true
			}
		case []interface{}:
			for _, x := range t {
				collect(x)
			}
		case map[string]interface{}:
			for _, x := range t {
				collect(x)
			}
		}
	}
	for _, g := range groups {
		collect(g)
	}
	return found
}

// wordIR — mirror word_ir.
func wordIR(w *Word, cmds map[string][]*Command) Expr {
	switch w.Kind {
	case "lit":
		return st(shellQuoteRemoval(w.Text))
	case "brace":
		return braceIR(w)
	case "var":
		return call("getVar", []Expr{st(w.VarName)})
	case "cs":
		if w.CSCmd != nil {
			return call("captureWords", []Expr{&ArrowE{Body: commandArrowStmts([]*Command{w.CSCmd})}})
		}
		body, ok := parseCmdList(w.Raw)
		if !ok {
			body = echoPlaceholder(w.Raw)
		}
		return call("captureWords", []Expr{&ArrowE{Body: commandArrowStmts(body)}})
	case "pe":
		return bracedParamIR(w)
	case "arith":
		return arithWordIR(w.Raw)
	case "array":
		return call("getVar", []Expr{st(w.ArrayName)})
	case "mapaccess":
		if slice, ok := zshSliceKey(w.MapName, w.MapKey); ok {
			return slice
		}
		return call("arrayIndex", []Expr{st(w.MapName), st(zshIndexKey(w.MapKey))})
	case "mapkeys":
		return call("arrayItems", []Expr{st(w.MapName)})
	case "maplen":
		return call("arrayLen", []Expr{st(w.MapName)})
	case "arrayslice":
		ln := ""
		if w.SliceLen != nil {
			ln = *w.SliceLen
		}
		return call("param", []Expr{st("slice"), st(w.MapName), st(w.SliceOff), st(ln)})
	case "interp":
		if part := purePart(w.Parts); part != nil {
			return partIR(part, cmds)
		}
		return interpolateIR(w.Parts, cmds)
	}
	return call("unsupported", []Expr{st("word")})
}

// wordIRQuoted — mirror word_ir_quoted (assignment RHS / env values).
func wordIRQuoted(w *Word, cmds map[string][]*Command) Expr {
	if w.Kind == "cs" {
		if w.CSCmd != nil {
			return call("capture", []Expr{&ArrowE{Body: commandArrowStmts([]*Command{w.CSCmd})}})
		}
		body, ok := parseCmdList(w.Raw)
		if !ok {
			body = echoPlaceholder(w.Raw)
		}
		return call("capture", []Expr{&ArrowE{Body: commandArrowStmts(body)}})
	}
	return wordIR(w, cmds)
}

// argWordIR — mirror arg_word_ir (exec args; GLOB_MAGIC tagging).
func argWordIR(w *Word, cmds map[string][]*Command) Expr {
	switch w.Kind {
	case "lit":
		s2 := shellQuoteRemoval(w.Text)
		if !w.Quoted && hasGlobChars(s2) {
			return st(globMagic + s2)
		}
		return st(s2)
	// UNQUOTED pure expansion in exec-arg position (`echo $y`, `set -- $y`):
	// bash field-splits it on IFS into separate args. A bare Kind "var" is
	// unquoted by construction — quoted `"$y"` and `pre$y` merge into
	// "interp" and keep the bare getVar (mirror shir.rs arg_word_ir). `$@`/
	// `$*` keep the bare read (positional-join semantics).
	case "var":
		if w.VarName != "@" && w.VarName != "*" {
			return call("split", []Expr{call("getVar", []Expr{st(w.VarName)})})
		}
		return call("getVar", []Expr{st(w.VarName)})
	case "array":
		var elems []Expr
		for _, e := range w.ArrayElems {
			elems = append(elems, st(e))
		}
		return call("setArray", []Expr{st(w.ArrayName), &ArrayE{Elems: elems}, &BoolE{Value: false}})
	}
	return wordIR(w, cmds)
}

// forItemIR — mirror for_item_ir.
func forItemIR(w *Word, cmds map[string][]*Command) Expr {
	if w.Kind == "var" && (w.VarName == "@" || w.VarName == "*") {
		return call("listVar", []Expr{st(w.VarName)})
	}
	if w.Kind == "interp" {
		if part := purePart(w.Parts); part != nil {
			return partIRFlat(part, cmds)
		}
	}
	return argWordIR(w, cmds)
}

// ─────────────────────────────────────────────────────────────────────
// arithmetic (mirror shir.rs parse_arith + guards; ir.rs fold_arith_const)
// ─────────────────────────────────────────────────────────────────────

type ArithAst interface{}
type ArithNum struct{ Val int64 }
type ArithVar struct{ Name string }
type ArithIndex struct {
	Var string
	Key ArithAst
}
type ArithBin struct {
	Op       string
	Lhs, Rhs ArithAst
}
type ArithUn struct {
	Op  string
	Arg ArithAst
}
type ArithCond struct{ Test, Then, Else ArithAst }
type ArithAssign struct {
	Var, Op string
	Rhs     ArithAst
}
type ArithIncDec struct {
	Var    string
	Delta  int64
	Prefix bool
}

type arithParser struct {
	src []byte
	pos int
}

func (a *arithParser) skip() {
	for a.pos < len(a.src) && (a.src[a.pos] == ' ' || a.src[a.pos] == '\t' || a.src[a.pos] == '\n' || a.src[a.pos] == '\r') {
		a.pos++
	}
}
func (a *arithParser) eat2(s string) bool {
	if a.pos+len(s) <= len(a.src) && string(a.src[a.pos:a.pos+len(s)]) == s {
		a.pos += len(s)
		return true
	}
	return false
}
func (a *arithParser) identName() (string, bool) {
	if a.pos >= len(a.src) || !(isIdentStart(a.src[a.pos])) {
		return "", false
	}
	start := a.pos
	for a.pos < len(a.src) && isPlainIdentChar(a.src[a.pos]) {
		a.pos++
	}
	return string(a.src[start:a.pos]), true
}

func (a *arithParser) primary() (ArithAst, bool) {
	a.skip()
	if a.pos >= len(a.src) {
		return nil, false
	}
	c := a.src[a.pos]
	if c == '(' {
		a.pos++
		e, ok := a.ternary()
		if !ok {
			return nil, false
		}
		a.skip()
		if a.pos >= len(a.src) || a.src[a.pos] != ')' {
			return nil, false
		}
		a.pos++
		return e, true
	}
	if c >= '0' && c <= '9' {
		start := a.pos
		for a.pos < len(a.src) && (isPlainIdentChar(a.src[a.pos]) || a.src[a.pos] == 'x' || a.src[a.pos] == 'X') {
			a.pos++
		}
		s := string(a.src[start:a.pos])
		var v int64
		var err error
		if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
			v, err = strconv.ParseInt(s[2:], 16, 64)
		} else {
			v, err = strconv.ParseInt(s, 10, 64)
		}
		if err != nil {
			return nil, false
		}
		return &ArithNum{Val: v}, true
	}
	if c == '$' {
		return nil, false
	}
	if isIdentStart(c) {
		name, ok := a.identName()
		if !ok {
			return nil, false
		}
		a.skip()
		if a.pos < len(a.src) && a.src[a.pos] == '[' {
			a.pos++
			key, ok := a.ternary()
			if !ok {
				return nil, false
			}
			a.skip()
			if a.pos >= len(a.src) || a.src[a.pos] != ']' {
				return nil, false
			}
			a.pos++
			return &ArithIndex{Var: name, Key: key}, true
		}
		if a.eat2("++") {
			return &ArithIncDec{Var: name, Delta: 1, Prefix: false}, true
		}
		if a.eat2("--") {
			return &ArithIncDec{Var: name, Delta: -1, Prefix: false}, true
		}
		return &ArithVar{Name: name}, true
	}
	return nil, false
}

func (a *arithParser) unary() (ArithAst, bool) {
	a.skip()
	if a.pos < len(a.src) {
		c := a.src[a.pos]
		if c == '+' && a.pos+1 < len(a.src) && a.src[a.pos+1] == '+' {
			a.pos += 2
			a.skip()
			name, ok := a.identName()
			if !ok {
				return nil, false
			}
			return &ArithIncDec{Var: name, Delta: 1, Prefix: true}, true
		}
		if c == '-' && a.pos+1 < len(a.src) && a.src[a.pos+1] == '-' {
			a.pos += 2
			a.skip()
			name, ok := a.identName()
			if !ok {
				return nil, false
			}
			return &ArithIncDec{Var: name, Delta: -1, Prefix: true}, true
		}
		if c == '-' || c == '+' || c == '!' || c == '~' {
			a.pos++
			op := "-"
			if c == '+' {
				op = "+"
			} else if c == '!' {
				op = "!"
			} else if c == '~' {
				op = "~"
			}
			arg, ok := a.unary()
			if !ok {
				return nil, false
			}
			return &ArithUn{Op: op, Arg: arg}, true
		}
	}
	return a.primary()
}

func (a *arithParser) pow() (ArithAst, bool) {
	base, ok := a.unary()
	if !ok {
		return nil, false
	}
	a.skip()
	if a.pos+1 < len(a.src) && a.src[a.pos] == '*' && a.src[a.pos+1] == '*' {
		a.pos += 2
		exp, ok := a.pow()
		if !ok {
			return nil, false
		}
		return &ArithBin{Op: "**", Lhs: base, Rhs: exp}, true
	}
	return base, true
}

func (a *arithParser) binLevel(next func() (ArithAst, bool), ops ...string) (ArithAst, bool) {
	lhs, ok := next()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.pos >= len(a.src) {
			return lhs, true
		}
		c := a.src[a.pos]
		matched := false
		for _, op := range ops {
			if len(op) == 1 && c == op[0] {
				if op == "&" && a.pos+1 < len(a.src) && a.src[a.pos+1] == '&' {
					continue
				}
				if op == "|" && a.pos+1 < len(a.src) && a.src[a.pos+1] == '|' {
					continue
				}
				a.pos++
				rhs, ok := next()
				if !ok {
					return nil, false
				}
				lhs = &ArithBin{Op: op, Lhs: lhs, Rhs: rhs}
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		return lhs, true
	}
}

func (a *arithParser) mul() (ArithAst, bool) { return a.binLevel(a.pow, "*", "/", "%") }
func (a *arithParser) add() (ArithAst, bool) { return a.binLevel(a.mul, "+", "-") }

func (a *arithParser) shift() (ArithAst, bool) {
	lhs, ok := a.add()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.eat2("<<") {
			rhs, ok := a.add()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: "<<", Lhs: lhs, Rhs: rhs}
		} else if a.eat2(">>") {
			rhs, ok := a.add()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: ">>", Lhs: lhs, Rhs: rhs}
		} else {
			return lhs, true
		}
	}
}

func (a *arithParser) rel() (ArithAst, bool) {
	lhs, ok := a.shift()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.pos >= len(a.src) {
			return lhs, true
		}
		c := a.src[a.pos]
		if c == '<' || c == '>' {
			two := a.pos+1 < len(a.src) && a.src[a.pos+1] == '='
			op := string(c)
			if two {
				op += "="
			}
			a.pos += 1
			if two {
				a.pos++
			}
			rhs, ok := a.shift()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: op, Lhs: lhs, Rhs: rhs}
		} else {
			return lhs, true
		}
	}
}

func (a *arithParser) eq() (ArithAst, bool) {
	lhs, ok := a.rel()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.eat2("==") {
			rhs, ok := a.rel()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: "==", Lhs: lhs, Rhs: rhs}
		} else if a.eat2("!=") {
			rhs, ok := a.rel()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: "!=", Lhs: lhs, Rhs: rhs}
		} else {
			return lhs, true
		}
	}
}

func (a *arithParser) band() (ArithAst, bool) {
	lhs, ok := a.eq()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.pos < len(a.src) && a.src[a.pos] == '&' && (a.pos+1 >= len(a.src) || a.src[a.pos+1] != '&') {
			a.pos++
			rhs, ok := a.eq()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: "&", Lhs: lhs, Rhs: rhs}
		} else {
			return lhs, true
		}
	}
}

func (a *arithParser) bxor() (ArithAst, bool) {
	lhs, ok := a.band()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.pos < len(a.src) && a.src[a.pos] == '^' {
			a.pos++
			rhs, ok := a.band()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: "^", Lhs: lhs, Rhs: rhs}
		} else {
			return lhs, true
		}
	}
}

func (a *arithParser) bor() (ArithAst, bool) {
	lhs, ok := a.bxor()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.pos < len(a.src) && a.src[a.pos] == '|' && (a.pos+1 >= len(a.src) || a.src[a.pos+1] != '|') {
			a.pos++
			rhs, ok := a.bxor()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: "|", Lhs: lhs, Rhs: rhs}
		} else {
			return lhs, true
		}
	}
}

func (a *arithParser) land() (ArithAst, bool) {
	lhs, ok := a.bor()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.eat2("&&") {
			rhs, ok := a.bor()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: "&&", Lhs: lhs, Rhs: rhs}
		} else {
			return lhs, true
		}
	}
}

func (a *arithParser) lor() (ArithAst, bool) {
	lhs, ok := a.land()
	if !ok {
		return nil, false
	}
	for {
		a.skip()
		if a.eat2("||") {
			rhs, ok := a.land()
			if !ok {
				return nil, false
			}
			lhs = &ArithBin{Op: "||", Lhs: lhs, Rhs: rhs}
		} else {
			return lhs, true
		}
	}
}

func (a *arithParser) ternary() (ArithAst, bool) {
	test, ok := a.lor()
	if !ok {
		return nil, false
	}
	a.skip()
	if a.pos < len(a.src) && a.src[a.pos] == '?' {
		a.pos++
		then, ok := a.ternary()
		if !ok {
			return nil, false
		}
		a.skip()
		if a.pos >= len(a.src) || a.src[a.pos] != ':' {
			return nil, false
		}
		a.pos++
		else_, ok := a.ternary()
		if !ok {
			return nil, false
		}
		return &ArithCond{Test: test, Then: then, Else: else_}, true
	}
	return test, true
}

func (a *arithParser) assignment() (ArithAst, bool) {
	a.skip()
	if a.pos < len(a.src) && isIdentStart(a.src[a.pos]) {
		save := a.pos
		name, ok := a.identName()
		if !ok {
			return nil, false
		}
		a.skip()
		if a.pos < len(a.src) && a.src[a.pos] == '[' {
			a.pos = save
			return a.ternary()
		}
		var op string
		matched := false
		if a.pos < len(a.src) && a.src[a.pos] == '=' {
			if a.pos+1 < len(a.src) && a.src[a.pos+1] == '=' {
				// == is equality — not assignment
			} else {
				a.pos++
				op = "="
				matched = true
			}
		} else if a.eat2("+=") {
			op = "+="
			matched = true
		} else if a.eat2("-=") {
			op = "-="
			matched = true
		} else if a.eat2("*=") {
			op = "*="
			matched = true
		}
		if matched {
			a.skip()
			if a.pos >= len(a.src) {
				return nil, false
			}
			rhs, ok := a.assignment()
			if !ok {
				return nil, false
			}
			return &ArithAssign{Var: name, Op: op, Rhs: rhs}, true
		}
		a.pos = save
	}
	return a.ternary()
}

func parseArith(src string) (ArithAst, bool) {
	a := &arithParser{src: []byte(src)}
	ast, ok := a.assignment()
	if !ok {
		return nil, false
	}
	a.skip()
	if a.pos != len(a.src) {
		return nil, false
	}
	return ast, true
}

func arithHasDivMod(ast ArithAst) bool {
	switch t := ast.(type) {
	case *ArithBin:
		return t.Op == "/" || t.Op == "%" || arithHasDivMod(t.Lhs) || arithHasDivMod(t.Rhs)
	case *ArithUn:
		return arithHasDivMod(t.Arg)
	case *ArithCond:
		return arithHasDivMod(t.Test) || arithHasDivMod(t.Then) || arithHasDivMod(t.Else)
	case *ArithIndex:
		return arithHasDivMod(t.Key)
	case *ArithAssign:
		return arithHasDivMod(t.Rhs)
	}
	return false
}

func arithHasWrite(ast ArithAst) bool {
	switch t := ast.(type) {
	case *ArithAssign, *ArithIncDec:
		return true
	case *ArithBin:
		return arithHasWrite(t.Lhs) || arithHasWrite(t.Rhs)
	case *ArithUn:
		return arithHasWrite(t.Arg)
	case *ArithCond:
		return arithHasWrite(t.Test) || arithHasWrite(t.Then) || arithHasWrite(t.Else)
	case *ArithIndex:
		return arithHasWrite(t.Key)
	}
	return false
}

func arithLowerable(ast ArithAst) bool {
	switch t := ast.(type) {
	case *ArithAssign:
		return !arithHasWrite(t.Rhs)
	case *ArithIncDec:
		return true
	case *ArithBin:
		return !arithHasWrite(t.Lhs) && !arithHasWrite(t.Rhs)
	case *ArithUn:
		return !arithHasWrite(t.Arg)
	case *ArithCond, *ArithIndex:
		return !arithHasWrite(ast)
	}
	return true
}

// parseArithNative — mirror parse_arith_native.
func parseArithNative(src string) (ArithAst, bool) {
	ast, ok := parseArith(src)
	if !ok {
		return nil, false
	}
	if !arithLowerable(ast) || (arithHasDivMod(ast) && arithHasWrite(ast)) {
		return nil, false
	}
	return ast, true
}

// arithWordIR — $((...)) in word/part position.
func arithWordIR(raw string) Expr {
	if ast, ok := parseArithNative(raw); ok {
		return &ArithE{Ast: ast}
	}
	return call("arith", []Expr{st(raw)})
}

// foldArithConst — mirror ir.rs fold_arith_const (constant arith strings).
func foldArithConst(expr string) (int64, bool) {
	b := []byte(expr)
	pos := 0
	ws := func() {
		for pos < len(b) && (b[pos] == ' ' || b[pos] == '\t' || b[pos] == '\n' || b[pos] == '\r') {
			pos++
		}
	}
	var number func() (int64, bool)
	number = func() (int64, bool) {
		ws()
		neg := false
		if pos < len(b) && b[pos] == '-' {
			neg = true
			pos++
		}
		start := pos
		for pos < len(b) && b[pos] >= '0' && b[pos] <= '9' {
			pos++
		}
		if pos == start {
			return 0, false
		}
		v := int64(0)
		for _, d := range b[start:pos] {
			v = v*10 + int64(d-'0')
		}
		if neg {
			v = -v
		}
		return v, true
	}
	// expression: number (op number)* with + - * / % and parens
	var value func() (int64, bool)
	value = func() (int64, bool) {
		ws()
		if pos < len(b) && b[pos] == '(' {
			pos++
			v, ok := value()
			if !ok {
				return 0, false
			}
			ws()
			if pos >= len(b) || b[pos] != ')' {
				return 0, false
			}
			pos++
			return v, true
		}
		return number()
	}
	v, ok := value()
	if !ok {
		return 0, false
	}
	ws()
	if pos != len(b) {
		return 0, false
	}
	return v, true
}

// ─────────────────────────────────────────────────────────────────────
// command → IR (mirror stmt_for_command / command_to_ir / body_stmts /
// command_arrow_stmts / not_ir / try_lift_grep_contains)
// ─────────────────────────────────────────────────────────────────────

func notIR(inner Expr) Expr {
	return &BinOpE{Op: "Not", Lhs: inner, Rhs: inner}
}

func isSafeGrepLiteral(pat string) bool {
	if strings.HasPrefix(pat, "-") {
		return false
	}
	for _, c := range pat {
		switch c {
		case '^', '$', '.', '[', ']', '*', '\\', '\n':
			return false
		}
	}
	return true
}

// commandArrowStmts — mirror command_arrow_stmts.
func commandArrowStmts(cmds []*Command) []Stmt {
	// Mirrors command_arrow_stmts over a Block: a single-command body lowers
	// each expression-bodied command via command_to_ir (redirects become
	// redirect CALLS in expression context); compound commands keep
	// stmt_for_command.
	var out []Stmt
	for _, c := range cmds {
		switch c.Kind {
		case "simple", "builtin", "test", "redirect", "pipeline", "and", "or",
			"not", "assign", "arith", "break", "continue":
			out = append(out, &ExprS{Expr: commandToIR(c)})
		default:
			if s := stmtForCommand(c); s != nil {
				out = append(out, s)
			}
		}
	}
	return out
}

func bodyStmtsOfList(cmds []*Command) []Stmt {
	var out []Stmt
	for _, c := range cmds {
		if s := stmtForCommand(c); s != nil {
			out = append(out, s)
		}
	}
	return out
}

// commandToIR — mirror command_to_ir (expression position).
func commandToIR(cmd *Command) Expr {
	switch cmd.Kind {
	case "test":
		return call("test", []Expr{st(cmd.TestExpr)})
	case "simple", "builtin":
		// exec_expr: redirects become a redirect CALL in expression context
		e := execCallIR(cmd)
		if len(cmd.Redirect) == 0 {
			return e
		}
		persist := false
		if cmd.Name != nil && cmd.Name.Kind == "lit" && cmd.Name.Text == "exec" && len(cmd.Args) == 0 {
			persist = true
		}
		var specs []Expr
		for _, rd := range cmd.Redirect {
			specs = append(specs, redirectSpecObject(rd, persist))
		}
		return call("redirect", []Expr{
			&ArrowE{Body: []Stmt{&ExprS{Expr: e}}},
			&ArrayE{Elems: specs},
		})
	case "redirect":
		persist := isBareExec(cmd.Inner)
		var specs []Expr
		for _, rd := range cmd.Redirect {
			specs = append(specs, redirectSpecObject(rd, persist))
		}
		return call("redirect", []Expr{
			&ArrowE{Body: []Stmt{&ExprS{Expr: commandToIR(cmd.Inner)}}},
			&ArrayE{Elems: specs},
		})
	case "pipeline":
		var stages []Expr
		for _, c := range cmd.Stages {
			stages = append(stages, &ArrowE{Body: commandArrowStmts([]*Command{c})})
		}
		return call("pipeline", []Expr{&ArrayE{Elems: stages}})
	case "subshell":
		return call("subshell", []Expr{&ArrowE{Body: commandArrowStmts(cmd.BodyCmds)}})
	case "block":
		return call("block", []Expr{&ArrowE{Body: bodyStmtsOfList(cmd.BodyCmds)}})
	case "and":
		return &BinOpE{Op: "And", Lhs: commandToIR(cmd.Lhs), Rhs: commandToIR(cmd.Rhs)}
	case "or":
		return &BinOpE{Op: "Or", Lhs: commandToIR(cmd.Lhs), Rhs: commandToIR(cmd.Rhs)}
	case "not":
		return notIR(commandToIR(cmd.BodyCmds[0]))
	case "assign":
		return assignmentExprIR(cmd)
	case "arith":
		// (( expr )) → exec let with one arg
		return call("exec", []Expr{st("let"), &ArrayE{Elems: []Expr{st(cmd.ArithRaw)}}})
	}
	return call("unsupported", []Expr{st("cmd:" + cmd.Kind)})
}

func isBareExec(cmd *Command) bool {
	if cmd.Kind == "simple" {
		if cmd.Name.Kind == "lit" && cmd.Name.Text == "exec" {
			return true
		}
	}
	return false
}

// stmtForCommand — mirror stmt_for_command.
func stmtForCommand(cmd *Command) Stmt {
	switch cmd.Kind {
	case "simple", "builtin":
		e := execCallIR(cmd)
		if len(cmd.Redirect) == 0 {
			return &ExprS{Expr: e}
		}
		return &RedirectS{Inner: []Stmt{&ExprS{Expr: e}}, Redirects: redirectsIR(cmd.Redirect)}
	case "break":
		return &ExprS{Expr: call("break", []Expr{})}
	case "continue":
		return &ExprS{Expr: call("continue", []Expr{})}
	case "return":
		var val Expr
		if cmd.RetVal != nil {
			val = wordIRQuoted(cmd.RetVal, nil)
		}
		return &ReturnS{Value: val}
	case "case":
		var clauses []CaseClauseIR
		for _, cl := range cmd.CaseClauses {
			clauses = append(clauses, CaseClauseIR{
				Patterns: cl.Patterns,
				Body:     bodyStmtsOfList(cl.Body),
			})
		}
		return &CaseS{Disc: wordIR(cmd.CaseWord, nil), Clauses: clauses}
	case "redirect":
		// bare redirect at command start: inner = empty-name simple
		var inner []Stmt
		if s := stmtForCommand(cmd.Inner); s != nil {
			inner = []Stmt{s}
		} else {
			inner = []Stmt{&ExprS{Expr: call("true", []Expr{})}}
		}
		return &RedirectS{Inner: inner, Redirects: redirectsIR(cmd.Redirect)}
	case "assign":
		return &AssignS{Var: cmd.AssignVar, Expr: assignmentValueIR(cmd)}
	case "if":
		cond := commandToTestIR(cmd.Cond)
		var then []Stmt
		var else_ []Stmt
		if cmd.Then != nil {
			then = bodyStmtsOfList(cmd.Then)
		}
		if cmd.Else != nil {
			if cmd.Else.Kind == "block" {
				else_ = bodyStmtsOfList(cmd.Else.BodyCmds)
			} else if s := stmtForCommand(cmd.Else); s != nil {
				else_ = []Stmt{s}
			}
		}
		return &IfS{Cond: cond, Then: then, Else: else_}
	case "while":
		cond := commandToTestIR(cmd.Cond)
		if cmd.Until {
			cond = notIR(cond)
		}
		return &WhileS{Cond: cond, Body: bodyStmtsOfList(cmd.Body)}
	case "for":
		items := mergedWordsIR(cmd.Items, func(w *Word) Expr { return forItemIR(w, nil) })
		return &ForS{Var: cmd.ForVar, Iter: &ArrayE{Elems: items}, Body: bodyStmtsOfList(cmd.ForBody)}
	case "function":
		// mirrors Command::Function → IrStmt::Function (body flattened
		// from the Block, like body_stmts(&Command::Block(..)))
		return &FunctionS{Name: cmd.FuncName, Body: bodyStmtsOfList(cmd.BodyCmds)}
	case "pipeline":
		var stages []Expr
		for _, c := range cmd.Stages {
			stages = append(stages, &ArrowE{Body: commandArrowStmts([]*Command{c})})
		}
		return &ExprS{Expr: call("pipeline", []Expr{&ArrayE{Elems: stages}})}
	case "and":
		return &ExprS{Expr: &BinOpE{Op: "And", Lhs: commandToIR(cmd.Lhs), Rhs: commandToIR(cmd.Rhs)}}
	case "or":
		return &ExprS{Expr: &BinOpE{Op: "Or", Lhs: commandToIR(cmd.Lhs), Rhs: commandToIR(cmd.Rhs)}}
	case "not":
		return &ExprS{Expr: notIR(commandToIR(cmd.BodyCmds[0]))}
	case "block":
		return &BlockS{Body: bodyStmtsOfList(cmd.BodyCmds)}
	case "background":
		return &BackgroundS{Body: commandArrowStmts(cmd.BodyCmds)}
	case "subshell":
		return &SubshellS{Body: commandArrowStmts(cmd.BodyCmds)}
	case "test":
		return &ExprS{Expr: call("test", []Expr{st(cmd.TestExpr)})}
	case "arith":
		return &ExprS{Expr: call("exec", []Expr{st("let"), &ArrayE{Elems: []Expr{st(cmd.ArithRaw)}}})}
	}
	return nil
}

// execCallIR — mirror exec_call_ir.
func execCallIR(cmd *Command) Expr {
	var callArgs []Expr
	callArgs = append(callArgs, wordIR(cmd.Name, nil))
	args := mergedWordsIR(cmd.Args, func(w *Word) Expr { return argWordIR(w, nil) })
	callArgs = append(callArgs, &ArrayE{Elems: args})
	if len(cmd.EnvVars) > 0 {
		var props []PropE
		for _, ev := range cmd.EnvVars {
			props = append(props, PropE{Key: ev.Name, Val: wordIRQuoted(ev.Val, nil)})
		}
		callArgs = append(callArgs, &ObjectE{Props: props})
	}
	return call("exec", callArgs)
}

func redirectsIR(redirects []*Redirect) []RedirectIR {
	var out []RedirectIR
	for _, r := range redirects {
		out = append(out, redirectToIR(r))
	}
	return out
}

// redirectToIR — mirror redirect_to_ir.
func redirectToIR(r *Redirect) RedirectIR {
	digitTarget := false
	if r.Target.Kind == "lit" {
		t := r.Target.Text
		if t != "" {
			digitTarget = true
			for i := 0; i < len(t); i++ {
				if !isDigit(t[i]) {
					digitTarget = false
					break
				}
			}
		}
	}
	mode := "w"
	defaultFD := 1
	switch r.Op {
	case "in":
		mode, defaultFD = "r", 0
	case "out":
		mode, defaultFD = "w", 1
	case "append":
		mode, defaultFD = "a", 1
	case "inout":
		mode, defaultFD = "r+", 0
	case "outerr":
		mode, defaultFD = "w", 2
	case "inerr":
		mode, defaultFD = "r", 2
	case "heredoc":
		mode, defaultFD = "heredoc", 0
	case "heredoc-tabs":
		mode, defaultFD = "heredoc-tabs", 0
	case "herestring":
		mode, defaultFD = "herestring", 0
	}
	isDup := digitTarget && (r.Op == "in" || r.Op == "outerr" || r.Op == "inerr" ||
		(r.Op == "append" && r.FD != nil && *r.FD == 2))
	fd := defaultFD
	if isDup {
		if r.FD != nil {
			fd = *r.FD
		} else {
			fd = 1
		}
	} else if r.FD != nil {
		fd = *r.FD
	}
	var target Expr
	if isDup {
		target = st("&" + r.Target.Text)
	} else if r.Op == "heredoc" || r.Op == "heredoc-tabs" {
		// the heredoc target is the captured body (core: st(heredoc_body))
		target = st(r.HeredocBody)
	} else {
		target = wordIR(r.Target, nil)
	}
	return RedirectIR{FD: fd, Mode: mode, Target: target, Interpolate: !r.HeredocQuoted}
}

// redirectSpecObject — mirror redirect_spec_object_persist (arrow context).
func redirectSpecObject(r *Redirect, persist bool) Expr {
	ir := redirectToIR(r)
	props := []PropE{
		{Key: "fd", Val: &IntE{Value: int64(ir.FD)}},
		{Key: "mode", Val: st(ir.Mode)},
		{Key: "target", Val: ir.Target},
	}
	if persist {
		props = append(props, PropE{Key: "persist", Val: &BoolE{Value: true}})
	}
	return &ObjectE{Props: props}
}

// assignmentValueIR — mirror assignment_value_ir.
func assignmentValueIR(cmd *Command) Expr {
	if cmd.AssignVal.Kind == "array" {
		var elems []Expr
		for _, e := range cmd.AssignVal.ArrayElems {
			elems = append(elems, st(e))
		}
		if cmd.AssignOp == "+=" {
			return call("setArrayAppend", []Expr{st(cmd.AssignVal.ArrayName), &ArrayE{Elems: elems}})
		}
		return call("setArray", []Expr{st(cmd.AssignVal.ArrayName), &ArrayE{Elems: elems}})
	}
	if cmd.AssignOp == "=" {
		return wordIRQuoted(cmd.AssignVal, nil)
	}
	return call("assign", []Expr{st(cmd.AssignVar), st(assignOpStr(cmd.AssignOp)), wordIRQuoted(cmd.AssignVal, nil)})
}

func assignOpStr(op string) string {
	switch op {
	case "+=":
		return "+="
	case "-=":
		return "-="
	case "*=":
		return "*="
	case "/=":
		return "/="
	case "%=":
		return "%="
	}
	return "="
}

// assignmentExprIR — mirror assignment_expr_ir.
func assignmentExprIR(cmd *Command) Expr {
	if cmd.AssignVal.Kind == "array" {
		var elems []Expr
		for _, e := range cmd.AssignVal.ArrayElems {
			elems = append(elems, st(e))
		}
		if cmd.AssignOp == "+=" {
			return call("setArrayAppend", []Expr{st(cmd.AssignVal.ArrayName), &ArrayE{Elems: elems}})
		}
		return call("setArray", []Expr{st(cmd.AssignVal.ArrayName), &ArrayE{Elems: elems}})
	}
	return call("assign", []Expr{st(cmd.AssignVar), st(assignOpStr(cmd.AssignOp)), wordIRQuoted(cmd.AssignVal, nil)})
}

// commandToTestIR — mirror command_to_test_ir (cond positions).
func commandToTestIR(cmd *Command) Expr {
	ir := commandToIR(cmd)
	if lifted := tryLiftGrepContains(ir); lifted != nil {
		return lifted
	}
	return ir
}

// tryLiftGrepContains — echo <arg> | grep <lit> >/dev/null 2>/dev/null → contains.
func tryLiftGrepContains(cond Expr) Expr {
	c, ok := cond.(*CallE)
	if !ok || c.Func != "pipeline" {
		return nil
	}
	if len(c.Args) != 1 {
		return nil
	}
	arr, ok := c.Args[0].(*ArrayE)
	if !ok || len(arr.Elems) != 2 {
		return nil
	}
	s1, ok1 := arr.Elems[0].(*ArrowE)
	s2, ok2 := arr.Elems[1].(*ArrowE)
	if !ok1 || !ok2 {
		return nil
	}
	// stage 1: Expr(exec("echo", [arg]))
	if len(s1.Body) != 1 {
		return nil
	}
	e1, ok := s1.Body[0].(*ExprS)
	if !ok {
		return nil
	}
	ec1, ok := e1.Expr.(*CallE)
	if !ok || ec1.Func != "exec" || len(ec1.Args) != 2 {
		return nil
	}
	name1, ok := ec1.Args[0].(*StrE)
	if !ok || name1.Value != "echo" {
		return nil
	}
	eargs1, ok := ec1.Args[1].(*ArrayE)
	if !ok || len(eargs1.Elems) != 1 {
		return nil
	}
	arg := eargs1.Elems[0]
	// stage 2: Expr(Call("redirect", [Arrow([exec grep...]), Array(specs)]))
	if len(s2.Body) != 1 {
		return nil
	}
	e2, ok := s2.Body[0].(*ExprS)
	if !ok {
		return nil
	}
	rc, ok := e2.Expr.(*CallE)
	if !ok || rc.Func != "redirect" || len(rc.Args) != 2 {
		return nil
	}
	innerArrow, ok := rc.Args[0].(*ArrowE)
	if !ok || len(innerArrow.Body) != 1 {
		return nil
	}
	e3, ok := innerArrow.Body[0].(*ExprS)
	if !ok {
		return nil
	}
	ec3, ok := e3.Expr.(*CallE)
	if !ok || ec3.Func != "exec" || len(ec3.Args) != 2 {
		return nil
	}
	name2, ok := ec3.Args[0].(*StrE)
	if !ok || name2.Value != "grep" {
		return nil
	}
	gargs, ok := ec3.Args[1].(*ArrayE)
	if !ok || len(gargs.Elems) != 1 {
		return nil
	}
	pat, ok := gargs.Elems[0].(*StrE)
	if !ok || !isSafeGrepLiteral(pat.Value) {
		return nil
	}
	specs, ok := rc.Args[1].(*ArrayE)
	if !ok {
		return nil
	}
	out, err := false, false
	for _, spec := range specs.Elems {
		obj, ok := spec.(*ObjectE)
		if !ok {
			continue
		}
		fd, mode, target := -1, "", ""
		for _, p := range obj.Props {
			switch p.Key {
			case "fd":
				if iv, ok := p.Val.(*IntE); ok {
					fd = int(iv.Value)
				}
			case "mode":
				if sv, ok := p.Val.(*StrE); ok {
					mode = sv.Value
				}
			case "target":
				if sv, ok := p.Val.(*StrE); ok {
					target = sv.Value
				}
			}
		}
		if mode == "w" && target == "/dev/null" {
			if fd == 1 {
				out = true
			} else if fd == 2 {
				err = true
			}
		}
	}
	if !(out && err) {
		return nil
	}
	return call("contains", []Expr{arg, &StrE{Value: pat.Value, Style: "SingleQuoted"}})
}
