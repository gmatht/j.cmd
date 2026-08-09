# t50_file_test: test a file exists
# diagnostics: program prints its result to stdout
if (-e "/etc/passwd") {
    print "exists\n";
}
