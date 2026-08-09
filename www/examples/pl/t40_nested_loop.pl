# t40_nested_loop: nested loops
# diagnostics: program prints its result to stdout
for my $i (1, 2) {
    for my $j (1, 2) {
        print "$i$j\n";
    }
}
