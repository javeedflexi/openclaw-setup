// health.js — simple health server on port 18790
// Uses CommonJS (require) to avoid ES module issues in the container
const http = require('http')
const start = Date.now()

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    ok: true,
    uptime: Date.now() - start,
    shard: process.env.CONTAINER_SHARD_ID || 'default'
  }))
}).listen(18790, '0.0.0.0', () => {
  console.log('[health] listening on :18790')
})