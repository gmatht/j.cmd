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
	filtered := []string{}
	for _, a := range args {
		if a == "--raw" {
			raw = true
		} else {
			filtered = append(filtered, a)
		}
	}
	if len(filtered) != 2 || filtered[0] != "--shir" {
		fmt.Fprintln(os.Stderr, "usage: py-sh-go --shir <file.py> [--raw]")
		os.Exit(2)
	}
	inp := filtered[1]
	src := inp
	if strings.Contains(inp, ".py") || !strings.ContainsAny(inp, " \t\n") {
		if b, err := os.ReadFile(inp); err == nil {
			src = string(b)
		}
	}
	out, err := pylib.Shir(src)
	if err != nil {
		fmt.Fprintln(os.Stderr, "py-sh-go: "+err.Error())
		os.Exit(2)
	}
	os.Stdout.Write(out)
	if !raw {
		os.Stdout.Write([]byte{'\n'})
	}
}
