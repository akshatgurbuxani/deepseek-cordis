# @deepseek-cordis/process-workspace

Guarded command execution for a configured workspace. The model supplies a program and argument vector; no shell parses the request. Every call requires one-time approval and an exact sandbox lease.

The Node provider permits only configured executable names, rejects absolute and symbolic-link working directories, supplies stdin as EOF, uses a caller-supplied scrubbed environment, caps timeout and output, and terminates the process group on timeout or cancellation. Nonzero exits are normal results so the agent can inspect failures.

## Enforcement boundary

The provider reports `partial` enforcement. It confines selection of the working directory and executable name, but Node alone cannot prevent an allowed program from reading other host paths, using the network, or spawning descendants with inherited authority. Do not treat the allowlist as an operating-system sandbox. Compose a full isolation backend before changing the tool's required enforcement to `full`.

Output retains a bounded tail independently for stdout and stderr. Truncation is explicit and no recovery file is written. Commands are foreground-only and receive no interactive terminal or model-controlled environment variables.
