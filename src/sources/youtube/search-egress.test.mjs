// Run with: node --experimental-strip-types --experimental-test-module-mocks --test src/sources/youtube/search-egress.test.mjs
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import config from '../../../config.default.ts'
import * as utils from '../../utils.ts'

const requests = []
const logs = []
const failedResponse = {
  statusCode: 503,
  error: 'test upstream unavailable',
  body: {}
}
let respond = () => failedResponse
const captureRequest = async (url, options) => {
  requests.push({ url, options })
  // A failed response forces source-level fallback without contacting YouTube.
  return respond(url, options)
}
mock.module('../../utils.ts', {
  namedExports: {
    ...utils,
    logger: (...args) => logs.push(args),
    makeRequest: captureRequest,
    http1makeRequest: captureRequest
  }
})

const egress = await import('./egress.ts')
mock.module('./egress.ts', {
  namedExports: {
    ...egress,
    youtubeFetch: async (url, options, proxy) => {
      requests.push({ url, options: { ...options, proxy } })
      return new Response('"VISITOR_DATA":"sample-visitor"', { status: 200 })
    }
  }
})

const { default: YouTubeSource } = await import('./YouTube.ts')
const { poTokenManager } = await import('./sabr/potoken.ts')
const clients = await Promise.all(
  [
    'Android',
    'AndroidVR',
    'Web',
    'WebEmbedded',
    'visionOs',
    'Music',
    'Web_Remix'
  ].map(async (name) => [name, (await import(`./clients/${name}.ts`)).default])
)
const extraClients = await Promise.all(
  ['IOS', 'TV', 'TVCast', 'TV_downgraded', 'TVEmbedded'].map(async (name) => [
    name,
    (await import(`./clients/${name}.ts`)).default
  ])
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
    [...clients, ...extraClients].map(([name, Client]) => [
      name,
      new Client(nodelink, null)
    ])
  )
  source.clients.WebRemix = source.clients.Web_Remix
  return source
}

for (const mode of ['off', 'control', 'all']) {
  test(`${mode}: visitor bootstrap and fallbacks retain the bootstrap route`, async () => {
    const source = fixture(mode)
    try {
      requests.length = 0
      await source._fetchVisitorData()
      assert.equal(
        requests.length,
        3,
        'music visitor, embed, then guide fallback'
      )
      for (const request of requests) {
        assert.equal(Boolean(request.options.proxy), mode !== 'off')
      }
      requests.length = 0
      await source.clients.Web.getVisitorData()
      assert.equal(requests.length, 1)
      assert.equal(Boolean(requests[0].options.proxy), mode !== 'off')
      requests.length = 0
      assert.equal(await poTokenManager.fetchVisitorData(), 'sample-visitor')
      assert.equal(requests.length, 1)
      assert.equal(Boolean(requests[0].options.proxy), mode !== 'off')
    } finally {
      source.cleanup()
    }
  })

  test(`${mode}: player-script bootstrap retains its proxy route`, async () => {
    const source = fixture(mode)
    try {
      source.cipherManager.config.url = ''
      respond = () => ({ statusCode: 200, body: 'signatureTimestamp:123456' })
      requests.length = 0
      assert.equal(
        await source.cipherManager.getTimestamp(
          'https://www.youtube.com/s/player/test/base.js'
        ),
        '123456'
      )
      assert.equal(requests.length, 1)
      assert.equal(Boolean(requests[0].options.proxy), mode !== 'off')
    } finally {
      respond = () => failedResponse
      source.cleanup()
    }
  })

  test(`${mode}: every search client follows playback egress`, async () => {
    const source = fixture(mode)
    try {
      for (const [name] of clients) {
        requests.length = 0
        // Call clients directly too: undefined must not restore the bootstrap proxy.
        await source.clients[name].search(
          'test song',
          'track',
          source.ytContext
        )
        assert.equal(requests.length, 1, `${name} must issue one search`)
        assert.match(requests[0].url, /\/youtubei\/v1\/search/)
        assert.equal(Boolean(requests[0].options.proxy), mode === 'all', name)
      }
      assert.equal(
        Boolean(source.getProxy()),
        mode !== 'off',
        'bootstrap route'
      )
      assert.equal(
        Boolean(source.getPlayerProxy()),
        mode === 'all',
        'player route'
      )
      assert.equal(
        Boolean(source.getMediaProxy()),
        mode === 'all',
        'media route'
      )
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
      const routeLogs = logs
        .map((args) => args.at(-1))
        .filter((message) => message.includes('egress operation=search'))
      assert.equal(routeLogs.length, 2)
      for (const message of routeLogs) {
        assert.ok(
          message.includes(`route=${mode === 'all' ? 'proxy' : 'direct'}`)
        )
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

  test(`${mode}: every playlist and radio resolver follows playback egress`, async () => {
    const source = fixture(mode)
    try {
      for (const [name] of [...clients, ...extraClients]) {
        for (const playlistId of ['PL_test', 'RDabcdefghijk']) {
          requests.length = 0
          await source.clients[name].resolve(
            `https://www.youtube.com/playlist?list=${playlistId}&v=abcdefghijk`,
            'youtube',
            source.ytContext,
            null
          )
          assert.equal(requests.length, 1, `${name}: ${playlistId}`)
          assert.match(requests[0].url, /\/youtubei\/v1\/(browse|next)/)
          assert.equal(Boolean(requests[0].options.proxy), mode === 'all', name)
        }
      }
    } finally {
      source.cleanup()
    }
  })

  test(`${mode}: recommendations and their TV fallback follow playback egress`, async () => {
    const source = fixture(mode)
    try {
      requests.length = 0
      await source.getRecommendations('abcdefghijk')
      assert.equal(requests.length, 2, 'WebRemix then TV radio fallback')
      for (const request of requests) {
        assert.equal(Boolean(request.options.proxy), mode === 'all')
      }
    } finally {
      source.cleanup()
    }
  })

  test(`${mode}: chapters and video next requests follow playback egress`, async () => {
    const source = fixture(mode)
    try {
      for (const name of ['Web', 'WebEmbedded']) {
        requests.length = 0
        await assert.rejects(
          source.clients[name].getChapters(
            { identifier: 'abcdefghijk', length: 60000 },
            source.ytContext
          ),
          /Search failed for chapters/
        )
        assert.equal(requests.length, 1)
        assert.equal(Boolean(requests[0].options.proxy), mode === 'all')
      }
      requests.length = 0
      await source.clients.Web._makeNextRequest(
        'abcdefghijk',
        source.ytContext,
        {}
      )
      assert.equal(requests.length, 1)
      assert.equal(Boolean(requests[0].options.proxy), mode === 'all')
    } finally {
      source.cleanup()
    }
  })

  test(`${mode}: playlist continuation requests follow playback egress`, async () => {
    const source = fixture(mode)
    try {
      const renderer = {
        contents: [{ playlistVideoRenderer: { videoId: 'abcdefghijk' } }],
        continuations: [{ nextContinuationData: { continuation: 'next-page' } }]
      }
      requests.length = 0
      await source.clients.Android._handleBrowsePlaylistResponse(
        'PL_test',
        {
          contents: {
            singleColumnBrowseResultsRenderer: {
              tabs: [
                {
                  tabRenderer: {
                    content: {
                      sectionListRenderer: {
                        contents: [{ playlistVideoListRenderer: renderer }]
                      }
                    }
                  }
                }
              ]
            }
          }
        },
        'youtube',
        source.ytContext
      )
      const browsePages = requests.filter(
        (request) => request.options.body?.continuation
      )
      assert.equal(browsePages.length, 1, 'Android browse continuation')
      assert.equal(browsePages[0].options.body.continuation, 'next-page')
      assert.equal(Boolean(browsePages[0].options.proxy), mode === 'all')

      requests.length = 0
      await source.clients.Music._handlePlaylistResponse(
        'PL_test',
        null,
        {
          contents: {
            singleColumnMusicWatchNextResultsRenderer: {
              playlist: {
                playlist: {
                  contents: [
                    { playlistPanelVideoRenderer: { videoId: 'abcdefghijk' } }
                  ]
                }
              },
              tabbedRenderer: {
                watchNextTabbedResultsRenderer: {
                  tabs: [
                    {
                      tabRenderer: {
                        content: {
                          musicQueueRenderer: {
                            content: {
                              playlistPanelRenderer: {
                                continuations: [
                                  {
                                    nextContinuationData: {
                                      continuation: 'music-next-page'
                                    }
                                  }
                                ]
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        },
        'ytmusic',
        source.ytContext
      )
      const musicPages = requests.filter(
        (request) => request.options.body?.continuation
      )
      assert.equal(musicPages.length, 1, 'YouTube Music next continuation')
      assert.equal(musicPages[0].options.body.continuation, 'music-next-page')
      assert.equal(Boolean(musicPages[0].options.proxy), mode === 'all')
    } finally {
      source.cleanup()
    }
  })

  test(`${mode}: live-chat bootstrap and polls follow playback egress`, async () => {
    const source = fixture(mode)
    try {
      respond = (url) => ({
        statusCode: 200,
        body: url.includes('/live_chat/')
          ? {
              continuationContents: {
                liveChatContinuation: {
                  actions: [],
                  continuations: [
                    {
                      timedContinuationData: {
                        continuation: 'poll-again',
                        timeoutMs: 1000
                      }
                    }
                  ]
                }
              }
            }
          : {
              contents: {
                twoColumnWatchNextResults: {
                  conversationBar: {
                    liveChatRenderer: {
                      continuations: [
                        {
                          reloadContinuationData: { continuation: 'first-poll' }
                        }
                      ]
                    }
                  }
                }
              }
            }
      })
      requests.length = 0
      const chat = await source.liveChat.getLiveChat('abcdefghijk')
      assert.ok(chat)
      assert.ok(await chat.poll())
      assert.equal(requests.length, 2, 'video next then live-chat poll')
      for (const request of requests) {
        assert.equal(Boolean(request.options.proxy), mode === 'all')
      }
    } finally {
      respond = () => failedResponse
      source.cleanup()
    }
  })
}
