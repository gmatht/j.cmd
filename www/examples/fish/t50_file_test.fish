# t50_file_test: test a file exists
# diagnostics: program prints its result to stdout
if test -f /etc/passwd
    echo exists
end
