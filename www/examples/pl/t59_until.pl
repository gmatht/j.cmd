# t59_until: until loop (negated condition)
# diagnostics: program prints its result to stdout
my $i = 0;
until ($i >= 3) {
    print "u$i\n";
    $i++;
}
