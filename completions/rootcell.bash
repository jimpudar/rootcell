###-begin-rootcell-completions-###
#
# yargs command completion script
#
# Installation: rootcell completion >> ~/.bashrc
#    or rootcell completion >> ~/.bash_profile on OSX.
#
_rootcell_yargs_completions()
{
    local cur_word args type_list

    cur_word="${COMP_WORDS[COMP_CWORD]}"
    args=("${COMP_WORDS[@]}")

    # ask yargs to generate completions.
    # see https://stackoverflow.com/a/40944195/7080036 for the spaces-handling awk
    mapfile -t type_list < <(rootcell --get-yargs-completions "${args[@]}")
    mapfile -t COMPREPLY < <(compgen -W "$( printf '%q ' "${type_list[@]}" )" -- "${cur_word}" |
        awk '/ / { print "\""$0"\"" } /^[^ ]+$/ { print $0 }')

    # if no match was found, fall back to filename completion
    if [ ${#COMPREPLY[@]} -eq 0 ]; then
      COMPREPLY=()
    fi

    return 0
}
complete -o bashdefault -o default -F _rootcell_yargs_completions rootcell
###-end-rootcell-completions-###
