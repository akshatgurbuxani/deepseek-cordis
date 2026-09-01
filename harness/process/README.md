# @deepseek-cordis/process

Provider-neutral contracts for bounded process execution. Requests contain a program and argument vector, a workspace-relative working directory, a timeout, and optional cancellation. Results keep nonzero exits, signals, timeouts, and per-stream truncation as data; only invalid requests, confinement failures, spawn failures, and cancellation reject.

This package does not execute commands or grant authority. A concrete provider owns executable policy, workspace confinement, environment construction, process lifecycle, and output budgets.
