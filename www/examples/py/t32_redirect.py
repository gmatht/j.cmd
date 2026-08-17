# t32_redirect: redirect output to a file
# diagnostics: program prints its result to stdout
# Relative target: the gate runs native + transpiled sides in per-run
# scratch dirs (frontend-stdout.sh, the go-sh precedent), so a fixed
# absolute path like /tmp/f would collide across users (a stale
# root-owned /tmp/f makes native python's open() throw EACCES before
# its print — flaky DIFF). The literal-path-only py parser can't build
# a unique path, so both sides share the scratch CWD instead.
with open("f", "w") as fh:
    fh.write("data\n")
print("wrote")
