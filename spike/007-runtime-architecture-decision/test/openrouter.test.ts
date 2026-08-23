import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ModelRequest,
  OpenRouterModelAdapter,
  type OpenRouterUsage,
} from '../src/index.ts'

const request: ModelRequest = {
  sessionId: 'session-1',
  turnId: 'session-1:turn:1',
  step: 2,
  messages: [
    { role: 'user', content: 'add two numbers' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'previous', name: 'add', arguments: { a: 1, b: 2 } }],
    },
    { role: 'tool', callId: 'previous', name: 'add', ok: true, output: 3 },
    { role: 'tool', callId: 'failed', name: 'missing', ok: false, error: 'not found' },
  ],
  tools: [{
    name: 'add',
    description: 'Add numbers',
    inputSchema: { type: 'object' },
  }],
}

test('OpenRouter adapter maps harness history, tools, response calls, and usage', async () => {
  let receivedUrl: string | undefined
  let receivedInit: RequestInit | undefined
  let usage: OpenRouterUsage | undefined
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    receivedUrl = String(input)
    receivedInit = init
    return new Response(JSON.stringify({
      model: 'provider/selected-model',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'next-call',
            type: 'function',
            function: { name: 'add', arguments: '{"a":20,"b":22}' },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const adapter = new OpenRouterModelAdapter({
    apiKey: 'test-secret',
    model: 'openrouter/free',
    httpReferer: 'https://example.test',
    appTitle: 'Spike test',
    fetch: fakeFetch,
    onUsage: (value) => { usage = value },
  })

  const result = await adapter.complete(request)
  const headers = receivedInit?.headers as Record<string, string>
  const body = JSON.parse(String(receivedInit?.body))

  assert.equal(receivedUrl, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(headers.Authorization, 'Bearer test-secret')
  assert.equal(headers['X-OpenRouter-Metadata'], 'enabled')
  assert.equal(headers['HTTP-Referer'], 'https://example.test')
  assert.equal(headers['X-Title'], 'Spike test')
  assert.equal(JSON.stringify(body).includes('test-secret'), false)
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'add two numbers' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'previous',
        type: 'function',
        function: { name: 'add', arguments: '{"a":1,"b":2}' },
      }],
    },
    { role: 'tool', tool_call_id: 'previous', content: '3' },
    { role: 'tool', tool_call_id: 'failed', content: '{"error":"not found"}' },
  ])
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: {
      name: 'add',
      description: 'Add numbers',
      parameters: { type: 'object' },
    },
  }])
  assert.equal(body.parallel_tool_calls, false)
  assert.deepEqual(result, {
    type: 'tool_calls',
    calls: [{ id: 'next-call', name: 'add', arguments: { a: 20, b: 22 } }],
  })
  assert.deepEqual(usage, {
    requestedModel: 'openrouter/free',
    selectedModel: 'provider/selected-model',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  })
})

test('OpenRouter adapter accepts a final assistant message', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'The answer is 42.' } }],
  }), { status: 200 })) as typeof fetch
  const adapter = new OpenRouterModelAdapter({ apiKey: 'test', fetch: fakeFetch })

  assert.deepEqual(await adapter.complete({ ...request, tools: [] }), {
    type: 'message',
    content: 'The answer is 42.',
  })
})

test('OpenRouter adapter contains HTTP and malformed tool-call failures', async () => {
  assert.throws(() => new OpenRouterModelAdapter({ apiKey: '' }), /API key is required/)

  const failedFetch = (async () => new Response('rate limited', {
    status: 429,
    statusText: 'Too Many Requests',
  })) as typeof fetch
  await assert.rejects(
    new OpenRouterModelAdapter({ apiKey: 'test', fetch: failedFetch }).complete(request),
    /OpenRouter request failed \(429\): rate limited/,
  )

  const privacyFetch = (async () => new Response(JSON.stringify({
    error: { message: 'No endpoints available matching your guardrail restrictions and data policy.' },
  }), { status: 404 })) as typeof fetch
  await assert.rejects(
    new OpenRouterModelAdapter({
      apiKey: 'test',
      model: 'deepseek/example',
      fetch: privacyFetch,
    }).complete(request),
    /Review Settings > Privacy: ZDR.*model\/provider allowlists/,
  )

  const malformedFetch = (async () => new Response(JSON.stringify({
    choices: [{
      message: {
        tool_calls: [{
          id: 'bad',
          function: { name: 'add', arguments: '{not json}' },
        }],
      },
    }],
  }), { status: 200 })) as typeof fetch
  await assert.rejects(
    new OpenRouterModelAdapter({ apiKey: 'test', fetch: malformedFetch }).complete(request),
    /invalid JSON arguments/,
  )
})
