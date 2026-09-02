# @deepseek-cordis/process-workspace

Guarded command execution for a configured workspace. The model supplies a program and argument vector; no shell parses the request. Every call requires one-time approval and an exact sandbox lease.

The Node provider permits only configured executable names, rejects absolute and symbolic-link working directories, supplies stdin as EOF, uses a caller-supplied scrubbed environment, caps timeout and output, and terminates the process group on timeout or cancellation. Nonzero exits are normal results so the agent can inspect failures.

## Enforcement boundary

The Node provider reports `partial` enforcement. It confines selection of the
working directory and executable name, but Node alone cannot prevent an allowed
program from reading other host paths, using the network, or spawning
descendants with inherited authority. Do not treat the allowlist as an
operating-system sandbox; select the Docker backend when the tool must require
`full` enforcement.

`DockerWorkspaceProcessRunner` is the first `full` backend. Construction
preflights both a reachable Docker daemon and an already-local configured image;
execution uses `--pull never`, no network, a read-only container root, dropped
Linux capabilities, `no-new-privileges`, bounded memory/PIDs/tmpfs, a numeric
host user when available, and one writable bind mount at `/workspace`. The
model-selected executable becomes the entrypoint only after every Docker option,
and model arguments follow the configured image. A unique named container uses
`--rm`, while `finally` also attempts `docker rm --force` after success,
failure, timeout, or cancellation.

Here, `full` means the command receives no ordinary filesystem authority outside
the mounted workspace and no network authority under Docker's normal isolation
model. It does not make workspace contents read-only, validate the configured
image, defend a compromised Docker daemon/runtime/kernel, or prevent a command
from damaging files inside the approved workspace. Image acquisition and trust
remain operator responsibilities.

The invocation surface follows Docker's official
[`docker container run` reference](https://docs.docker.com/reference/cli/docker/container/run/)
and keeps its claim within Docker's documented
[engine security model](https://docs.docker.com/engine/security/).

Output retains a bounded tail independently for stdout and stderr. Truncation is explicit and no recovery file is written. Commands are foreground-only and receive no interactive terminal or model-controlled environment variables.
