# Case pattern with command substitution $(...) followed by )
# Parser failed with: Unexpected token: RedirectOut (in case body)
case "word" in
    $(echo "pattern") )
        echo matched
        ;;
esac
