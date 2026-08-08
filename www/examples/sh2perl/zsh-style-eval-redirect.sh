# Zsh-style plugin with eval and redirect syntax not valid in bash
eval '
  proxy() {
    if [[ -n "$DEFAULT_PROXY" && -z "$SHELLPROXY_URL" ]]; then
      SHELLPROXY_URL="$DEFAULT_PROXY"
    fi
  }
'
printf "%s=[%s]\n" SHELLPROXY_URL "${SHELLPROXY_URL:-}"

