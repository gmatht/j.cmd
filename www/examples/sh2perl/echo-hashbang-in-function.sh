prepare_gpg_home() {
    echo "#!/bin/sh
exec '$(echo test)' --flag \"\$@\"" > /tmp/echo_hashbang_in_function_output.sh
}
