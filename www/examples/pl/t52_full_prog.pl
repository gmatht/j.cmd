# t52_full_prog: full program combining constructs
# diagnostics: program prints its result to stdout
sub greet {
    my ($name) = @_;
    return "hello $name";
}
foreach my $n ("a", "b") {
    print greet($n), "\n";
}
