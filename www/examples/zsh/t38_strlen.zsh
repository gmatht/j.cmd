# t38_strlen: string length
# diagnostics: program prints its result to stdout
# NOTE: unquoted `${#s}` lowers to getVar("#s") (byte-equal to the core),
# but the ESTree emitter reads that via the sh2 store while const vars are
# lifted to native JS bindings — stale "" (a core emitter gap, bash hits it
# too: `x=42; echo ${#x}` → "0"). The quoted spelling lowers to
# param("len") which carries the lifted binding end-to-end. See
# core-requests/zsh-sh-go-<ts>.md and FRONTEND.md.
s=hello
echo "${#s}"
