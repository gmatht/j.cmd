// zsh-sh-go CLI: zsh source -> A1 shIR JSON (thin wrapper around the
// zshlib library, which the combined busybox also dispatches through).
package main

import (
	"fmt"
	"os"
	"strings"

	zshlib "github.com/gmatht/sh2loop/frontends/zsh-sh-go"
)

func main() {
	args := os.Args[1:]
	raw := false
	var filtered []string
	for _, a := range args {
		if a == "--raw" {
			raw = true
		} else {
			filtered = append(filtered, a)
		}
	}
	if len(filtered) != 2 || filtered[0] != "--shir" {
		fmt.Fprintln(os.Stderr, "usage: zsh-sh-go --shir <file.zsh> [--raw]")
		os.Exit(2)
	}
	inp := filtered[1]
	src := inp
	if strings.Contains(inp, ".sh") || !strings.ContainsAny(inp, " \t\n") {
		if b, err := os.ReadFile(inp); err == nil {
			src = string(b)
		}
	}
	out, err := zshlib.Shir(src)
	if err != nil {
		// the core's export_shir prints the error and returns normally:
		// empty stdout, exit 0
		fmt.Fprintln(os.Stderr, "Parse error: "+err.Error())
		return
	}
	os.Stdout.Write(out)
	if !raw {
		os.Stdout.Write([]byte{'\n'})
	}
}
