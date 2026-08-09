# t64_prefix_suffix: prefix & suffix removal
# diagnostics: program prints its result to stdout
my $x = "hello";
(my $a = $x) =~ s/^he//; print "$a\n";
(my $b = $x) =~ s/lo$//; print "$b\n";
(my $c = $x) =~ s/^.*l//; print "$c\n";
(my $d = $x) =~ s/l.*$//; print "$d\n";
