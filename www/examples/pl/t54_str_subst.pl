# t54_str_subst: string substitution
# diagnostics: program prints its result to stdout
my $s = "parrot";
(my $t = $s) =~ s/p/r/g;
print "$t\n";
(my $u = $s) =~ s/rr/ll/g;
print "$u\n";
