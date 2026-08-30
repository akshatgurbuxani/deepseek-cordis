# `@deepseek-cordis/compaction`

Optional provenance-preserving session compaction capability.

`SessionCompactor` selects a complete closed-turn prefix while retaining at
least the newest closed turn. It gives an injected `SummaryAdapter` the exact
model messages and event sequences selected, then appends one atomic
`compaction/summary` checkpoint. The checkpoint stores the summarizer identity,
summary text, and exact surface sequence list it shadows. Original events stay
in the append-only log; only derived model history changes.

Compaction runs only while the session is idle. It rejects concurrent attempts,
revalidates the selected prefix after asynchronous summarization, propagates
cancellation, and commits nothing on failure or empty output. Whole-turn prefix
selection preserves tool-call/result pairing without requiring the larger
DeepSeek surface-range protocol.

`ModelSummaryAdapter` supplies the production model path. It replays the exact
selected messages through the shared stream collector, adds a stable trailing
checkpoint instruction, sends no tool schemas, and accepts only a completed
text response. Alternative tokenizer-, template-, or remote-summary providers
can implement the same small `SummaryAdapter` contract.
