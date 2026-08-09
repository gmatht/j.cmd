# t41_local_var: local variable inside a function
# diagnostics: program prints its result to stdout
sub f {
    my $y = 5;
    print "$y\n";
}
f();
