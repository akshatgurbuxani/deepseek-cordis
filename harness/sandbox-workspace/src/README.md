# Workspace sandbox source boundary

The package owns one exact operation dialect and its execution lease. Tool
registration contributes only schema and safety metadata; it has no handler.
Approval remains owned by `approval`, durable audit by the agent loop, and
provider lifecycle by `runtime-cordis`/`app-boot`.

Keep this provider deliberately narrow. A later filesystem capability family
should introduce read, observation, guarded edit, and alternate backends rather
than growing arbitrary dispatch inside this first provider.
