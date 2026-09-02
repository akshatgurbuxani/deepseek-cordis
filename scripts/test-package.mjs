import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'deepseek-cordis-package-'))

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} failed with status ${String(result.status)}\n${result.stderr}`,
    )
  }
  return result
}

try {
  const packed = run('npm', ['pack', '--json', '--silent', '--pack-destination', temporaryRoot])
  const manifest = JSON.parse(packed.stdout)
  if (
    !Array.isArray(manifest) ||
    manifest.length !== 1 ||
    typeof manifest[0]?.filename !== 'string'
  ) {
    throw new Error('npm pack did not report exactly one package')
  }
  const archive = join(temporaryRoot, manifest[0].filename)
  const installation = join(temporaryRoot, 'installation')
  run('npm', ['install', '--ignore-scripts', '--silent', '--prefix', installation, archive])

  const packageRoot = join(installation, 'node_modules', 'deepseek-cordis')
  const executable = join(packageRoot, 'dist', 'deepseek-cordis.js')
  const linkedBinary = join(
    installation,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'deepseek-cordis.cmd' : 'deepseek-cordis',
  )
  if (!existsSync(executable) || !existsSync(linkedBinary)) {
    throw new Error('installed package did not expose the deepseek-cordis binary')
  }

  const help = run(process.execPath, [executable, '--help'])
  if (!help.stdout.startsWith('Usage: deepseek-cordis')) {
    throw new Error('packaged executable did not expose operator help')
  }

  const replay = run(process.execPath, [executable, '--quiet', '--replay', 'add 20 and 22'])
  if (replay.stdout !== 'The answer is 42.\n') {
    throw new Error(
      `quiet packaged replay emitted unexpected output: ${JSON.stringify(replay.stdout)}`,
    )
  }

  const profile = join(temporaryRoot, 'configuration', 'profile.json')
  run(process.execPath, [executable, '--init', profile])
  const sessions = run(process.execPath, [executable, '--sessions', '--profile', profile])
  if (sessions.stdout !== 'No persisted sessions.\n') {
    throw new Error(
      `packaged session discovery emitted unexpected output: ${JSON.stringify(sessions.stdout)}`,
    )
  }

  console.log('Installed package passed replay, initialization, and session-discovery smoke tests.')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
