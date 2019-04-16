'use strict';

const fs = require('fs')
const { spawn } = require('child_process')
const path = require('path')
const express = require('express')
const fetch = require('node-fetch')
const isBase64 = require('is-base64')
const waitForLocalhost = require('wait-for-localhost')
const AdmZip = require('adm-zip')
 
// used to store proxy process configuration between requests
const CONFIG = {
  app: null,
  // environment variables used to configure HTTP service to proxy
  // PROXY_HOST, PROXY_PORT, PROXY_ALIVE_PATH and PROXY_PROTOCOL
  // defaults to: http://localhost:80/
  proxy: {
    host: process.env['PROXY_HOST'] || 'localhost',
    port: process.env['PROXY_PORT'] || 80,
    alive_path: process.env['PROXY_ALIVE_PATH'] || '/',
    alive_delay: process.env['PROXY_ALIVE_DELAY'] || 100,
    protocol: process.env['PROXY_PROTOCOL'] || 'http'
  }
}

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

  if (mime.startsWith('text') || custom_text_mimes.includes(mime)) {
    return false
  }

  return true
}

// encode http response body into web action response body
// binary content must be base64 encoded.
const encode_response_body = async (resp) => {
  const content_type = resp.headers.get('content-type').split(';')[0]

  if (is_binary_content(content_type)) {
    const buf = await resp.buffer()
    return buf.toString('base64')
  }

  return await resp.text()
}

// create new app server process from user-configuration.
// return async value that resolves when process exits or dies.
const spawn_user_app = () => {
  if (!CONFIG.app.running) {
    CONFIG.app.running = new Promise((resolve, reject) => {
      console.log('PROXY Starting user application server:', CONFIG.app.cmd, CONFIG.app.args)
      const cmd = spawn(CONFIG.app.cmd, CONFIG.app.args, { cwd: CONFIG.app.dir, stdio: 'inherit' })

      cmd.on('error', (err) => {
        console.error(`PROXY user app server error: ${err}`);
        reject(err)
      })

      cmd.on('exit', (code) => {
        console.error(`PROXY user app server exited with code: ${code}`);
        resolve({ code })
      })
    })
  }

  return CONFIG.app.running
}

// async function that returns when app server is ready to serve HTTP requests
// checks localhost port is available and serving HTTP requests before returning.
// if user provided app server in binary archive, start child process for app server.
const wait_for_app_server = async () => {
  if (!CONFIG.app_server_checks) {
    const checks = CONFIG.app_server_checks = []

    // only spawn app server if binary archive is provided in parameters
    if (CONFIG.app) {
      const server_up = spawn_user_app()
      checks.push(server_up)
    }

    console.log('PROXY waiting for HTTP service on port to be available:', CONFIG.proxy.port)
    const serving_requests = waitForLocalhost({port: CONFIG.proxy.port, path: CONFIG.proxy.alive_path, delay: CONFIG.proxy.alive_delay}) 
    serving_requests.then(() => console.log('PROXY HTTP service is now available...'))

    checks.push(serving_requests)
  }

  // wait for app server to start responding to http requests or process to die.
  // if the result is a null value, it came from the `waitForLocalhost` function.
  // this means the app server is responding to http requests.
  // if the result is a non-null value, it came from the  `spawn_user_app` function. 
  // this means the process has died and can't serve HTTP requests.
  const check_results = await Promise.race(CONFIG.app_server_checks)
  if (check_results) {
    throw new Error('app server process is not running.')
  }
}

const app = express()
app.use(express.json({limit: '48MB'}))

// the /init endpoint is used to dynamically inject function code into the runtime. 
// if params contain a binary archive, unzip into runtime environment
// otherwise, assume app server process already started in container and return.
app.post('/init', (req, res) => {
  const params = req.body.value
  console.log('PROXY /init main:', params.main, 'binary:', params.binary)

  if (params.binary) {
    const dir = path.join(process.env.PWD, 'src')
    const base64 = Buffer.from(params.code, 'base64')
    console.time('PROXY unzipping binary archive elapsed time')
    const zip = new AdmZip(base64)
    zip.extractAllTo(dir, true)
    console.timeEnd('PROXY unzipping binary archive elapsed time')

    const main = params.main.split(' ')
    const cmd = main[0]
    const args = main.slice(1)
    CONFIG.app = { dir, cmd, args }
  }

  res.json({ok: true})
})

// the /run endpoint is used to pass HTTP requests to the web action
// parse http request parameters and proxy to the external HTTP service
// http response is encoded into web action response
app.post('/run', async (req, res, next) => {
  const params = req.body.value
  const DEBUG = params['__ow_proxy_debug'] || false
  if (DEBUG) console.log('PROXY /run req.body value:', req.body)

  // allow setting proxy options dynamically using default action parameters
  const proxy_config = ['host', 'port', 'alive_path', 'alive_delay', 'protocol']
  const to_param = name => `__ow_proxy_${name}`
  proxy_config.forEach(c => CONFIG.proxy[c] = params[to_param(c)] || CONFIG.proxy[c])
  if (DEBUG) console.log('PROXY config.proxy:', CONFIG.proxy)

  // allow setting custom environment variables from action parameters
  const env_prefix = '__ow_proxy_env_'
  Object.keys(params)
    .filter(p => p.startsWith(env_prefix))
    .forEach(p => process.env[p.slice(env_prefix.length)] = params[p])
  if (DEBUG) console.log('PROXY process.env:', process.env)

  const options = {
    method: params['__ow_method'], headers: params['__ow_headers']
  }

  // leaving the host header seems to break some examples...
  delete options.headers.host

  if (can_have_body(options.method) && params['__ow_body']) {
    options.body = decode_body(params['__ow_body'])
  }

  try {
    // wait for app server to be available before sending HTTP requests
    await wait_for_app_server()

    const host = `${CONFIG.proxy.protocol}://${CONFIG.proxy.host}:${CONFIG.proxy.port}`
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
  } catch (err) {
    return next(err)
  }

  console.log('XXX_THE_END_OF_A_WHISK_ACTIVATION_XXX')
})

console.log('PROXY starting on port 8080')
app.listen(8080)
