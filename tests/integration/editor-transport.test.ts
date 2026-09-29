import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'
import {
  gzipSync,
  deflateSync,
  deflateRawSync,
  brotliCompressSync,
} from 'node:zlib'
import { test, type TestContext } from 'node:test'
import { createEditorTransport } from '../../src/server/editors/editor-transport.ts'
import { SettingsSync } from '../../src/server/editors/settings-sync.ts'
import { silentLogger } from '../../src/server/logging.ts'
import { load } from 'cheerio'

const path = `/editors/${'a'.repeat(64)}/`
const html =
  '<html><head><meta id="vscode-workbench-web-configuration" data-settings="{}"><script nonce="fixture"></script></head><body>café 中文 🧪</body></html>'
const cookies = ['vscode-tkn=runtime; SameSite=Lax', 'preference=fr; Path=/']

async function fixture(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const upstream = createServer(handler)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const transport = createEditorTransport({
    target: () => ({
      url: target,
      token: 'test',
      profile: { name: 'fixture', contents: '{}' },
      settings: new SettingsSync('unused-settings.json', silentLogger),
    }),
    activation: () => 'current-activation',
    logger: silentLogger,
  })
  const server = createServer(transport.handleRequest)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    transport.close()
    server.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ])
  })
  return {
    upstream,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
  }
}

async function get(url: string) {
  const outgoing = request(url, {
    headers: {
      Authorization: 'Bearer test',
      'X-Forwarded-Host': 'editor.example.test',
      Cookie: 'vscode-tkn=old; preference=fr',
    },
  })
  const received = once(outgoing, 'response')
  outgoing.end()
  const [response] = (await received) as [IncomingMessage]
  return {
    status: response.statusCode,
    headers: response.headers,
    body: await text(response),
  }
}

test(
  'HTTP/1.0 editor documents accept a missing Host header',
  { timeout: 5000 },
  async (t) => {
    const forwarded: (string | string[] | undefined)[] = []
    const { url } = await fixture(t, (request, response) => {
      forwarded.push(request.headers['x-forwarded-host'])
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(html)
    })
    const endpoint = new URL(url)
    for (const authority of [undefined, 'editor.example.test']) {
      // http.request supplies Host automatically; use the actual HTTP/1.0 wire shape.
      const socket = connect({
        host: endpoint.hostname,
        port: Number(endpoint.port),
      })
      t.after(() => socket.destroy())
      const response = text(socket)
      socket.write(
        [
          `GET ${endpoint.pathname} HTTP/1.0`,
          'Authorization: Bearer test',
          ...(authority ? [`X-Forwarded-Host: ${authority}`] : []),
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      )
      const result = await response
      assert.match(result, /^HTTP\/1\.[01] 200 /)
      assert.match(result, /ade-settings-sync\.js/)
    }
    assert.deepEqual(forwarded, [undefined, 'editor.example.test'])
    assert.equal((await get(url)).status, 200)
  },
)

for (const [encoding, encode] of [
  ['identity', (body: string) => Buffer.from(body)],
  ['gzip', gzipSync],
  ['deflate', deflateSync],
  ['deflate', deflateRawSync],
  ['br', brotliCompressSync],
] as const) {
  test(
    `document proxy transforms ${encode === deflateRawSync ? 'raw deflate' : encoding} responses and preserves headers`,
    { timeout: 5000 },
    async (t) => {
      const { url } = await fixture(t, (request, response) => {
        assert.equal(request.url, `${path}?workspace=example`)
        assert.equal(request.headers['x-forwarded-host'], 'editor.example.test')
        assert.equal(request.headers.authorization, undefined)
        assert.equal(request.headers.cookie, 'vscode-tkn=test; preference=fr')
        const body = encode(html)
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': encoding,
          'Content-Length': body.length,
          'Set-Cookie': cookies,
          'Cache-Control': 'public',
        })
        response.end(body)
      })
      const response = await get(`${url}?workspace=example&tkn=stale`)
      assert.equal(response.status, 200)
      assert.deepEqual(response.headers['set-cookie'], cookies)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(response.headers['content-encoding'], undefined)
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8')
      if (response.headers['content-length'])
        assert.equal(
          Number(response.headers['content-length']),
          Buffer.byteLength(response.body),
        )
      const page = load(response.body)
      assert.equal(page('body').text(), 'café 中文 🧪')
      assert.deepEqual(
        JSON.parse(
          page('#vscode-workbench-web-configuration').attr('data-settings')!,
        ).profile,
        { name: 'fixture', contents: '{}' },
      )
      assert.equal(
        page('meta[name="ade-chat-activation-after"]').attr('content'),
        'current-activation',
      )
      assert.equal(
        page(`script[src="${path}ade-settings-sync.js"]`).attr('nonce'),
        'fixture',
      )
    },
  )
}

test(
  'document proxy follows redirects and preserves non-success responses',
  { timeout: 5000 },
  async (t) => {
    let failure = false
    const { url } = await fixture(t, (request, response) => {
      if (request.url === path) {
        response.writeHead(302, { Location: '/final' }).end()
        return
      }
      assert.equal(request.url, '/final')
      assert.match(request.headers.cookie!, /vscode-tkn=test/)
      response.writeHead(failure ? 503 : 200, {
        'Content-Encoding': 'gzip',
        'Set-Cookie': cookies,
      })
      response.end(gzipSync(failure ? 'Temporarily unavailable' : html))
    })
    const response = await get(url)
    assert.equal(response.status, 200)
    assert.match(response.body, /ade-settings-sync.js/)
    failure = true
    const failed = await get(url)
    assert.equal(failed.status, 503)
    assert.equal(failed.body, 'Temporarily unavailable')
    assert.deepEqual(failed.headers['set-cookie'], cookies)
  },
)

for (const failure of ['truncated', 'invalid-compression', 'invalid-html']) {
  test(
    `document proxy handles ${failure} through the shared error response`,
    { timeout: 5000 },
    async (t) => {
      const { url } = await fixture(t, (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'gzip' })
        if (failure === 'truncated') {
          response.write(gzipSync(html).subarray(0, 12))
          setImmediate(() => response.destroy())
        } else
          response.end(
            failure === 'invalid-compression'
              ? 'bad gzip'
              : gzipSync('<html></html>'),
          )
      })
      const response = await get(url)
      assert.equal(response.status, 502)
      assert.equal(
        response.body,
        'Editor unavailable. Open the worktree again.',
      )
    },
  )
}

for (const started of [false, true]) {
  test(
    `document deadline includes waiting for ${started ? 'the body' : 'headers'}`,
    { timeout: 5000 },
    async (t) => {
      const { url, upstream } = await fixture(t, (_request, response) => {
        if (started) response.write(html)
      })
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const received = once(upstream, 'request')
      const result = get(url)
      const [, pending] = (await received) as [IncomingMessage, ServerResponse]
      t.mock.timers.tick(29_999)
      assert.equal(pending.destroyed, false)
      if (started) pending.write('more body data')
      t.mock.timers.tick(1)
      assert.equal((await result).status, 502)
    },
  )
}
