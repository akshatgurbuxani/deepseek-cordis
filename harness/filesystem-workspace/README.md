# `@deepseek-cordis/filesystem-workspace`

Node workspace implementation and model-facing adapter for the provider-neutral
filesystem capability.

The provider rejects absolute/traversing paths and symbolic-link traversal,
bounds text operations, sorts and truncates directory listings, versions files,
and publishes same-directory temporary files atomically. The adapter exposes
`read_workspace_file`, `list_workspace_directory`, `stat_workspace_path`,
`write_workspace_file`, and `edit_workspace_file` as handler-free consequential
tools. It also executes Feature 14's create-only tool for compatibility.

`WORKSPACE_FILESYSTEM_PROMPT_SECTION` contributes guidance only when at least
one generalized workspace tool is in the exact model-visible schema set. It
teaches observation-before-mutation, precise edits, stale-version recovery,
relative-path boundaries, and result-confirmed claims without exposing the
provider's host root.

Enforcement remains `partial`: portable Node APIs cannot eliminate a hostile
external process racing a validated ancestor. Version guards detect target
changes; they do not turn the host filesystem into a kernel capability.
