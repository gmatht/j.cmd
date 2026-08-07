// busybox: every sh2loop source->shIR frontend in one binary.
//
// This is the answer to "can we statically link all the Go frontends
// together": not via -buildmode=c-archive into the Rust otranspilerl
// (unsupported on wasip1/wasm), but as a single Go binary that imports
// the six frontend LIBRARIES (the frontends/ dirs are `package <x>lib`
// + a thin cmd/<name>/ CLI wrapper, so there is exactly one copy of each
// parser — no fork). One wasm artifact carries one Go runtime instead of
// six, shrinking the on-disk total ~3x (≈20.8 MB -> ≈6 MB).
//
// Dispatch contract (used by the otranspilerl WASM host seam):
//
//	busybox --shir <file> [--raw]             (lang inferred from extension)
//	busybox --lang <lang> --shir <file> [--raw]
//
// lang: c | fish | go | perl | py | zsh (aliases: c-sh-go, fish-sh-go,
// go-sh, perl-sh-go, py-sh-go, python, zsh-sh-go). The arg after --shir
// is read as a file when it exists, else treated as literal source.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	clib "github.com/gmatht/sh2loop/frontends/c-sh-go"
	fishlib "github.com/gmatht/sh2loop/frontends/fish-sh-go"
	golib "github.com/gmatht/sh2loop/frontends/go-sh"
	pllib "github.com/gmatht/sh2loop/frontends/perl-sh-go"
	pylib "github.com/gmatht/sh2loop/frontends/py-sh-go"
	zshlib "github.com/gmatht/sh2loop/frontends/zsh-sh-go"
)

type frontend struct {
	name string
	shir func(src string) ([]byte, error)
}

var langAliases = map[string]string{
	"c": "c", "c-sh-go": "c",
	"fish": "fish", "fish-sh-go": "fish",
	"go": "go", "go-sh": "go",
	"perl": "perl", "perl-sh-go": "perl",
	"py": "py", "python": "py", "py-sh-go": "py",
	"zsh": "zsh", "zsh-sh-go": "zsh",
}

var frontends = map[string]frontend{
	"c":    {"c-sh-go", clib.Shir},
	"fish": {"fish-sh-go", fishlib.Shir},
	"go":   {"go-sh", golib.Shir},
	"perl": {"perl-sh-go", pllib.Shir},
	"py":   {"py-sh-go", pylib.Shir},
	"zsh":  {"zsh-sh-go", zshlib.Shir},
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: busybox [--lang <c|fish|go|perl|py|zsh>] --shir <file> [--raw]")
	os.Exit(2)
}

func inferLang(path string) string {
	switch filepath.Ext(path) {
	case ".c":
		return "c"
	case ".fish":
		return "fish"
	case ".go":
		return "go"
	case ".pl":
		return "perl"
	case ".py":
		return "py"
	case ".zsh":
		return "zsh"
	}
	return ""
}

func main() {
	args := os.Args[1:]
	raw := false
	lang := ""
	var rest []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--raw":
			raw = true
		case "--lang":
			if i+1 >= len(args) {
				usage()
			}
			i++
			lang = args[i]
		default:
			rest = append(rest, args[i])
		}
	}
	if len(rest) != 2 || rest[0] != "--shir" {
		usage()
	}
	if lang == "" {
		lang = inferLang(rest[1])
		if lang == "" {
			fmt.Fprintln(os.Stderr, "busybox: cannot infer language from "+rest[1]+" (pass --lang)")
			os.Exit(2)
		}
	}
	if alias, ok := langAliases[lang]; ok {
		lang = alias
	}
	fe, ok := frontends[lang]
	if !ok {
		fmt.Fprintf(os.Stderr, "busybox: unknown language %q (c, fish, go, perl, py, zsh)\n", lang)
		os.Exit(2)
	}
	src := rest[1]
	if b, err := os.ReadFile(rest[1]); err == nil {
		src = string(b)
	}
	out, err := fe.shir(src)
	if err != nil {
		fmt.Fprintln(os.Stderr, fe.name+": "+err.Error())
		os.Exit(1)
	}
	os.Stdout.Write(out)
	if !raw {
		os.Stdout.Write([]byte{'\n'})
	}
}
