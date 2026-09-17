PORT=$(((1`date +%N`%20007)+10000))

python -m http.server $PORT & '/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe' http://127.0.0.1:$PORT/"$1"
