# t32_redirect: redirect output to a file
# diagnostics: program prints its result to stdout
# The file lives in the run's CWD (the frontend dir for both the native
# and the transpiled runner), NOT /tmp: a fixed /tmp path collides across
# users/runs (a root-owned leftover from another gate run blocks llm's
# redirect with EACCES). rm -f first clears any stale leftover (the run
# dir is writable by the gate runner even for foreign-owned files), and
# the final rm keeps the gate's worktree clean.
rm -f fish_sh_go_t32_out.txt
echo data > fish_sh_go_t32_out.txt
cat fish_sh_go_t32_out.txt
rm -f fish_sh_go_t32_out.txt
