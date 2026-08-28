#!/usr/bin/env node

import { runCli } from './index.js'

try {
  await runCli()
} catch (error) {
  console.error('\n[cli/error]')
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
