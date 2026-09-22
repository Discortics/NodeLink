import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { after, test } from 'node:test'
import { once } from 'node:events'
import { shouldProxyYouTube, youtubeFetch } from './egress.ts'
import CipherManager from './CipherManager.ts'
import { http1makeRequest, makeRequest } from '../../utils.ts'

const auth = `Basic ${Buffer.from('example-user:example-pass').toString('base64')}`
let targetRequests = 0
let proxyConnects = 0
const target = http.createServer((_request, response) => {
  targetRequests++
  response.writeHead(200, { 'Content-Type': 'text/plain' })
  response.end('ok')
})
target.listen(0, '127.0.0.1')
await once(target, 'listening')
const targetUrl = `http://127.0.0.1:${target.address().port}/sample`

const proxy = http.createServer((request, response) => {
  assert.equal(request.headers['proxy-authorization'], auth)
  proxyConnects++
  const upstream = http.request(targetUrl, { method: request.method }, (result) => {
    response.writeHead(result.statusCode ?? 502, result.headers)
    result.pipe(response)
  })
  upstream.on('error', () => response.destroy())
  request.pipe(upstream)
})
proxy.on('connect', (request, socket, head) => {
  assert.equal(request.headers['proxy-authorization'], auth)
  proxyConnects++
  const upstream = net.connect(target.address().port, '127.0.0.1')
  upstream.once('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
})
proxy.listen(0, '127.0.0.1')
await once(proxy, 'listening')
const proxyConfig = {
  url: `http://127.0.0.1:${proxy.address().port}`,
  username: 'example-user',
  password: 'example-pass',
  type: 'forward'
}
after(() => {
  target.closeAllConnections()
  proxy.closeAllConnections()
  target.close()
  proxy.close()
})

test('request classification keeps internal cipher and control-mode media direct', () => {
  for (const mode of ['off', 'control', 'all']) {
    assert.equal(shouldProxyYouTube(mode, 'internal'), false)
  }
  assert.equal(shouldProxyYouTube('off', 'control'), false)
  assert.equal(shouldProxyYouTube('control', 'control'), true)
  assert.equal(shouldProxyYouTube('control', 'media'), false)
  assert.equal(shouldProxyYouTube('all', 'media'), true)
})

test('authenticated native fetch uses a per-request proxy for SABR and PO token traffic', async () => {
  const before = proxyConnects
  const response = await youtubeFetch(targetUrl, {}, proxyConfig, 'sabr', 'media')
  assert.equal(await response.text(), 'ok')
  assert.ok(proxyConnects > before)

  const afterProxy = proxyConnects
  const direct = await youtubeFetch(targetUrl, {}, undefined, 'potoken', 'control')
  assert.equal(await direct.text(), 'ok')
  assert.equal(proxyConnects, afterProxy)
})

test('makeRequest options.proxy and HLS or HTTP preflight use authenticated proxy transport', async () => {
  const before = proxyConnects
  const control = await makeRequest(targetUrl, { method: 'GET', proxy: proxyConfig })
  assert.equal(control.statusCode, 200)
  assert.ok(proxyConnects > before)

  const afterControl = proxyConnects
  const hls = await http1makeRequest(targetUrl, { method: 'GET', proxy: proxyConfig })
  assert.equal(hls.statusCode, 200)
  assert.ok(proxyConnects > afterControl)

  const afterHls = proxyConnects
  const direct = await http1makeRequest(targetUrl, { method: 'HEAD' })
  assert.equal(direct.statusCode, 200)
  assert.equal(proxyConnects, afterHls)
  assert.ok(targetRequests >= 4)
})

test('internal cipher health request stays direct even with a YouTube proxy', async () => {
  const cipher = new CipherManager({
    options: { sources: { youtube: { cipher: { url: targetUrl } } } },
    sources: { getSource: () => ({ getProxy: () => proxyConfig }) }
  })
  try {
    const before = proxyConnects
    assert.equal(await cipher.checkCipherServerStatus(), true)
    assert.equal(proxyConnects, before)
  } finally {
    cipher.cleanup()
  }
})
