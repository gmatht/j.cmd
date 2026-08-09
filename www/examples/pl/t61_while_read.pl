# t61_while_read: read-loop over stdin
# diagnostics: program prints its result to stdout
while (<STDIN>) {
    chomp;
    print "line=$_\n";
}
