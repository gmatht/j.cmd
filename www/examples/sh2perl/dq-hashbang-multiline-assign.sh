config=$(echo "#!/bin/sh
exec '$(which cmd)' --option \"\$@\"" > /tmp/config.sh)
printf "%s=[%s]\n" config "${config:-}"

