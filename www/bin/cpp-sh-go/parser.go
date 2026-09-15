package cppshgo

import "fmt"

// treeCheck — the browser pure-Go stand-in for the fleet's tree-sitter
// refusal gate (frontends/cpp-sh-go/parser.go uses tree-sitter-cpp via
// cgo, which cannot build to wasm). The vendored main.go's tokenizer is
// string/char/comment/preprocessor-safe, so a token-level scan refuses
// the C++-only surface honestly (REFUSE > GUESS) without the grammar:
//
//   • every refuseKeywords word as a standalone token
//     (template/class/namespace/auto/try/throw/catch/… — the map in
//     main.go documents the refused surface, mirrored by the *_refuse
//     pins in testdata_cpp/)
//   • the scope / pointer-member operators `::` and `->`
//   • reference declarators — a lone `&` token (int& r = …). The
//     expressible corpus never uses binary/address-of `&`, and clib's
//     shared lowering has no reference semantics — refusing keeps the
//     subset honest (the fleet refuses reference_declarator nodes).
//
// Placement new / non-constant array bounds are refused by desugarNew
// in main.go — the same error the fleet's treeCheck surfaces.
func treeCheck(src string) error {
	toks, err := lex(src)
	if err != nil {
		return err
	}
	for _, t := range toks {
		if t.kind == "id" {
			if reason, bad := refuseKeywords[t.text]; bad {
				return fmt.Errorf("unsupported C++: %s (token %q)", reason, t.text)
			}
			continue
		}
		if t.kind == "op" {
			switch t.text {
			case "::":
				return fmt.Errorf("unsupported C++: scope resolution (std::… is out of scope)")
			case "->":
				return fmt.Errorf("unsupported C++: member access via pointer (use . on structs)")
			case "&":
				return fmt.Errorf("unsupported C++: reference declarator (int& …)")
			}
		}
	}
	return nil
}
