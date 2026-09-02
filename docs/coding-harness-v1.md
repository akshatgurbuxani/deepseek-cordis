# Coding-harness v1 qualification

This document defines the supported v1 boundary. It does not add capabilities;
it records what the required suite and packaged-install check demonstrate.

## Qualified workflows

| Workflow | Required evidence | Supported claim |
| --- | --- | --- |
| Install and start | `npm run test:package` | The tarball installs with lifecycle scripts disabled and exposes a working Node 24 CLI. |
| Configure | CLI initialization tests | `--init` creates and validates a mode-0600 coding profile and never overwrites it. |
| Inspect and edit | CLI live-composition and filesystem suites | Approved reads establish an observation; exact edits and multi-hunk patches reject stale state and publish atomically. |
| Run checks | CLI command composition and process suites | Allowed argv commands run with bounded time/output and without model-provider credentials in their environment. |
| Continue work | CLI and file-session suites | Sessions survive restart, interrupted tails are repaired, and exact `--resume` rejects missing or memory-only histories. |
| Recover safely | cancellation, locking, and sandbox suites | Cancellation closes durable boundaries; concurrent writers, traversal, links, races, and unapproved effects fail closed. |

These tests qualify the harness mechanics. They do not certify that every
OpenRouter model will choose correct tools, produce good patches, or complete a
repository task. Live model qualification remains explicit and opt-in because
it depends on credentials, provider availability, model changes, and cost.

## Supported default limits

| Area | Default v1 limit |
| --- | --- |
| Runtime | Node.js 24 or newer |
| Model loop | 8 model steps per turn |
| Workspace text file | 1 MiB |
| Directory listing | 200 returned entries |
| Recursive discovery | 500 returned paths, depth 8 |
| Patch | 32 replacements, 64 KiB preview diff |
| Command | 120 seconds; caller request capped at 600 seconds |
| Command output | 64,000 bytes per stdout/stderr tail |
| Docker | 1 GiB memory, 256 PIDs, 256 MiB tmpfs, no network |
| Session document | 64 MiB whole-document JSON |
| Instructions | 64 KiB assembled from sources no larger than 1 MiB |
| Context policy | compact at 80%, retain one turn, one useful overflow retry |
| Provider retry | two pre-stream retries, 250 ms initial and 5 s maximum delay |

The limits are containment bounds, not throughput promises. A September 2,
2026 local benchmark of 100 four-event turns produced a 101,408-byte document
at 88 appends/second (p50 11.16 ms, p95 13.90 ms). Results are filesystem and
machine dependent; run `npm run benchmark:session-file -- <turns>` on the target
host. Whole-document persistence should be replaced only if deployment evidence
shows it is the constraint.

## Safe operating profile

- Use Docker command execution for untrusted command workloads; local mode is
  deliberately only partial confinement.
- Keep one writer per session ID. Use separate sessions for concurrent work.
- Keep approval on `ask` for interactive coding and inspect exact arguments.
- Pin a Docker image by digest and pre-install it; the harness never pulls one.
- Set routing data collection to `deny` when privacy outweighs route availability.
- Treat profiles, plugins, instruction files, and the selected model as trusted
  policy inputs. Workspace content remains untrusted data.

Attachments, parallel tools, subagents, scheduling, automatic commits,
automatic profile watching, and UI are outside v1. They require separate
ordering or authority contracts and are not implied by this qualification.
