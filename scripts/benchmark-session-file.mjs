import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { FileSessionStore, sessionFilePath } from '@deepseek-cordis/session-file'

const turns = Number(process.argv[2] ?? 250)
if (!Number.isSafeInteger(turns) || turns < 1) {
  throw new RangeError('turn count must be a positive safe integer')
}

const directory = mkdtempSync(join(tmpdir(), 'deepseek-cordis-session-benchmark-'))
try {
  const session = new FileSessionStore({ directory }).create('benchmark')
  const appendMilliseconds = []
  const append = (event) => {
    const started = performance.now()
    session.append(event)
    appendMilliseconds.push(performance.now() - started)
  }

  const started = performance.now()
  for (let turn = 1; turn <= turns; turn += 1) {
    const turnId = `benchmark:turn:${turn}`
    append({ type: 'turn/start', turnId })
    append({ type: 'user/message', turnId, content: `Request ${turn}: ${'x'.repeat(256)}` })
    append({ type: 'assistant/message', turnId, content: `Response ${turn}: ${'y'.repeat(256)}` })
    append({ type: 'turn/end', turnId, status: 'completed' })
  }
  const totalMilliseconds = performance.now() - started
  appendMilliseconds.sort((left, right) => left - right)
  const percentile = (ratio) =>
    appendMilliseconds[
      Math.min(appendMilliseconds.length - 1, Math.floor(ratio * appendMilliseconds.length))
    ]

  process.stdout.write(
    `${JSON.stringify(
      {
        turns,
        events: session.events.length,
        documentBytes: statSync(sessionFilePath(directory, session.id)).size,
        totalMilliseconds: Math.round(totalMilliseconds),
        appendsPerSecond: Math.round((session.events.length * 1000) / totalMilliseconds),
        appendMilliseconds: {
          p50: Number(percentile(0.5).toFixed(2)),
          p95: Number(percentile(0.95).toFixed(2)),
          max: Number(appendMilliseconds.at(-1).toFixed(2)),
        },
      },
      null,
      2,
    )}\n`,
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
