#!/usr/bin/env node

import { runCli } from './index.js'

const abort = new AbortController()
let streamed = false
const cancel = () => { abort.abort({ kind: 'user' }) }
process.once('SIGINT', cancel)

try {
  await runCli({
    signal: abort.signal,
    onTextDelta: (delta) => {
      streamed = true
      process.stdout.write(delta)
    },
    output: (content) => {
      if (streamed) process.stdout.write('\n')
      else console.log(content)
    },
  })
} catch (error) {
  if (error instanceof Error && error.name === 'TurnCancelledError') {
    console.error('\n[cli/cancelled]')
    process.exitCode = 130
  } else {
    console.error('\n[cli/error]')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
} finally {
  process.removeListener('SIGINT', cancel)
}
