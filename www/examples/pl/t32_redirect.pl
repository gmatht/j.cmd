# t32_redirect: redirect output to a file
# diagnostics: program prints its result to stdout
open(my $fh, ">", "/tmp/f.$$") or die;
print $fh "data\n";
close $fh;
print "wrote\n";
