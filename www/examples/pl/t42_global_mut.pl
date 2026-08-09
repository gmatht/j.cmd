# t42_global_mut: function mutates a global
# diagnostics: program prints its result to stdout
our $g = 0;
sub f {
    $g = 1;
}
f();
print "$g\n";
