package main

import (
	"fmt"
	"os"

	golib "github.com/gmatht/sh2loop/frontends/go-sh"
)

// t99_external_unit: a call to a function in ANOTHER compilation unit
// (`golib.Shir` — the CLI's own call shape, cmd/go-sh/main.go:68).
// The callee body is not in this input, so no signature is known; the
// call lowers to the bare sub name with the multi-return positional
// distribution, and the error slot is dropped like Atoi's. The call
// sits past the usage exit so the no-args path never executes it —
// the gate verifies parse + valid A1 + dead code (DOCUMENTED
// APPROXIMATION in go-sh.go callTargetName).
func main() {
	args := os.Args[1:]
	if len(args) < 1 {
		fmt.Println("alive")
		os.Exit(2)
	}
	out, err := golib.Shir(args[0])
	fmt.Println(out, err)
}
