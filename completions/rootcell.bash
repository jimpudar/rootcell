_rootcell() {
  local cur prev suggestion
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$prev" = "--instance" ]; then
    COMPREPLY=()
    if [ -d .rootcell/instances ]; then
      while IFS= read -r suggestion; do
        case "$suggestion" in
          "$cur"*) COMPREPLY+=("$suggestion") ;;
        esac
      done < <(command ls -1 .rootcell/instances 2>/dev/null)
    fi
  elif [ "$COMP_CWORD" -eq 1 ] || { [ "${COMP_WORDS[1]}" = "--instance" ] && [ "$COMP_CWORD" -eq 3 ]; }; then
    COMPREPLY=()
    while IFS= read -r suggestion; do
      COMPREPLY+=("$suggestion")
    done < <(compgen -W "--instance provision allow pubkey spy" -- "$cur")
  fi
}
complete -F _rootcell rootcell ./rootcell
