import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ModelContextOverflowError,
  ModelStreamAbortedError,
  resolveModelInfo,
} from '@deepseek-cordis/model'
import {
  type OpenRouterDiagnostics,
  OpenRouterHttpError,
  OpenRouterModelAdapter,
  OpenRouterRequestError,
  OpenRouterResponseError,
} from '@deepseek-cordis/model-openrouter'
import type { ModelRequest } from '@deepseek-cordis/protocol'

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
  tools: [
    {
      name: 'add',
      description: 'Add numbers',
      inputSchema: { type: 'object' },
    },
  ],
}

function streamedResponse(parts: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        parts.forEach((part) => {
          controller.enqueue(encoder.encode(part))
        })
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

test('maps complete history, tools, calls, attribution, usage, and routing metadata', async () => {
  let receivedUrl: string | undefined
  let receivedInit: RequestInit | undefined
  let diagnostics: OpenRouterDiagnostics | undefined
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    receivedUrl = String(input)
    receivedInit = init
    return new Response(
      JSON.stringify({
        model: 'provider/selected-model',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'next-call',
                  type: 'function',
                  function: { name: 'add', arguments: '{"a":20,"b":22}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        openrouter_metadata: {
          requested: 'openrouter/free',
          strategy: 'free',
          future_additive_field: { accepted: true },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  const adapter = new OpenRouterModelAdapter({
    apiKey: 'test-secret',
    model: 'openrouter/free',
    endpoint: 'https://router.test/completions',
    httpReferer: 'https://example.test',
    appTitle: 'Harness test',
    fetch: fakeFetch,
    onDiagnostics: (value) => {
      diagnostics = value
    },
  })

  const result = await adapter.complete({
    ...request,
    systemPrompt: 'You are a careful coding agent.',
  })
  const headers = receivedInit?.headers as Record<string, string>
  const body = JSON.parse(String(receivedInit?.body))

  assert.equal(adapter.id, 'openrouter:openrouter/free')
  assert.equal(receivedUrl, 'https://router.test/completions')
  assert.equal(headers.Authorization, 'Bearer test-secret')
  assert.equal(headers['X-OpenRouter-Metadata'], 'enabled')
  assert.equal(headers['HTTP-Referer'], 'https://example.test')
  assert.equal(headers['X-OpenRouter-Title'], 'Harness test')
  assert.equal(JSON.stringify(body).includes('test-secret'), false)
  assert.equal(body.session_id, 'session-1')
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are a careful coding agent.' },
    { role: 'user', content: 'add two numbers' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'previous',
          type: 'function',
          function: { name: 'add', arguments: '{"a":1,"b":2}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'previous', content: '3' },
    { role: 'tool', tool_call_id: 'failed', content: '{"error":"not found"}' },
  ])
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'add',
        description: 'Add numbers',
        parameters: { type: 'object' },
      },
    },
  ])
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.parallel_tool_calls, false)
  assert.deepEqual(result, {
    type: 'tool_calls',
    calls: [{ id: 'next-call', name: 'add', arguments: { a: 20, b: 22 } }],
  })
  assert.deepEqual(diagnostics, {
    requestedModel: 'openrouter/free',
    selectedModel: 'provider/selected-model',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    routerMetadata: {
      requested: 'openrouter/free',
      strategy: 'free',
      future_additive_field: { accepted: true },
    },
  })
  assert.equal(Object.isFrozen(diagnostics), true)
  assert.equal(Object.isFrozen(diagnostics?.routerMetadata), true)
})

test('accepts final text and omits tool fields and optional attribution', async () => {
  let body: Record<string, unknown> | undefined
  let headers: Record<string, string> | undefined
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    headers = init?.headers as Record<string, string>
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'The answer is 42.' } }],
      }),
      { status: 200 },
    )
  }) as typeof fetch
  const adapter = new OpenRouterModelAdapter({ apiKey: 'test', fetch: fakeFetch })

  assert.deepEqual(await adapter.complete({ ...request, tools: [] }), {
    type: 'message',
    content: 'The answer is 42.',
  })
  assert.equal(body?.model, 'openrouter/free')
  assert.equal('tools' in (body ?? {}), false)
  assert.equal('tool_choice' in (body ?? {}), false)
  assert.equal(headers?.['HTTP-Referer'], undefined)
  assert.equal(headers?.['X-OpenRouter-Title'], undefined)
})

test('streams split SSE text, reports terminal diagnostics, and forwards cancellation', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const signals: Array<AbortSignal | null | undefined> = []
  let diagnostics: OpenRouterDiagnostics | undefined
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    signals.push(init?.signal)
    return streamedResponse([
      ': keepalive\r\n\r\ndata: {"model":"provider/stream","choices":[{"delta":{"content":"hel',
      'lo "}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ])
  }) as typeof fetch
  const adapter = new OpenRouterModelAdapter({
    apiKey: 'test',
    fetch: fakeFetch,
    onDiagnostics: (value) => {
      diagnostics = value
    },
  })
  const controller = new AbortController()
  const deltas: string[] = []

  assert.deepEqual(
    await adapter.complete(request, {
      signal: controller.signal,
      onTextDelta: (delta) => {
        deltas.push(delta)
      },
    }),
    { type: 'message', content: 'hello world' },
  )
  assert.deepEqual(deltas, ['hello ', 'world'])
  assert.equal(bodies[0]?.stream, true)
  assert.deepEqual(bodies[0]?.stream_options, { include_usage: true })
  assert.equal(signals[0], controller.signal)
  assert.deepEqual(diagnostics, {
    requestedModel: 'openrouter/free',
    selectedModel: 'provider/stream',
    promptTokens: 2,
    completionTokens: 2,
    totalTokens: 4,
  })

  const cancelled = new AbortController()
  await assert.rejects(
    adapter.complete(request, {
      signal: cancelled.signal,
      onTextDelta: () => {
        cancelled.abort({ kind: 'user' })
      },
    }),
    ModelStreamAbortedError,
  )
})

test('assembles fragmented streaming tool calls before publishing completion', async () => {
  const fetch = (async () =>
    streamedResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"add","arguments":"{\\"a\\":20"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"b\\":22}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ])) as typeof globalThis.fetch
  const adapter = new OpenRouterModelAdapter({ apiKey: 'test', fetch })

  assert.deepEqual(await adapter.complete(request, { onTextDelta: () => undefined }), {
    type: 'tool_calls',
    calls: [{ id: 'call-1', name: 'add', arguments: { a: 20, b: 22 } }],
  })
})

test('rejects malformed streaming envelopes and tool-call fragments', async () => {
  const malformed: ReadonlyArray<readonly [string, RegExp]> = [
    ['data: {not json}\n\n', /invalid streaming JSON/],
    ['data: 1\n\n', /invalid streaming response/],
    ['data: {"error":{}}\n\n', /stream failed/],
    ['data: {"error":{"message":"provider broke"}}\n\n', /provider broke/],
    ['data: {"choices":[null]}\n\n', /invalid streaming choice/],
    ['data: {"choices":[{"delta":{"content":1}}]}\n\n', /invalid streaming text/],
    ['data: {"choices":[{"delta":{"tool_calls":{}}}]}\n\n', /invalid streaming tool calls/],
    ['data: {"choices":[{"delta":{"tool_calls":[null]}}]}\n\n', /invalid streaming tool call/],
    ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":1}]}}]}\n\n', /tool call id/],
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"other"}]}}]}\n\n',
      /tool call type/,
    ],
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":1}]}}]}\n\n',
      /tool function/,
    ],
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":1}}]}}]}\n\n',
      /tool name/,
    ],
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":1}}]}}]}\n\n',
      /tool arguments/,
    ],
    ['data: {"choices":[]}\n\ndata: [DONE]\n\n', /no completion choice/],
  ]

  for (const [body, expected] of malformed) {
    const fetch = (async () => streamedResponse([body])) as typeof globalThis.fetch
    const adapter = new OpenRouterModelAdapter({ apiKey: 'test', fetch })
    await assert.rejects(adapter.complete(request, { onTextDelta: () => undefined }), expected)
  }

  const noBodyFetch = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch
  await assert.rejects(
    new OpenRouterModelAdapter({
      apiKey: 'test',
      fetch: noBodyFetch,
    }).complete(request, { onTextDelta: () => undefined }),
    /stream has no body/,
  )
})

test('normalizes missing keys, network failures, and HTTP failures without leaking secrets', async () => {
  assert.throws(
    () => new OpenRouterModelAdapter({ apiKey: '' }),
    (error) => error instanceof OpenRouterRequestError && /API key is required/.test(error.message),
  )

  const networkAdapter = new OpenRouterModelAdapter({
    apiKey: 'network-secret',
    fetch: (async () => {
      throw new Error('socket closed')
    }) as typeof fetch,
  })
  await assert.rejects(
    networkAdapter.complete(request),
    (error) =>
      error instanceof OpenRouterRequestError &&
      /network request failed: socket closed/.test(error.message) &&
      !error.message.includes('network-secret'),
  )

  const failedFetch = (async () =>
    new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
    })) as typeof fetch
  await assert.rejects(
    new OpenRouterModelAdapter({ apiKey: 'http-secret', fetch: failedFetch }).complete(request),
    (error) =>
      error instanceof OpenRouterHttpError &&
      error.status === 429 &&
      error.detail === 'rate limited' &&
      !error.message.includes('http-secret'),
  )

  const emptyFailure = (async () =>
    new Response('', {
      status: 503,
      statusText: 'Unavailable',
    })) as typeof fetch
  await assert.rejects(
    new OpenRouterModelAdapter({ apiKey: 'test', fetch: emptyFailure }).complete(request),
    /OpenRouter request failed \(503\): Unavailable/,
  )
})

test('normalizes HTTP and streamed context-limit failures for policy recovery', async () => {
  const http = new OpenRouterModelAdapter({
    apiKey: 'test',
    contextWindow: 128_000,
    fetch: (async () =>
      new Response('maximum context length exceeded', {
        status: 400,
      })) as typeof fetch,
  })
  assert.equal(http.contextWindow, 128_000)
  await assert.rejects(http.complete(request), ModelContextOverflowError)

  const unrelatedLargeRequest = new OpenRouterModelAdapter({
    apiKey: 'test',
    fetch: (async () =>
      new Response('request body is too large', {
        status: 413,
      })) as typeof fetch,
  })
  await assert.rejects(
    unrelatedLargeRequest.complete(request),
    (error) => error instanceof OpenRouterHttpError && error.status === 413,
  )

  const streamed = new OpenRouterModelAdapter({
    apiKey: 'test',
    fetch: (async () =>
      streamedResponse([
        'data: {"error":{"code":"context_length_exceeded","message":"too many tokens"}}\n\n',
      ])) as typeof fetch,
  })
  await assert.rejects(
    streamed.complete(request, { onTextDelta: () => undefined }),
    ModelContextOverflowError,
  )
  assert.throws(
    () => new OpenRouterModelAdapter({ apiKey: 'test', contextWindow: 0 }),
    /context window must be a positive integer/,
  )
})

test('resolves and caches exact context capacity from the OpenRouter catalog', async () => {
  let calls = 0
  let authorization: string | undefined
  const adapter = new OpenRouterModelAdapter({
    apiKey: 'metadata-secret',
    model: 'openai/gpt-4',
    modelsEndpoint: 'https://router.test/models',
    fetch: (async (_input, init) => {
      calls += 1
      assert.ok(init)
      authorization = (init.headers as Record<string, string>).Authorization
      return new Response(
        JSON.stringify({
          data: [
            { id: 'other/model', context_length: 1_000 },
            { id: 'openai/gpt-4', context_length: 8_192 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch,
  })

  assert.deepEqual(await resolveModelInfo(adapter), {
    model: 'openai/gpt-4',
    contextWindow: 8_192,
  })
  assert.deepEqual(await resolveModelInfo(adapter), {
    model: 'openai/gpt-4',
    contextWindow: 8_192,
  })
  assert.equal(calls, 1)
  assert.equal(authorization, 'Bearer metadata-secret')

  let overrideFetches = 0
  const configured = new OpenRouterModelAdapter({
    apiKey: 'test',
    contextWindow: 32_000,
    fetch: (async () => {
      overrideFetches += 1
      throw new Error('unused')
    }) as typeof fetch,
  })
  assert.equal((await resolveModelInfo(configured)).contextWindow, 32_000)
  assert.equal(overrideFetches, 0)
})

test('model metadata lookup validates failures and tolerates an unknown route', async () => {
  const adapterFor = (fetch: typeof globalThis.fetch) =>
    new OpenRouterModelAdapter({
      apiKey: 'metadata-secret',
      model: 'unknown/model',
      fetch,
    })
  const missing = adapterFor(
    (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
  )
  assert.deepEqual(await resolveModelInfo(missing), { model: 'unknown/model' })

  await assert.rejects(
    resolveModelInfo(
      adapterFor((async () => {
        throw new Error('socket failed')
      }) as typeof fetch),
    ),
    (error) =>
      error instanceof OpenRouterRequestError &&
      /metadata request failed/.test(error.message) &&
      !error.message.includes('metadata-secret'),
  )

  await assert.rejects(
    resolveModelInfo(
      adapterFor(
        (async () => new Response('catalog unavailable', { status: 503 })) as typeof fetch,
      ),
    ),
    (error) => error instanceof OpenRouterHttpError && error.status === 503,
  )

  await assert.rejects(
    resolveModelInfo(
      adapterFor((async () => new Response('{bad json', { status: 200 })) as typeof fetch),
    ),
    /invalid model metadata/,
  )
  await assert.rejects(
    resolveModelInfo(adapterFor((async () => new Response('{}', { status: 200 })) as typeof fetch)),
    /invalid model metadata/,
  )
})

test('rejects invalid JSON, completion envelopes, messages, and empty completions', async () => {
  const adapterFor = (body: string) =>
    new OpenRouterModelAdapter({
      apiKey: 'test',
      fetch: (async () => new Response(body, { status: 200 })) as typeof fetch,
    })

  await assert.rejects(
    adapterFor('{not json}').complete(request),
    (error) => error instanceof OpenRouterResponseError && /invalid JSON/.test(error.message),
  )
  await assert.rejects(adapterFor('{}').complete(request), /invalid completion response/)
  await assert.rejects(
    adapterFor('{"choices":[{}]}').complete(request),
    /did not contain a message/,
  )
  await assert.rejects(
    adapterFor('{"choices":[{"message":{"content":null}}]}').complete(request),
    /neither text nor tool calls/,
  )
})

test('rejects malformed tool-call envelopes, functions, and arguments', async () => {
  const completeWithCall = async (call: unknown) => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [call] } }],
        }),
        { status: 200 },
      )) as typeof globalThis.fetch
    return new OpenRouterModelAdapter({ apiKey: 'test', fetch }).complete(request)
  }

  await assert.rejects(
    completeWithCall({ id: 'bad', type: 'other', function: {} }),
    /invalid tool call/,
  )
  await assert.rejects(
    completeWithCall({ id: 'bad', type: 'function', function: { name: 1, arguments: '{}' } }),
    /invalid tool function/,
  )
  await assert.rejects(
    completeWithCall({
      id: 'bad',
      type: 'function',
      function: { name: 'add', arguments: '{not json}' },
    }),
    /invalid JSON arguments/,
  )
  await assert.rejects(
    completeWithCall({
      id: 'bad',
      type: 'function',
      function: { name: 'add', arguments: '1e400' },
    }),
    /non-JSON arguments/,
  )
})

test('optional live completion returns text when explicitly enabled', {
  skip: process.env.OPENROUTER_LIVE_TEST !== '1' || !process.env.OPENROUTER_API_KEY,
}, async () => {
  const adapter = new OpenRouterModelAdapter({
    apiKey: process.env.OPENROUTER_API_KEY!,
    ...(process.env.OPENROUTER_MODEL ? { model: process.env.OPENROUTER_MODEL } : {}),
  })
  const deltas: string[] = []
  const response = await adapter.complete(
    {
      sessionId: 'live-smoke',
      turnId: 'live-smoke:turn:1',
      step: 1,
      messages: [{ role: 'user', content: 'Reply with exactly: live ok' }],
      tools: [],
    },
    {
      onTextDelta: (delta) => {
        deltas.push(delta)
      },
    },
  )
  assert.equal(response.type, 'message')
  assert.ok(response.type === 'message' && response.content.length > 0)
  assert.equal(deltas.join(''), response.type === 'message' ? response.content : '')
})
