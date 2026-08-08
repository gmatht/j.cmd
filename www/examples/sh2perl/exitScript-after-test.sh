if [[ ! -z $(apt-cache search ^libssl) ]]; then
    exitScript 1
fi
printf "parsed OK\\n"
