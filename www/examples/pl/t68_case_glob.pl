# t68_case_glob: pattern dispatch via if/elsif
# diagnostics: program prints its result to stdout
my $s = "hello";
if ($s =~ /^h/) {
    print "star\n";
} elsif ($s =~ /l/ || $s =~ /x/) {
    print "alt\n";
}
$s = "axl";
if ($s =~ /^h/) {
    print "star2\n";
} elsif ($s =~ /l/ || $s =~ /x/) {
    print "alt2\n";
}
