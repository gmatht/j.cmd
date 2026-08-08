# Demonstrate case statement with $(( )) arithmetic in body
# Parser failed with: Unexpected token: ParenClose
case $? in
    0)
        echo $(( 1 + 2 ))
        ;;
    *)
        echo "other"
        ;;
esac
