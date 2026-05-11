_rootcell() {
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "provision allow pubkey spy" -- "${COMP_WORDS[COMP_CWORD]}") )
  fi
}
complete -F _rootcell rootcell ./rootcell
