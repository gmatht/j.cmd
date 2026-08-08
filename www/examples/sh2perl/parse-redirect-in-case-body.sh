# Redirect in case statement body
case "$1" in
    test)
        cmd >/dev/null && echo ok
        ;;
esac
