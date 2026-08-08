# case statement with ;;
case "$1" in
    -h|--help)
        usage
        exit 0
        ;;
    --version)
        echo "$VERSION"
        exit 0
        ;;
esac
