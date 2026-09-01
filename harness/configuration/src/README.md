# Configuration source

`index.ts` owns schema V1 types, exact-key validation, defaulting, immutable
normalization, and JSON diagnostics. Keep filesystem reads and relative-path
resolution in the launcher, runtime lifecycle in `app-boot`, and capability
construction in the packages that own those capabilities.

Workspace instruction configuration remains a distinct typed section. It owns
only portable discovery vocabulary and bounds; it never reads `AGENTS.md` or
interprets persona text as a path.
