// py-sh-go CLI: Python source -> A1 shIR JSON (thin wrapper around the
// pylib library, which the combined busybox also dispatches through).
package main

import (
	"fmt"
	"os"
	"strings"

	pylib "github.com/gmatht/sh2loop/frontends/py-sh-go"
)

func main() {
	args := os.Args[1:]
	raw := false
	exact64 := false
	parse := false
	filtered := []string{}
	for _, a := range args {
		switch a {
		case "--raw":
			raw = true
		case "--parse":
			// Parse with the full ANTLR Python grammar, print the file_input
			// tree / report syntax errors, and exit (no lowering). This is the
			// coverage front end; the v1 lowering path stays on --shir.
			parse = true
		case "--exact-i64":
			// C-only callers (python-O4): prove integer ranges against
			// the exact signed-i64 ceiling (2^63-1) instead of the JS
			// Number bound (2^53), so a value proven to fit i64 stays
			// native instead of being homed in GMP. A default-off flag:
			// the ESTree/JS path needs the 2^53 bound.
			exact64 = true
		default:
			filtered = append(filtered, a)
		}
	}
	if parse {
		if len(filtered) != 1 {
			fmt.Fprintln(os.Stderr, "usage: py-sh-go --parse <file.py>")
			os.Exit(2)
		}
		src, err := os.ReadFile(filtered[0])
		if err != nil {
			fmt.Fprintln(os.Stderr, "py-sh-go: "+err.Error())
			os.Exit(2)
		}
		if _, errs := pylib.ParsePython(string(src)); len(errs) > 0 {
			for _, e := range errs {
				fmt.Fprintln(os.Stderr, "py-sh-go: parse: "+e)
			}
			os.Exit(1)
		}
		return
	}
	if len(filtered) != 2 || filtered[0] != "--shir" {
		fmt.Fprintln(os.Stderr, "usage: py-sh-go --shir <file.py> [--raw] [--exact-i64]")
		os.Exit(2)
	}
	inp := filtered[1]
	src := inp
	if strings.Contains(inp, ".py") || !strings.ContainsAny(inp, " \t\n") {
		if b, err := os.ReadFile(inp); err == nil {
			src = string(b)
		}
	}
	out, err := pylib.ShirExact(src, exact64)
	if err != nil {
		fmt.Fprintln(os.Stderr, "py-sh-go: "+err.Error())
		os.Exit(2)
	}
	os.Stdout.Write(out)
	if !raw {
		os.Stdout.Write([]byte{'\n'})
	}
}
