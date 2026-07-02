import http.server, urllib.request, urllib.parse, json, os, sys

PORT = 3000
# La key NUNCA va hardcodeada (este repo es público). Para usar el proxy local:
#   APOLLO_API_KEY=tu_key python3 server.py
# La app en producción no usa este proxy — llama a la edge function apollo-proxy.
APOLLO_KEY = os.environ.get('APOLLO_API_KEY', '')
APOLLO_BASE = 'https://api.apollo.io/api/v1'
DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def log_message(self, fmt, *args):
        print(f"  {args[0]} {args[1]}")

    def send_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_POST(self):
        if not self.path.startswith('/proxy/apollo/'):
            self.send_response(404); self.end_headers(); return

        if not APOLLO_KEY:
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_cors()
            self.end_headers()
            self.wfile.write(b'{"error":"APOLLO_API_KEY no configurada (exporta la variable antes de arrancar)"}')
            return

        apollo_path = self.path.replace('/proxy/apollo/', '/')
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)

        req = urllib.request.Request(
            APOLLO_BASE + apollo_path,
            data=body,
            headers={
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
                'X-Api-Key': APOLLO_KEY,
            },
            method='POST'
        )
        try:
            with urllib.request.urlopen(req) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json')
                self.send_cors()
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_cors()
            self.end_headers()
            self.wfile.write(data)

print(f"\n✅ Servidor corriendo en http://localhost:{PORT}")
print(f"   Abre esa URL en tu navegador\n")
httpd = http.server.HTTPServer(('', PORT), Handler)
httpd.serve_forever()
