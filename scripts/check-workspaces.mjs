import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sorted(values) {
  return [...values].sort()
}

function compare(label, actual, expected) {
  const actualValues = sorted(actual)
  const expectedValues = sorted(expected)
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    failures.push(
      `${label} differ:\n  registered: ${actualValues.join(', ')}\n  discovered: ${expectedValues.join(', ')}`,
    )
  }
}

const rootPackage = readJson(join(root, 'package.json'))
if (!Array.isArray(rootPackage.workspaces)) {
  failures.push('root package.json must declare workspaces as an array')
}

const registered = new Set(rootPackage.workspaces ?? [])
const harnessRoot = join(root, 'harness')
const discovered = new Set(
  readdirSync(harnessRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(harnessRoot, entry.name, 'package.json')),
    )
    .map((entry) => `harness/${entry.name}`),
)
compare('root npm workspaces and harness packages', registered, discovered)

const packagesByName = new Map()
for (const workspace of registered) {
  const manifestPath = join(root, workspace, 'package.json')
  if (!existsSync(manifestPath)) {
    failures.push(`workspace ${workspace} has no package.json`)
    continue
  }

  const manifest = readJson(manifestPath)
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    failures.push(`workspace ${workspace} has no package name`)
    continue
  }
  if (packagesByName.has(manifest.name)) {
    failures.push(`duplicate package name ${manifest.name}`)
    continue
  }
  packagesByName.set(manifest.name, { manifest, workspace })
}

const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]
for (const { manifest, workspace } of packagesByName.values()) {
  for (const section of dependencySections) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@deepseek-cordis/')) continue
      const target = packagesByName.get(name)
      if (!target) {
        failures.push(`${workspace} has unknown internal ${section} entry ${name}`)
      } else if (version !== target.manifest.version) {
        failures.push(
          `${workspace} requires ${name}@${version}, but the workspace version is ${target.manifest.version}`,
        )
      }
    }
  }
}

const rootTsconfig = readJson(join(root, 'tsconfig.json'))
const referenced = new Set(
  (rootTsconfig.references ?? []).map(({ path }) => relative(root, resolve(root, path))),
)
compare('root TypeScript references and npm workspaces', referenced, registered)

if (failures.length > 0) {
  console.error(`Workspace validation failed:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log(`Validated ${registered.size} workspaces.`)
}
