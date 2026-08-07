// zsh-sh-go A2 var-type analysis + A1 JSON emitter.
// Mirrors shir.rs analyze_var_types (numeric_lift_vars / string_lift_vars)
// and shir_json.rs program_json/expr_json/stmt_json.

package zshlib

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

const contractVersion = 1

// ─────────────────────────────────────────────────────────────────────
// A2: type verdicts (mirror analyze_var_types)
// ─────────────────────────────────────────────────────────────────────

func isPlainIdent(s string) bool {
	if s == "" || !isIdentStart(s[0]) {
		return false
	}
	for i := 1; i < len(s); i++ {
		if !isPlainIdentChar(s[i]) {
			return false
		}
	}
	return true
}

var reservedVars = map[string]bool{
	"IFS": true, "PATH": true, "HOME": true, "PWD": true, "OLDPWD": true,
	"SHELL": true, "USER": true, "TERM": true, "LANG": true, "LC_ALL": true,
	"LC_CTYPE": true, "PS1": true, "PS2": true, "PS3": true, "PS4": true,
	"ENV": true, "BASH": true, "BASH_VERSION": true, "RANDOM": true,
	"SECONDS": true, "LINENO": true, "PPID": true, "SHLVL": true,
	"HOSTNAME": true, "TMPDIR": true, "CDPATH": true, "COLUMNS": true,
	"LINES": true, "UID": true, "EUID": true, "GROUPS": true, "OPTIND": true,
	"OPTARG": true, "REPLY": true, "PIPESTATUS": true, "FUNCNAME": true,
	"BASH_SOURCE": true, "BASH_LINENO": true, "BASH_ARGV": true, "BASH_ARGC": true,
}

var jsKeywords = map[string]bool{
	"var": true, "let": true, "const": true, "function": true, "return": true,
	"if": true, "else": true, "for": true, "while": true, "do": true,
	"switch": true, "case": true, "break": true, "continue": true, "new": true,
	"delete": true, "typeof": true, "instanceof": true, "in": true, "of": true,
	"class": true, "extends": true, "super": true, "this": true, "null": true,
	"true": true, "false": true, "undefined": true, "NaN": true, "Infinity": true,
	"async": true, "await": true, "yield": true, "static": true, "import": true,
	"export": true, "default": true, "try": true, "catch": true, "finally": true,
	"throw": true, "void": true, "with": true, "debugger": true, "enum": true,
}

var writeBuiltins = map[string]bool{
	"read": true, "declare": true, "typeset": true, "local": true,
	"export": true, "readonly": true, "unset": true, "mapfile": true,
	"readarray": true, "let": true, "eval": true, "source": true, ".": true,
}

// markStoreRefs — mirror mark_store_refs (string-parsed store reads).
func markStoreRefs(s string, out map[string]bool) {
	b := []byte(s)
	n := len(b)
	i := 0
	for i < n {
		if b[i] != '$' {
			i++
			continue
		}
		if i+2 < n && b[i+1] == '(' && b[i+2] == '(' {
			// $(( ... )) arith region
			j := i + 3
			depth := 2
			for j < n && depth > 0 {
				if b[j] == '(' {
					depth++
				} else if b[j] == ')' {
					depth--
				}
				j++
			}
			if depth != 0 {
				break
			}
			markArithRegion(string(b[i+3:j-2]), out)
			i = j
			continue
		}
		if i+1 < n && b[i+1] == '(' {
			// $( cmd ) — subprocess; skip the region (quote aware)
			j := i + 2
			depth := 1
			inSq, inDq, inBt := false, false, false
			for j < n && depth > 0 {
				cc := b[j]
				if inSq {
					if cc == '\'' {
						inSq = false
					}
					j++
					continue
				}
				if inDq {
					if cc == '\\' {
						j += 2
						continue
					}
					if cc == '"' {
						inDq = false
					}
					j++
					continue
				}
				if inBt {
					if cc == '`' {
						inBt = false
					}
					j++
					continue
				}
				switch cc {
				case '\'':
					inSq = true
				case '"':
					inDq = true
				case '`':
					inBt = true
				case '(':
					depth++
				case ')':
					depth--
				}
				j++
			}
			if depth != 0 {
				break
			}
			i = j
			continue
		}
		if i+1 < n && b[i+1] == '\'' {
			// $'...' ANSI-C — not a store read
			j := i + 2
			for j < n && b[j] != '\'' {
				if b[j] == '\\' {
					j++
				}
				j++
			}
			i = j + 1
			continue
		}
		if i+1 < n && b[i+1] == '{' {
			rest := string(b[i+2:])
			nameLen := 0
			for nameLen < len(rest) && isPlainIdentChar(rest[nameLen]) {
				nameLen++
			}
			if nameLen > 0 {
				name := rest[:nameLen]
				if isPlainIdent(name) {
					out[name] = true
				}
			}
			i += 2 + nameLen
			continue
		}
		rest := string(b[i+1:])
		nameLen := 0
		for nameLen < len(rest) && isPlainIdentChar(rest[nameLen]) {
			nameLen++
		}
		if nameLen > 0 {
			name := rest[:nameLen]
			if isPlainIdent(name) {
				out[name] = true
			}
			i += 1 + nameLen
			continue
		}
		i++
	}
}

func markArithRegion(region string, out map[string]bool) {
	b := []byte(region)
	n := len(b)
	i := 0
	for i < n {
		c := b[i]
		if c == '$' {
			skip := 1
			if i+1 < n && b[i+1] == '{' {
				skip = 2
			}
			rest := string(b[i+skip:])
			nameLen := 0
			for nameLen < len(rest) && isPlainIdentChar(rest[nameLen]) {
				nameLen++
			}
			if nameLen > 0 {
				name := rest[:nameLen]
				if isPlainIdent(name) {
					out[name] = true
				}
			}
			i += skip + nameLen
			continue
		}
		prevAlnum := i > 0 && (isPlainIdentChar(b[i-1]))
		if isIdentStart(c) && !prevAlnum {
			start := i
			for i < n && isPlainIdentChar(b[i]) {
				i++
			}
			w := string(b[start:i])
			if isPlainIdent(w) {
				out[w] = true
			}
		} else {
			i++
		}
	}
}

func markAllIdents(s string, out map[string]bool) {
	b := []byte(s)
	n := len(b)
	i := 0
	for i < n {
		c := b[i]
		if (isIdentStart(c)) && (i == 0 || !isPlainIdentChar(b[i-1])) {
			start := i
			for i < n && isPlainIdentChar(b[i]) {
				i++
			}
			w := string(b[start:i])
			if isPlainIdent(w) {
				out[w] = true
			}
		} else {
			i++
		}
	}
}

func markAllIdentsArgs(e Expr, out map[string]bool) {
	switch t := e.(type) {
	case *StrE:
		markAllIdents(t.Value, out)
	case *ArrayE:
		for _, el := range t.Elems {
			markAllIdentsArgs(el, out)
		}
	case *ObjectE:
		for _, p := range t.Props {
			markAllIdentsArgs(p.Val, out)
		}
	}
}

func markWriteBuiltinVars(e Expr, excluded map[string]bool) {
	switch t := e.(type) {
	case *ArrayE:
		for _, el := range t.Elems {
			markWriteBuiltinVars(el, excluded)
		}
	case *StrE:
		v := strings.SplitN(t.Value, "=", 2)[0]
		if isPlainIdent(v) {
			excluded[v] = true
		}
	}
}

func arithLetArgsNative(args []Expr) bool {
	if len(args) != 2 {
		return false
	}
	cn, ok := args[0].(*StrE)
	if !ok || cn.Value != "let" {
		return false
	}
	cargs, ok := args[1].(*ArrayE)
	if !ok || len(cargs.Elems) == 0 {
		return false
	}
	for _, a := range cargs.Elems {
		sv, ok := a.(*StrE)
		if !ok {
			return false
		}
		if _, ok := parseArithNative(sv.Value); !ok {
			return false
		}
	}
	return true
}

func intDeclareNames(args []Expr) ([]string, bool) {
	if len(args) != 2 {
		return nil, false
	}
	cn, ok := args[0].(*StrE)
	if !ok {
		return nil, false
	}
	if cn.Value != "typeset" && cn.Value != "declare" && cn.Value != "readonly" {
		return nil, false
	}
	cargs, ok := args[1].(*ArrayE)
	if !ok {
		return nil, false
	}
	var names []string
	sawI := false
	for _, a := range cargs.Elems {
		sv, ok := a.(*StrE)
		if !ok {
			return nil, false
		}
		s := sv.Value
		if strings.HasPrefix(s, "-") {
			if strings.ContainsAny(s, "pfF") {
				return nil, false
			}
			if strings.Contains(s, "i") {
				sawI = true
			}
		} else if strings.HasPrefix(s, "+") {
			return nil, false
		} else if strings.Contains(s, "=") {
			return nil, false
		} else if isPlainIdent(s) {
			names = append(names, s)
		} else {
			return nil, false
		}
	}
	if !sawI || len(names) == 0 {
		return nil, false
	}
	return names, true
}

func pureValueDeclare(args []Expr) ([][2]string, bool) {
	if len(args) != 2 {
		return nil, false
	}
	cn, ok := args[0].(*StrE)
	if !ok {
		return nil, false
	}
	if cn.Value != "local" && cn.Value != "declare" && cn.Value != "typeset" && cn.Value != "readonly" {
		return nil, false
	}
	cargs, ok := args[1].(*ArrayE)
	if !ok {
		return nil, false
	}
	var out [][2]string
	for _, a := range cargs.Elems {
		sv, ok := a.(*StrE)
		if !ok {
			return nil, false
		}
		s := sv.Value
		if strings.HasPrefix(s, "-") || strings.HasPrefix(s, "+") {
			return nil, false
		}
		eq := strings.Index(s, "=")
		if eq < 0 {
			return nil, false
		}
		name, value := s[:eq], s[eq+1:]
		if !isPlainIdent(name) {
			return nil, false
		}
		for i := 0; i < len(value); i++ {
			c := value[i]
			if !(isPlainIdentChar(c) || c == '.' || c == '/' || c == ':' || c == ',' || c == '+' || c == '-') {
				return nil, false
			}
		}
		out = append(out, [2]string{name, value})
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

func collectNativeArithSources(args []Expr, assigns map[string][]Expr) {
	if len(args) != 2 {
		return
	}
	cn, ok := args[0].(*StrE)
	if !ok {
		return
	}
	switch cn.Value {
	case "typeset", "declare", "readonly":
		if names, ok := intDeclareNames(args); ok {
			for _, n := range names {
				assigns[n] = append(assigns[n], &IntE{Value: 0})
			}
		} else if pairs, ok := pureValueDeclare(args); ok {
			for _, p := range pairs {
				assigns[p[0]] = append(assigns[p[0]], &StrE{Value: p[1], Style: "SingleQuoted"})
			}
		}
	case "local":
		if pairs, ok := pureValueDeclare(args); ok {
			for _, p := range pairs {
				assigns[p[0]] = append(assigns[p[0]], &StrE{Value: p[1], Style: "SingleQuoted"})
			}
		}
	case "let":
		if !arithLetArgsNative(args) {
			return
		}
		cargs := args[1].(*ArrayE)
		for _, a := range cargs.Elems {
			sv := a.(*StrE)
			if ast, ok := parseArithNative(sv.Value); ok {
				for _, w := range arithWrittenVars(ast) {
					assigns[w] = append(assigns[w], &IntE{Value: 0})
				}
			}
		}
	}
}

func arithWrittenVars(ast ArithAst) []string {
	var out []string
	var walk func(a ArithAst)
	walk = func(a ArithAst) {
		switch t := a.(type) {
		case *ArithAssign:
			out = append(out, t.Var)
			walk(t.Rhs)
		case *ArithIncDec:
			out = append(out, t.Var)
		case *ArithBin:
			walk(t.Lhs)
			walk(t.Rhs)
		case *ArithUn:
			walk(t.Arg)
		case *ArithCond:
			walk(t.Test)
			walk(t.Then)
			walk(t.Else)
		case *ArithIndex:
			walk(t.Key)
		}
	}
	walk(ast)
	return out
}

// iterNumeric — mirror iter_numeric.
func iterNumeric(e Expr) (bool, bool) { // (numeric, known)
	switch t := e.(type) {
	case *RangeE:
		return true, true // the Range iterable is numeric by construction
	case *ArrayE:
		numeric := true
		known := true
		for _, el := range t.Elems {
			switch elt := el.(type) {
			case *StrE:
				if _, err := strconv.ParseInt(strings.TrimSpace(elt.Value), 10, 64); err != nil {
					numeric = false
				}
			case *CallE:
				if elt.Func == "brace" {
					if v, ok := braceNumeric(elt.Args); ok {
						if !v {
							numeric = false
						}
					} else {
						known = false
					}
				} else {
					known = false
				}
			default:
				known = false
			}
		}
		return numeric, known
	case *CallE:
		if t.Func == "brace" {
			return braceNumeric(t.Args)
		}
	}
	return false, false
}

func braceNumeric(args []Expr) (bool, bool) {
	for _, a := range args {
		if jv, ok := a.(*JsonE); ok {
			numeric := true
			jsonItemsNumeric(jv.Value, &numeric)
			return numeric, true
		}
	}
	return false, false
}

func jsonItemsNumeric(v interface{}, found *bool) {
	switch t := v.(type) {
	case []interface{}:
		for _, x := range t {
			jsonItemsNumeric(x, found)
		}
	case map[string]interface{}:
		if _, isRange := t["range"]; !isRange {
			*found = false
		}
	case string:
		if _, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64); err != nil {
			*found = false
		}
	default:
		*found = false
	}
}

// ── lift walkers (mirror numeric_lift_vars / string_lift_vars) ──────

type liftCtx struct {
	excluded  map[string]bool
	stringCtx map[string]bool
	inCopy    bool
}

func walkExprN(e Expr, ctx *liftCtx) {
	switch t := e.(type) {
	case *CallE:
		letArgsNative := t.Func == "exec" && arithLetArgsNative(t.Args)
		if t.Func != "getVar" && t.Func != "test" && t.Func != "setArray" && t.Func != "setArrayAppend" && !letArgsNative {
			for _, a := range t.Args {
				markStrArgs(a, ctx.stringCtx)
			}
		}
		if ctx.inCopy && letArgsNative {
			if len(t.Args) == 2 {
				if _, ok := t.Args[0].(*StrE); ok {
					if cargs, ok := t.Args[1].(*ArrayE); ok {
						for _, a := range cargs.Elems {
							if sv, ok := a.(*StrE); ok {
								if ast, ok := parseArithNative(sv.Value); ok {
									for _, w := range arithWrittenVars(ast) {
										ctx.excluded[w] = true
									}
								}
							}
						}
					}
				}
			}
		}
		if t.Func == "exec" || t.Func == "builtin" {
			if len(t.Args) > 0 {
				if cn, ok := t.Args[0].(*StrE); ok && writeBuiltins[cn.Value] {
					nativeLet := cn.Value == "let" && letArgsNative
					intdecl := []string{}
					if cn.Value != "let" {
						if names, ok := intDeclareNames(t.Args); ok {
							intdecl = names
						}
					}
					pureDecl := !ctx.inCopy
					if pureDecl {
						if _, ok := pureValueDeclare(t.Args); !ok {
							pureDecl = false
						}
					}
					if !(nativeLet || len(intdecl) > 0 || pureDecl) {
						for _, a := range t.Args[1:] {
							markWriteBuiltinVars(a, ctx.excluded)
							markAllIdentsArgs(a, ctx.stringCtx)
						}
					}
				}
			}
		}
		switch t.Func {
		case "arrayIndex", "arrayLen", "arrayItems", "arraySlice", "setArray", "setArrayAppend":
			if len(t.Args) > 0 {
				if name, ok := t.Args[0].(*StrE); ok {
					ctx.excluded[name.Value] = true
				}
			}
		}
		for _, a := range t.Args {
			walkExprN(a, ctx)
		}
	case *ArrowE:
		for _, st := range t.Body {
			walkStmtN(st, ctx)
		}
	case *InterpE:
		for _, p := range t.Parts {
			if !p.IsLit {
				walkExprN(p.Expr, ctx)
			}
		}
	case *ArrayE:
		for _, el := range t.Elems {
			walkExprN(el, ctx)
		}
	case *ObjectE:
		for _, p := range t.Props {
			walkExprN(p.Val, ctx)
		}
	}
}

func walkStmtN(st Stmt, ctx *liftCtx) {
	switch t := st.(type) {
	case *AssignS:
		if ctx.inCopy {
			ctx.excluded[t.Var] = true
		}
		walkExprN(t.Expr, ctx)
	case *ForS:
		walkExprN(t.Iter, ctx)
		for _, b := range t.Body {
			walkStmtN(b, ctx)
		}
	case *WhileS:
		walkExprN(t.Cond, ctx)
		for _, b := range t.Body {
			walkStmtN(b, ctx)
		}
	case *IfS:
		walkExprN(t.Cond, ctx)
		for _, b := range t.Then {
			walkStmtN(b, ctx)
		}
		for _, b := range t.Else {
			walkStmtN(b, ctx)
		}
	case *ExprS:
		walkExprN(t.Expr, ctx)
	case *BlockS:
		for _, b := range t.Body {
			walkStmtN(b, ctx)
		}
	case *BackgroundS:
		for _, b := range t.Body {
			walkStmtN(b, ctx)
		}
	case *SubshellS:
		sub := &liftCtx{excluded: ctx.excluded, stringCtx: ctx.stringCtx, inCopy: true}
		for _, b := range t.Body {
			walkStmtN(b, sub)
		}
	case *RedirectS:
		for _, b := range t.Inner {
			walkStmtN(b, ctx)
		}
		for _, r := range t.Redirects {
			walkExprN(r.Target, ctx)
		}
	case *FunctionS:
		for _, b := range t.Body {
			walkStmtN(b, ctx)
		}
	case *ReturnS:
		if t.Value != nil {
			walkExprN(t.Value, ctx)
		}
	case *CaseS:
		walkExprN(t.Disc, ctx)
		for _, cl := range t.Clauses {
			for _, pat := range cl.Patterns {
				markStoreRefs(pat, ctx.stringCtx)
			}
			for _, b := range cl.Body {
				walkStmtN(b, ctx)
			}
		}
	}
}

func markStrArgs(e Expr, out map[string]bool) {
	switch t := e.(type) {
	case *StrE:
		markStoreRefs(t.Value, out)
	case *ArrayE:
		for _, el := range t.Elems {
			markStrArgs(el, out)
		}
	case *ObjectE:
		for _, p := range t.Props {
			markStrArgs(p.Val, out)
		}
	}
}

// collectAssigns — assignment sources (mirror collect_assigns).
func collectAssigns(st Stmt, assigns map[string][]Expr) {
	switch t := st.(type) {
	case *AssignS:
		assigns[t.Var] = append(assigns[t.Var], t.Expr)
	case *WhileS, *BlockS, *FunctionS, *SubshellS, *BackgroundS:
		var body []Stmt
		switch bt := st.(type) {
		case *WhileS:
			body = bt.Body
		case *BlockS:
			body = bt.Body
		case *FunctionS:
			body = bt.Body
		case *SubshellS:
			body = bt.Body
		case *BackgroundS:
			body = bt.Body
		}
		for _, b := range body {
			collectAssigns(b, assigns)
		}
	case *IfS:
		for _, b := range t.Then {
			collectAssigns(b, assigns)
		}
		for _, b := range t.Else {
			collectAssigns(b, assigns)
		}
	case *ForS:
		if _, ok := assigns[t.Var]; !ok {
			assigns[t.Var] = nil
		}
		for _, b := range t.Body {
			collectAssigns(b, assigns)
		}
	case *ExprS:
		collectExprAssigns(t.Expr, assigns)
	case *CaseS:
		for _, cl := range t.Clauses {
			for _, b := range cl.Body {
				collectAssigns(b, assigns)
			}
		}
	case *RedirectS:
		for _, b := range t.Inner {
			collectAssigns(b, assigns)
		}
	case *PipelineS:
		for _, stage := range t.Stages {
			for _, b := range stage {
				collectAssigns(b, assigns)
			}
		}
	}
}

// PipelineS — needed by collectAssigns (mirror IrStmt::Pipeline).
type PipelineS struct{ Stages [][]Stmt }

func collectExprAssigns(e Expr, assigns map[string][]Expr) {
	switch t := e.(type) {
	case *ArrowE:
		for _, st := range t.Body {
			collectAssigns(st, assigns)
		}
	case *CallE:
		if t.Func == "exec" {
			collectNativeArithSources(t.Args, assigns)
		}
		for _, a := range t.Args {
			collectExprAssigns(a, assigns)
		}
	case *ArrayE:
		for _, el := range t.Elems {
			collectExprAssigns(el, assigns)
		}
	}
}

// collectForIters — mirror collect_for_iters.
func collectForIters(st Stmt, out map[string]Expr) {
	switch t := st.(type) {
	case *ForS:
		out[t.Var] = t.Iter
		for _, b := range t.Body {
			collectForIters(b, out)
		}
	case *WhileS:
		for _, b := range t.Body {
			collectForIters(b, out)
		}
	case *BlockS:
		for _, b := range t.Body {
			collectForIters(b, out)
		}
	case *FunctionS:
		for _, b := range t.Body {
			collectForIters(b, out)
		}
	case *SubshellS:
		for _, b := range t.Body {
			collectForIters(b, out)
		}
	case *BackgroundS:
		for _, b := range t.Body {
			collectForIters(b, out)
		}
	case *IfS:
		for _, b := range t.Then {
			collectForIters(b, out)
		}
		for _, b := range t.Else {
			collectForIters(b, out)
		}
	case *RedirectS:
		for _, b := range t.Inner {
			collectForIters(b, out)
		}
	case *CaseS:
		for _, cl := range t.Clauses {
			for _, b := range cl.Body {
				collectForIters(b, out)
			}
		}
	case *PipelineS:
		for _, stage := range t.Stages {
			for _, b := range stage {
				collectForIters(b, out)
			}
		}
	}
}

// numericLiftVars — mirror numeric_lift_vars.
func numericLiftVars(stmts []Stmt) map[string]bool {
	ctx := &liftCtx{excluded: map[string]bool{}, stringCtx: map[string]bool{}}
	for _, st := range stmts {
		walkStmtN(st, ctx)
	}
	assigns := map[string][]Expr{}
	for _, st := range stmts {
		collectAssigns(st, assigns)
	}
	forIters := map[string]Expr{}
	for _, st := range stmts {
		collectForIters(st, forIters)
	}
	lifted := map[string]bool{}
	for {
		changed := false
		for name, exprs := range assigns {
			if lifted[name] || ctx.excluded[name] || ctx.stringCtx[name] ||
				reservedVars[name] || jsKeywords[name] ||
				strings.Contains(name, "[") || strings.Contains(name, "]") {
				continue
			}
			allNumeric := true
			for _, e := range exprs {
				ok := false
				switch t := e.(type) {
				case *ArithE:
					ok = !arithHasDivMod(t.Ast)
				case *IntE:
					ok = true
				case *StrE:
					_, err := strconv.ParseInt(strings.TrimSpace(t.Value), 10, 64)
					ok = err == nil
				case *VarE:
					ok = lifted[t.Name]
				case *CallE:
					if t.Func == "getVar" && len(t.Args) == 1 {
						if n, ok2 := t.Args[0].(*StrE); ok2 {
							ok = lifted[n.Value]
						}
					}
				}
				if !ok {
					allNumeric = false
					break
				}
			}
			if allNumeric {
				if it, ok := forIters[name]; ok {
					num, known := iterNumeric(it)
					if !known || !num {
						allNumeric = false
					}
				}
			}
			if allNumeric {
				lifted[name] = true
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	return lifted
}

// stringLiftVars — mirror string_lift_vars.
func stringLiftVars(stmts []Stmt, numeric map[string]bool) map[string]bool {
	ctx := &liftCtx{excluded: map[string]bool{}, stringCtx: map[string]bool{}}
	for _, st := range stmts {
		walkStmtN(st, ctx)
	}
	assigns := map[string][]Expr{}
	for _, st := range stmts {
		collectAssigns(st, assigns)
	}
	lifted := map[string]bool{}
	for {
		changed := false
		for name, exprs := range assigns {
			if lifted[name] || numeric[name] || ctx.excluded[name] || ctx.stringCtx[name] ||
				reservedVars[name] || jsKeywords[name] ||
				strings.Contains(name, "[") || strings.Contains(name, "]") {
				continue
			}
			allString := true
			for _, e := range exprs {
				ok := false
				switch t := e.(type) {
				case *StrE:
					ok = true
				case *InterpE:
					ok = true
				case *VarE:
					ok = lifted[t.Name]
				case *CallE:
					if t.Func == "getVar" && len(t.Args) == 1 {
						if n, ok2 := t.Args[0].(*StrE); ok2 {
							ok = lifted[n.Value]
						}
					}
					if t.Func == "capture" && len(t.Args) == 1 {
						if _, ok2 := t.Args[0].(*ArrowE); ok2 {
							ok = true
						}
					}
				}
				if !ok {
					allString = false
					break
				}
			}
			if allString {
				lifted[name] = true
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	return lifted
}

func analyzeVarTypes(stmts []Stmt) []VarTypeOut {
	numeric := numericLiftVars(stmts)
	strs := stringLiftVars(stmts, numeric)
	names := map[string]bool{}
	for n := range numeric {
		names[n] = true
	}
	for n := range strs {
		names[n] = true
	}
	var sorted []string
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	var out []VarTypeOut
	for _, n := range sorted {
		t := "Str"
		if numeric[n] {
			t = "Int"
		}
		out = append(out, VarTypeOut{Name: n, Type: t})
	}
	return out
}

type VarTypeOut struct{ Name, Type string }

// ─────────────────────────────────────────────────────────────────────
// A1b: max-string-length verdicts (mirror analyze_string_lengths — the
// transform the C backend asked for: fixed buffers instead of heap). A
// fixed-point over the assignments: each var's bound is the max over its
// assignment RHS lengths (Str literals, Interpolate = the literal parts +
// the interpolated vars' bounds); captures/calls/binops are unbounded
// (None); a loop-accumulated `s="$s$x"` grows past the cap each
// iteration and flips to None (the cap guarantees termination).
// ─────────────────────────────────────────────────────────────────────

type VarLenOut struct {
	Name   string
	MaxLen *uint64
} // nil = unbounded

type lenAssign struct {
	name string
	rhs  Expr
}

const strLenCap uint64 = 4096
const strLenIterLimit = 1024

func satAdd64(a, b uint64) uint64 {
	if a > ^uint64(0)-b {
		return ^uint64(0)
	}
	return a + b
}

// collectLenAssigns — mirror the assignment-collection walk inside
// analyze_string_lengths: Assign targets with no indices, plus the
// `local name=value` / `declare name=value` / `export name=value`
// declaration assignments (the exec/builtin call's args carry "name=" +
// the value). If/While/For/Subshell/Background/Block/Redirect/Function
// bodies are walked; Case and Pipeline statements are NOT (as in the
// core).
func collectLenAssigns(st Stmt, assigns *[]lenAssign) {
	switch t := st.(type) {
	case *AssignS:
		*assigns = append(*assigns, lenAssign{t.Var, t.Expr})
	case *ExprS:
		c, ok := t.Expr.(*CallE)
		if !ok || len(c.Args) < 2 {
			return
		}
		cn, ok := c.Args[0].(*StrE)
		if !ok {
			return
		}
		if cn.Value != "local" && cn.Value != "declare" && cn.Value != "readonly" && cn.Value != "export" {
			return
		}
		arr, ok := c.Args[1].(*ArrayE)
		if !ok {
			return
		}
		i := 0
		for i < len(arr.Elems) {
			if nv, ok := arr.Elems[i].(*StrE); ok {
				if eq := strings.Index(nv.Value, "="); eq >= 0 {
					name := nv.Value[:eq]
					value := nv.Value[eq+1:]
					if name != "" {
						// the value may be inline ("" for `name=$(...)`)
						// or the NEXT array element: ["sqrt_n=", [value]]
						var v Expr
						nextIsArray := false
						if i+1 < len(arr.Elems) {
							next := arr.Elems[i+1]
							if inner, ok := next.(*ArrayE); ok {
								nextIsArray = true
								if len(inner.Elems) == 1 {
									v = inner.Elems[0]
								} else {
									v = next
								}
							} else {
								v = next
							}
						} else if !strings.Contains(value, "$") {
							// inline literal
							v = &StrE{Value: value, Style: "DoubleQuoted"}
						} else {
							break
						}
						*assigns = append(*assigns, lenAssign{name, v})
						if nextIsArray {
							i += 2
							continue
						}
					}
				}
			}
			i++
		}
	case *IfS:
		for _, b := range t.Then {
			collectLenAssigns(b, assigns)
		}
		for _, b := range t.Else {
			collectLenAssigns(b, assigns)
		}
	case *WhileS:
		for _, b := range t.Body {
			collectLenAssigns(b, assigns)
		}
	case *ForS:
		for _, b := range t.Body {
			collectLenAssigns(b, assigns)
		}
	case *SubshellS:
		for _, b := range t.Body {
			collectLenAssigns(b, assigns)
		}
	case *BackgroundS:
		for _, b := range t.Body {
			collectLenAssigns(b, assigns)
		}
	case *BlockS:
		for _, b := range t.Body {
			collectLenAssigns(b, assigns)
		}
	case *RedirectS:
		for _, b := range t.Inner {
			collectLenAssigns(b, assigns)
		}
	case *FunctionS:
		for _, b := range t.Body {
			collectLenAssigns(b, assigns)
		}
	}
}

// exprStrLen — mirror expr_len (the per-expr bound; None = unbounded).
func exprStrLen(e Expr, lens map[string]*uint64, cap uint64) *uint64 {
	switch t := e.(type) {
	case *StrE:
		v := uint64(len(t.Value))
		return &v
	case *IntE:
		v := uint64(20) // the max digit count
		return &v
	case *VarE:
		return lens[t.Name]
	case *InterpE:
		var total uint64
		for _, p := range t.Parts {
			var l uint64
			if p.IsLit {
				l = uint64(len(p.Lit))
			} else {
				l2 := exprStrLen(p.Expr, lens, cap)
				if l2 == nil {
					return nil
				}
				l = *l2
			}
			total = satAdd64(total, l)
			if total > cap {
				return nil
			}
		}
		return &total
	case *CallE:
		if t.Func == "getVar" {
			if len(t.Args) > 0 {
				if n, ok := t.Args[0].(*StrE); ok {
					return lens[n.Value]
				}
			}
			return nil
		}
		if t.Func == "capture" {
			if len(t.Args) > 0 {
				return captureBound(t.Args[0], lens, cap)
			}
			return nil
		}
		return nil
	case *BinOpE:
		switch t.Op {
		case "Concat": // a . b = max(a)+max(b)
			l := exprStrLen(t.Lhs, lens, cap)
			if l == nil {
				return nil
			}
			r := exprStrLen(t.Rhs, lens, cap)
			if r == nil {
				return nil
			}
			v := satAdd64(*l, *r)
			return &v
		case "Eq", "Ne", "Lt", "Gt", "Le", "Ge", "And", "Or", "Not":
			v := uint64(1) // comparisons/logicals yield 0/1
			return &v
		default:
			v := uint64(20) // the numeric/bitwise ops -> a number
			return &v
		}
	case *ArithE:
		v := uint64(20) // $((...)) -> a number
		return &v
	}
	return nil // calls / arrays — unbounded
}

// captureStages — mirror capture_stages (the wrapped command's stages).
func captureStages(e Expr) []Expr {
	switch t := e.(type) {
	case *CallE:
		if t.Func == "pipeline" {
			if len(t.Args) > 0 {
				if arr, ok := t.Args[0].(*ArrayE); ok {
					return arr.Elems
				}
			}
			return []Expr{e}
		}
		if t.Func == "exec" || t.Func == "builtin" {
			// the stages may sit in the exec's args directly
			// ([Arrow, Arrow]) or wrapped in a single Array
			// ([Array([Arrow, Arrow])]) — both appear in the corpus
			if len(t.Args) > 0 {
				if arr, ok := t.Args[0].(*ArrayE); ok && allArrows(arr.Elems) {
					return arr.Elems
				}
			}
			var stages []Expr
			for _, a := range t.Args {
				if _, ok := a.(*ArrowE); ok {
					stages = append(stages, a)
				}
			}
			if len(stages) == 0 {
				return []Expr{e}
			}
			return stages
		}
	case *ArrowE:
		// a single-command stage: the call IS the stage
		for _, st := range t.Body {
			es, ok := st.(*ExprS)
			if !ok {
				continue
			}
			c, ok := es.Expr.(*CallE)
			if !ok {
				continue
			}
			if c.Func != "exec" && c.Func != "builtin" && c.Func != "pipeline" {
				return []Expr{c}
			}
			// the inner call's args ARE the stages (or the pipeline's
			// [Array([Arrow, ...])])
			if len(c.Args) > 0 {
				if arr, ok := c.Args[0].(*ArrayE); ok && allArrows(arr.Elems) {
					return arr.Elems
				}
			}
			var stages []Expr
			for _, a := range c.Args {
				if _, ok := a.(*ArrowE); ok {
					stages = append(stages, a)
				}
			}
			if len(stages) == 0 {
				return []Expr{c}
			}
			return stages
		}
		return nil
	}
	return []Expr{e}
}

func allArrows(es []Expr) bool {
	for _, a := range es {
		if _, ok := a.(*ArrowE); !ok {
			return false
		}
	}
	return true
}

// stageCmd — mirror stage_cmd (the command name of a pipeline stage).
func stageCmd(stage Expr) (string, bool) {
	switch t := stage.(type) {
	case *ArrowE:
		for _, st := range t.Body {
			es, ok := st.(*ExprS)
			if !ok {
				continue
			}
			c, ok := es.Expr.(*CallE)
			if !ok || (c.Func != "exec" && c.Func != "builtin") {
				continue
			}
			if len(c.Args) > 0 {
				if n, ok := c.Args[0].(*StrE); ok {
					return n.Value, true
				}
			}
		}
		return "", false
	case *CallE:
		if t.Func == "exec" || t.Func == "builtin" {
			if len(t.Args) > 0 {
				if n, ok := t.Args[0].(*StrE); ok {
					return n.Value, true
				}
			}
		}
		return "", false
	}
	return "", false
}

func grepArg(args []Expr) string {
	for _, a := range args {
		if sv, ok := a.(*StrE); ok && len(sv.Value) == 2 && sv.Value[0] == '-' {
			return sv.Value
		}
	}
	return ""
}

// captureBound — mirror capture_bound: the capture's bound depends on the
// CAPTURED COMMAND: bc yields a fixed-width number; the filters
// (grep/sed/tr/...) yield output no larger than the input — bounded by
// the pipeline's FIRST stage when that is a bounded echo; everything else
// is unbounded.
func captureBound(e Expr, lens map[string]*uint64, cap uint64) *uint64 {
	stages := captureStages(e)
	if len(stages) == 0 {
		return nil
	}
	last := stages[len(stages)-1]
	cmdName, ok := stageCmd(last)
	if !ok {
		return nil
	}
	// the grep OPTIONS change the bound: -q emits nothing, -c emits
	// a count (a number), the rest filter (<= the input)
	lastFlag := ""
	if arr, ok := last.(*ArrowE); ok {
		for _, st := range arr.Body {
			es, ok := st.(*ExprS)
			if !ok {
				continue
			}
			c, ok := es.Expr.(*CallE)
			if !ok || len(c.Args) < 2 {
				continue
			}
			items, ok := c.Args[1].(*ArrayE)
			if !ok {
				continue
			}
			if f := grepArg(items.Elems); f != "" {
				lastFlag = f
				break
			}
		}
	}
	// zero-output builtins — the capture is the empty string (the
	// guard applies to the whole or-pattern in the core, so "true"
	// without -q falls through to the default: unbounded)
	if cmdName == "true" || cmdName == "false" || cmdName == ":" ||
		cmdName == "test" || cmdName == "[" || cmdName == "[[" || cmdName == "grep" {
		if lastFlag == "-q" {
			v := uint64(0)
			return &v
		}
	}
	switch cmdName {
	case "bc":
		v := uint64(40) // an arbitrary-precision number (the primes sqrt case)
		return &v
	case "wc":
		v := uint64(20) // always numbers (the -l/-w/-c counts)
		return &v
	case "grep":
		if lastFlag == "-c" {
			v := uint64(20)
			return &v
		}
		// the filters: output <= input — the FIRST stage's bound
		return captureBound(stages[0], lens, cap)
	case "md5sum":
		v := uint64(32)
		return &v
	case "sha1sum":
		v := uint64(40)
		return &v
	case "sha256sum":
		v := uint64(64)
		return &v
	case "sha512sum":
		v := uint64(128)
		return &v
	case "date":
		v := uint64(30) // the timestamp
		return &v
	case "umask":
		v := uint64(4) // an octal
		return &v
	case "expr":
		v := uint64(20) // a number (or a short string)
		return &v
	case "seq":
		return nil // the item count unknown
	case "echo", "printf":
		// the output is the args' joined lengths (skip the command
		// name; the real args live in the trailing Array) — the
		// stage may be an Arrow wrapping the call, or a bare Call
		var call *CallE
		if arr, ok := last.(*ArrowE); ok {
			for _, st := range arr.Body {
				if es, ok := st.(*ExprS); ok {
					if c, ok := es.Expr.(*CallE); ok {
						call = c
						break
					}
				}
			}
		} else if c, ok := last.(*CallE); ok {
			call = c
		}
		var total uint64
		if call != nil {
			for _, a := range call.Args {
				var l uint64
				if items, ok := a.(*ArrayE); ok {
					var t uint64
					for _, it := range items.Elems {
						l2 := exprStrLen(it, lens, cap)
						if l2 == nil {
							return nil
						}
						t = satAdd64(t, *l2)
					}
					l = t
				} else {
					l2 := exprStrLen(a, lens, cap)
					if l2 == nil {
						return nil
					}
					l = *l2
				}
				total = satAdd64(satAdd64(total, l), 1)
			}
		}
		if total > cap {
			return nil
		}
		return &total
	case "sed", "tr", "head", "tail", "sort", "uniq", "cut",
		"cat", "paste", "rev", "join", "basename", "dirname", "comm":
		// the filters: output <= input — the FIRST stage's bound
		return captureBound(stages[0], lens, cap)
	}
	return nil
}

// analyzeStringLengths — mirror analyze_string_lengths. Returns the
// (name, max_len) pairs sorted by name, matching the core's BTreeMap.
func analyzeStringLengths(stmts []Stmt) []VarLenOut {
	var assigns []lenAssign
	for _, st := range stmts {
		collectLenAssigns(st, &assigns)
	}
	names := map[string]bool{}
	for _, a := range assigns {
		names[a.name] = true
	}
	var sorted []string
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	lens := map[string]*uint64{}
	for _, n := range sorted {
		z := uint64(0)
		lens[n] = &z
	}
	for it := 0; it < strLenIterLimit; it++ {
		changed := false
		for _, a := range assigns {
			cur := lens[a.name]
			if cur == nil {
				continue
			}
			l := exprStrLen(a.rhs, lens, strLenCap)
			var newv *uint64
			if l != nil {
				if *l > strLenCap {
					newv = nil
				} else {
					m := *l
					if *cur > m {
						m = *cur
					}
					newv = &m
				}
			}
			if (newv == nil) != (cur == nil) || (newv != nil && *newv != *cur) {
				lens[a.name] = newv
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	var out []VarLenOut
	for _, n := range sorted {
		out = append(out, VarLenOut{Name: n, MaxLen: lens[n]})
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// A1c: const/var verdicts (mirror analyze_var_const — the const-markup
// ask: which assigned vars are write-once, single-site, never
// runtime-written → `Const`, everything else `Var`). Sorted by name;
// every assigned var gets a verdict (missing names = never assigned).
// ─────────────────────────────────────────────────────────────────────

type VarConstOut struct{ Name, Kind string }

type varConstAcc struct {
	sites          map[string]int
	multiRun       map[string]bool
	runtimeWritten map[string]bool
	arithWritten   map[string]bool
	indexWritten   map[string]bool
	dynamic        bool
}

func (acc *varConstAcc) site(name string, multiRun bool) {
	acc.sites[name]++
	if multiRun {
		acc.multiRun[name] = true
	}
}

var constStoreWrite = map[string]bool{
	"read": true, "readarray": true, "mapfile": true, "unset": true,
}
var constDeclAssign = map[string]bool{
	"local": true, "declare": true, "readonly": true, "export": true, "typeset": true,
}
var constDynamicWrite = map[string]bool{
	"eval": true, "source": true, ".": true,
}

// builtinNames — identifier names in a builtin's arg list: each Str is
// `name` or `name=value`; nested Arrays recurse (mirror of
// builtin_names).
func builtinNames(es []Expr, out map[string]bool) {
	for _, a := range es {
		switch t := a.(type) {
		case *ArrayE:
			builtinNames(t.Elems, out)
		case *StrE:
			name := strings.SplitN(t.Value, "=", 2)[0]
			if isPlainIdent(name) {
				out[name] = true
			}
		}
	}
}

// classifyBuiltin — the exec/builtin command shape: args[0] = command
// name, args[1] = the arg-list Array. Classifies the write, if any
// (mirror of classify_builtin).
func classifyBuiltin(args []Expr, acc *varConstAcc, multiRun bool) {
	if len(args) < 2 {
		return
	}
	cn, ok := args[0].(*StrE)
	if !ok {
		return
	}
	rest, ok := args[1].(*ArrayE)
	if !ok {
		return
	}
	cname := cn.Value
	if constDynamicWrite[cname] {
		acc.dynamic = true
		return
	}
	if constStoreWrite[cname] {
		names := map[string]bool{}
		builtinNames(rest.Elems, names)
		for n := range names {
			acc.runtimeWritten[n] = true
		}
		return
	}
	if cname == "let" {
		// `let x=5` / `let x++` — the runtime evaluates arith strings;
		// every bare identifier is a potential write (mirror of
		// arith_idents).
		names := map[string]bool{}
		for _, a := range rest.Elems {
			if sv, ok := a.(*StrE); ok {
				markAllIdents(sv.Value, names)
			}
		}
		for n := range names {
			acc.runtimeWritten[n] = true
		}
		return
	}
	if constDeclAssign[cname] {
		names := map[string]bool{}
		builtinNames(rest.Elems, names)
		for n := range names {
			acc.site(n, multiRun)
		}
	}
}

func walkExprConst(e Expr, acc *varConstAcc, multiRun bool) {
	switch t := e.(type) {
	case *ArithE:
		for _, w := range arithWrittenVars(t.Ast) {
			acc.arithWritten[w] = true
		}
		walkArithConst(t.Ast, acc, multiRun)
	case *ArrowE:
		for _, st := range t.Body {
			walkStmtConst(st, acc, multiRun)
		}
	case *CallE:
		if t.Func == "setVar" || t.Func == "setArray" {
			if len(t.Args) == 2 {
				if n, ok := t.Args[0].(*StrE); ok {
					acc.site(n.Value, multiRun)
				}
			}
		}
		if t.Func == "exec" || t.Func == "builtin" {
			classifyBuiltin(t.Args, acc, multiRun)
		}
		for _, a := range t.Args {
			walkExprConst(a, acc, multiRun)
		}
	case *InterpE:
		for _, p := range t.Parts {
			if !p.IsLit {
				walkExprConst(p.Expr, acc, multiRun)
			}
		}
	case *ArrayE:
		for _, el := range t.Elems {
			walkExprConst(el, acc, multiRun)
		}
	case *ObjectE:
		for _, p := range t.Props {
			walkExprConst(p.Val, acc, multiRun)
		}
	case *BinOpE:
		walkExprConst(t.Lhs, acc, multiRun)
		walkExprConst(t.Rhs, acc, multiRun)
	}
}

func walkArithConst(a ArithAst, acc *varConstAcc, multiRun bool) {
	switch t := a.(type) {
	case *ArithIndex:
		walkArithConst(t.Key, acc, multiRun)
	case *ArithBin:
		walkArithConst(t.Lhs, acc, multiRun)
		walkArithConst(t.Rhs, acc, multiRun)
	case *ArithUn:
		walkArithConst(t.Arg, acc, multiRun)
	case *ArithCond:
		walkArithConst(t.Test, acc, multiRun)
		walkArithConst(t.Then, acc, multiRun)
		walkArithConst(t.Else, acc, multiRun)
	case *ArithAssign:
		// writes already recorded via arithWrittenVars above
		walkArithConst(t.Rhs, acc, multiRun)
	}
}

func walkStmtConst(st Stmt, acc *varConstAcc, multiRun bool) {
	switch t := st.(type) {
	case *AssignS:
		// array-element writes arrive with the index baked into the
		// name (`arr[1]=z` → var "arr[1]") — the store owns the element
		if !strings.Contains(t.Var, "[") {
			acc.site(t.Var, multiRun)
		} else {
			acc.indexWritten[strings.SplitN(t.Var, "[", 2)[0]] = true
		}
		walkExprConst(t.Expr, acc, multiRun)
	case *IfS:
		walkExprConst(t.Cond, acc, multiRun)
		for _, s := range t.Then {
			walkStmtConst(s, acc, multiRun)
		}
		for _, e := range t.Elsifs {
			if c, ok := e[0].(Expr); ok {
				walkExprConst(c, acc, multiRun)
			}
			if b, ok := e[1].([]Stmt); ok {
				for _, s := range b {
					walkStmtConst(s, acc, multiRun)
				}
			}
		}
		for _, s := range t.Else {
			walkStmtConst(s, acc, multiRun)
		}
	case *ForS:
		// loop vars + loop bodies run per iteration
		acc.site(t.Var, true)
		walkExprConst(t.Iter, acc, multiRun)
		for _, s := range t.Body {
			walkStmtConst(s, acc, true)
		}
	case *WhileS:
		walkExprConst(t.Cond, acc, multiRun)
		for _, s := range t.Body {
			walkStmtConst(s, acc, true)
		}
	case *FunctionS:
		// a function may run 0..N times — its sites are multi-run
		for _, s := range t.Body {
			walkStmtConst(s, acc, true)
		}
	case *SubshellS:
		for _, s := range t.Body {
			walkStmtConst(s, acc, multiRun)
		}
	case *BackgroundS:
		for _, s := range t.Body {
			walkStmtConst(s, acc, multiRun)
		}
	case *BlockS:
		for _, s := range t.Body {
			walkStmtConst(s, acc, multiRun)
		}
	case *RedirectS:
		for _, s := range t.Inner {
			walkStmtConst(s, acc, multiRun)
		}
		for _, r := range t.Redirects {
			walkExprConst(r.Target, acc, multiRun)
		}
	case *CaseS:
		walkExprConst(t.Disc, acc, multiRun)
		for _, cl := range t.Clauses {
			for _, s := range cl.Body {
				walkStmtConst(s, acc, multiRun)
			}
		}
	case *PipelineS:
		for _, stage := range t.Stages {
			for _, s := range stage {
				walkStmtConst(s, acc, multiRun)
			}
		}
	case *ExprS:
		walkExprConst(t.Expr, acc, multiRun)
	case *ReturnS:
		if t.Value != nil {
			walkExprConst(t.Value, acc, multiRun)
		}
	}
}

// analyzeVarConst — mirror analyze_var_const. Sorted by name for
// deterministic serialization.
func analyzeVarConst(stmts []Stmt) []VarConstOut {
	acc := &varConstAcc{
		sites:          map[string]int{},
		multiRun:       map[string]bool{},
		runtimeWritten: map[string]bool{},
		arithWritten:   map[string]bool{},
		indexWritten:   map[string]bool{},
	}
	for _, s := range stmts {
		walkStmtConst(s, acc, false)
	}
	names := map[string]bool{}
	for n := range acc.sites {
		names[n] = true
	}
	for n := range acc.runtimeWritten {
		names[n] = true
	}
	for n := range acc.arithWritten {
		names[n] = true
	}
	for n := range acc.indexWritten {
		names[n] = true
	}
	var sorted []string
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	var out []VarConstOut
	for _, n := range sorted {
		kind := "Var"
		if acc.sites[n] == 1 && !acc.multiRun[n] && !acc.runtimeWritten[n] &&
			!acc.arithWritten[n] && !acc.indexWritten[n] && !acc.dynamic {
			kind = "Const"
		}
		out = append(out, VarConstOut{Name: n, Kind: kind})
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// A1d: variable lifetimes (mirror shir_passes::lifetime::
// analyze_var_lifetimes — the C backend's fixed-buffer transform input:
// per-var live spans (first/last statement positions of a pre-order
// walk) + the escape bit). Sorted by name.
// ─────────────────────────────────────────────────────────────────────

type VarLifetimeOut struct {
	Name    string
	First   int
	Last    int
	Escapes bool
}

type lifetimeAcc struct {
	first   map[string]int
	last    map[string]int
	escapes map[string]bool
}

// access — record one access (def or use) at the current position.
func access(name string, pos int, acc *lifetimeAcc, inClosure bool) {
	if _, ok := acc.first[name]; !ok {
		acc.first[name] = pos
	}
	acc.last[name] = pos
	if inClosure {
		// a closure may outlive the scope where the var's buffer lives
		acc.escapes[name] = true
	}
}

func walkStmtsLife(stmts []Stmt, pos *int, acc *lifetimeAcc, inClosure, copied bool) {
	for _, st := range stmts {
		*pos++
		walkStmtLife(st, pos, acc, inClosure, copied)
	}
}

func walkStmtLife(st Stmt, pos *int, acc *lifetimeAcc, inClosure, copied bool) {
	p := *pos
	switch t := st.(type) {
	case *AssignS:
		// plain scalar def (our lowering never emits index targets)
		access(t.Var, p, acc, inClosure)
		walkExprLife(t.Expr, p, acc, inClosure)
	case *IfS:
		walkExprLife(t.Cond, p, acc, inClosure)
		walkStmtsLife(t.Then, pos, acc, inClosure, copied)
		for _, e := range t.Elsifs {
			if c, ok := e[0].(Expr); ok {
				walkExprLife(c, p, acc, inClosure)
			}
			if b, ok := e[1].([]Stmt); ok {
				walkStmtsLife(b, pos, acc, inClosure, copied)
			}
		}
		walkStmtsLife(t.Else, pos, acc, inClosure, copied)
	case *ForS:
		// the loop var is defined at the loop head, then per iteration
		access(t.Var, p, acc, inClosure)
		walkExprLife(t.Iter, p, acc, inClosure)
		walkStmtsLife(t.Body, pos, acc, inClosure, copied)
	case *WhileS:
		walkExprLife(t.Cond, p, acc, inClosure)
		walkStmtsLife(t.Body, pos, acc, inClosure, copied)
	case *FunctionS:
		// the function name is defined (callable)
		access(t.Name, p, acc, inClosure)
		// body: a function may run 0..N times; accesses count
		walkStmtsLife(t.Body, pos, acc, inClosure, copied)
	case *ReturnS:
		// the value is handed to the caller, which may retain it
		if t.Value != nil {
			walkExprLife(t.Value, p, acc, inClosure)
			markVarsEscape(t.Value, acc)
		}
	case *CaseS:
		walkExprLife(t.Disc, p, acc, inClosure)
		for _, cl := range t.Clauses {
			walkStmtsLife(cl.Body, pos, acc, inClosure, copied)
		}
	case *RedirectS:
		walkStmtsLife(t.Inner, pos, acc, inClosure, copied)
		for _, r := range t.Redirects {
			walkExprLife(r.Target, p, acc, inClosure)
		}
	case *BlockS:
		walkStmtsLife(t.Body, pos, acc, inClosure, copied)
	case *SubshellS:
		// bash forks: the child observes the parent's values at fork
		// time (uses); writes don't propagate back. Record accesses.
		walkStmtsLife(t.Body, pos, acc, inClosure, true)
	case *BackgroundS:
		walkStmtsLife(t.Body, pos, acc, inClosure, true)
	case *PipelineS:
		for _, stage := range t.Stages {
			walkStmtsLife(stage, pos, acc, inClosure, copied)
		}
	case *ExprS:
		walkExprLife(t.Expr, p, acc, inClosure)
	}
}

func walkExprLife(e Expr, pos int, acc *lifetimeAcc, inClosure bool) {
	switch t := e.(type) {
	case *VarE:
		access(t.Name, pos, acc, inClosure)
	case *CallE:
		switch t.Func {
		case "getVar":
			// getVar("x") — a $x read
			if len(t.Args) > 0 {
				if n, ok := t.Args[0].(*StrE); ok {
					access(n.Value, pos, acc, inClosure)
				}
			}
			return
		case "setVar":
			// setVar("x", v) — a $x write
			if len(t.Args) > 0 {
				if n, ok := t.Args[0].(*StrE); ok {
					access(n.Value, pos, acc, inClosure)
				}
			}
			if len(t.Args) > 1 {
				walkExprLife(t.Args[1], pos, acc, inClosure)
			}
			return
		case "setArray", "setArrayAppend":
			// array write — the array is heap storage
			if len(t.Args) > 0 {
				if n, ok := t.Args[0].(*StrE); ok {
					access(n.Value, pos, acc, inClosure)
					acc.escapes[n.Value] = true
				}
			}
			for _, a := range t.Args[1:] {
				walkExprLife(a, pos, acc, inClosure)
			}
			return
		case "define", "fnCall":
			for _, a := range t.Args {
				walkExprLife(a, pos, acc, inClosure)
			}
			// define(name, Arrow) — the arrow is a closure: vars
			// accessed inside it escape
			if t.Func == "define" && len(t.Args) > 1 {
				if arr, ok := t.Args[1].(*ArrowE); ok {
					p := pos
					walkStmtsLife(arr.Body, &p, acc, true, false)
				}
			}
			return
		case "exec", "pipeline", "capture", "captureWords", "redirect",
			"subshell", "background", "forLoop", "whileLoop", "whileLoopSync",
			"cstyleFor", "cstyleForSync", "forIn", "forOf", "commandSubstitution":
			// subprocess boundaries: uses only (kernel copies)
			for _, a := range t.Args {
				walkExprLife(a, pos, acc, inClosure)
			}
			return
		}
		// everything else: walk args as ordinary expressions
		for _, a := range t.Args {
			walkExprLife(a, pos, acc, inClosure)
		}
	case *InterpE:
		for _, p := range t.Parts {
			if !p.IsLit {
				walkExprLife(p.Expr, pos, acc, inClosure)
			}
		}
	case *ArrayE:
		for _, el := range t.Elems {
			walkExprLife(el, pos, acc, inClosure)
		}
	case *ObjectE:
		for _, p := range t.Props {
			walkExprLife(p.Val, pos, acc, inClosure)
		}
	case *ArrowE:
		// a closure: every access inside escapes
		p := pos
		walkStmtsLife(t.Body, &p, acc, true, false)
	case *ArithE:
		walkArithLife(t.Ast, pos, acc, inClosure)
	case *BinOpE:
		walkExprLife(t.Lhs, pos, acc, inClosure)
		walkExprLife(t.Rhs, pos, acc, inClosure)
	}
}

func walkArithLife(a ArithAst, pos int, acc *lifetimeAcc, inClosure bool) {
	switch t := a.(type) {
	case *ArithVar:
		access(t.Name, pos, acc, inClosure)
	case *ArithIndex:
		access(t.Var, pos, acc, inClosure)
		walkArithLife(t.Key, pos, acc, inClosure)
	case *ArithBin:
		walkArithLife(t.Lhs, pos, acc, inClosure)
		walkArithLife(t.Rhs, pos, acc, inClosure)
	case *ArithUn:
		walkArithLife(t.Arg, pos, acc, inClosure)
	case *ArithCond:
		walkArithLife(t.Test, pos, acc, inClosure)
		walkArithLife(t.Then, pos, acc, inClosure)
		walkArithLife(t.Else, pos, acc, inClosure)
	case *ArithAssign:
		// x=... in $(( )) — a def (read-modify-write)
		access(t.Var, pos, acc, inClosure)
		walkArithLife(t.Rhs, pos, acc, inClosure)
	case *ArithIncDec:
		// x++ / x-- — reads and writes
		access(t.Var, pos, acc, inClosure)
	}
}

// markVarsEscape — every variable appearing in an expression escapes
// (array-element stores and function returns may retain it).
func markVarsEscape(e Expr, acc *lifetimeAcc) {
	switch t := e.(type) {
	case *VarE:
		if _, ok := acc.first[t.Name]; !ok {
			acc.first[t.Name] = 0
		}
		acc.escapes[t.Name] = true
	case *BinOpE:
		markVarsEscape(t.Lhs, acc)
		markVarsEscape(t.Rhs, acc)
	case *CallE:
		for _, a := range t.Args {
			markVarsEscape(a, acc)
		}
	case *InterpE:
		for _, p := range t.Parts {
			if !p.IsLit {
				markVarsEscape(p.Expr, acc)
			}
		}
	case *ArrowE:
		// a closure stores its whole environment
		markStmtsVarsEscape(t.Body, acc)
	case *ArrayE:
		for _, el := range t.Elems {
			markVarsEscape(el, acc)
		}
	case *ArithE:
		markArithVarsEscape(t.Ast, acc)
	case *ObjectE:
		for _, p := range t.Props {
			markVarsEscape(p.Val, acc)
		}
	}
}

func markStmtVarsEscape(st Stmt, acc *lifetimeAcc) {
	switch t := st.(type) {
	case *AssignS:
		if _, ok := acc.first[t.Var]; !ok {
			acc.first[t.Var] = 0
		}
		acc.escapes[t.Var] = true
		markVarsEscape(t.Expr, acc)
	case *IfS:
		markVarsEscape(t.Cond, acc)
		markStmtsVarsEscape(t.Then, acc)
		for _, e := range t.Elsifs {
			if c, ok := e[0].(Expr); ok {
				markVarsEscape(c, acc)
			}
			if b, ok := e[1].([]Stmt); ok {
				markStmtsVarsEscape(b, acc)
			}
		}
		markStmtsVarsEscape(t.Else, acc)
	case *ForS:
		if _, ok := acc.first[t.Var]; !ok {
			acc.first[t.Var] = 0
		}
		acc.escapes[t.Var] = true
		markVarsEscape(t.Iter, acc)
		markStmtsVarsEscape(t.Body, acc)
	case *WhileS:
		markVarsEscape(t.Cond, acc)
		markStmtsVarsEscape(t.Body, acc)
	case *ReturnS:
		if t.Value != nil {
			markVarsEscape(t.Value, acc)
		}
	case *CaseS:
		markVarsEscape(t.Disc, acc)
		for _, cl := range t.Clauses {
			markStmtsVarsEscape(cl.Body, acc)
		}
	case *RedirectS:
		markStmtsVarsEscape(t.Inner, acc)
		for _, r := range t.Redirects {
			markVarsEscape(r.Target, acc)
		}
	case *BlockS:
		markStmtsVarsEscape(t.Body, acc)
	case *SubshellS:
		markStmtsVarsEscape(t.Body, acc)
	case *BackgroundS:
		markStmtsVarsEscape(t.Body, acc)
	case *PipelineS:
		for _, stage := range t.Stages {
			markStmtsVarsEscape(stage, acc)
		}
	case *FunctionS:
		if _, ok := acc.first[t.Name]; !ok {
			acc.first[t.Name] = 0
		}
		acc.escapes[t.Name] = true
		markStmtsVarsEscape(t.Body, acc)
	case *ExprS:
		markVarsEscape(t.Expr, acc)
	}
}

func markStmtsVarsEscape(stmts []Stmt, acc *lifetimeAcc) {
	for _, st := range stmts {
		markStmtVarsEscape(st, acc)
	}
}

func markArithVarsEscape(a ArithAst, acc *lifetimeAcc) {
	switch t := a.(type) {
	case *ArithVar:
		if _, ok := acc.first[t.Name]; !ok {
			acc.first[t.Name] = 0
		}
		acc.escapes[t.Name] = true
	case *ArithIndex:
		if _, ok := acc.first[t.Var]; !ok {
			acc.first[t.Var] = 0
		}
		acc.escapes[t.Var] = true
		markArithVarsEscape(t.Key, acc)
	case *ArithBin:
		markArithVarsEscape(t.Lhs, acc)
		markArithVarsEscape(t.Rhs, acc)
	case *ArithUn:
		markArithVarsEscape(t.Arg, acc)
	case *ArithCond:
		markArithVarsEscape(t.Test, acc)
		markArithVarsEscape(t.Then, acc)
		markArithVarsEscape(t.Else, acc)
	case *ArithAssign:
		if _, ok := acc.first[t.Var]; !ok {
			acc.first[t.Var] = 0
		}
		acc.escapes[t.Var] = true
		markArithVarsEscape(t.Rhs, acc)
	case *ArithIncDec:
		if _, ok := acc.first[t.Var]; !ok {
			acc.first[t.Var] = 0
		}
		acc.escapes[t.Var] = true
	}
}

// analyzeVarLifetimes — mirror analyze_var_lifetimes. Top-level stmts
// are walked with a pre-order position counter; subs (Perl subroutines)
// don't exist in our lowering. Sorted by name.
func analyzeVarLifetimes(stmts []Stmt) []VarLifetimeOut {
	acc := &lifetimeAcc{
		first:   map[string]int{},
		last:    map[string]int{},
		escapes: map[string]bool{},
	}
	pos := 0
	walkStmtsLife(stmts, &pos, acc, false, false)
	var sorted []string
	for n := range acc.first {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	var out []VarLifetimeOut
	for _, n := range sorted {
		out = append(out, VarLifetimeOut{
			Name:    n,
			First:   acc.first[n],
			Last:    acc.last[n],
			Escapes: acc.escapes[n],
		})
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// optimize (mirror optimize_stmts: arith-const fold; self-assign removal
// is a no-op for our node shapes — IrExpr::Var is never produced)
// ─────────────────────────────────────────────────────────────────────

func foldExpr(e Expr) Expr {
	switch t := e.(type) {
	case *CallE:
		args := make([]Expr, len(t.Args))
		for i, a := range t.Args {
			args[i] = foldExpr(a)
		}
		if t.Func == "arith" && len(args) == 1 {
			if sv, ok := args[0].(*StrE); ok {
				if v, ok := foldArithConst(sv.Value); ok {
					return &IntE{Value: v}
				}
			}
		}
		return &CallE{Func: t.Func, Args: args}
	case *InterpE:
		out := &InterpE{}
		for _, p := range t.Parts {
			if p.IsLit {
				out.Parts = append(out.Parts, p)
			} else {
				out.Parts = append(out.Parts, InterpPartE{IsLit: false, Expr: foldExpr(p.Expr)})
			}
		}
		return out
	case *ArrayE:
		out := &ArrayE{}
		for _, el := range t.Elems {
			out.Elems = append(out.Elems, foldExpr(el))
		}
		return out
	case *ObjectE:
		out := &ObjectE{}
		for _, p := range t.Props {
			out.Props = append(out.Props, PropE{Key: p.Key, Val: foldExpr(p.Val)})
		}
		return out
	case *ArrowE:
		return &ArrowE{Body: foldStmts(t.Body)}
	}
	return e
}

func foldStmt(s Stmt) Stmt {
	switch t := s.(type) {
	case *ExprS:
		return &ExprS{Expr: foldExpr(t.Expr)}
	case *AssignS:
		return &AssignS{Var: t.Var, Expr: foldExpr(t.Expr)}
	}
	return s
}

func foldStmts(stmts []Stmt) []Stmt {
	out := make([]Stmt, len(stmts))
	for i, s := range stmts {
		out[i] = foldStmt(s)
	}
	return out
}

func optimizeStmts(stmts []Stmt) []Stmt {
	return foldStmts(stmts)
}

// ─────────────────────────────────────────────────────────────────────
// A1 JSON emit (mirror shir_json.rs)
// ─────────────────────────────────────────────────────────────────────

func exprJSON(e Expr) map[string]interface{} {
	switch t := e.(type) {
	case *IntE:
		return map[string]interface{}{"type": "Int", "value": t.Value}
	case *RangeE:
		return map[string]interface{}{"type": "Range", "start": t.Start, "end": t.End}
	case *StrE:
		return map[string]interface{}{"type": "Str", "value": t.Value, "style": t.Style}
	case *VarE:
		return map[string]interface{}{"type": "Var", "name": t.Name, "sigil": nil}
	case *CallE:
		return map[string]interface{}{
			"type":   "Call",
			"func":   t.Func,
			"args":   exprsJSON(t.Args),
			"purity": callPurity(t.Func, t.Args),
		}
	case *InterpE:
		parts := []interface{}{}
		for _, p := range t.Parts {
			if p.IsLit {
				parts = append(parts, map[string]interface{}{"kind": "lit", "text": p.Lit})
			} else {
				parts = append(parts, map[string]interface{}{"kind": "expr", "expr": exprJSON(p.Expr)})
			}
		}
		return map[string]interface{}{"type": "Interpolate", "parts": parts}
	case *ArrayE:
		return map[string]interface{}{"type": "Array", "elements": exprsJSON(t.Elems)}
	case *ObjectE:
		var props []interface{}
		for _, p := range t.Props {
			props = append(props, map[string]interface{}{"key": p.Key, "value": exprJSON(p.Val)})
		}
		return map[string]interface{}{"type": "Object", "properties": props}
	case *ArrowE:
		return map[string]interface{}{"type": "Arrow", "body": stmtsJSON(t.Body)}
	case *ArithE:
		return map[string]interface{}{"type": "Arith", "ast": arithJSON(t.Ast)}
	case *BoolE:
		return map[string]interface{}{"type": "Bool", "value": t.Value}
	case *JsonE:
		return map[string]interface{}{"type": "Json", "value": t.Value}
	case *BinOpE:
		return map[string]interface{}{
			"type": "BinOp", "op": t.Op,
			"lhs": exprJSON(t.Lhs), "rhs": exprJSON(t.Rhs),
		}
	}
	return map[string]interface{}{"type": "Unsupported"}
}

func exprsJSON(es []Expr) []interface{} {
	out := make([]interface{}, len(es))
	for i, e := range es {
		out[i] = exprJSON(e)
	}
	return out
}

func arithJSON(a ArithAst) map[string]interface{} {
	switch t := a.(type) {
	case *ArithNum:
		return map[string]interface{}{"type": "Num", "value": t.Val}
	case *ArithVar:
		return map[string]interface{}{"type": "Var", "name": t.Name}
	case *ArithIndex:
		return map[string]interface{}{"type": "Index", "var": t.Var, "key": arithJSON(t.Key)}
	case *ArithBin:
		return map[string]interface{}{"type": "Bin", "op": t.Op, "lhs": arithJSON(t.Lhs), "rhs": arithJSON(t.Rhs)}
	case *ArithUn:
		return map[string]interface{}{"type": "Un", "op": t.Op, "arg": arithJSON(t.Arg)}
	case *ArithCond:
		return map[string]interface{}{
			"type": "Cond", "test": arithJSON(t.Test),
			"then": arithJSON(t.Then), "else": arithJSON(t.Else),
		}
	case *ArithAssign:
		return map[string]interface{}{"type": "Assign", "var": t.Var, "op": t.Op, "rhs": arithJSON(t.Rhs)}
	case *ArithIncDec:
		return map[string]interface{}{"type": "IncDec", "var": t.Var, "delta": t.Delta, "prefix": t.Prefix}
	}
	return map[string]interface{}{"type": "Num", "value": 0}
}

func stmtJSON(s Stmt) map[string]interface{} {
	switch t := s.(type) {
	case *AssignS:
		return map[string]interface{}{
			"type": "Assign",
			"targets": []interface{}{map[string]interface{}{
				"var": t.Var, "sigil": nil, "indices": []interface{}{},
			}},
			"expr": exprJSON(t.Expr),
		}
	case *ExprS:
		return map[string]interface{}{"type": "Expr", "expr": exprJSON(t.Expr)}
	case *IfS:
		return map[string]interface{}{
			"type":   "If",
			"cond":   exprJSON(t.Cond),
			"then":   stmtsJSON(t.Then),
			"elsifs": []interface{}{},
			"else":   stmtsJSON(t.Else),
		}
	case *WhileS:
		return map[string]interface{}{
			"type": "While",
			"cond": exprJSON(t.Cond),
			"body": stmtsJSON(t.Body),
		}
	case *ForS:
		return map[string]interface{}{
			"type": "For",
			"var":  t.Var,
			"iter": exprJSON(t.Iter),
			"body": stmtsJSON(t.Body),
		}
	case *RedirectS:
		return map[string]interface{}{
			"type":      "Redirect",
			"inner":     stmtsJSON(t.Inner),
			"redirects": redirectsJSON(t.Redirects),
		}
	case *BlockS:
		return map[string]interface{}{"type": "Block", "body": stmtsJSON(t.Body)}
	case *BackgroundS:
		return map[string]interface{}{"type": "Background", "body": stmtsJSON(t.Body)}
	case *SubshellS:
		return map[string]interface{}{"type": "Subshell", "body": stmtsJSON(t.Body)}
	case *FunctionS:
		return map[string]interface{}{"type": "Function", "name": t.Name, "body": stmtsJSON(t.Body)}
	case *ReturnS:
		var v interface{}
		if t.Value != nil {
			v = exprJSON(t.Value)
		}
		return map[string]interface{}{"type": "Return", "value": v}
	case *CaseS:
		var clauses []interface{}
		for _, cl := range t.Clauses {
			clauses = append(clauses, map[string]interface{}{
				"patterns": cl.Patterns,
				"body":     stmtsJSON(cl.Body),
			})
		}
		return map[string]interface{}{"type": "Case", "discriminant": exprJSON(t.Disc), "clauses": clauses}
	case *PipelineS:
		var stages []interface{}
		for _, stage := range t.Stages {
			stages = append(stages, stmtsJSON(stage))
		}
		return map[string]interface{}{
			"type": "Pipeline", "stages": stages,
			"last_output": false, "capture": nil, "cmd_str": "",
			"purity": "Spawn",
		}
	}
	return map[string]interface{}{"type": "noop"}
}

func stmtsJSON(stmts []Stmt) []interface{} {
	out := make([]interface{}, len(stmts))
	for i, s := range stmts {
		out[i] = stmtJSON(s)
	}
	return out
}

func redirectsJSON(rs []RedirectIR) []interface{} {
	out := make([]interface{}, len(rs))
	for i, r := range rs {
		out[i] = map[string]interface{}{
			"fd": r.FD, "mode": r.Mode,
			"target": exprJSON(r.Target), "interpolate": r.Interpolate,
		}
	}
	return out
}

// programJSON — the A1 program with stmt_lines.
func programJSON(stmts []Stmt, varTypes []VarTypeOut, varLengths []VarLenOut, varConst []VarConstOut, varLifetimes []VarLifetimeOut) []byte {
	prog := map[string]interface{}{
		"type":             "Program",
		"contract_version": contractVersion,
		"imports":          []string{},
		"requires":         []string{},
		"var_types":        varTypesJSON(varTypes),
		"stmt_lines":       []interface{}{},
		"var_lengths":      varLengthsJSON(varLengths),
		"var_const":        varConstJSON(varConst),
		"var_lifetimes":    varLifetimesJSON(varLifetimes),
		"subs":             []interface{}{},
		"stmts":            stmtsJSON(stmts),
	}
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(prog); err != nil {
		return []byte(fmt.Sprintf("emit error: %v", err))
	}
	out := strings.TrimSuffix(buf.String(), "\n")
	return []byte(out)
}

func varTypesJSON(vts []VarTypeOut) []interface{} {
	out := make([]interface{}, len(vts))
	for i, v := range vts {
		out[i] = map[string]interface{}{"name": v.Name, "type": v.Type}
	}
	return out
}

func varLengthsJSON(vls []VarLenOut) []interface{} {
	out := make([]interface{}, len(vls))
	for i, v := range vls {
		var ml interface{}
		if v.MaxLen != nil {
			ml = *v.MaxLen
		}
		out[i] = map[string]interface{}{"name": v.Name, "max_len": ml}
	}
	return out
}

func varConstJSON(vcs []VarConstOut) []interface{} {
	out := make([]interface{}, len(vcs))
	for i, v := range vcs {
		out[i] = map[string]interface{}{"name": v.Name, "kind": v.Kind}
	}
	return out
}

func varLifetimesJSON(vls []VarLifetimeOut) []interface{} {
	out := make([]interface{}, len(vls))
	for i, v := range vls {
		out[i] = map[string]interface{}{
			"name":    v.Name,
			"first":   v.First,
			"last":    v.Last,
			"escapes": v.Escapes,
		}
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────
// driver: file → A1 JSON
// ─────────────────────────────────────────────────────────────────────

func shirForSource(src string) ([]byte, error) {
	p := &Parser{src: src}
	cmds, err := p.parseProgram()
	if err != nil {
		return nil, err
	}
	var stmts []Stmt
	for _, c := range cmds {
		if s := stmtForCommand(c); s != nil {
			stmts = append(stmts, s)
		}
	}
	stmts = optimizeStmts(stmts)
	applyTransforms(stmts) // mirror ast_to_ir: worker-submitted transforms (seq-range-for)
	vt := analyzeVarTypes(stmts)
	vl := analyzeStringLengths(stmts)
	vc := analyzeVarConst(stmts)
	vlif := analyzeVarLifetimes(stmts)
	return programJSON(stmts, vt, vl, vc, vlif), nil
}

// Shir — zsh-sh-go as a library: zsh source -> A1 shIR JSON bytes (no
// trailing newline). Both the CLI (cmd/zsh-sh-go) and the combined
// busybox dispatch through this single entry point.
func Shir(src string) ([]byte, error) {
	return shirForSource(src)
}
