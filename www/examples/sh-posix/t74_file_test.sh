# t74_file_test: [ -e ] and [ -s ] file tests
# diagnostics: program prints its result to stdout
[ -e /nonexistent_xyz ] && echo exists || echo missing
[ -s /etc/hostname ] && echo nonempty
