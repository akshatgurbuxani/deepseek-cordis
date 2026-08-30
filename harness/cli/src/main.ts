#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'

import { runCli, runInteractiveCli } from './index.js'

const abort = new AbortController()
let streamed = false
const interactive = process.argv.slice(2).includes('--interactive')
const reader = interactive
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined
const lines = reader?.[Symbol.asyncIterator]()
const cancel = () => {
  abort.abort({ kind: 'user' })
  reader?.close()
}
process.once('SIGINT', cancel)

try {
  const common = {
    signal: abort.signal,
    onTextDelta: (delta: string) => {
      streamed = true
      process.stdout.write(delta)
    },
    output: (content: string) => {
      if (streamed) {
        process.stdout.write('\n')
        streamed = false
      } else console.log(content)
    },
  }
  if (reader) {
    await runInteractiveCli({
      ...common,
      readLine: async (prompt) => {
        process.stdout.write(prompt)
        try {
          const next = await lines!.next()
          return next.done ? undefined : next.value
        } catch (error) {
          if (abort.signal.aborted) return undefined
          throw error
        }
      },
    })
    if (abort.signal.aborted) {
      const error = new Error('interactive session cancelled')
      error.name = 'TurnCancelledError'
      throw error
    }
  } else {
    await runCli(common)
  }
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
  reader?.close()
  process.removeListener('SIGINT', cancel)
}
