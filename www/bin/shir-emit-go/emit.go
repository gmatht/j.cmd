// Package shiremit builds and emits the A1 shIR JSON contract.
//
// The contract is defined in sh2perl/src/shir_json.rs (and the matching
// deserializer in shir_json_in.rs). This Go package is the
// single-source-of-truth for the A1 JSON shape used by all
// ANTLR4+Go frontends (py-sh-go, posix-sh-go, perl-sh-go, go-sh).
// It replaces the deferred #4 serde-derive refactor (in Rust) with
// the equivalent in Go: one Emitter, one Program type, one JSON shape.
//
// The emitted JSON MUST be byte-identical to the core's
// shir_json.rs output for the same program. encoding/json on
// map[string]any produces alphabetically-sorted keys (matching
// serde_json's BTreeMap), which is what the contract requires.
//
// Usage:
//
//	prog := &shiremit.Program{...}
//	b, err := shiremit.Emit(prog)
//	// b is the A1 JSON, ready to write to stdout or feed to
//	// debashc --shir-in-estree for the round-trip / ingress test.
package shiremit

import (
	"encoding/json"
	"sort"
)

// ContractVersion must match sh2perl/src/shir_json.rs CONTRACT_VERSION.
const ContractVersion = 1

// Program is the top-level A1 shIR program.
//
// The JSON field order is alphabetical (encoding/json sorts map keys).
// The struct fields below are exported for programmatic construction;
// the emitted JSON is a map[string]any (sorted), not a Go struct
// literal, so the JSON shape is the contract — not these struct tags.
type Program struct {
	Imports   []string            `json:"imports"`
	Requires  []string            `json:"requires"`
	VarTypes  []VarType           `json:"var_types"`
	Subs      []Sub               `json:"subs"`
	Stmts     []map[string]any    `json:"stmts"`
	ContractVersion int           `json:"contract_version"`
	Type      string              `json:"type"` // always "Program"
}

type VarType struct {
	Name string `json:"name"`
	Type string `json:"type"` // "Int" or "Str"
}

type Sub struct {
	Type   string           `json:"type"` // "Sub"
	Name   string           `json:"name"`
	Params []string         `json:"params"`
	Body   []map[string]any `json:"body"`
}

// Emit serializes prog to the A1 shIR JSON, byte-equivalent to the
// core's shir_json.rs output for the same program (sorted keys,
// contract_version field, etc.).
func Emit(prog *Program) ([]byte, error) {
	// Build the top-level map (sorted by encoding/json).
	// We use map[string]any so keys sort alphabetically on marshal.
	// Empty (non-nil) slices ensure "[]" not "null" in the JSON, matching
	// the contract exactly.
	imports := prog.Imports
	if imports == nil {
		imports = []string{}
	}
	requires := prog.Requires
	if requires == nil {
		requires = []string{}
	}
	v := map[string]any{
		"type":             "Program",
		"contract_version": ContractVersion,
		"imports":          imports,
		"requires":         requires,
		"var_types":        toAnySlice(prog.VarTypes),
		"subs":             toAnySubs(prog.Subs),
		"stmts":            toAnyStmts(prog.Stmts),
	}
	return json.Marshal(v)
}

// EmitToMap returns the program as a map[string]any (sorted keys when
// later marshaled). Useful for tests that need the JSON shape without
// the final marshal step.
func EmitToMap(prog *Program) map[string]any {
	imports := prog.Imports
	if imports == nil {
		imports = []string{}
	}
	requires := prog.Requires
	if requires == nil {
		requires = []string{}
	}
	return map[string]any{
		"type":             "Program",
		"contract_version": ContractVersion,
		"imports":          imports,
		"requires":         requires,
		"var_types":        toAnySlice(prog.VarTypes),
		"subs":             toAnySubs(prog.Subs),
		"stmts":            toAnyStmts(prog.Stmts),
	}
}

// --- helpers to convert typed slices to map slices (so the emitted
// JSON has alphabetically-sorted keys via map[string]any) ---

func toAnySlice(vs []VarType) []any {
	out := make([]any, len(vs))
	for i, v := range vs {
		out[i] = map[string]any{"name": v.Name, "type": v.Type}
	}
	return out
}

func toAnySubs(subs []Sub) []any {
	out := make([]any, len(subs))
	for i, s := range subs {
		out[i] = map[string]any{
			"type":   s.Type,
			"name":   s.Name,
			"params": s.Params,
			"body":   toAnyStmts(s.Body),
		}
	}
	return out
}

func toAnyStmts(stmts []map[string]any) []any {
	out := make([]any, len(stmts))
	for i, s := range stmts {
		out[i] = s
	}
	return out
}

// SortedKeys returns the keys of m in alphabetical order (for callers
// that need to inspect the JSON shape).
func SortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
