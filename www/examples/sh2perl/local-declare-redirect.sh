# Demonstrate local/declare with redirect inside case body
# Parser failed with: Unexpected token: RedirectOut
case "x" in
    $(echo "pattern") )
        local testvar >/dev/null
        ;;
esac
