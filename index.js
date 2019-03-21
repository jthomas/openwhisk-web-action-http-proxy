'use strict';

const express = require('express')
const fetch = require('node-fetch')
const isBase64 = require('is-base64')
const waitForLocalhost = require('wait-for-localhost')
 
// environment variables used to configure HTTP service to proxy
// PROXY_HOST, PROXY_PORT, PROXY_ALIVE_PATH and PROXY_PROTOCOL
// defaults to: http://localhost:80/
const proxy_host = process.env['PROXY_HOST'] || 'localhost'
const proxy_port = process.env['PROXY_PORT'] || 80
const proxy_alive_path = process.env['PROXY_ALIVE_PATH'] || '/'
const proxy_alive_delay = process.env['PROXY_ALIVE_DELAY'] || 100
const proxy_protocol = process.env['PROXY_PROTOCOL'] || 'http'

// decode web action request bodys into byte buffer
// binary content is encoded as base64 
const decode_body = raw_body => {
  const mime = isBase64(raw_body) ? 'base64' : 'utf-8'
  return Buffer.from(raw_body, mime)
}

// only HTTP GETs and HEADs support a request body
const can_have_body = method => { 
  return method !== 'get' && method !=='head'
}
 
// does mime type refer to binary content?
// copied from same list openwhisk uses to handle encoding binary content
// https://doc.akka.io/api/akka-http/10.0.4/akka/http/scaladsl/model/MediaTypes$.html
const is_binary_content = mime => {
  const custom_text_mimes = [
    'application/atom+xml',
    'application/base64',
    'application/javascript',
    'application/json',
    'application/rss+xml',
    'application/soap+xml',
    'application/xhtml+xml',
    'application/xml',
  ]

  if (mime && mime.startsWith('text') || custom_text_mimes.includes(mime)) {
    return false
  }

  return true
}

// encode http response body into web action response body
// binary content must be base64 encoded.
const encode_response_body = async (resp) => {
  let content_type = resp.headers ? resp.headers.get('content-type') : ""

  if (content_type && content_type != "") {
    content_type = content_type.split(';')[0]
  }

  if (is_binary_content(content_type)) {
    const buf = await resp.buffer()
    return buf.toString('base64')
  }

  return await resp.text()
}


const app = express()
app.use(express.json())

// the /init endpoint is normally used to dynamically inject function code into the runtime. 
// using the proxy, the code already lives in the container so this becomes a no-op.
app.post('/init', (req, res) => {
  res.json({ok: true})
})

// the /run endpoint is used to pass HTTP requests to the web action
// parse http request parameters and proxy to the external HTTP service
// http response is encoded into web action response
app.post('/run', async (req, res) => {
  const params = req.body.value
  const DEBUG = params['__ow_proxy_debug'] || false
  if (DEBUG) console.log('PROXY /run req.body value:', req.body)

  const options = {
    method: params['__ow_method'],
    headers: params['__ow_headers']
  }

  // leaving the host header seems to break some examples...
  // what about other headers?
  delete options.headers.host

  if (can_have_body(options.method) && params['__ow_body']) {
    options.body = decode_body(params['__ow_body'])
  }

  console.log('PROXY waiting for HTTP service on port to be available:', proxy_port)
  await waitForLocalhost({port: proxy_port, path: proxy_alive_path, delay: proxy_alive_delay})
  console.log('PROXY HTTP service is now available...')

  const host = `${proxy_protocol}://${proxy_host}:${proxy_port}`
  const url = new URL(params['__ow_path'], host)
  url.search = params['__ow_query'] || ''

  if (DEBUG) console.log('PROXY outgoing HTTP request:', url, options)
  const resp = await fetch(url, options)

  if (DEBUG) console.log('PROXY incoming HTTP response:', resp)
  const body = await encode_response_body(resp)

  const statusCode = resp.status
  const headers = resp.headers.raw()

  const webActionResponse = {
    statusCode, headers, body
  }

  res.json(webActionResponse)
  console.log('XXX_THE_END_OF_A_WHISK_ACTIVATION_XXX')
})

console.log('PROXY starting on port 8080')
app.listen(8080)
