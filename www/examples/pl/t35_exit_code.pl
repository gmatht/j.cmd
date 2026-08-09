# t35_exit_code: capture the exit code
# diagnostics: program prints its result to stdout
system("false");
print (($? >> 8) . "\n");
