_rootcell() {
  if [ "$COMP_CWORD" -eq 1 ]; then
    local cur suggestion
    cur="${COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=()
    while IFS= read -r suggestion; do
      COMPREPLY+=("$suggestion")
    done < <(compgen -W "provision allow pubkey spy" -- "$cur")
  fi
}
complete -F _rootcell rootcell ./rootcell
