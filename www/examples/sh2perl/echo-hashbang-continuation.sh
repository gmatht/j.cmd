echo "#!/bin/sh
exec '$(echo test)' --flag \"\$@\"" > /tmp/echo_hashbang_continuation_output.sh
