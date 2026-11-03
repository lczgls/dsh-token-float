/**
 * Host half of the token/cost meter.
 *
 * The readout itself lives in the browser half (`client.js`): it subscribes to
 * the `tokenUsage` / `contextPressure` projections the Host already publishes
 * for the Session and renders them in the `sidebar.footer.action` slot.
 *
 * This half adds the one thing a browser cannot do by itself — a durable daily
 * ledger. "How much did today cost" used to live in `localStorage`, which dies
 * with site data or on another machine; here it is a small JSON file under
 * `~/.dsh`, reachable from the page through one authenticated route:
 *
 *   GET  /dsh-token-float-api/ledger                → { ok, days: { "YYYY-MM-DD": cost } }
 *   POST /dsh-token-float-api/ledger { day, cost }  → { ok, days }
 *
 * The client probes the route on start-up and silently falls back to
 * `localStorage` when it answers 404 (a Host that has not restarted yet), so
 * the meter keeps working either way.
 *
 * @module dsh-token-float
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** URL prefix owned by this plugin; everything under it is the ledger RPC. */
const ROUTE_PREFIX = '/dsh-token-float-api'

/** Ledger file: one small JSON document, rewritten on every flush. */
const LEDGER_PATH = join(homedir(), '.dsh', 'dsh-token-float', 'ledger.json')

/** Guard against a runaway body from a misbehaving client. */
const MAX_BODY_BYTES = 8 * 1024

/** Serialises read-modify-write cycles so two flushes cannot lose an update. */
let writeChain = Promise.resolve()

function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

async function readLedger() {
  try {
    const raw = await fs.readFile(LEDGER_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const days = parsed && typeof parsed === 'object' ? parsed.days : null
    if (!days || typeof days !== 'object') return { version: 1, days: {} }
    return { version: 1, days }
  } catch {
    // Missing or corrupt file: start clean rather than failing the route.
    return { version: 1, days: {} }
  }
}

async function writeLedger(ledger) {
  await fs.mkdir(dirname(LEDGER_PATH), { recursive: true })
  const tmp = LEDGER_PATH + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8')
  await fs.rename(tmp, LEDGER_PATH)
}

/** Merge one day figure; `Math.max` keeps a stale flush from shrinking it. */
function mergeDay(ledger, day, cost) {
  const previous = Number(ledger.days[day])
  const next = Number.isFinite(previous) ? Math.max(previous, cost) : cost
  ledger.days[day] = Math.round(next * 1e6) / 1e6
  return ledger
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('body too large')
        error.status = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** The Loader row the client-module scan needs; the ledger route hangs off it. */
export function apply(ctx) {
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          let method = ''
          try {
            // Same boundary the Web and Desktop shells use: rejects anything that
            // did not arrive through an authenticated app session.
            const rejection = webCtx.connection.requestRejection(req)
            if (rejection !== undefined) {
              respond(res, rejection, { error: rejection === 401 ? 'authentication required' : 'request rejected' })
              return
            }
            const url = new URL(req.url || '/', 'http://localhost')
            method = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
            if (method !== 'ledger') {
              respond(res, 404, { error: 'not found' })
              return
            }
            if (req.method === 'GET') {
              const ledger = await readLedger()
              respond(res, 200, { ok: true, days: ledger.days })
              return
            }
            if (req.method !== 'POST') {
              respond(res, 405, { error: 'ledger accepts GET or POST' })
              return
            }
            const raw = await readBody(req)
            let args
            try {
              args = raw.length > 0 ? JSON.parse(raw) : {}
            } catch {
              respond(res, 400, { error: 'invalid JSON body' })
              return
            }
            const day = typeof args.day === 'string' ? args.day : ''
            const cost = Number(args.cost)
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(cost) || cost < 0) {
              respond(res, 400, { error: 'expected { day: "YYYY-MM-DD", cost: number >= 0 }' })
              return
            }
            let days = null
            writeChain = writeChain.then(async () => {
              const ledger = mergeDay(await readLedger(), day, cost)
              await writeLedger(ledger)
              days = ledger.days
            })
            await writeChain
            respond(res, 200, { ok: true, days: days || {} })
          } catch (error) {
            const status = (error && error.status) || 500
            if (status === 500) console.warn('[dsh-token-float] ledger ' + (method || 'unknown') + ' failed: ' + String((error && error.stack) || error))
            if (res.headersSent) {
              res.destroy(error)
              return
            }
            respond(res, status, { error: status === 500 ? 'internal error' : String((error && error.message) || error) })
          }
        }
      })
      return () => dispose()
    }, 'dsh-token-float: ledger route')
  })
}

export const name = 'token-float'
