// Run with: node --experimental-strip-types --experimental-test-module-mocks --test src/sources/youtube/search-egress.test.mjs
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import config from '../../../config.default.ts'
import * as utils from '../../utils.ts'

const requests = []
const logs = []
mock.module('../../utils.ts', {
  namedExports: {
    ...utils,
    logger: (...args) => logs.push(args),
    makeRequest: async (url, options) => {
      requests.push({ url, options })
      // A failed response forces source-level fallback without contacting YouTube.
      return { statusCode: 503, error: 'test upstream unavailable', body: {} }
    }
  }
})

const { default: YouTubeSource } = await import('./YouTube.ts')
const clients = await Promise.all(
  ['Android', 'AndroidVR', 'Web', 'WebEmbedded', 'visionOs', 'Music', 'Web_Remix']
    .map(async (name) => [name, (await import(`./clients/${name}.ts`)).default])
)
const proxy = { url: 'http://127.0.0.1:12345', type: 'forward' }

function fixture(mode) {
  const options = structuredClone(config)
  options.sources.youtube.proxyMode = mode
  options.sources.youtube.proxies = [proxy]
  options.sources.youtube.clients.search = ['Android', 'Web']
  let source
  const nodelink = { options, sources: { getSource: () => source } }
  source = new YouTubeSource(nodelink)
  source.clients = Object.fromEntries(
    clients.map(([name, Client]) => [name, new Client(nodelink, null)])
  )
  source.clients.WebRemix = source.clients.Web_Remix
  return source
}

for (const mode of ['off', 'control', 'all']) {
  test(`${mode}: every search client follows playback egress`, async () => {
    const source = fixture(mode)
    try {
      for (const [name] of clients) {
        requests.length = 0
        // Call clients directly too: undefined must not restore the bootstrap proxy.
        await source.clients[name].search('test song', 'track', source.ytContext)
        assert.equal(requests.length, 1, `${name} must issue one search`)
        assert.match(requests[0].url, /\/youtubei\/v1\/search/)
        assert.equal(Boolean(requests[0].options.proxy), mode === 'all', name)
      }
      assert.equal(Boolean(source.getProxy()), mode !== 'off', 'bootstrap route')
      assert.equal(Boolean(source.getPlayerProxy()), mode === 'all', 'player route')
      assert.equal(Boolean(source.getMediaProxy()), mode === 'all', 'media route')
    } finally {
      source.cleanup()
    }
  })

  test(`${mode}: source fallback and routing logs follow search egress`, async () => {
    const source = fixture(mode)
    try {
      requests.length = 0
      logs.length = 0
      await source.search('test song', 'ytsearch')
      assert.equal(requests.length, 2, 'Android then Web fallback')
      for (const request of requests) {
        assert.equal(Boolean(request.options.proxy), mode === 'all')
      }
      const routeLogs = logs.map((args) => args.at(-1))
        .filter((message) => message.includes('egress operation=search'))
      assert.equal(routeLogs.length, 2)
      for (const message of routeLogs) {
        assert.ok(message.includes(`route=${mode === 'all' ? 'proxy' : 'direct'}`))
      }
    } finally {
      source.cleanup()
    }
  })

  test(`${mode}: YouTube Music search fallback follows playback egress`, async () => {
    const source = fixture(mode)
    try {
      requests.length = 0
      await source.search('test song', 'ytmsearch')
      assert.equal(requests.length, 2, 'WebRemix then Music fallback')
      for (const request of requests) {
        assert.equal(Boolean(request.options.proxy), mode === 'all')
      }
    } finally {
      source.cleanup()
    }
  })
}
