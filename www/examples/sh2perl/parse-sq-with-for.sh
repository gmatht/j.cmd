#!/bin/sh
# Multi-line single-quoted string containing 'for' keyword with content after it
echo | perl -e '
for (my $i=0; $i<10; $i++) {
  print "ok\n";
}
'
