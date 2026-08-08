# $(...) inside case pattern
case "$(__docker_to_extglob "$subcommands")" in
    foo)
        echo bar
        ;;
esac
