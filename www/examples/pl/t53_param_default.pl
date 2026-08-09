# t53_param_default: environment default value
# diagnostics: program prints its result to stdout
my $x = $ENV{x} // "def";
print "a=$x\n";
$x = "set";
print "b=$x\n";
