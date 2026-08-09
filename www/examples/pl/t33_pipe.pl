# t33_pipe: pipe between commands
# diagnostics: program prints its result to stdout
open(my $ph, "-|", "echo", "hello") or die;
my $out = <$ph>;
close $ph;
print $out;
