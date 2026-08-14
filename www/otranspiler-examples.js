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
    { name: "vertex-shader", desc: "bash-authored VERTEX shader (pick the glslv target) — MIMEcroft's camera transform", code: '# the MIMEcroft VERTEX shader, authored in bash — pick the glslv target to\n# compile it to GLSL ES 1.00 (the sh2glsl --vertex pipeline: ap_*/ash_*/auv_*/\n# ucp_*/ucy_*/ucs/uop_*/usc_*/ublk_*/uov bridges in, vp_*/vc_*/vu_* out).\n# Object → world (floats via the bc captures — note every capture carries a\n# decimal-point literal, the float-path gate).\nwx=$(echo "scale=4; $ap_x * $usc_x / 1000000.0 + $uop_x / 1000.0" | bc)\nwy=$(echo "scale=4; $ap_y * $usc_y / 1000000.0 + $uop_y / 1000.0" | bc)\nwz=$(echo "scale=4; $ap_z * $usc_z / 1000000.0 + $uop_z / 1000.0" | bc)\n# face brightness × block colour (int, ×1000)\nvc_r=$((ash_r * ublk_r / 1000))\nvc_g=$((ash_g * ublk_g / 1000))\nvc_b=$((ash_b * ublk_b / 1000))\nvc_a=1000\nif [ "$uov" -gt 500 ]; then\n  # overlay: flat NDC\n  vp_x=$wx\n  vp_y=$wy\n  vp_z=$(echo "scale=4; $uov * 0.0 - 0.95" | bc)\n  vp_w=$(echo "scale=4; $uov * 0.0 + 1.0" | bc)\n  vu_u=0\n  vu_v=0\nelse\n  # camera-relative + yaw rotation (bc trig → GLSL cos/sin)\n  cx=$(echo "scale=4; $ucp_x / 1000.0 + 0.0" | bc)\n  cz=$(echo "scale=4; $ucp_z / 1000.0 + 0.0" | bc)\n  dx=$(echo "scale=4; $wx - $cx + 0.0" | bc)\n  dz=$(echo "scale=4; $wz - $cz + 0.0" | bc)\n  rad=$(echo "scale=8; $ucy_m * 3.14159265 / 180000.0" | bc)\n  c=$(echo "scale=6; c($rad) + 0.0" | bc)\n  s=$(echo "scale=6; s($rad) + 0.0" | bc)\n  relx=$(echo "scale=4; $dx * $c + $dz * $s + 0.0" | bc)\n  relz=$(echo "scale=4; 0 - $dx * $s + $dz * $c + 0.0" | bc)\n  w=$(echo "scale=4; 0 - $relz + 0.0" | bc)\n  vp_x=$(echo "scale=4; $relx * 0.9" | bc)\n  vp_y=$(echo "scale=4; $dy * 0.9" | bc)\n  vp_z=$(echo "scale=4; $w * $w / 64.0" | bc)\n  vp_w=$w\n  vu_u=$auv_u\n  vu_v=$auv_v\nfi\n' },
  { name: "fragment-shader", desc: "bash-authored fragment shader (pick the glsl target)", code: '# a minimal fragment shader — pick the glsl target to compile it to GLSL ES 1.00\n# (the sh2glsl pipeline: frag_x/frag_y/vcolor_rgb bridges + putb output)\nfx=$((frag_x))\nfy=$((frag_y))\nr=$((vcolor_r))\nif [ $((fx % 8)) -eq 0 ]; then\n  putb 255\nelse\n  putb $r\nfi\nputb 0\nputb $((fy % 4 * 60))\nputb 255\n' },
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
    { name: "alphanumeric-compare", desc: "a bash comparator (-1/0/1 echo protocol) — drives the qsort builtin and C function-pointer comparators: source it, then qsort a alphanumeric_compare / source my_qsort.c",
      code: `# alphanumeric_compare.sh — a bash COMPARATOR for sorting words.
#
# THE PROTOCOL (C qsort convention): the function is called with two
# words as $1 and $2, and must ECHO a signed number to stdout:
#   -1  $1 sorts before $2
#    0  equal
#    1  $1 sorts after $2
# Nothing else — the caller captures the echo, it must not reach the
# terminal (that is why the verdicts go to stdout via echo, and the
# caller runs the function under command substitution / capture).
#
# WHO USES IT:
#   * the \`qsort\` builtin:
#       a=(pear apple fig banana)
#       qsort a alphanumeric_compare; echo "\${a[@]}"   → apple banana fig pear
#   * C code sourced through the c-sh-go frontend — my_qsort.c calls
#     the comparator by name via its cmp_call bridge:
#       source /examples/sh-posix/alphanumeric_compare.sh
#       source /examples/c/my_qsort.c                  → apple banana fig pear
#
# [[ $1 < $2 ]] is the LEXICOGRAPHIC (alphabetical) comparison — the
# same ordering C's strcmp uses for ASCII text. Swap the two verdicts
# (or flip the operators) to sort descending instead:
#   reverse_compare() { if [[ "$1" > "$2" ]]; then echo -1;
#                       elif [[ "$1" < "$2" ]]; then echo 1;
#                       else echo 0; fi }
alphanumeric_compare() { if [[ "$1" < "$2" ]]; then echo -1;
                         elif [[ "$1" > "$2" ]]; then echo 1;
                         else echo 0; fi }` },  ],

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
    { name: "my_qsort", desc: "C bubble sort whose comparator is a BASH function — a real function-pointer parameter ((*cmp)(a, b); the pointer VALUE is the comparator's NAME). The isolated run shows the unsorted array (no bash comparator here); in j.cmd: source /examples/sh-posix/alphanumeric_compare.sh first.",
      code: `// my_qsort.c — a C sort whose comparator is a BASH function.
//
// The signature mirrors libc qsort:
//     void qsort(void *base, size_t nitems, size_t size,
//                int (*compar)(const void *, const void *))
// mapped onto the c-sh-go transpiler's world, where the runtime store is
// UNTYPED (every value is a string) and a POINTER is a NAME:
//   * void *base     — the array's variable name (arrays decay to their
//                      name at the call site: \`my_qsort(a, 4, cmp)\`).
//                      \`void\` is the ANY verdict — base[j] just reads
//                      the word at index j and hands it to the
//                      comparator, no cast, no deref (the "cast" is
//                      implicit: there are no types at runtime).
//   * size_t nitems  — \`int nitems\` here (size_t needs typedefs).
//   * size_t size    — dropped: store elements are single untyped words.
//   * compar         — a real C function-pointer parameter; the call
//                      \`(*cmp)(a, b)\` is the comparator bridge — it
//                      dispatches to whatever bash function the caller
//                      passed (the pointer VALUE is the function's NAME,
//                      a string) and captures its echoed -1/0/1 verdict,
//                      the C qsort comparator protocol.
//
// HOW TO RUN (in j.cmd — the transpiled path, NOT \`cc\`):
//   source /examples/sh-posix/alphanumeric_compare.sh   # the comparator
//   source /examples/c/my_qsort.c                       # defines + runs
//   → apple banana fig pear
//
//   # swap any protocol-compatible bash comparator — descending:
//   reverse_compare() { if [[ "$1" > "$2" ]]; then echo -1;
//                       elif [[ "$1" < "$2" ]]; then echo 1;
//                       else echo 0; fi }
//   a=(pear apple fig banana); my_qsort a 4 reverse_compare; echo "\${a[@]}"
//
// NOTE: the function-pointer call is a TRANSPILER bridge — this file does not compile
// with \`cc\` (cproc); it runs through \`source\`, which parses C with the
// c-sh-go frontend and executes the generated JS in the shell runtime.
#include <stdio.h>

int my_qsort(void *base, int nitems, int (*cmp)(const void *, const void *)) {
  int i;
  int j;
  i = 0;
  while (i < nitems - 1) {
    j = 0;
    while (j < nitems - 1 - i) {
      if ((*cmp)(base[j], base[j + 1]) > 0) {
        char *t = base[j];
        base[j] = base[j + 1];
        base[j + 1] = t;
      }
      j = j + 1;
    }
    i = i + 1;
  }
  return 0;
}

int main() {
  char *a[4] = {"pear", "apple", "fig", "banana"};
  my_qsort(a, 4, "alphanumeric_compare");
  int k;
  for (k = 0; k < 4; k++) {
    printf("%s ", a[k]);
  }
  printf("\\n");
  printf("\\n");
  printf("usage: this sort ran with the bash comparator alphanumeric_compare — swap it freely:\\n");
  printf("  reverse_compare() { if [[ \\"$1\\" > \\"$2\\" ]]; then echo -1; elif [[ \\"$1\\" < \\"$2\\" ]]; then echo 1; else echo 0; fi }\\n");
  printf("  a=(pear apple fig banana); my_qsort a 4 reverse_compare; echo \\"\${a[@]}\\"\\n");
  return 0;
}` },
    { name: "linked-list", desc: "getline(&b,&n,stdin) → malloc'd linked list (struct Node, p->next) → slurp2 returns the list HANDLE to bash, sink2 takes the pointer back. Sourcing prints usage; in j.cmd: linkedlist=$(printf 'three\ntwo\none\n' | slurp2); sink2 $linkedlist",
      code: `// linked_list.c — a C linked-list generator + sink, driven by bash.
//
// THE C SIDE
//   struct Node { char *word; struct Node *next; } — a real heap-linked
//   list. \`p->member\` reads/writes the runtime mem arena at the member's
//   byte offset (malloc(sizeof(struct Node)) → 16 bytes: word at 0,
//   next at 8). NULL is the empty string; \`while (list != 0)\` is the
//   pointer-non-null test.
//
//   gen_line(word) — the GENERATOR: prepends one node (LIFO — the list
//   ends up in reverse input order).
//   sink()          — the SINK: drains the list head-to-tail, printing
//   each word. Prepend + head-to-tail = REVERSED input.
//   slurp()         — reads stdin LINES with the STANDARD getline(&b,
//   &bufsize, stdin) (lowered to the runtime getLine bridge: fills b,
//   returns the count, -1 at EOF) and feeds gen_line.
//   main()          — slurp + sink: reads stdin, reverses it, prints.
//
// THE BASH SIDE (the demo): bash combines the two over a pipe — the
// generator slurps stdin, the sink emits the reversed lines:
//
//   printf 'three\\ntwo\\none\\n' | source /examples/c/linked_list.c
//   → one
//     two
//     three
//
//   # or build the list a word at a time and sink it later:
//   source /examples/c/linked_list.c
//   for w in alpha beta gamma; do gen_line "$w"; done
//   sink            → gamma beta alpha
//
//   # the IDIOMATIC form: capture slurp2's output (the head's mem handle
//   # — an opaque string; the pointer IS a name) into a bash variable and
//   # pass the pointer back in:
//   linkedlist=$(printf 'three\\ntwo\\none\\n' | slurp2)   # slurp2 reads the pipe, prints the handle
//   sink2 $linkedlist      → one two three
//   # (slurp2 also leaves the handle in the $last global, so a direct
//   # \`printf … | slurp2\` followed by \`sink2 "$last"\` works too)
//
// NOTE: this exercises the c-sh-go TRANSPILER (struct pointers, the
// \`->\` member lowering, getline) — it does not compile with \`cc\`.
#include <stdio.h>

struct Node { char *word; struct Node *next; };

struct Node *list = 0;
struct Node *last = 0;   // slurp2 also leaves the fresh head here — bash can read $last

int gen_line(char *word) {
  struct Node *n = malloc(sizeof(struct Node));
  n->word = word;
  n->next = list;
  list = n;
  return 0;
}

int sink() {
  while (list != 0) {
    printf("%s\\n", list->word);
    list = list->next;
  }
  return 0;
}

int slurp() {
  char *b;
  unsigned long bufsize = 0;
  int characters;
  characters = getline(&b, &bufsize, stdin);
  while (characters != -1) {
    gen_line(b);
    characters = getline(&b, &bufsize, stdin);
  }
  return 0;
}

// slurp2 — like slurp, but builds the list in a LOCAL head and RETURNS
// the list to bash: \`printf "%s" head\` prints the head node's mem handle
// (an opaque string — bash holds it in a variable; a pointer IS a name).
//   p=$(slurp2)      # slurp2 reads stdin, prints the head handle
//   sink2 "$p"       # the same list, drained from the pointer
int slurp2() {
  struct Node *head = 0;
  char *b;
  unsigned long bufsize = 0;
  int characters;
  characters = getline(&b, &bufsize, stdin);
  while (characters != -1) {
    struct Node *n = malloc(sizeof(struct Node));
    n->word = b;
    n->next = head;
    head = n;
    characters = getline(&b, &bufsize, stdin);
  }
  last = head;
  printf("%s", head);
  return 0;
}

// sink2 — drains a list passed in BY POINTER (the handle bash holds):
//   sink2 "$p"
int sink2(struct Node *head) {
  struct Node *p = head;
  while (p != 0) {
    printf("%s\\n", p->word);
    p = p->next;
  }
  return 0;
}

int main() {
  char *b;
  unsigned long bufsize = 0;
  int characters;
  characters = getline(&b, &bufsize, stdin);
  if (characters < 0) {
    printf("linked_list.c — a C linked-list generator + sink (sourced into this shell)\\n");
    printf("\\n");
    printf("  pipe stdin through it — reverses the lines:\\n");
    printf("    printf 'three\\ntwo\\none\\n' | source /examples/c/linked_list.c\\n");
    printf("\\n");
    printf("  hold the list in a bash VARIABLE (the head's mem handle) and pass the pointer back:\\n");
    printf("    linkedlist=$(printf 'four\\nthree\\ntwo\\none\\n' | slurp2); sink2 $linkedlist\\n");
    printf("\\n");
    printf("  or build it a word at a time and sink later:\\n");
    printf("    for w in alpha beta gamma; do gen_line \\"$w\\"; done; sink\\n");
  } else {
    gen_line(b);
    characters = getline(&b, &bufsize, stdin);
    while (characters >= 0) {
      gen_line(b);
      characters = getline(&b, &bufsize, stdin);
    }
    sink();
  }
  return 0;
}` },  ],

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

  cpp: [
    // C++ (the cpp-sh-go frontend's tree-sitter-cpp subset — the
    // c-sh-go clib lowering underneath). The browser has no C++
    // frontend wasm yet, so the GUI shows the transpiled target only.
    { name: "hello", desc: "Hello world (printf)", code: '#include <cstdio>\nint main() {\n    printf("hello from c++\n");\n    return 0;\n}\n' },
    { name: "bool", desc: "bool comparisons", code: '#include <cstdio>\nint main() {\n    bool ok = true;\n    bool no = false;\n    if (ok == 1) printf("yes\n");\n    if (no == 0) printf("not no\n");\n    if (!(no == 1)) printf("bang\n");\n    printf("%d %d\n", ok, no);\n    return 0;\n}\n' },
    { name: "arith-loop", desc: "for + while loop", code: '#include <cstdio>\nint main() {\n    int sum = 0;\n    for (int i = 1; i <= 4; i++) {\n        sum += i;\n    }\n    printf("sum=%d\n", sum);\n    int n = 0;\n    while (n < 3) {\n        n++;\n    }\n    printf("n=%d\n", n);\n    return 0;\n}\n' },
    { name: "break", desc: "break out of a while", code: '#include <cstdio>\nint main() {\n    int i = 0;\n    while (1) {\n        i++;\n        if (i == 3) break;\n        printf("%d\n", i);\n    }\n    printf("done i=%d\n", i);\n    return 0;\n}\n' },
    { name: "switch", desc: "switch/case dispatch", code: '#include <cstdio>\nint main() {\n    int x = 2;\n    switch (x) {\n        case 1: printf("one\n"); break;\n        case 2: printf("two\n"); break;\n        default: printf("other\n"); break;\n    }\n    return 0;\n}\n' },
    { name: "cond", desc: "ternary ?: expression", code: '#include <cstdio>\nint main() {\n    int a = 3;\n    int b = 5;\n    int m = (a > b) ? a : b;\n    printf("max=%d\n", m);\n    int x = -2;\n    int s = (x > 0) ? 1 : (x < 0) ? -1 : 0;\n    printf("sign=%d\n", s);\n    return 0;\n}\n' },
  ],

  powershell: [
    // PowerShell (.ps1 — the powershell-sh-go frontend's v1 subset:
    // Write-Output/echo, ${} braced vars, [type] casts in argument
    // position, &/. invocation of literal names, adjacent-argument
    // concatenation). No browser pwsh, and no browser frontend wasm
    // yet — the GUI shows the transpiled target only.
    { name: "echo", desc: "Write-Output hello", code: '# a comment\nWrite-Output "hello powershell"\n' },
    { name: "braced-var", desc: "${name} variable read", code: 'Write-Output "a ${foo} b"\n' },
    { name: "cast", desc: "[type] cast in argument position", code: 'Write-Output [string]"cast value"\n' },
    { name: "invocation", desc: "& / . invocation operators", code: '& echo hello\n. echo "world"\n' },
    { name: "concat", desc: "concatenated command argument", code: 'Write-Output pre"mid"post\nWrite-Output $foo"b"\nWrite-Output 2"a"\n' },
  ],

  rust: [
    // Rust (the rust-frontend's syn-based subset: fn main, let, println!,
    // arithmetic, if/else, while, for range). No browser Rust frontend
    // wasm yet — the GUI shows the transpiled target only.
    { name: "hello", desc: "Hello world", code: 'fn main() {\n    println!("hello rust");\n}\n' },
    { name: "let", desc: "let binding + print", code: 'fn main() {\n    let x = 42;\n    println!("x={}", x);\n}\n' },
    { name: "arith", desc: "arithmetic expressions", code: 'fn main() {\n    let x = 2;\n    println!("{}", x + 3);\n    println!("{}", x * 4);\n    println!("{}", 10 / 3);\n    println!("{}", 10 % 3);\n    println!("{}", 7 - 2);\n}\n' },
    { name: "if-else", desc: "if / else", code: 'fn main() {\n    let x = 2;\n    if x > 1 {\n        println!("big");\n    } else {\n        println!("small");\n    }\n}\n' },
    { name: "while", desc: "while loop", code: 'fn main() {\n    let mut i = 0;\n    while i < 3 {\n        println!("i={}", i);\n        i += 1;\n    }\n}\n' },
    { name: "for-range", desc: "for over a range", code: 'fn main() {\n    for i in 0..3 {\n        println!("n={}", i);\n    }\n}\n' },
  ],

  zig: [
    // Zig (the zig-sh-go frontend's clib-lowered subset: std.debug.print,
    // ints, if/else, while, for ranges, fn, pointers, switch, comptime
    // consts, @intCast/@as). No browser Zig frontend wasm yet — the GUI
    // shows the transpiled target only.
    { name: "print", desc: "std.debug.print hello", code: 'const std = @import("std");\n\npub fn main() void {\n    std.debug.print("hello zig\n", .{});\n}\n' },
    { name: "arith", desc: "binary arithmetic", code: 'const std = @import("std");\n\npub fn main() void {\n    std.debug.print("{d}\n", .{1 + 2});\n    std.debug.print("{d}\n", .{3 * 4});\n    std.debug.print("{d}\n", .{(8 - 3) * 2});\n}\n' },
    { name: "if-else", desc: "if / else-if / else", code: 'const std = @import("std");\n\npub fn main() void {\n    const s = 85;\n    if (s >= 90) {\n        std.debug.print("A\n", .{});\n    } else if (s >= 80) {\n        std.debug.print("B\n", .{});\n    } else if (s >= 70) {\n        std.debug.print("C\n", .{});\n    } else {\n        std.debug.print("F\n", .{});\n    }\n}\n' },
    { name: "while", desc: "while with : (update)", code: 'const std = @import("std");\n\npub fn main() void {\n    var i: i32 = 0;\n    while (i < 3) : (i += 1) {\n        std.debug.print("w{d}\n", .{i});\n    }\n}\n' },
    { name: "for-range", desc: "for (START..END) |i|", code: 'const std = @import("std");\n\npub fn main() void {\n    for (0..4) |i| {\n        std.debug.print("{d}\n", .{i});\n    }\n}\n' },
    { name: "fn", desc: "user functions + nested calls", code: 'const std = @import("std");\n\nfn triple(n: i32) i32 {\n    return n * 3;\n}\n\npub fn main() void {\n    std.debug.print("{d}\n", .{triple(5)});\n}\n' },
    { name: "switch", desc: "switch prongs + else", code: 'const std = @import("std");\n\npub fn main() void {\n    const x = 2;\n    switch (x) {\n        1 => std.debug.print("one\n", .{}),\n        2 => std.debug.print("two\n", .{}),\n        else => std.debug.print("other\n", .{}),\n    }\n}\n' },
  ],
};

// Language metadata for the sidebar pills.
export const LANGS = {
  sh:   { label: "sh",   full: "POSIX shell",  runtime: "bash.wasm", ext: "sh" },
  zsh:  { label: "zsh",  full: "Z shell",      runtime: "zsh.wasm", ext: "zsh" },
  fish: { label: "fish", full: "Friendly shell", runtime: "fish.wasm", ext: "fish" },
  go:   { label: "go",   full: "Go",           runtime: "go.wasm (toolchain)", ext: "go" },
  py:   { label: "py",   full: "Python",       runtime: "micropython.wasm", ext: "py" },
  c:    { label: "c",    full: "C",            runtime: "tcc.wasm", ext: "c" },
  pl:   { label: "pl",   full: "Perl",         runtime: "zeroperl.wasm (Perl 5.42)", ext: "pl" },
  bat:  { label: "bat",  full: "Windows batch", runtime: "none (no cmd.exe in browser)", ext: "bat" },
  cpp:  { label: "cpp",  full: "C++",           runtime: "none (no browser C++ frontend wasm yet)", ext: "cc" },
  powershell: { label: "ps1", full: "PowerShell", runtime: "none (no browser pwsh/frontend wasm yet)", ext: "ps1" },
  rust: { label: "rs",   full: "Rust",          runtime: "none (no browser Rust frontend wasm yet)", ext: "rs" },
  zig:  { label: "zig",  full: "Zig",           runtime: "none (no browser Zig frontend wasm yet)", ext: "zig" },
};

export function getExamples(lang) {
  return EXAMPLES[lang] || [];
}
