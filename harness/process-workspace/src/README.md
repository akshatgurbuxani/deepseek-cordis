# Workspace process source

This module owns local Node and Docker workspace process runners, the exact
workspace-command sandbox lease, consequential tool definition, and model-facing
command guidance. Shared validation keeps program, argv, timeout, and cwd policy
identical across backends. Docker options are constructed entirely from trusted
profile state before the model-selected entrypoint and arguments are appended.
