// otranspiler web GUI — examples per input language.
//
// Each example is small, stdio-only and chosen to exercise the
// constructs the transpiler handles (echo/print, vars, strings,
// arithmetic, arrays, loops, conditionals, functions, args, stdin) so
// the generated code RUNS in the target language too — the stdout diff
// then compares like with like. `runtime` notes how the original is
// executed in the browser (see otranspiler.html's runtime map).
//
// NOTE the py examples avoid f-strings (the vendored micropython is an
// older build without them) and the pl examples stick to core perl.

export const EXAMPLES = {
  sh: [
    { name: "hello", desc: "Hello world with a variable", code: 'name="world"\necho "hello $name"\n' },
    { name: "loop-count", desc: "for loop 1..3", code: 'for i in 1 2 3; do\n  echo "count $i"\ndone\n' },
    { name: "arith", desc: "$(( )) arithmetic", code: 'x=6\ny=7\necho "6*7=$((x * y))"\n' },
    { name: "conditional", desc: "if / else on a variable", code: 'n=5\nif [ "$n" -gt 3 ]; then\n  echo "big"\nelse\n  echo "small"\nfi\n' },
    { name: "function", desc: "function + args", code: 'greet() {\n  echo "hi $1"\n}\ngreet world\n' },
    { name: "multi-echo", desc: "several outputs (good for diffing)", code: 'echo "one"\necho "two"\necho "three"\n' },
    { name: "while-count", desc: "while loop with arithmetic", code: 'i=0\nwhile [ "$i" -lt 3 ]; do\n  echo "i=$i"\n  i=$((i + 1))\ndone\n' },
    { name: "string-interp", desc: "interpolation inside a word", code: 'user="alice"\nfile="report"\necho "user=$user file=$file"\n' },
    { name: "case-match", desc: "case statement", code: 'x="b"\ncase "$x" in\n  a) echo "first" ;;\n  b) echo "second" ;;\n  *) echo "other" ;;\nesac\n' },
    { name: "concat", desc: "string concatenation", code: 'a="foo"\nb="bar"\necho "$a$b"\n' },
    { name: "string-length", desc: "${#s} parameter expansion", code: 's="hello"\necho "len=${#s}"\n' },
    { name: "sequence", desc: "brace expansion 1..3", code: 'for i in {1..3}; do echo "$i"; done\n' },
    { name: "gnu-isms", desc: "GNU-isms — bash/gnu extensions POSIX sh lacks", code: '# GNU-isms — bash/gnu extensions POSIX sh lacks\n# See Also: /www/otranspiler.html#&example=grep_p\necho "$(( 5 ** 3 ))"\ns="Hello World"\necho "${s,,}"\necho "${s^^}"\necho "${s:6:5}"\necho "${s/World/Bash}"\n(( x = 2 + 3 )); echo $x\nif [[ "a" = "a" ]]; then echo eq; fi\narr=(alpha beta gamma)\necho "${#arr[@]}"\necho "${arr[1]}"\necho $\'tab\there\'\nfor i in {1..3}; do echo "$i"; done\n' },
    { name: "sqrt1337", desc: "for loop + pipe — find squares containing 1337", code: 'for i in `seq 1 10000`\ndo\n\tif echo $((i*i)) | grep 1337 > /dev/null\n\tthen \n\t\techo $i\n\tfi\ndone\n' },
            { name: "nospace", desc: "the 'No spaces' tag — provably spaceless vars skip the word-split", code: `# the 'No spaces' tag: vars provably free of IFS whitespace
# (numeric values, spaceless constants, \`tr -d '[:space:]'\` outputs,
# transitively through assignments) skip the word-split on unquoted
# \`$var\` — look at the GENERATED JS: the tagged vars emit bare
# (\`[n, s, t, ...]\`), the untagged \`w\` (which has spaces) keeps its
# \`String(w).split(/\\s+/).filter(...)\` word-split.
n=42
s="hello"
t="xy"
w="a  b"
echo "$n|$s|$t|$w"
echo $n $s $t $w
` },
    { name: "grep_p", desc: "GNU grep -P — ERE-safe forms lower to grep -E, PCRE-only forms keep the grep_p polyfill", code: `# grep_p — GNU grep -P (PCRE). ERE-safe patterns (no \\b \\d \\w (? …)
# constructs) lower to \`grep -E\` inline; PCRE-only forms keep the
# portable grep_p polyfill: grep -P || ggrep -P || pcre2grep ||
# pcregrep || perl. Look at the generated SH (or js, which uses a JS
# RegExp ≈ PCRE) for each form.
text='fig:cart<apple-rest;tea'

# ERE-safe: plain alternation → the sh target emits \`grep -E\`
printf '%s\\n' "$text" | grep -P 'apple|fig'

# ERE-safe: a plain character class → \`grep -E\`
printf '%s\\n' "$text" | grep -P '[a-z]+'

# PCRE-only: \\b word boundary (ERE has no word-boundary) → grep_p
printf '%s\\n' "$text" | grep -P '\\bapple\\b'

# PCRE-only: negative lookbehind + -o (only-matching) → grep_p
printf '%s\\n' "$text" | grep -oP '(?<![:-])\\b\\w+'
` },
  ],

  zsh: [
    { name: "hello", desc: "Hello world (echo)", code: 'name="world"\necho "hello $name"\n' },
    { name: "loop-count", desc: "for loop 1..3", code: 'for i in 1 2 3; do\n  echo "count $i"\ndone\n' },
    { name: "arith", desc: "$(( )) arithmetic", code: 'x=6\ny=7\necho "6*7=$((x * y))"\n' },
    { name: "array", desc: "indexed array", code: 'arr=(alpha beta gamma)\necho "second=$arr[2]"\necho "all=$arr"\n' },
    { name: "function", desc: "function + $1 arg", code: 'greet() {\n  echo "hi $1"\n}\ngreet world\n' },
    { name: "while-count", desc: "while loop with arithmetic", code: 'i=0\nwhile (( i < 3 )); do\n  echo "i=$i"\n  (( i++ ))\ndone\n' },
    { name: "string-interp", desc: "interpolation inside a word", code: 'user="alice"\nfile="report"\necho "user=$user file=$file"\n' },
    { name: "case-match", desc: "case statement", code: 'x="b"\ncase "$x" in\n  a) echo "first" ;;\n  b) echo "second" ;;\n  *) echo "other" ;;\nesac\n' },
    { name: "concat", desc: "string concatenation", code: 'a="foo"\nb="bar"\necho "$a$b"\n' },
    { name: "string-length", desc: "${#s} parameter expansion", code: 's="hello"\necho "len=${#s}"\n' },
  ],

  fish: [
    { name: "hello", desc: "Hello world (echo)", code: 'set name world\necho "hello $name"\n' },
    { name: "loop-count", desc: "for loop 1..3", code: 'for i in 1 2 3\n  echo "count $i"\nend\n' },
    { name: "arith", desc: "math expression", code: 'set x 6\nset y 7\nmath "$x * $y"\n' },
    { name: "array", desc: "indexed array", code: 'set arr alpha beta gamma\necho "second=$arr[2]"\necho "all=$arr"\n' },
    { name: "function", desc: "function + $argv[1]", code: 'function greet\n  echo "hi $argv[1]"\nend\ngreet world\n' },
    { name: "while-count", desc: "while loop", code: 'set i 0\nwhile test $i -lt 3\n  echo "i=$i"\n  set i (math "$i + 1")\nend\n' },
    { name: "string-interp", desc: "interpolation inside a word", code: 'set user alice\nset file report\necho "user=$user file=$file"\n' },
    { name: "switch-match", desc: "switch statement", code: 'set x b\nswitch $x\n  case a\n    echo first\n  case b\n    echo second\n  case "*"\n    echo other\nend\n' },
    { name: "test-builtin", desc: "if test condition", code: 'if test 5 -gt 3\n  echo "five is big"\nend\n' },
    { name: "concat", desc: "string concatenation", code: 'set a foo\nset b bar\necho "$a$b"\n' },
    { name: "nested-echo", desc: "two-level loop", code: 'for a in 1 2\n  for b in x y\n    echo "$a$b"\n  end\nend\n' },
  ],

  go: [
    { name: "hello", desc: "Hello world", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tname := "world"\n\tfmt.Printf("hello %s\\n", name)\n}\n' },
    { name: "loop-count", desc: "for loop 1..3", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfor i := 1; i <= 3; i++ {\n\t\tfmt.Printf("count %d\\n", i)\n\t}\n}\n' },
    { name: "arith", desc: "integer arithmetic", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tx, y := 6, 7\n\tfmt.Printf("6*7=%d\\n", x*y)\n}\n' },
    { name: "conditional", desc: "if / else", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tn := 5\n\tif n > 3 {\n\t\tfmt.Println("big")\n\t} else {\n\t\tfmt.Println("small")\n\t}\n}\n' },
    { name: "while-count", desc: "for-as-while", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\ti := 0\n\tfor i < 3 {\n\t\tfmt.Printf("i=%d\\n", i)\n\t\ti++\n\t}\n}\n' },
    { name: "strings", desc: "string interpolation via fmt", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tuser := "alice"\n\tfile := "report"\n\tfmt.Printf("user=%s file=%s\\n", user, file)\n}\n' },
    { name: "slice", desc: "slice iteration", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tarr := []string{"alpha", "beta", "gamma"}\n\tfmt.Printf("second=%s\\n", arr[1])\n}\n' },
    { name: "function", desc: "function + arg", code: 'package main\n\nimport "fmt"\n\nfunc greet(name string) {\n\tfmt.Printf("hi %s\\n", name)\n}\n\nfunc main() {\n\tgreet("world")\n}\n' },
    { name: "for-range", desc: "range over a slice", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tarr := []string{"alpha", "beta", "gamma"}\n\tfor _, v := range arr {\n\t\tfmt.Println(v)\n\t}\n}\n' },
    { name: "concat", desc: "string concatenation", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\ta, b := "foo", "bar"\n\tfmt.Println(a + b)\n}\n' },
    { name: "switch-case", desc: "switch statement", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tx := "b"\n\tswitch x {\n\tcase "a":\n\t\tfmt.Println("first")\n\tcase "b":\n\t\tfmt.Println("second")\n\tdefault:\n\t\tfmt.Println("other")\n\t}\n}\n' },
    { name: "multi-echo", desc: "several outputs", code: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("one")\n\tfmt.Println("two")\n\tfmt.Println("three")\n}\n' },
  ],

  py: [
    { name: "hello", desc: "Hello world", code: 'name = "world"\nprint("hello", name)\n' },
    { name: "loop-count", desc: "for loop 1..3", code: "for i in range(1, 4):\n    print(\"count\", i)\n" },
    { name: "arith", desc: "arithmetic", code: "x = 6\ny = 7\nprint(\"6*7=\", x * y)\n" },
    { name: "conditional", desc: "if / else", code: 'n = 5\nif n > 3:\n    print("big")\nelse:\n    print("small")\n' },
    { name: "function", desc: "function + arg", code: 'def greet(name):\n    print("hi", name)\n\ngreet("world")\n' },
    { name: "while-count", desc: "while loop", code: "i = 0\nwhile i < 3:\n    print(\"i=\", i)\n    i += 1\n" },
    { name: "strings", desc: "string concatenation", code: 'user = "alice"\nfile = "report"\nprint("user=" + user + " file=" + file)\n' },
    { name: "list", desc: "list + index", code: 'arr = ["alpha", "beta", "gamma"]\nprint("second=", arr[1])\n' },
    { name: "len-list", desc: "list length", code: 'arr = ["alpha", "beta", "gamma"]\nprint("len=", len(arr))\n' },
    { name: "concat", desc: "string joining", code: 'a = "foo"\nb = "bar"\nprint(a + b)\n' },
    { name: "multi-echo", desc: "several outputs", code: 'print("one")\nprint("two")\nprint("three")\n' },
    { name: "percent-fmt", desc: "% formatting (micropython-safe)", code: 'x = 42\nprint("x=%d" % x)\n' },
  ],

  c: [
    { name: "hello", desc: "Hello world", code: '#include <stdio.h>\n\nint main(void) {\n    const char *name = "world";\n    printf("hello %s\\n", name);\n    return 0;\n}\n' },
    { name: "loop-count", desc: "for loop 1..3", code: '#include <stdio.h>\n\nint main(void) {\n    for (int i = 1; i <= 3; i++)\n        printf("count %d\\n", i);\n    return 0;\n}\n' },
    { name: "arith", desc: "arithmetic", code: '#include <stdio.h>\n\nint main(void) {\n    int x = 6;\n    int y = 7;\n    printf("6*7=%d\\n", x * y);\n    return 0;\n}\n' },
    { name: "conditional", desc: "if / else", code: '#include <stdio.h>\n\nint main(void) {\n    int n = 5;\n    if (n > 3)\n        printf("big\\n");\n    else\n        printf("small\\n");\n    return 0;\n}\n' },
    { name: "while-count", desc: "while loop", code: '#include <stdio.h>\n\nint main(void) {\n    int i = 0;\n    while (i < 3) {\n        printf("i=%d\\n", i);\n        i++;\n    }\n    return 0;\n}\n' },
    { name: "strings", desc: "two variables", code: '#include <stdio.h>\n\nint main(void) {\n    const char *user = "alice";\n    const char *file = "report";\n    printf("user=%s file=%s\\n", user, file);\n    return 0;\n}\n' },
    { name: "array", desc: "array + index", code: '#include <stdio.h>\n\nint main(void) {\n    int arr[3];\n    arr[0] = 10;\n    arr[1] = 20;\n    arr[2] = 30;\n    printf("second=%d\\n", arr[1]);\n    return 0;\n}\n' },
    { name: "function", desc: "function + arg", code: '#include <stdio.h>\n\nvoid greet(const char *name) {\n    printf("hi %s\\n", name);\n}\n\nint main(void) {\n    greet("world");\n    return 0;\n}\n' },
    { name: "array-loop", desc: "iterate an array", code: '#include <stdio.h>\n\nint main(void) {\n    int arr[3];\n    arr[0] = 10;\n    arr[1] = 20;\n    arr[2] = 30;\n    for (int i = 0; i < 3; i++)\n        printf("%d\\n", arr[i]);\n    return 0;\n}\n' },
    { name: "switch-case", desc: "switch statement", code: '#include <stdio.h>\n\nint main(void) {\n    int x = 2;\n    switch (x) {\n        case 1: printf("first\\n"); break;\n        case 2: printf("second\\n"); break;\n        default:  printf("other\\n");\n    }\n    return 0;\n}\n' },
    { name: "concat", desc: "string concatenation", code: '#include <stdio.h>\n#include <string.h>\n\nint main(void) {\n    char out[16];\n    strcpy(out, "foo");\n    strcat(out, "bar");\n    printf("%s\\n", out);\n    return 0;\n}\n' },
    { name: "multi-echo", desc: "several outputs", code: '#include <stdio.h>\n\nint main(void) {\n    printf("one\\n");\n    printf("two\\n");\n    printf("three\\n");\n    return 0;\n}\n' },
    { name: "pointers", desc: "pointer idioms — deref, arrays, malloc, **, swap, struct", code: `#include <stdio.h>
#include <stdlib.h>

struct Point { int x; int y; };

int main(void) {
    /* 1 — basic deref: p = &x, *p read + write */
    int x = 5;
    int *p = &x;
    printf("deref=%d\\n", *p);
    *p = 7;
    printf("after=%d\\n", x);

    /* 2 — a pointer walks an array: q = a, q[i] + *(q+k) */
    int a[4];
    a[0] = 10; a[1] = 20; a[2] = 30; a[3] = 40;
    int *q = a;
    printf("walk=");
    for (int i = 0; i < 4; i++)
        printf("%d ", q[i]);
    printf("\\n");
    printf("off2=%d\\n", *(q + 2));

    /* 3 — pointer with a base offset: r = &a[1] */
    int *r = &a[1];
    printf("base=%d,%d\\n", r[0], r[2]);

    /* 4 — sum through the pointer (the read lowers to a temp) */
    int sum = 0;
    for (int i = 0; i < 4; i++) {
        int v = q[i];
        sum = sum + v;
    }
    printf("sum=%d\\n", sum);

    /* 5 — heap pointer: malloc + index + deref write + free */
    int *h = malloc(4 * sizeof(int));
    h[0] = 1; h[1] = 2; h[2] = 3; h[3] = 4;
    printf("heap=%d,%d\\n", h[0], h[3]);
    *h = 99;
    printf("heap-after=%d\\n", h[0]);
    free(h);

    /* 6 — double pointer: pp = &p, **pp through the alias chain */
    int **pp = &p;
    printf("pp=%d\\n", **pp);

    /* 7 — swap through two pointers */
    int s1 = 1;
    int s2 = 2;
    int *pa = &s1;
    int *pb = &s2;
    int tmp = *pa;
    *pa = *pb;
    *pb = tmp;
    printf("swap=%d,%d\\n", s1, s2);

    /* 8 — struct value + member access */
    struct Point pt;
    pt.x = 3;
    pt.y = 4;
    printf("point=%d,%d\\n", pt.x, pt.y);

    return 0;
}
` },
  ],

  pl: [
    { name: "hello", desc: "Hello world", code: 'my $name = "world";\nprint "hello $name\\n";\n' },
    { name: "loop-count", desc: "for loop 1..3", code: "for my $i (1..3) {\n    print \"count $i\\n\";\n}\n" },
    { name: "arith", desc: "arithmetic", code: 'my $x = 6;\nmy $y = 7;\nprint "6*7=", $x * $y, "\\n";\n' },
    { name: "conditional", desc: "if / else", code: 'my $n = 5;\nif ($n > 3) {\n    print "big\\n";\n} else {\n    print "small\\n";\n}\n' },
    { name: "function", desc: "subroutine + arg", code: 'sub greet {\n    my ($name) = @_;\n    print "hi $name\\n";\n}\ngreet("world");\n' },
    { name: "while-count", desc: "while loop", code: 'my $i = 0;\nwhile ($i < 3) {\n    print "i=$i\\n";\n    $i++;\n}\n' },
    { name: "strings", desc: "two variables", code: 'my $user = "alice";\nmy $file = "report";\nprint "user=$user file=$file\\n";\n' },
    { name: "array", desc: "array + index", code: 'my @arr = ("alpha", "beta", "gamma");\nprint "second=$arr[1]\\n";\n' },
    { name: "join", desc: "join a list", code: 'my @a = ("alpha", "beta", "gamma");\nprint join(",", @a), "\\n";\n' },
    { name: "concat", desc: "string concatenation", code: 'my $a = "foo";\nmy $b = "bar";\nprint "$a$b\\n";\n' },
    { name: "switch-case", desc: "if / elsif chain", code: 'my $x = "b";\nif ($x eq "a") {\n    print "first\\n";\n} elsif ($x eq "b") {\n    print "second\\n";\n} else {\n    print "other\\n";\n}\n' },
    { name: "multi-echo", desc: "several outputs", code: 'print "one\\n";\nprint "two\\n";\nprint "three\\n";\n' },
  ],

  bat: [
    // Windows batch (cmd.exe) — the bat-sh-go frontend's v1.1 subset:
    // @echo off / rem / echo, set + set /a, %var% expansion, if/else
    // blocks, for %%v + for /l + for /f, goto/label, call :label,
    // exit /b, > redirects, ^ continuation, builtin→posix mapping.
    // NO browser cmd.exe exists, so the original stdout can't run —
    // the GUI shows the transpiled code + the target's stdout only.
    { name: "hello", desc: "echo + set", code: '@echo off\r\nset name=world\r\necho hello %name%\r\n' },
    { name: "arith", desc: "set /a integer arithmetic", code: '@echo off\r\nset /a x=2+3*4\r\necho x=%x%\r\n' },
    { name: "conditional", desc: "if / else (parenthesized)", code: '@echo off\r\nif "1"=="1" (echo eq) else (echo ne)\r\n' },
    { name: "for-loop", desc: "for %%v over a word list", code: '@echo off\r\nfor %%v in (alpha beta gamma) do echo item %%v\r\n' },
    { name: "for-l", desc: "for /l numeric range", code: '@echo off\r\nfor /l %%i in (1 1 3) do echo num %%i\r\n' },
    { name: "goto", desc: "goto + label (jump)", code: '@echo off\r\necho before\r\ngoto skip\r\necho never\r\n:skip\r\necho after\r\n' },
    { name: "call", desc: "call :label subroutine", code: '@echo off\r\necho start\r\ncall :greet World\r\necho done\r\ngoto :eof\r\n:greet\r\necho hello %1\r\ngoto :eof\r\n' },
    { name: "args", desc: "%1 %2 %* arguments", code: '@echo off\r\necho arg1=%1 arg2=%2 all=%*\r\n' },
    { name: "if-defined", desc: "if defined / exist", code: '@echo off\r\nset myvar=hello\r\nif defined myvar (echo defined) else (echo not-defined)\r\nif exist . (echo here) else (echo missing)\r\n' },
    { name: "redirect", desc: "> file, type, del (mapped to posix)", code: '@echo off\r\necho one > a.txt\r\ntype a.txt\r\ndel /q a.txt\r\n' },
    { name: "for-f", desc: "for /f line + field tokens", code: '@echo off\r\necho alpha beta > f.txt\r\nfor /f %%w in (f.txt) do echo word %%w\r\n' },
    { name: "exit", desc: "exit /b early", code: '@echo off\r\necho before\r\nexit /b 0\r\necho never\r\n' },
    { name: "echo-blank", desc: "echo. / echo: blank lines", code: '@echo off\r\necho hello world\r\necho.\r\necho:\r\n' },
    { name: "continuation", desc: "^ line continuation", code: '@echo off\r\necho one^\r\ntwo\r\n' },
    { name: "block", desc: "multi-line parenthesized block", code: '@echo off\r\nif "1"=="1" (\r\n    echo in-block\r\n    echo second-line\r\n)\r\necho after\r\n' },
  ],
};

// Language metadata for the sidebar pills.
export const LANGS = {
  sh:   { label: "sh",   full: "POSIX shell",  runtime: "bash.wasm" },
  zsh:  { label: "zsh",  full: "Z shell",      runtime: "zsh.wasm" },
  fish: { label: "fish", full: "Friendly shell", runtime: "fish.wasm" },
  go:   { label: "go",   full: "Go",           runtime: "go.wasm (toolchain)" },
  py:   { label: "py",   full: "Python",       runtime: "micropython.wasm" },
  c:    { label: "c",    full: "C",            runtime: "tcc.wasm" },
  pl:   { label: "pl",   full: "Perl",         runtime: "zeroperl.wasm (Perl 5.42)" },
  bat:  { label: "bat",  full: "Windows batch", runtime: "none (no cmd.exe in browser)" },
};

export function getExamples(lang) {
  return EXAMPLES[lang] || [];
}
