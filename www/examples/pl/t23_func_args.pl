# t23_func_args: function with arguments
# diagnostics: program prints its result to stdout
sub f {
    my ($x) = @_;
    print "$x\n";
}
f("hello");
