# `@deepseek-cordis/workspace-instructions`

Bounded, refreshable workspace guidance for the system-prompt capability.

The provider finds the nearest configured project-root marker between a working
directory and its explicit workspace boundary, then loads candidate files from
that root down to the working directory. Base candidates precede local overlays
within each directory; deeper files therefore have higher precedence. Duplicate
trimmed content in one directory is rendered once.

Every assembly performs a new coherent read, so edits and removals are visible
on the next model request without a watcher or process-global cache. Sources are
bounded individually and as a complete UTF-8 prompt section. Broad sources are
omitted before the most-specific source is truncated. Relative source paths are
rendered as provenance; the absolute host workspace is not.

Candidate names and root markers must be single path components. The working
directory must remain under the real workspace boundary. Unlike the motivating
DeepSeek Harness implementation, symbolic-link instruction files are ignored:
repository guidance cannot use this package to read beyond that boundary.

The exported section is dynamic and has no shared session state. Applications
should register it in the applicable system-prompt scope; the CLI mounts one
provider per runtime and relies on the system-prompt service's session scoping.
