#compdef rootcell
###-begin-rootcell-completions-###
#
# yargs command completion script
#
# Installation: rootcell completion >> ~/.zshrc
#    or rootcell completion >> ~/.zprofile on OSX.
#
_rootcell_yargs_completions()
{
  local reply
  local si=$IFS
  IFS=$'
' reply=($(COMP_CWORD="$((CURRENT-1))" COMP_LINE="$BUFFER" COMP_POINT="$CURSOR" rootcell --get-yargs-completions "${words[@]}"))
  IFS=$si
  if [[ ${#reply} -gt 0 ]]; then
    _describe 'values' reply
  else
    _default
  fi
}
if [[ "'${zsh_eval_context[-1]}" == "loadautofunc" ]]; then
  _rootcell_yargs_completions "$@"
else
  compdef _rootcell_yargs_completions rootcell
fi
###-end-rootcell-completions-###
