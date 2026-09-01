import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { InMemorySystemPrompt, type PromptAssemblyContext } from '@deepseek-cordis/system-prompt'
import {
  createWorkspaceInstructionsSection,
  NodeWorkspaceInstructions,
  renderWorkspaceInstructions,
  WORKSPACE_INSTRUCTIONS_SECTION_NAME,
} from '@deepseek-cordis/workspace-instructions'

const context: PromptAssemblyContext = {
  sessionId: 'session-a',
  turnId: 'session-a:turn:1',
  step: 1,
  tools: [],
}

function temporaryWorkspace(t: TestContext, name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `deepseek-cordis-instructions-${name}-`))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

test('discovery follows project hierarchy, precedence, overlays, and per-directory dedup', async (t) => {
  const boundary = temporaryWorkspace(t, 'hierarchy')
  const project = join(boundary, 'project')
  const working = join(project, 'packages', 'app')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(working, { recursive: true })
  writeFileSync(join(boundary, 'AGENTS.md'), 'outside project marker')
  writeFileSync(join(project, 'AGENTS.md'), 'root guidance')
  writeFileSync(join(project, 'CLAUDE.md'), ' root guidance\n')
  writeFileSync(join(project, 'AGENTS.local.md'), 'root local overlay')
  writeFileSync(join(project, 'packages', 'AGENTS.md'), 'package guidance')
  writeFileSync(join(working, 'CLAUDE.local.md'), 'app local guidance')

  const provider = new NodeWorkspaceInstructions({
    workspaceRoot: boundary,
    workingDirectory: working,
    maxBytes: 65_536,
  })
  const discovery = await provider.discover()

  assert.equal(discovery.projectRoot, 'project')
  assert.deepEqual(
    discovery.sources.map(({ path, content }) => [path, content]),
    [
      ['AGENTS.md', 'root guidance'],
      ['AGENTS.local.md', 'root local overlay'],
      ['packages/AGENTS.md', 'package guidance'],
      ['packages/app/CLAUDE.local.md', 'app local guidance'],
    ],
  )
  assert.deepEqual(discovery.omissions, [])
  const rendered = await provider.render(context)
  assert.ok(rendered.indexOf('root guidance') < rendered.indexOf('app local guidance'))
  assert.equal(rendered.includes('outside project marker'), false)
  assert.equal(rendered.includes(boundary), false)
  assert.equal(Object.isFrozen(discovery), true)
  assert.equal(Object.isFrozen(discovery.sources), true)
})

test('source policy skips oversized, non-regular, and symbolic-link candidates', async (t) => {
  const workspace = temporaryWorkspace(t, 'source-policy')
  writeFileSync(join(workspace, 'AGENTS.md'), '0123456789')
  mkdirSync(join(workspace, 'CLAUDE.md'))
  writeFileSync(join(workspace, 'outside.md'), 'must not load')
  symlinkSync(join(workspace, 'outside.md'), join(workspace, 'AGENTS.local.md'))
  writeFileSync(join(workspace, 'CLAUDE.local.md'), Buffer.from([0xff]))

  const discovery = await new NodeWorkspaceInstructions({
    workspaceRoot: workspace,
    maxBytes: 1_000,
    maxSourceBytes: 5,
  }).discover()

  assert.deepEqual(discovery.sources, [])
  assert.deepEqual(discovery.omissions, [
    { path: 'AGENTS.md', reason: 'source-budget' },
    { path: 'CLAUDE.md', reason: 'not-regular-file' },
    { path: 'AGENTS.local.md', reason: 'symbolic-link' },
    { path: 'CLAUDE.local.md', reason: 'invalid-utf8' },
  ])
  assert.match(
    await new NodeWorkspaceInstructions({
      workspaceRoot: workspace,
      maxBytes: 1_000,
      maxSourceBytes: 5,
    }).render(context),
    /Instructions omitted by source budget: AGENTS\.md/,
  )
})

test('aggregate budget drops broad files before truncating the most-specific file', () => {
  const discovery = {
    projectRoot: '/private/project',
    sources: [
      { path: 'AGENTS.md', bytes: 300, content: 'broad '.repeat(50) },
      { path: 'src/AGENTS.md', bytes: 300, content: `specific ${'🙂'.repeat(50)}` },
    ],
    omissions: [],
  }
  const rendered = renderWorkspaceInstructions(discovery, 450)

  assert.ok(Buffer.byteLength(rendered) <= 450)
  assert.equal(rendered.includes('broad broad'), false)
  assert.match(rendered, /src\/AGENTS\.md/)
  assert.match(rendered, /truncated by aggregate budget/)
  assert.doesNotMatch(rendered, /�/)
  assert.equal(renderWorkspaceInstructions(discovery, 1), '')
  assert.equal(renderWorkspaceInstructions(discovery, 0), '')
})

test('dynamic sections refresh on the next assembly and remain session-scoped', async (t) => {
  const workspaceA = temporaryWorkspace(t, 'session-a')
  const workspaceB = temporaryWorkspace(t, 'session-b')
  writeFileSync(join(workspaceA, 'AGENTS.md'), 'session A version one')
  writeFileSync(join(workspaceB, 'AGENTS.md'), 'session B only')
  const prompts = new InMemorySystemPrompt()
  prompts.register(
    createWorkspaceInstructionsSection(
      new NodeWorkspaceInstructions({ workspaceRoot: workspaceA, maxBytes: 4_096 }),
    ),
    { scope: 'session-a' },
  )
  prompts.register(
    createWorkspaceInstructionsSection(
      new NodeWorkspaceInstructions({ workspaceRoot: workspaceB, maxBytes: 4_096 }),
    ),
    { scope: 'session-b' },
  )

  assert.match((await prompts.assemble(context)).systemPrompt ?? '', /session A version one/)
  assert.doesNotMatch((await prompts.assemble(context)).systemPrompt ?? '', /session B only/)
  writeFileSync(join(workspaceA, 'AGENTS.md'), 'session A version two')
  assert.match((await prompts.assemble(context)).systemPrompt ?? '', /session A version two/)
  rmSync(join(workspaceA, 'AGENTS.md'))
  assert.deepEqual(await prompts.assemble(context), { sectionNames: [] })
  assert.match(
    (
      await prompts.assemble({
        ...context,
        sessionId: 'session-b',
        turnId: 'session-b:turn:1',
      })
    ).systemPrompt ?? '',
    /session B only/,
  )
})

test('configuration rejects escapes and cancellation interrupts discovery', async (t) => {
  const workspace = temporaryWorkspace(t, 'validation')
  assert.throws(
    () => new NodeWorkspaceInstructions({ workspaceRoot: 'relative', maxBytes: 1 }),
    /workspaceRoot must be absolute/,
  )
  assert.throws(
    () =>
      new NodeWorkspaceInstructions({
        workspaceRoot: workspace,
        maxBytes: 1,
        instructionFileCandidates: ['nested/AGENTS.md'],
      }),
    /one non-empty path component/,
  )
  assert.throws(
    () =>
      new NodeWorkspaceInstructions({
        workspaceRoot: workspace,
        maxBytes: 1,
        instructionFileCandidates: ['AGENTS\0.md'],
      }),
    /one non-empty path component/,
  )
  assert.throws(
    () =>
      new NodeWorkspaceInstructions({
        workspaceRoot: workspace,
        maxBytes: 1,
        projectRootMarkers: ['.git', '.git'],
      }),
    /must not contain duplicates/,
  )
  const outside = temporaryWorkspace(t, 'outside')
  await assert.rejects(
    new NodeWorkspaceInstructions({
      workspaceRoot: workspace,
      workingDirectory: outside,
      maxBytes: 1,
    }).discover(),
    /must remain within workspaceRoot/,
  )

  const controller = new AbortController()
  controller.abort(new Error('stop discovery'))
  await assert.rejects(
    new NodeWorkspaceInstructions({ workspaceRoot: workspace, maxBytes: 1 }).discover(
      controller.signal,
    ),
    /stop discovery/,
  )
  assert.equal(
    createWorkspaceInstructionsSection(
      new NodeWorkspaceInstructions({ workspaceRoot: workspace, maxBytes: 1 }),
    ).name,
    WORKSPACE_INSTRUCTIONS_SECTION_NAME,
  )
})
