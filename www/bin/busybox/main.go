// browser dispatcher — the merged unified frontend CLI.
//
// This is the browser port of the sh2loop fleet's busybox (one binary
// over the whole frontend fleet): after the otranspiler command merges
// the seven <lang>-sh-go libraries + posix-sh-go (the shell frontend) +
// shir-emit-go into one main.go, THIS main dispatches by --lang. The
// lib entry points are the merge's prefixed names (c_Shir, go_Shir,
// ..., sh_shirForSource — shirForSource is posix-sh-go's library
// entry; upstream posix-sh-go is a package-main CLI, so the merge
// renames its main() to sh_main and the dispatcher uses shirForSource).
//
//	<merged> --lang <c|fish|go|perl|py|sh|zsh> --shir <file> [--raw]
//	<merged> --shir <file> [--raw]                    (lang from extension)
//
// Source of truth for the lib sources: www/bin/<frontend>/ (vendored
// from gmatht/sh2loop/frontends/<frontend>/).
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

type frontend struct {
	name string
	shir func(src string) ([]byte, error)
}

var langAliases = map[string]string{
	"bat": "bat", "bat-sh-go": "bat", "cmd": "bat",
	"c": "c", "c-sh-go": "c",
	"fish": "fish", "fish-sh-go": "fish",
	"go": "go", "go-sh": "go",
	"perl": "perl", "perl-sh-go": "perl", "pl": "perl",
	"py": "py", "python": "py", "py-sh-go": "py",
	"sh": "sh", "posix-sh-go": "sh", "bash": "sh",
	"zsh": "zsh", "zsh-sh-go": "zsh",
}

var frontends = map[string]frontend{
	"bat":  {"bat-sh-go", bat_Shir},
	"c":    {"c-sh-go", c_Shir},
	"fish": {"fish-sh-go", fish_Shir},
	"go":   {"go-sh", go_Shir},
	"perl": {"perl-sh-go", pl_Shir},
	"py":   {"py-sh-go", py_Shir},
	"sh":   {"posix-sh-go", sh_shirForSource},
	"zsh":  {"zsh-sh-go", zsh_Shir},
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: frontend [--lang <bat|c|fish|go|perl|py|sh|zsh>] --shir <file> [--raw]")
	os.Exit(2)
}

func inferLang(path string) string {
	switch filepath.Ext(path) {
	case ".bat":
		return "bat"
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
	case ".sh", "":
		return "sh"
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
			fmt.Fprintln(os.Stderr, "frontend: cannot infer language from "+rest[1]+" (pass --lang)")
			os.Exit(2)
		}
	}
	if alias, ok := langAliases[lang]; ok {
		lang = alias
	}
	fe, ok := frontends[lang]
	if !ok {
		fmt.Fprintf(os.Stderr, "frontend: unknown language %q (c, fish, go, perl, py, sh, zsh)\n", lang)
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
