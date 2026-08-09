# t48_accum: accumulate a sum in a loop
# diagnostics: program prints its result to stdout
my $s = 0;
foreach my $n (1, 2, 3) {
    $s += $n;
}
print "$s\n";
