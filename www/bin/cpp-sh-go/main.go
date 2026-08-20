// Package cppshgo — C++14 source → A1 shIR JSON (prototype, per CPP_PLAN.md).
//
// The v0.1 prototype proves the CPP_PLAN split concretely: the C++
// frontend INCLUDES (but never modifies) the shared C lowering — the
// c-sh-go `clib` package is a Go-module dependency, and this package is
// the C++-only surface on top of it:
//
//   1. a tiny C++ tokenizer (string/char/comment/preprocessor safe)
//   2. C++-only keyword REFUSAL (REFUSE > GUESS — templates, classes,
//      std::/::, exceptions, coroutines, concepts, modules, references…)
//   3. a bounded DESUGAR of the expressible C++ surface onto C:
//        bool / true / false / nullptr → int / 1 / 0 / 0
//        new T[N] / new T              → malloc(N * sizeof(T)) / malloc(sizeof(T))
//        delete[] p / delete p         → free(p)
//   4. the desugared C → clib.Shir — the SHARED lowering + A1 emitter.
//      Byte-equality with the C frontend on the expressible subset is
//      the oracle (CPP_PLAN §5), and the C corpus staying green is the
//      cpp gate's hard invariant.
//
// The hand-rolled tokenizer is the PROVISIONAL parser: CPP_PLAN §1–§2
// replaces it with tree-sitter (tree-sitter-c / tree-sitter-cpp, one
// shared walker, shipped as a self-contained wasm) when the full-C/C++
// grammar work lands. This layer's job is to prove the split, the shared
// emitter, and the gate today.
package cppshgo

import (
	"fmt"
	"strings"

	clib "github.com/gmatht/sh2loop/frontends/c-sh-go"
)

// C++-only keywords that have NO C correspondence — refuse loudly
// (REFUSE > GUESS), never guess. The value is the reason shown to the
// user, so a refusal reads as a decision, not a parse failure.
var refuseKeywords = map[string]string{
	"template":          "templates",
	"class":             "classes (use struct for data-only)",
	"namespace":         "namespaces",
	"using":             "using declarations",
	"virtual":           "virtual methods",
	"public":            "access specifiers",
	"private":           "access specifiers",
	"protected":         "access specifiers",
	"friend":            "friend declarations",
	"operator":          "operator overloading",
	"typename":          "typename",
	"mutable":           "mutable",
	"explicit":          "explicit",
	"constexpr":         "constexpr",
	"consteval":         "consteval (C++20)",
	"constinit":         "constinit (C++20)",
	"auto":              "auto (use explicit int)",
	"try":               "exceptions",
	"throw":             "exceptions",
	"catch":             "exceptions",
	"typeid":            "RTTI (typeid)",
	"static_cast":       "C++ casts",
	"dynamic_cast":      "C++ casts",
	"reinterpret_cast":  "C++ casts",
	"const_cast":        "C++ casts",
	"co_await":          "coroutines (C++20)",
	"co_yield":          "coroutines (C++20)",
	"co_return":         "coroutines (C++20)",
	"concept":           "concepts (C++20)",
	"requires":          "concepts (C++20)",
	"char8_t":           "char8_t (C++20)",
	"this":              "`this` (member context)",
	"::":                "scope resolution (std::… is out of scope)",
	"->":                "member access via pointer (use . on structs)",
	"new (":             "placement/new with constructor args",
}

// ── tokenizer ────────────────────────────────────────────────────
// A minimal C++ lexer: enough to find the C++-only surface safely
// (never inside strings/chars/comments) and reassemble C-flavored
// source for clib. Comments and preprocessor lines are dropped (clib
// skips them anyway).
type tok struct{ kind, text string } // id num str chr op

func lex(src string) ([]tok, error) {
	var out []tok
	i, n := 0, len(src)
	for i < n {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '/' && i+1 < n && src[i+1] == '/': // // comment
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && src[i+1] == '*': // /* */ comment
			i += 2
			for i+1 < n && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i += 2
		case c == '#': // preprocessor line — skip (clib skips too)
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '"': // string literal — one token, escapes decoded later by clib
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
		case c == '\'': // char literal
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
		case c >= '0' && c <= '9':
			j := i
			for j < n && (src[j] >= '0' && src[j] <= '9' || src[j] == 'x' || src[j] >= 'a' && src[j] <= 'f' || src[j] >= 'A' && src[j] <= 'F') {
				j++
			}
			out = append(out, tok{"num", src[i:j]})
			i = j
		case isIdStart(c):
			j := i
			for j < n && isIdChar(src[j]) {
				j++
			}
			out = append(out, tok{"id", src[i:j]})
			i = j
		default:
			// operators — longest match first, so `<=>` / `<<=` / `::` /
			// `->` survive reassembly as single tokens.
			three := ""
			if i+2 < n {
				three = src[i : i+3]
			}
			two := ""
			if i+1 < n {
				two = src[i : i+2]
			}
			switch {
			case three == "<=>":
				out = append(out, tok{"op", "<=>"}); i += 3
			case two == "::" || two == "->" || two == "<<=" || two == ">>=":
				out = append(out, tok{"op", two}); i += 2
			case two == "<<" || two == ">>" || two == "<=" || two == ">=" ||
				two == "==" || two == "!=" || two == "&&" || two == "||" ||
				two == "+=" || two == "-=" || two == "*=" || two == "/=" ||
				two == "%=" || two == "&=" || two == "|=" || two == "^=" ||
				two == "++" || two == "--":
				out = append(out, tok{"op", two}); i += 2
			default:
				out = append(out, tok{"op", string(c)}); i++
			}
		}
	}
	return out, nil
}

func isIdStart(c byte) bool { return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }
func isIdChar(c byte) bool  { return isIdStart(c) || c >= '0' && c <= '9' }

// ── the C++-only surface: refuse + desugar ──────────────────────

// translate runs the refusal scan and the desugar over the token
// stream, returning the C-flavored token stream.
func translate(toks []tok) ([]tok, error) {
	// 1. REFUSE — scan every token; C++-only keywords error loudly.
	for _, t := range toks {
		if t.kind == "id" {
			if why, bad := refuseKeywords[t.text]; bad {
				return nil, fmt.Errorf("unsupported C++: %s (%s)", t.text, why)
			}
		}
		if t.kind == "op" {
			if why, bad := refuseKeywords[t.text]; bad {
				return nil, fmt.Errorf("unsupported C++: %s (%s)", t.text, why)
			}
		}
	}
	// 2. DESUGAR — the expressible C++ surface, bounded and pinned by
	//    testdata. Every rule below has a testdata_cpp/ example.
	var out []tok
	i := 0
	for i < len(toks) {
		t := toks[i]
		switch t.text {
		case "bool":
			out = append(out, tok{"id", "int"})
			i++
		case "true":
			out = append(out, tok{"num", "1"})
			i++
		case "false":
			out = append(out, tok{"num", "0"})
			i++
		case "nullptr":
			out = append(out, tok{"num", "0"})
			i++
		case "new":
			n, ni, err := desugarNew(toks, i)
			if err != nil {
				return nil, err
			}
			out = append(out, n...)
			i = ni
		case "delete":
			n, ni, err := desugarDelete(toks, i)
			if err != nil {
				return nil, err
			}
			out = append(out, n...)
			i = ni
		default:
			out = append(out, t)
			i++
		}
	}
	return out, nil
}

// desugarNew — `new T` → `malloc(sizeof(T))`, `new T[N]` → `malloc(N *
// sizeof(T))`. Only the plain single-identifier type form (or `struct
// X`) is expressible; constructor args / placement / pointer types
// refuse. `ni` is the index just past the whole `new …` construct.
func desugarNew(toks []tok, i int) ([]tok, int, error) {
	// type: `struct X` or a single identifier
	j := i + 1
	typ := ""
	if j < len(toks) && toks[j].text == "struct" {
		typ = "struct " + toks[j+1].text
		j += 2
	} else if j < len(toks) && toks[j].kind == "id" {
		typ = toks[j].text
		j++
	} else {
		return nil, 0, fmt.Errorf("unsupported C++: new with complex type (v0.1 supports `new T` / `new T[N]` only)")
	}
	// pointer types refuse (REFUSE > GUESS — no silent misparse)
	if j < len(toks) && toks[j].text == "*" {
		return nil, 0, fmt.Errorf("unsupported C++: new with pointer type (v0.1 supports `new T` / `new T[N]` only)")
	}
	// optional `[N]` — the array form maps to malloc(N * sizeof(T))
	if j < len(toks) && toks[j].text == "[" {
		depth := 0
		k := j
		for ; k < len(toks); k++ {
			switch toks[k].text {
			case "[":
				depth++
			case "]":
				depth--
				if depth == 0 {
					goto closed
				}
			}
		}
		return nil, 0, fmt.Errorf("unsupported C++: new with unterminated array bound")
	closed:
		var mid []tok
		mid = append(mid, toks[j+1:k]...)
		// the shared heap lowering (clib) requires a compile-time size —
		// refuse a non-constant bound here with a C++-specific message
		// (REFUSE > GUESS; the clib message would surface otherwise).
		for _, m := range mid {
			if m.kind == "id" {
				return nil, 0, fmt.Errorf("unsupported C++: new with non-constant array bound (the shared heap lowering needs a compile-time size)")
			}
		}
		out := []tok{{"id", "malloc"}, {"op", "("}}
		out = append(out, mid...)
		out = append(out, tok{"op", "*"}, tok{"id", "sizeof"}, tok{"op", "("}, tok{"id", typ}, tok{"op", ")"}, tok{"op", ")"})
		return out, k + 1, nil
	}
	if j < len(toks) && toks[j].text == "(" {
		return nil, 0, fmt.Errorf("unsupported C++: new with constructor args (placement new)")
	}
	out := []tok{{"id", "malloc"}, {"op", "("}, {"id", "sizeof"}, {"op", "("}, {"id", typ}, {"op", ")"}, {"op", ")"}}
	return out, j, nil
}

// desugarDelete — `delete[] p` / `delete p` → `free(p)`.
func desugarDelete(toks []tok, i int) ([]tok, int, error) {
	j := i + 1
	if j < len(toks) && toks[j].text == "[" {
		j++ // `delete[`
	}
	if j < len(toks) && toks[j].text == "]" {
		j++ // `delete[]`
	}
	if j >= len(toks) || toks[j].kind != "id" {
		return nil, 0, fmt.Errorf("unsupported C++: delete of a non-identifier (v0.1 supports `delete p` / `delete[] p` only)")
	}
	out := []tok{{"id", "free"}, {"op", "("}, {toks[j].kind, toks[j].text}, {"op", ")"}}
	return out, j + 1, nil
}

// reassemble joins the C-flavored token stream back into source text
// for clib. Whitespace-insensitive (clib re-lexes), but strings/chars
// are emitted as single tokens so they survive intact.
func reassemble(toks []tok) string {
	var sb strings.Builder
	for _, t := range toks {
		sb.WriteString(t.text)
		sb.WriteByte(' ')
	}
	return sb.String()
}

// Shir is the frontend entry point (the same contract every frontend
// exposes): C++ source → A1 shIR JSON bytes. The C++-only surface is
// applied here; the shared lowering is clib.Shir, untouched.
func Shir(src string) ([]byte, error) {
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	c, err := translate(toks)
	if err != nil {
		return nil, err
	}
	return clib.Shir(reassemble(c))
}
