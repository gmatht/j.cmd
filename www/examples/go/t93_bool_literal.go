// t93_bool_literal: bool literals + bare-var conditions — `raw := false`
// lowers to `raw = "false"` (a literal, never a `$false` var read), and
// `if raw` / `if !raw` lower to the `"$raw"="true"` test (the Not twin
// wraps it in `!`).
// diagnostics: program prints its result to stdout
package main

import "fmt"

func main() {
	raw := false
	if !raw {
		fmt.Println("not raw")
	}
	raw = true
	if raw {
		fmt.Println("raw")
	}
}
