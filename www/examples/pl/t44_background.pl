# t44_background: background job and wait
# diagnostics: program prints its result to stdout
my $pid = fork();
if (!$pid) {
    print "child\n";
    exit;
}
wait();
print "main\n";
