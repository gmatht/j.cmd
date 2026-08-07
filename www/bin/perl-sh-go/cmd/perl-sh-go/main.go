// perl-sh-go CLI: Perl source -> A1 shIR JSON (thin wrapper around the
// pllib library, which the combined busybox also dispatches through).
package main

import (
	"fmt"
	"os"

	pllib "github.com/gmatht/sh2loop/frontends/perl-sh-go"
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
		fmt.Fprintln(os.Stderr, "usage: perl-sh-go --shir <file.pl> [--raw]")
		os.Exit(2)
	}
	inp := filtered[1]
	src := inp
	if b, err := os.ReadFile(inp); err == nil {
		src = string(b)
	}
	out, err := pllib.Shir(src)
	if err != nil {
		fmt.Fprintln(os.Stderr, "perl-sh-go: "+err.Error())
		os.Exit(2)
	}
	os.Stdout.Write(out)
	if !raw {
		os.Stdout.Write([]byte{'\n'})
	}
}
