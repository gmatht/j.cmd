// Package ziglib — Zig source → A1 shIR JSON (PLAN_ZIG_F.md: the
// C++-style split onto c-sh-go's lowering — one runtime, two grammars,
// one shared lowering; include, never modify, `frontends/c-sh-go`).
//
// This package is the Zig-only surface, the exact mirror of the cpp
// split:
//
//  1. a Zig tokenizer (string/char/comment safe)
//  2. the Zig-only keyword REFUSAL table (REFUSE > GUESS — the error
//     model, optionals, defer, comptime, generics, async… all refuse
//     loudly with their rung/table entry)
//  3. a bounded DESUGAR of the expressible Zig surface onto C:
//     const std = @import("std");   → skipped (the std import binding)
//     pub fn main() void { … }      → int main(void) { … }
//     std.debug.print(fmt, .{a, b}) → printf(cfmt, a, b)
//     — {d}/{s}/{any} → %d/%s/%d, {{/}} → {/}, .{…} → the arg list
//  4. the desugared C → clib.Shir — the SHARED lowering + A1 emitter.
//     Byte-equality with the C frontend on the expressible subset is
//     the oracle (CPP_PLAN §5), and the C corpus staying green is the
//     hard invariant (PLAN_ZIG_F §3).
//
// The hand-rolled tokenizer is the PROVISIONAL parser (the cpp
// template): PLAN_ZIG_F §2 replaces it with tree-sitter-zig when the
// full grammar work lands. This layer's job is to prove the split and
// the gate today, one pinned testdata example at a time.
package ziglib

import (
	"fmt"
	"strconv"
	"strings"

	clib "github.com/gmatht/sh2loop/frontends/c-sh-go"
)

// ── tokenizer ───────────────────────────────────────────────────────
// A minimal Zig lexer: comments (// and //! — Zig has no block
// comments), strings, chars, numbers, identifiers (incl. `@` builtins)
// and the operator set. Strings/chars are kept as RAW source text
// (quotes + escapes) so clib re-lexes them exactly — the cpp template.
type tok struct{ kind, text string } // id num str chr op

func lex(src string) ([]tok, error) {
	var out []tok
	i, n := 0, len(src)
	for i < n {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '/' && i+1 < n && src[i+1] == '/': // // and //! comments
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '"': // string literal — raw text (escapes intact)
			j := i + 1
			for j < n && src[j] != '"' {
				if src[j] == '\\' && j+1 < n {
					j += 2
					continue
				}
				j++
			}
			if j >= n {
				return nil, fmt.Errorf("unterminated string literal")
			}
			out = append(out, tok{"str", src[i : j+1]})
			i = j + 1
		case c == '\'': // char literal — raw text
			j := i + 1
			for j < n && src[j] != '\'' {
				if src[j] == '\\' && j+1 < n {
					j += 2
					continue
				}
				j++
			}
			if j >= n {
				return nil, fmt.Errorf("unterminated char literal")
			}
			out = append(out, tok{"chr", src[i : j+1]})
			i = j + 1
		case c >= '0' && c <= '9': // number literal (0x/0o/0b/_/float all
			// lex as one token; the translator refuses the non-decimal
			// forms — clib's number grammar is plain decimal)
			j := i
			for j < n && (src[j] >= '0' && src[j] <= '9' || src[j] == '_' ||
				src[j] >= 'a' && src[j] <= 'f' || src[j] >= 'A' && src[j] <= 'F' ||
				src[j] == 'x' || src[j] == 'o' || src[j] == 'b' || src[j] == 'e' || src[j] == 'E') {
				j++
			}
			out = append(out, tok{"num", src[i:j]})
			i = j
		case isIdStart(c) || c == '@': // identifiers + @ builtins
			j := i
			if src[j] == '@' {
				j++ // @ builtins: @import, @intCast, @as, … (@ alone is
				// a raw-identifier marker — the translator refuses it)
			}
			for j < n && isIdChar(src[j]) {
				j++
			}
			out = append(out, tok{"id", src[i:j]})
			i = j
		default:
			two := ""
			if i+1 < n {
				two = src[i : i+2]
			}
			switch two {
			case "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "%=",
				"<<=", ">>=", "&=", "|=", "^=", "++", "--", "<<", ">>", "..", "=>", "**":
				out = append(out, tok{"op", two})
				i += 2
				continue
			}
			if strings.ContainsRune("=+-*/%<>!&|^~?:.,;{}()[]", rune(c)) {
				out = append(out, tok{"op", string(c)})
				i++
			} else {
				return nil, fmt.Errorf("lex: unexpected %q", string(c))
			}
		}
	}
	return out, nil
}

func isIdStart(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}
func isIdChar(c byte) bool { return isIdStart(c) || c >= '0' && c <= '9' }

// ── the Zig-only surface: refuse + desugar ──────────────────────────

// refuse — unsupported constructs fail loud (refuse > guess). Panic so
// the library entry (Shir) can recover it as an error (the clib
// discipline).
func refuse(msg string) {
	panic(msg)
}

// stmtRefusals — Zig keywords/constructs with NO v1 correspondence.
// Each entry names its rung/table position (PLAN_ZIG_F §3) so a
// refusal reads as a decision, not a parse failure. The C-compatible
// statements (if/while/for/switch/return/defer, var/const decls) are
// handled by their own parsers, NOT refused.
var stmtRefusals = map[string]string{
	"errdefer":       "errdefer is refused (the error model is a dedicated rung after v1)",
	"try":            "try is refused (the error model is a dedicated rung after v1)",
	"catch":          "catch is refused (the error model is a dedicated rung after v1)",
	"orelse":         "orelse is refused (the error model is a dedicated rung after v1)",
	"error":          "the Zig error model is refused (a dedicated rung after v1)",
	"comptime":       "comptime blocks are refused (comptime evaluation is a later rung)",
	"break":          "break/continue are later rungs",
	"continue":       "break/continue are later rungs",
	"asm":            "asm is refused",
	"test":           "Zig tests are not in the subset",
	"unreachable":    "unreachable is refused",
	"struct":         "struct declarations are refused (a later milestone)",
	"union":          "tagged unions are refused",
	"enum":           "enums are refused",
	"usingnamespace": "usingnamespace is refused",
	"async":          "async is refused",
	"await":          "async/await is refused",
	"suspend":        "async is refused",
	"resume":         "async is refused",
	"extern":         "extern fn is refused",
	"export":         "export fn is refused",
	"inline":         "inline is refused",
	"noinline":       "noinline is refused",
	"volatile":       "volatile is refused",
	"align":          "align is refused",
	"callconv":       "callconv is refused",
	"linksection":    "linksection is refused",
	"null":           "optionals (null) are refused — a dedicated rung after v1",
	"undefined":      "undefined is refused",
	"@import":        "@import is only supported as the top-level `const x = @import(\"std\");` binding",
	"@":              "Zig @ builtins beyond @import/@intCast/@as are refused",
}

// exprRefusals — keywords expressible as STATEMENTS in the subset but
// not as expressions (Zig's if/while/for/switch ARE expressions in the
// full language; the subset pins only the statement forms, so an
// expression-position use refuses loudly instead of guessing).
var exprRefusals = map[string]string{
	"if":     "if as an expression is not in the subset (statement if only)",
	"while":  "while as an expression is not in the subset",
	"for":    "for as an expression is not in the subset",
	"switch": "switch as an expression is not in the subset",
	"defer":  "defer is a statement, not an expression",
	"return": "return is a statement, not an expression",
	"var":    "var is a declaration, not an expression",
	"const":  "const is a declaration, not an expression",
}

// xlator — the Zig→C translator state. Emit is a token list joined
// into C source text for clib (whitespace-insensitive; clib re-lexes).
type xlator struct {
	ts  []tok
	p   int
	out []string

	// rung t03–t13 state:
	defers       []string       // function-scope defer statements (C text), t10
	depth        int            // block nesting depth (1 = function-body top level)
	arrays       map[string]int // array var name → element count, t06
	forCap       string         // active for-capture name, t05/t06
	forArr       string         // the iterated array when the capture rewrites, t06
	exprStmtCall bool           // the last primary parsed was a call, t07
}

func (x *xlator) peek() *tok {
	if x.p < len(x.ts) {
		return &x.ts[x.p]
	}
	return nil
}
func (x *xlator) next() *tok {
	t := x.peek()
	if t != nil {
		x.p++
	}
	return t
}
func (x *xlator) isOp(s string) bool { t := x.peek(); return t != nil && t.kind == "op" && t.text == s }
func (x *xlator) isId(s string) bool { t := x.peek(); return t != nil && t.kind == "id" && t.text == s }
func (x *xlator) emit(s string)      { x.out = append(x.out, s) }

// translate — the top-level walk: only the expressible container-level
// decls survive; everything else refuses with its table entry.
func translate(toks []tok) (string, error) {
	x := &xlator{ts: toks, arrays: map[string]int{}}
	for x.p < len(x.ts) {
		t := x.peek()
		switch {
		case t.kind == "op" && t.text == ";":
			x.next() // container-level empty decl — skip
		case t.kind == "id" && t.text == "pub":
			x.next()
			if !x.isId("fn") {
				refuse("`pub` is only supported on fn declarations")
			}
			x.fnDecl()
		case t.kind == "id" && t.text == "fn":
			x.fnDecl()
		case t.kind == "id" && t.text == "const":
			x.constDecl()
		case t.kind == "id" && t.text == "var":
			refuse("global var declarations are not in the subset (function-scope var only)")
		case t.kind == "id":
			if msg, bad := stmtRefusals[t.text]; bad {
				refuse(msg)
			}
			refuse("unsupported Zig construct at top level: " + t.text)
		default:
			refuse("unsupported Zig construct at top level")
		}
	}
	return strings.Join(x.out, " "), nil
}

// constDecl — top-level `const X = …;`. The ONLY special form is the
// std library binding `const std = @import("std");` — comptime-only and
// SKIPPED entirely. Other comptime const VALUES (t12) desugar to plain
// int declarations; clib's const folding collapses the chain.
func (x *xlator) constDecl() {
	x.next() // const
	nm := x.next()
	if nm == nil || nm.kind != "id" {
		refuse("expected a name after const")
	}
	if !x.isOp("=") {
		refuse("expected = in the const declaration")
	}
	x.next()
	if x.isId("@import") {
		x.next()
		if !x.isOp("(") {
			refuse("expected ( after @import")
		}
		x.next()
		mod := x.next()
		if mod == nil || mod.kind != "str" {
			refuse("expected a module name string in @import")
		}
		if mod.text != `"std"` {
			refuse("@import of modules other than std is refused: " + mod.text)
		}
		if !x.isOp(")") {
			refuse("expected ) after @import")
		}
		x.next()
		if !x.isOp(";") {
			refuse("expected ; after the import declaration")
		}
		x.next()
		// the std import binding is comptime-only — no C emission
		return
	}
	// comptime const value (t12) → int NAME = EXPR;
	if x.peek() != nil && x.peek().kind == "str" {
		refuse("top-level string consts are not in the subset")
	}
	x.emit("int")
	x.emit(nm.text)
	x.emit("=")
	x.expr()
	if !x.isOp(";") {
		refuse("expected ; after the const declaration")
	}
	x.next()
	x.emit(";")
}

// typeRef — a Zig type → its C type text. The v1 map (PLAN_ZIG_F §3):
// void → void, bool → int, i32/i64/u32/u64/isize/usize → int, u8 →
// char, *i32 → int *, *const u8 → const char *. Error unions (!T),
// optionals (?T), slices ([…]T — handled by decl), unknown types refuse
// loudly with their rung. Array types ([_]T / [N]T) are consumed by
// decl, never here.
func (x *xlator) typeRef() string {
	t := x.peek()
	if t == nil {
		refuse("expected a type")
	}
	switch {
	case t.kind == "op" && t.text == "!":
		refuse("error unions (!T) are refused — the error model is a dedicated rung after v1")
	case t.kind == "op" && t.text == "?":
		refuse("optionals (?T) are refused")
	case t.kind == "op" && t.text == "[":
		refuse("slice/array types are consumed by declarations only")
	case t.kind == "op" && t.text == "*":
		// pointer type (t08): *i32 → int *, *const u8 → const char *
		x.next()
		constQual := ""
		if x.isId("const") {
			x.next()
			constQual = "const "
		}
		inner := x.typeRef()
		switch inner {
		case "int":
			return "int *"
		case "char":
			if constQual != "" {
				return "const char *"
			}
			return "char *"
		default:
			refuse("unsupported pointer type")
		}
	case t.kind != "id":
		refuse("unsupported Zig type")
	}
	x.next()
	switch t.text {
	case "void":
		return "void"
	case "bool":
		return "int"
	case "i32", "i64", "u32", "u64", "isize", "usize":
		return "int"
	case "u8":
		return "char"
	case "error", "anyerror":
		refuse("the Zig error model is refused — a dedicated rung after v1")
	default:
		refuse("unsupported Zig type: " + t.text)
	}
	return ""
}

// fnDecl — `fn name(params) RetType { body }` (optionally `pub fn`).
// main → `int main(void)` — the signature clib consumes (main's body
// becomes the program). User functions (t07) → `static Ret name(params)`
// (the c-sh-go t17/t55 shape); their bodies use the same statement
// surface (return, defer, std.debug.print, …).
func (x *xlator) fnDecl() {
	x.next() // fn
	nm := x.next()
	if nm == nil || nm.kind != "id" {
		refuse("expected a function name after fn")
	}
	if !x.isOp("(") {
		refuse("expected ( after the function name")
	}
	x.next()
	var params []string
	if !x.isOp(")") {
		for {
			pn := x.next()
			if pn == nil || pn.kind != "id" || !x.isOp(":") {
				refuse("expected a `name: Type` parameter")
			}
			x.next() // :
			pt := x.typeRef()
			params = append(params, pt+" "+pn.text)
			if x.isOp(")") {
				break
			}
			if !x.isOp(",") {
				refuse("expected , between parameters")
			}
			x.next()
		}
	}
	x.next() // )
	ret := x.typeRef()
	x.defers = nil // per-function defer state (t10)
	if nm.text == "main" {
		if len(params) > 0 {
			refuse("main with parameters (argc/argv) is a later rung")
		}
		if ret != "void" {
			refuse("main must return void in the v1 subset")
		}
		x.emit("int")
		x.emit("main")
		x.emit("(")
		x.emit("void")
		x.emit(")")
		x.block()
		return
	}
	// user function (t07)
	x.emit("static")
	x.emit(ret)
	x.emit(nm.text)
	x.emit("(")
	for i, p := range params {
		if i > 0 {
			x.emit(",")
		}
		x.emit(p)
	}
	x.emit(")")
	x.block()
}

// block — `{ stmts }` → the same braces (Zig and C block syntax
// coincide on the subset). At the function-body top level (depth 1) the
// collected function-scope defers flush in REVERSE at scope exit (t10).
func (x *xlator) block() {
	if !x.isOp("{") {
		refuse("expected {")
	}
	x.next()
	x.emit("{")
	x.depth++
	for !x.isOp("}") {
		if x.p >= len(x.ts) {
			refuse("unterminated block")
		}
		x.stmt()
	}
	if x.depth == 1 && len(x.defers) > 0 {
		// function-scope defers run in REVERSE at scope exit (t10)
		for i := len(x.defers) - 1; i >= 0; i-- {
			x.emit(x.defers[i])
		}
		x.defers = nil
	}
	x.depth--
	x.next()
	x.emit("}")
}

// stmt — a statement inside a function body. The expressible set (the
// rung pins t03–t13): if/else, while (+`: (update)`), for (range and
// items), switch, return, function-scope defer, var/const declarations,
// assignments, std.debug.print calls and call expression statements.
// Every other Zig statement kind refuses loudly (REFUSE > GUESS).
func (x *xlator) stmt() {
	t := x.peek()
	if t == nil {
		refuse("unexpected end of input in statement")
	}
	if t.kind == "op" && t.text == ";" {
		x.next()
		return
	}
	if t.kind != "id" {
		refuse("unsupported Zig statement")
	}
	switch t.text {
	case "if":
		x.ifStmt()
	case "while":
		x.whileStmt()
	case "for":
		x.forStmt()
	case "switch":
		x.switchStmt()
	case "return":
		x.returnStmt()
	case "defer":
		x.deferStmt()
	case "var":
		x.decl()
	case "const":
		x.decl()
	case "std":
		x.stdCall()
	default:
		if msg, bad := stmtRefusals[t.text]; bad {
			refuse(msg)
		}
		x.assignOrCallStmt()
	}
}

// ifStmt — `if (cond) { } else if { } else { }` → identical C (t03; the
// c-sh-go t04_if_else/t34_elseif shape). Blocks are required in the
// pinned subset.
func (x *xlator) ifStmt() {
	x.next() // if
	x.emit("if")
	if !x.isOp("(") {
		refuse("expected ( after if")
	}
	x.next()
	x.emit("(")
	x.expr()
	if !x.isOp(")") {
		refuse("expected ) after the if condition")
	}
	x.next()
	x.emit(")")
	x.block()
	if x.isId("else") {
		x.next()
		x.emit("else")
		if x.isId("if") {
			x.ifStmt() // else if — continue the chain
			return
		}
		x.block()
	}
}

// whileStmt — `while (cond) { }` and `while (cond) : (update) { }` (t04).
// The Zig continue expression desugars to the body's last statement (the
// c-sh-go t05_while shape).
func (x *xlator) whileStmt() {
	x.next() // while
	x.emit("while")
	if !x.isOp("(") {
		refuse("expected ( after while")
	}
	x.next()
	x.emit("(")
	x.expr()
	if !x.isOp(")") {
		refuse("expected ) after the while condition")
	}
	x.next()
	x.emit(")")
	var update []string
	if x.isOp(":") {
		x.next()
		if !x.isOp("(") {
			refuse("expected ( after : in while")
		}
		x.next()
		mark := len(x.out)
		x.primary()
		if t := x.peek(); t != nil && t.kind == "op" && isAssignOp(t.text) {
			x.next()
			x.emit(t.text)
			x.expr()
		}
		if !x.isOp(")") {
			refuse("expected ) after the while update expression")
		}
		x.next()
		update = append([]string{}, x.out[mark:]...)
		x.out = x.out[:mark]
	}
	x.block()
	if update != nil {
		x.out = x.out[:len(x.out)-1] // drop the body's closing }
		x.out = append(x.out, update...)
		x.out = append(x.out, ";", "}")
	}
}

// forStmt — the two v1 for forms (t05/t06):
//
//	for (START..END) |cap| { }  →  int cap = START; for (cap = START; cap < END; cap += 1) { }
//	for (arr) |cap| { }         →  int cap = 0; for (cap = 0; cap < N; cap += 1) { }  (cap → arr[cap])
func (x *xlator) forStmt() {
	x.next() // for
	if !x.isOp("(") {
		refuse("expected ( after for")
	}
	x.next()
	mark := len(x.out)
	x.expr() // the iterable: a range start or an array id
	if x.isOp("..") {
		// range form (t05)
		x.next()
		start := strings.Join(x.out[mark:], " ")
		x.out = x.out[:mark]
		mark = len(x.out)
		x.expr() // the range end
		if !x.isOp(")") {
			refuse("expected ) after the for range")
		}
		x.next()
		end := strings.Join(x.out[mark:], " ")
		x.out = x.out[:mark]
		cap := x.captureName()
		x.emit("int")
		x.emit(cap)
		x.emit("=")
		x.emit(start)
		x.emit(";")
		x.emit("for")
		x.emit("(")
		x.emit(cap)
		x.emit("=")
		x.emit(start)
		x.emit(";")
		x.emit(cap)
		x.emit("<")
		x.emit(end)
		x.emit(";")
		x.emit(cap)
		x.emit("+=")
		x.emit("1")
		x.emit(")")
		x.forBlock(cap, "")
		return
	}
	// array form (t06)
	if !x.isOp(")") {
		refuse("expected ) after the for iterable")
	}
	x.next()
	arr := strings.Join(x.out[mark:], " ")
	x.out = x.out[:mark]
	cap := x.captureName()
	n, ok := x.arrays[arr]
	if !ok {
		refuse("for iteration over a non-array value is not in the subset: " + arr)
	}
	x.emit("int")
	x.emit(cap)
	x.emit("=")
	x.emit("0")
	x.emit(";")
	x.emit("for")
	x.emit("(")
	x.emit(cap)
	x.emit("=")
	x.emit("0")
	x.emit(";")
	x.emit(cap)
	x.emit("<")
	x.emit(strconv.Itoa(n))
	x.emit(";")
	x.emit(cap)
	x.emit("+=")
	x.emit("1")
	x.emit(")")
	x.forBlock(cap, arr)
}

// captureName — the `|cap|` after the for iterable.
func (x *xlator) captureName() string {
	if !x.isOp("|") {
		refuse("expected |capture| after the for iterable")
	}
	x.next()
	cap := x.next()
	if cap == nil || cap.kind != "id" {
		refuse("expected a capture name between | and |")
	}
	if !x.isOp("|") {
		refuse("expected | after the capture name")
	}
	x.next()
	return cap.text
}

// forBlock — the loop body with the capture mapping active (t06: the
// capture rewrites to the array read arr[cap]).
func (x *xlator) forBlock(cap, arr string) {
	oldCap, oldArr := x.forCap, x.forArr
	x.forCap, x.forArr = cap, arr
	x.block()
	x.forCap, x.forArr = oldCap, oldArr
}

// switchStmt — `switch (v) { prong => stmt, …, else => stmt }` → a C
// switch (t11; the c-sh-go t20_switch/t52_switch_many shape). Each
// non-default arm gets a trailing break; the else arm becomes default.
func (x *xlator) switchStmt() {
	x.next() // switch
	x.emit("switch")
	if !x.isOp("(") {
		refuse("expected ( after switch")
	}
	x.next()
	x.emit("(")
	x.expr()
	if !x.isOp(")") {
		refuse("expected ) after the switch value")
	}
	x.next()
	x.emit(")")
	if !x.isOp("{") {
		refuse("expected { after switch (...)")
	}
	x.next()
	x.emit("{")
	for !x.isOp("}") {
		if x.p >= len(x.ts) {
			refuse("unterminated switch")
		}
		if x.isId("else") {
			x.next()
			if !x.isOp("=>") {
				refuse("expected => after else in switch")
			}
			x.next()
			x.emit("default")
			x.emit(":")
			x.armBody()
			if x.isOp(",") {
				x.next()
			}
			continue
		}
		x.emit("case")
		x.expr()
		x.emit(":")
		if !x.isOp("=>") {
			refuse("expected => after the switch prong")
		}
		x.next()
		x.armBody()
		x.emit("break")
		x.emit(";")
		if x.isOp(",") {
			x.next()
		}
	}
	x.next() // }
	x.emit("}")
}

// armBody — a switch arm: a block or a single std.debug.print call (no
// trailing semicolon in the source — the arm's , or } terminates it).
func (x *xlator) armBody() {
	if x.isOp("{") {
		x.block()
		return
	}
	if !x.isId("std") {
		refuse("switch arms must be blocks or std.debug.print calls")
	}
	x.stdCallNoSemi()
	x.emit(";")
}

// returnStmt — `return expr;` / `return;` → identical. Function-scope
// defers flush in REVERSE before every return (t10).
func (x *xlator) returnStmt() {
	x.next() // return
	if len(x.defers) > 0 {
		for i := len(x.defers) - 1; i >= 0; i-- {
			x.emit(x.defers[i])
		}
	}
	x.emit("return")
	if x.isOp(";") {
		x.next()
		x.emit(";")
		return
	}
	x.expr()
	if !x.isOp(";") {
		refuse("expected ; after return")
	}
	x.next()
	x.emit(";")
}

// deferStmt — function-scope `defer stmt;` (t10). The deferred call is
// captured (not emitted inline) and flushed in REVERSE at scope exit —
// before every return and at the function end (PLAN_ZIG_F §3).
// Block-scope defer refuses.
func (x *xlator) deferStmt() {
	if x.depth != 1 {
		refuse("block-scope defer is refused — only function-scope defers are in the subset (t10)")
	}
	x.next() // defer
	if !x.isId("std") {
		refuse("defer of non-call statements is not in the subset (t10)")
	}
	mark := len(x.out)
	x.stdCallNoSemi()
	x.defers = append(x.defers, strings.Join(x.out[mark:], " ")+" ;")
	x.out = x.out[:mark]
	if !x.isOp(";") {
		refuse("expected ; after defer")
	}
	x.next()
}

// bracketedType — after the `[` of a bracketed type is consumed:
//
//	]const u8 → slice: char * (t09)
//	_]i32     → array, length from the literal (t06)
//	N]i32     → array, explicit length
func (x *xlator) bracketedType() (kind, elem string, arrLen int) {
	if x.isOp("]") {
		x.next()
		if x.isId("const") {
			x.next()
		}
		et := x.typeRef()
		if et != "char" {
			refuse("only []const u8 slices are in the subset")
		}
		return "slice", "char", -1
	}
	arrLen = -1
	if !x.isId("_") {
		t := x.next()
		if t == nil || t.kind != "num" {
			refuse("expected _ or a length in the array type")
		}
		arrLen, _ = strconv.Atoi(decimal(t.text))
	} else {
		x.next()
	}
	if !x.isOp("]") {
		refuse("expected ] in the array type")
	}
	x.next()
	et := x.typeRef()
	if et != "int" {
		refuse("only i32 array elements are in the subset")
	}
	return "array", "int", arrLen
}

// decl — a local declaration: `var name: Type = init;` / `const name[: Type] = init;`.
// The C-compatible desugar (t03/t06/t08/t09/t13; PLAN_ZIG_F §3):
//
//	var x: i32 = 5;             → int x = 5;
//	const p: *i32 = &x;         → int *p = &x;
//	const s: []const u8 = "hi"; → char *s = "hi";
//	const items = [_]i32{…};    → int items[N] = {…};  (type on the RHS)
func (x *xlator) decl() {
	isConst := x.isId("const")
	x.next() // var | const
	nm := x.next()
	if nm == nil || nm.kind != "id" {
		refuse("expected a name after var/const")
	}
	typ := ""
	isArray, isSlice := false, false
	arrLen := -1
	if x.isOp(":") {
		x.next()
		if x.isOp("[") {
			x.next()
			kind, elem, n := x.bracketedType()
			if kind == "slice" {
				typ, isSlice = "char *", true
			} else {
				typ, isArray, arrLen = elem, true, n
			}
		} else {
			typ = x.typeRef()
		}
	}
	if typ == "" {
		if !isConst {
			refuse("var declarations require a type annotation (Zig has no var inference)")
		}
		typ = "int" // an inferred comptime int (const)
	}
	if !x.isOp("=") {
		refuse("expected = in the declaration")
	}
	x.next()
	if !isArray && !isSlice && x.isOp("[") {
		// RHS typed array literal (t06): `const items = [_]i32{…};`
		x.next()
		kind, elem, n := x.bracketedType()
		if kind != "array" {
			refuse("slice literals are not in the subset")
		}
		typ, isArray, arrLen = elem, true, n
	}
	if isArray {
		mark := len(x.out)
		if x.isOp(".") {
			x.next() // the .{…} anonymous literal form
		}
		if !x.isOp("{") {
			refuse("array declarations require a { ... } initializer")
		}
		x.next()
		n := 0
		for {
			if n > 0 {
				x.emit(",")
			}
			x.expr()
			n++
			if x.isOp("}") {
				break
			}
			if !x.isOp(",") {
				refuse("expected , between array elements")
			}
			x.next()
		}
		x.next()                                     // }
		elems := append([]string{}, x.out[mark:]...) // copy — x.out's backing array is reused below
		x.out = x.out[:mark]
		if arrLen < 0 {
			arrLen = n
		}
		x.emit(typ)
		x.emit(nm.text + "[" + strconv.Itoa(arrLen) + "]")
		x.emit("=")
		x.emit("{")
		x.out = append(x.out, elems...)
		x.emit("}")
		if !x.isOp(";") {
			refuse("expected ; after the array declaration")
		}
		x.next()
		x.emit(";")
		x.arrays[nm.text] = arrLen
		return
	}
	x.emit(typ)
	x.emit(nm.text)
	x.emit("=")
	if isSlice {
		t := x.next()
		if t == nil || t.kind != "str" {
			refuse("slice declarations need a string literal initializer")
		}
		x.emit(t.text)
	} else {
		x.expr()
	}
	if !x.isOp(";") {
		refuse("expected ; after the declaration")
	}
	x.next()
	x.emit(";")
}

// assignOrCallStmt — an id-led statement: an assignment (`x = e;`,
// `p.* = e;`, compound ops) or a call expression statement (`f(x);`).
func (x *xlator) assignOrCallStmt() {
	x.exprStmtCall = false
	x.primary()
	t := x.peek()
	if t != nil && t.kind == "op" && isAssignOp(t.text) {
		x.next()
		x.emit(t.text)
		x.expr()
		if !x.isOp(";") {
			refuse("expected ; after the assignment")
		}
		x.next()
		x.emit(";")
		return
	}
	if !x.exprStmtCall {
		refuse("unsupported Zig statement")
	}
	if !x.isOp(";") {
		refuse("expected ; after the call statement")
	}
	x.next()
	x.emit(";")
}

// isAssignOp — the assignment operators (Zig and C share the set).
func isAssignOp(s string) bool {
	switch s {
	case "=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^=":
		return true
	}
	return false
}

// stdCall — `std . <path> ( … ) ;` — the std library surface. The v1
// expressible entry is exactly std.debug.print (PLAN_ZIG_F §3);
// everything else in std.* refuses. The trailing semicolon is part of
// the statement form (stdCall) but not of the embedded forms (switch
// arms t11, defer t10).
func (x *xlator) stdCall()       { x.stdCallSemi(true) }
func (x *xlator) stdCallNoSemi() { x.stdCallSemi(false) }
func (x *xlator) stdCallSemi(semi bool) {
	x.next() // std
	if !x.isOp(".") {
		refuse("std.* beyond std.debug.print is refused (no std.fs, no writers, no ArrayList)")
	}
	x.next() // .
	if !x.isId("debug") {
		refuse("std.* beyond std.debug.print is refused (no std.fs, no writers, no ArrayList)")
	}
	x.next() // debug
	if !x.isOp(".") {
		refuse("std.debug.* beyond std.debug.print is refused")
	}
	x.next() // .
	if !x.isId("print") {
		refuse("std.debug.* beyond std.debug.print is refused")
	}
	x.next() // print
	x.printCallSemi(semi)
}

// printCall — `std.debug.print(FMT, .{ARGS})` → `printf(CFMT, ARGS…)`.
// Zig placeholders convert on the format string ({d}/{s}/{c}/{any} →
// %d/%s/%c/%d; {{/}} → {/}); unknown specifiers refuse. The .{…}
// anonymous tuple becomes the C argument list (the empty tuple → no
// arguments). With semi, the trailing `;` of the statement form is
// expected and emitted; the embedded forms (switch arms, defer) pass
// false.
func (x *xlator) printCall()       { x.printCallSemi(true) }
func (x *xlator) printCallNoSemi() { x.printCallSemi(false) }
func (x *xlator) printCallSemi(semi bool) {
	if !x.isOp("(") {
		refuse("expected ( after std.debug.print")
	}
	x.next()
	f := x.peek()
	if f == nil || f.kind != "str" {
		refuse("std.debug.print format must be a string literal")
	}
	x.next()
	x.emit("printf")
	x.emit("(")
	x.emit(convertFormat(f.text))
	if !x.isOp(",") {
		refuse("std.debug.print requires the .{…} arguments tuple")
	}
	x.next()
	if !x.isOp(".") {
		refuse("std.debug.print arguments must be the .{…} anonymous tuple")
	}
	x.next()
	if !x.isOp("{") {
		refuse("std.debug.print arguments must be the .{…} anonymous tuple")
	}
	x.next()
	if !x.isOp("}") {
		for {
			x.emit(",")
			x.expr()
			if x.isOp("}") {
				break
			}
			if !x.isOp(",") {
				refuse("expected , between tuple arguments")
			}
			x.next()
		}
	}
	x.next() // }
	if !x.isOp(")") {
		refuse("expected ) after std.debug.print arguments")
	}
	x.next()
	x.emit(")")
	if semi {
		if !x.isOp(";") {
			refuse("expected ; after std.debug.print")
		}
		x.next()
		x.emit(";")
	}
}

// expr — a printf argument expression → C text. The v1 expressible
// shape: literals, identifiers, binary arith, unary !/-, parens, calls,
// casts — everything that maps onto the C surface clib already lowers.
// Zig-only syntax refuses.
func (x *xlator) expr() {
	x.primary()
	for {
		t := x.peek()
		if t != nil && t.kind == "op" && isBinOp(t.text) {
			x.next()
			x.emit(t.text)
			x.primary()
			continue
		}
		return
	}
}

func isBinOp(s string) bool {
	switch s {
	case "+", "-", "*", "/", "%", "==", "!=", "<", ">", "<=", ">=", "&&", "||":
		return true
	}
	return false
}

// primary — one expression operand. Strings/chars are re-emitted RAW
// (clib re-lexes and decodes them); ids pass through, with the
// rung-specific shapes: calls (t07), the x.* deref and s.len (t08/t09),
// s[0] indexing (t09), @intCast/@as (t13), and the for-items capture
// rewrite (t06).
func (x *xlator) primary() {
	t := x.peek()
	if t == nil {
		refuse("unexpected end of input in expression")
	}
	switch {
	case t.kind == "id":
		if t.text == "@intCast" || t.text == "@as" {
			x.castCall()
			return
		}
		if msg, bad := stmtRefusals[t.text]; bad {
			refuse(msg)
		}
		if msg, bad := exprRefusals[t.text]; bad {
			refuse(msg)
		}
		x.next()
		if x.forArr != "" && t.text == x.forCap {
			// for-items capture → the array read arr[cap] (t06)
			x.emit(x.forArr + "[" + x.forCap + "]")
			return
		}
		if t.text == "std" {
			refuse("std.* calls inside expressions are a later rung")
		}
		if x.isOp("(") {
			// a user function call (t07): name(args)
			x.emit(t.text)
			x.next() // (
			x.emit("(")
			if !x.isOp(")") {
				for {
					x.expr()
					if x.isOp(")") {
						break
					}
					if !x.isOp(",") {
						refuse("expected , between call arguments")
					}
					x.next()
					x.emit(",")
				}
			}
			x.next() // )
			x.emit(")")
			x.exprStmtCall = true
			return
		}
		if x.isOp(".") {
			x.next() // .
			if x.isOp("*") {
				// x.* deref → *x (t08)
				x.next()
				x.emit("*" + t.text)
				return
			}
			m := x.next()
			if m == nil || m.kind != "id" || m.text != "len" {
				refuse("only .* (deref) and .len are in the subset")
			}
			// s.len → strlen(s) (t09)
			x.emit("strlen(" + t.text + ")")
			return
		}
		if x.isOp("[") {
			// s[0] / arr[i] indexing (t09)
			x.next()
			x.emit(t.text + "[")
			x.expr()
			if !x.isOp("]") {
				refuse("expected ] after the index")
			}
			x.next()
			x.emit("]")
			return
		}
		x.emit(t.text)
	case t.kind == "num":
		x.next()
		x.emit(decimal(t.text))
	case t.kind == "str":
		x.next()
		x.emit(t.text)
	case t.kind == "chr":
		refuse("char literals are a later rung")
	case t.kind == "op" && t.text == "(":
		x.next()
		x.emit("(")
		x.expr()
		if !x.isOp(")") {
			refuse("expected ) in expression")
		}
		x.next()
		x.emit(")")
	case t.kind == "op" && (t.text == "-" || t.text == "!" || t.text == "&"):
		x.next()
		x.emit(t.text)
		x.primary()
	default:
		refuse("unsupported expression")
	}
}

// castCall — @intCast(expr) / @as(Type, expr) → the identity cast
// `(int) (expr)` on clib's C surface (t13; PLAN_ZIG_F §3).
func (x *xlator) castCall() {
	name := x.next()
	if name == nil || (name.text != "@intCast" && name.text != "@as") {
		refuse("expected @intCast or @as")
	}
	if !x.isOp("(") {
		refuse("expected ( after " + name.text)
	}
	x.next()
	if name.text == "@as" {
		x.typeRef() // the result type — identity, discarded
		if !x.isOp(",") {
			refuse("expected , in @as(Type, value)")
		}
		x.next()
	}
	x.emit("(int)")
	x.emit("(")
	x.expr()
	if !x.isOp(")") {
		refuse("expected ) after " + name.text)
	}
	x.next()
	x.emit(")")
}

// decimal — a Zig integer literal → C decimal text. `_` separators are
// stripped; hex/octal/binary/float literals refuse (clib's number
// grammar is plain decimal).
func decimal(s string) string {
	if len(s) > 1 && s[0] == '0' && (s[1] == 'x' || s[1] == 'o' || s[1] == 'b') {
		refuse("non-decimal literals are a later rung: " + s)
	}
	if strings.ContainsAny(s, ".eE") {
		refuse("float literals are a later rung (t23)")
	}
	return strings.ReplaceAll(s, "_", "")
}

// convertFormat — the Zig format string → C printf format text. The v1
// specifiers: {d} → %d, {s} → %s, {c} → %c, {any} → %d (PLAN_ZIG_F §3);
// {{ and }} are literal braces. Anything else in braces refuses
// (specifiers like {x}/{e}/{*} are later rungs). The raw string text
// (quotes + escapes) is preserved so clib re-lexes it exactly.
func convertFormat(raw string) string {
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		refuse("malformed format string")
	}
	inner := raw[1 : len(raw)-1]
	var sb strings.Builder
	sb.WriteByte('"')
	for i := 0; i < len(inner); {
		c := inner[i]
		if c == '\\' {
			// escape sequence — copy verbatim (clib decodes it)
			sb.WriteByte(c)
			i++
			if i < len(inner) {
				sb.WriteByte(inner[i])
				i++
			}
			continue
		}
		if c == '{' {
			if i+1 < len(inner) && inner[i+1] == '{' {
				sb.WriteByte('{') // {{ → literal brace
				i += 2
				continue
			}
			for _, spec := range []struct{ zig, c string }{
				{"{d}", "%d"}, {"{s}", "%s"}, {"{c}", "%c"}, {"{any}", "%d"},
			} {
				if i+len(spec.zig) <= len(inner) && inner[i:i+len(spec.zig)] == spec.zig {
					sb.WriteString(spec.c)
					i += len(spec.zig)
					goto matched
				}
			}
			if j := strings.IndexByte(inner[i:], '}'); j >= 0 {
				refuse("unsupported format specifier in std.debug.print: " + inner[i:i+j+1])
			}
			refuse("unterminated format specifier in std.debug.print")
		matched:
			continue
		}
		if c == '}' {
			if i+1 < len(inner) && inner[i+1] == '}' {
				sb.WriteByte('}') // }} → literal brace
				i += 2
				continue
			}
			refuse("stray } in std.debug.print format string")
		}
		sb.WriteByte(c)
		i++
	}
	sb.WriteByte('"')
	return sb.String()
}

// ── Shir — the frontend entry: Zig source → A1 shIR JSON bytes. The
// Zig-only surface is applied here; the shared lowering is clib.Shir,
// untouched. Refusals panic (see refuse) and are recovered as errors
// (the clib discipline). ─────────────────────────────────────────────
func Shir(src string) (out []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("REFUSE: %v", r)
		}
	}()
	toks, err := lex(src)
	if err != nil {
		return nil, fmt.Errorf("REFUSE: %w", err)
	}
	c, err := translate(toks)
	if err != nil {
		return nil, err
	}
	return clib.Shir(c)
}
