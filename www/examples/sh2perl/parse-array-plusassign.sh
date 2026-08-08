# arr+=("value") array append operator
LIST=()
LIST+=( "item1" "item2" )
printf "%s=[%s]\n" LIST "${LIST:-}"

