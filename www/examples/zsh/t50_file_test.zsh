# t50_file_test: test a file exists
# diagnostics: program prints its result to stdout
if [[ -f /etc/passwd ]]; then
    echo exists
fi
