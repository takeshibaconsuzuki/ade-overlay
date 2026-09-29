import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
app.setPath('userData', join(root, 'browser'))
function fixtureText() {
  return 'First middle last'
}
async function run() {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  try {
    await window.loadFile(join(root, 'index.html'))
    window.focus()
    const contents = window.webContents
    await contents.executeJavaScript(`(async () => {
    globalThis.pasteModule = await import(${JSON.stringify(pathToFileURL(join(root, 'chat-paste.mjs')).href)});
    globalThis.contentModule = await import(${JSON.stringify(pathToFileURL(join(root, 'paste-content.mjs')).href)});
    globalThis.fetch = async url => { if (String(url).includes('/blocked.png')) throw new TypeError('CORS'); await new Promise(resolve => setTimeout(resolve, String(url).includes('/1.png') ? 20 : 0)); return new Response(new Blob([String(url).includes('/1.png') ? new Uint8Array([1, 2]) : new Uint8Array([3, 4])], { type: 'image/png' })); };
    globalThis.fixture = { text: 'First middle last', html: '<p>First <b>bold</b></p><img src="https://example.test/1.png" alt="One"><p>Middle &amp; more</p><img src="//example.test/2.png"><p>Last</p>', images: [] };
  })()`)
    const parsed = await contents.executeJavaScript(
      'contentModule.parsePaste(fixture)',
    )
    assert.deepEqual(parsed, [
      { type: 'text', data: 'First bold' },
      { type: 'image', data: 'https://example.test/1.png' },
      { type: 'text', data: 'Middle & more' },
      { type: 'image', data: 'https://example.test/2.png' },
      { type: 'text', data: 'Last' },
    ])
    const image = '<img src="https://example.test/1.png">'
    const imagePart = { type: 'image', data: 'https://example.test/1.png' }
    for (const [html, expected] of [
      [
        ` \n <pre>  first\n  second</pre> \n ${image}<p>  after  </p>`,
        [
          { type: 'text', data: '  first\n  second' },
          imagePart,
          { type: 'text', data: 'after' },
        ],
      ],
      [
        `${image}<pre><code>\n\tfirst  \n  second\n\n</code></pre> \n `,
        [imagePart, { type: 'text', data: '\n\tfirst  \n  second\n\n' }],
      ],
      [
        `<p>Before</p><pre>  code  </pre><p>After</p>${image}`,
        [{ type: 'text', data: 'Before\n  code  \nAfter' }, imagePart],
      ],
      [
        `${image}<pre> \t </pre>${image}`,
        [imagePart, { type: 'text', data: ' \t ' }, imagePart],
      ],
      [
        `<pre><code>  first</code><br><code>\tsecond </code><br></pre>${image}`,
        [{ type: 'text', data: '  first\n\tsecond \n' }, imagePart],
      ],
    ]) {
      assert.deepEqual(
        await contents.executeJavaScript(
          `contentModule.parsePaste({ text: 'plain fallback must not replace rich content', html: ${JSON.stringify(html)}, images: [] })`,
        ),
        expected,
        'Rich text preserves preformatted whitespace across image boundaries',
      )
    }
    assert.deepEqual(
      await contents.executeJavaScript(
        `contentModule.parsePaste({ ...fixture, html: '', text: ${JSON.stringify('  code\n    indented\n')} })`,
      ),
      [{ type: 'text', data: '  code\n    indented\n' }],
    )
    const bytes = await contents.executeJavaScript(
      `contentModule.readPaste(fixture).then(parts => parts.map(part => ({ ...part, data: typeof part.data === 'string' ? part.data : Array.from(part.data) })))`,
    )
    assert.deepEqual(
      bytes.map((part) => part.data),
      ['First bold', [1, 2], 'Middle & more', [3, 4], 'Last'],
    )
    const images = await contents.executeJavaScript(
      `contentModule.readPaste({ text: '', html: '', images: [new Blob([new Uint8Array([7, 8])], { type: 'image/png' })] }).then(parts => Array.from(parts[0].data))`,
    )
    assert.deepEqual(images, [7, 8])
    assert.deepEqual(
      await contents.executeJavaScript(
        `contentModule.readPaste({ text: '', html: '<img src="data:image/png;base64,AQID">', images: [] }).then(parts => Array.from(parts[0].data))`,
      ),
      [1, 2, 3],
    )
    const unsafe = await contents.executeJavaScript(
      `contentModule.readPaste({ ...fixture, html: '<script>throw 1</script><style>bad</style><p>Safe</p><img src="relative.png"><p hidden>Hidden</p>' })`,
    )
    assert.deepEqual(
      unsafe.map((part) => part.data),
      ['Safe', 'relative.png'],
    )
    assert.deepEqual(
      await contents.executeJavaScript(
        `contentModule.readPaste({ ...fixture, html: '<p>Before</p><img src="https://example.test/blocked.png"><p>After</p>' })`,
      ),
      [
        { type: 'text', data: 'Before' },
        { type: 'image', data: 'https://example.test/blocked.png' },
        { type: 'text', data: 'After' },
      ],
    )
    await contents.executeJavaScript(`(() => {
      // No tab, icon, title, or accessibility label identifies these terminals.
      document.body.innerHTML = '<div class="xterm"><textarea></textarea></div><textarea id="editor"></textarea>';
      globalThis.logs = [];
      console.info = (...args) => logs.push(args);
      globalThis.delivered = [];
      globalThis.submitted = [];
      globalThis.reservations = [];
      globalThis.plainReads = 0;
      globalThis.richReads = 0;
      navigator.clipboard.readText = async () => { plainReads++; return 'plain fallback'; };
      navigator.clipboard.read = async () => { richReads++; return [new ClipboardItem({ 'text/plain': new Blob([fixture.text], { type: 'text/plain' }), 'text/html': new Blob([fixture.html], { type: 'text/html' }) })]; };
      globalThis.disposePaste = pasteModule.installChatPastePreview({
        reservePaste: () => new Promise((resolve, reject) => reservations.push({ resolve, reject })),
        paste: async (id, items) => submitted.push({ id, items }),
      });
      globalThis.terminal = document.querySelector('.xterm textarea');
      terminal.addEventListener('paste', event => delivered.push(event.clipboardData.getData('text/plain')));
      terminal.focus();
      globalThis.nativePaste = () => {
        const data = new DataTransfer();
        data.setData('text/plain', fixture.text);
        data.setData('text/html', fixture.html);
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        terminal.dispatchEvent(event);
        data.clearData(); // Browser clears access after dispatch.
        return event.defaultPrevented;
      };
    })()`)
    const until = async (expression) => {
      await contents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => (${expression}) ? resolve() : Date.now() > deadline ? reject(new Error('Timed out: ' + ${JSON.stringify(expression)})) : setTimeout(poll, 5);
        poll();
      })`)
    }
    assert.equal(await contents.executeJavaScript('nativePaste()'), true)
    assert.deepEqual(
      await contents.executeJavaScript(
        '({ delivered, submitted, pending: reservations.length })',
      ),
      { delivered: [], submitted: [], pending: 1 },
    )
    await contents.executeJavaScript(`reservations.shift().resolve('chat-1')`)
    await until('submitted.length === 1')
    assert.deepEqual(await contents.executeJavaScript('delivered'), [])
    assert.deepEqual(
      await contents.executeJavaScript(
        `submitted[0].items.map(part => typeof part.data === 'string' ? part.data : Array.from(part.data))`,
      ),
      ['First bold', [1, 2], 'Middle & more', [3, 4], 'Last'],
    )
    assert.equal(await contents.executeJavaScript('submitted[0].id'), 'chat-1')

    // Ordinary native paste is replayed exactly once, after target resolution.
    await contents.executeJavaScript('nativePaste()')
    assert.deepEqual(await contents.executeJavaScript('delivered'), [])
    await contents.executeJavaScript('reservations.shift().resolve(null)')
    await until('delivered.length === 1')
    assert.deepEqual(await contents.executeJavaScript('delivered'), [
      fixtureText(),
    ])

    // The command/keyboard API path is held too, including text-only pastes.
    await contents.executeJavaScript(
      `globalThis.apiResult = undefined; navigator.clipboard.readText().then(text => apiResult = text); void 0`,
      true,
    )
    assert.equal(await contents.executeJavaScript('apiResult'), undefined)
    await contents.executeJavaScript(`reservations.shift().resolve('chat-2')`)
    await until('apiResult !== undefined')
    assert.equal(await contents.executeJavaScript('apiResult'), '')
    assert.equal(await contents.executeJavaScript('submitted.length'), 2)
    await contents.executeJavaScript(
      `apiResult = undefined; navigator.clipboard.readText().then(text => apiResult = text); void 0`,
      true,
    )
    await contents.executeJavaScript('reservations.shift().resolve(null)')
    await until('apiResult !== undefined')
    assert.equal(await contents.executeJavaScript('apiResult'), fixtureText())

    // A later reservation may finish first; delivery still follows paste order.
    await contents.executeJavaScript(
      `fixture.text = 'earlier'; nativePaste(); fixture.text = 'later'; nativePaste(); reservations[1].resolve(null)`,
    )
    assert.equal(await contents.executeJavaScript('delivered.length'), 1)
    await contents.executeJavaScript(
      'reservations.shift().resolve(null); reservations.shift(); void 0',
    )
    await until('delivered.length === 3')
    assert.deepEqual(await contents.executeJavaScript('delivered'), [
      fixtureText(),
      'earlier',
      'later',
    ])

    // Disconnection cannot accidentally release text into a chat terminal.
    await contents.executeJavaScript(
      `nativePaste(); reservations.shift().reject(new Error('disconnected'))`,
    )
    await contents.executeJavaScript(
      'new Promise(resolve => setTimeout(resolve, 20))',
    )
    assert.equal(await contents.executeJavaScript('delivered.length'), 3)
    await contents.executeJavaScript(
      `navigator.clipboard.read = async () => { throw new Error('unsupported'); }; apiResult = undefined; navigator.clipboard.readText().then(text => apiResult = text); void 0`,
      true,
    )
    await contents.executeJavaScript(
      `reservations.shift().resolve('chat-plain')`,
    )
    await until('apiResult !== undefined')
    assert.deepEqual(
      await contents.executeJavaScript('submitted.at(-1).items'),
      [{ type: 'text', data: 'plain fallback' }],
    )
    assert.equal(await contents.executeJavaScript('apiResult'), '')

    // All four pastes start their image reads before the first one finishes.
    // Later downloads may complete first, but submissions must keep paste order.
    const submissionCount = await contents.executeJavaScript('submitted.length')
    await contents.executeJavaScript(`(() => {
      const previousFetch = globalThis.fetch;
      const previousFixture = { ...fixture };
      globalThis.imageReads = new Map();
      globalThis.completedImages = [];
      globalThis.fetch = async url => {
        const bytes = await new Promise(resolve => imageReads.set(String(url), resolve));
        completedImages.push(String(url));
        return new Response(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      };
      globalThis.restoreConcurrentFixture = () => {
        globalThis.fetch = previousFetch;
        Object.assign(fixture, previousFixture);
      };
      for (let index = 0; index < 4; index++) {
        fixture.html = '<p>Before ' + index + '</p><img src="https://example.test/concurrent-' + index + '.png"><p>After ' + index + '</p>';
        nativePaste();
        reservations.shift().resolve('concurrent-' + index);
      }
    })()`)
    await until('imageReads.size === 4')
    await contents.executeJavaScript(`(() => {
      for (const index of [3, 2, 1]) imageReads.get('https://example.test/concurrent-' + index + '.png')([index]);
    })()`)
    await until('completedImages.length === 3')
    assert.equal(
      await contents.executeJavaScript('submitted.length'),
      submissionCount,
    )
    await contents.executeJavaScript(
      `imageReads.get('https://example.test/concurrent-0.png')([0])`,
    )
    await until(`submitted.length === ${submissionCount + 4}`)
    assert.deepEqual(
      await contents.executeJavaScript(`submitted.slice(${submissionCount}).map(({ id, items }) => ({
        id, items: items.map(part => ({ ...part, data: typeof part.data === 'string' ? part.data : Array.from(part.data) })),
      }))`),
      [0, 1, 2, 3].map((index) => ({
        id: `concurrent-${index}`,
        items: [
          { type: 'text', data: `Before ${index}` },
          { type: 'image', data: [index] },
          { type: 'text', data: `After ${index}` },
        ],
      })),
    )
    await contents.executeJavaScript('restoreConcurrentFixture()')

    await contents.executeJavaScript(
      `document.querySelector('#editor').focus()`,
    )
    assert.equal(
      await contents.executeJavaScript('navigator.clipboard.readText()', true),
      'plain fallback',
    )
    assert.equal(await contents.executeJavaScript('reservations.length'), 0)
    await contents.executeJavaScript(
      'terminal.focus(); nativePaste(); disposePaste(); reservations.shift().resolve(null)',
    )
    await contents.executeJavaScript(
      'new Promise(resolve => setTimeout(resolve, 20))',
    )
    assert.equal(await contents.executeJavaScript('delivered.length'), 3)
    assert.equal(
      await contents.executeJavaScript('navigator.clipboard.readText()', true),
      'plain fallback',
    )
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true }))
  } catch (error) {
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify({ error: error.stack }),
    )
    app.exit(1)
  }
  app.exit(0)
}
run().catch((error) => {
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({ error: error.stack }),
  )
  app.exit(1)
})
