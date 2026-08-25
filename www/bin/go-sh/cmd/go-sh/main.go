// go-sh CLI: Go source -> A1 shIR JSON (thin wrapper around the golib
// library, which the combined busybox also dispatches through).
//
// PACKAGE MODE: Go packages span multiple FILES (`cpp-sh-go/main.go` +
// `cpp-sh-go/parser.go` share `package cppshgo`; main.go calls
// parser.go's treeCheck). The frontend resolves cross-file references
// via its name prescan, so multiple --shir inputs (or a directory of
// .go files, _test.go excluded) are CONCATENATED in input order before
// parsing — the same source a go build would see.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	golib "github.com/gmatht/sh2loop/frontends/go-sh"
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
	if len(filtered) < 2 || filtered[0] != "--shir" {
		fmt.Fprintln(os.Stderr, "usage: go-sh --shir <file.go> [more.go | dir] [--raw]")
		os.Exit(2)
	}
	var parts []string
	for _, inp := range filtered[1:] {
		if info, err := os.Stat(inp); err == nil && info.IsDir() {
			entries, err2 := os.ReadDir(inp)
			if err2 != nil {
				fmt.Fprintln(os.Stderr, "go-sh: "+err2.Error())
				os.Exit(2)
			}
			for _, e := range entries {
				name := e.Name()
				if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
					continue
				}
				b, err3 := os.ReadFile(filepath.Join(inp, name))
				if err3 != nil {
					fmt.Fprintln(os.Stderr, "go-sh: "+err3.Error())
					os.Exit(2)
				}
				parts = append(parts, string(b))
			}
			continue
		}
		b, err := os.ReadFile(inp)
		if err != nil {
			// preserve the legacy behavior: a non-readable operand is
			// the SOURCE TEXT itself (`go-sh --shir 'package main...'`)
			parts = append(parts, inp)
			continue
		}
		parts = append(parts, string(b))
	}
	src := strings.Join(parts, "\n")
	out, err := golib.Shir(src)
	if err != nil {
		fmt.Fprintln(os.Stderr, "go-sh: "+err.Error())
		os.Exit(2)
	}
	os.Stdout.Write(out)
	if !raw {
		os.Stdout.Write([]byte{'\n'})
	}
}
