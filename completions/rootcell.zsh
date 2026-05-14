_rootcell() {
  local -a subcmds=(
    'provision:re-copy files and re-rebuild both VMs'
    'allow:hot-reload allowlists into the firewall VM'
    'pubkey:print the agent VM SSH public key'
    'spy:tail formatted Bedrock traffic from the firewall VM'
  )
  _arguments \
    '--instance[select rootcell instance]:instance:_files -W .rootcell/instances -/' \
    '1: :{_describe subcommand subcmds}'
}
compdef _rootcell rootcell ./rootcell
