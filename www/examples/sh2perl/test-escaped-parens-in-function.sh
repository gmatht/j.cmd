check_path() {
  if [ \( ! -h "$1" -a -d "$1" \) -o \( -h "$1" \) ]; then
    echo ok
  fi
}
