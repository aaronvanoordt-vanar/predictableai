// Servidor proxy local para Apollo API
// Uso: node server.js
// Luego abre http://localhost:3000 en tu navegador

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
// La key NUNCA va hardcodeada (este repo es público). Para usar el proxy local:
//   APOLLO_API_KEY=tu_key node server.js
const APOLLO_KEY = process.env.APOLLO_API_KEY || '';
const APOLLO_HOST = 'api.apollo.io';

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Proxy Apollo API
  if (parsedUrl.pathname.startsWith('/proxy/apollo/')) {
    const apolloPath = '/api/v1/' + parsedUrl.pathname.replace('/proxy/apollo/', '');
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const options = {
        hostname: APOLLO_HOST,
        path: apolloPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': APOLLO_KEY,
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const proxyReq = https.request(options, proxyRes => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      proxyReq.on('error', err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      proxyReq.write(body);
      proxyReq.end();
    });
    return;
  }

  // Servir index.html
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`   Abre esa URL en tu navegador (no el archivo directo)\n`);
});
