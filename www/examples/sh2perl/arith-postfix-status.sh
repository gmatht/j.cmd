#!/bin/sh
# postfix ((i++)) status: the value is the OLD value (0 -> status 1) —
# exercises the lastExit reader predicate ($? after (( ))) + the
# prefix/postfix rendering
i=0
((i++))
echo "post0=$?"
((++i))
echo "pre=$?"
i=5
((i++))
echo "post5=$?"
