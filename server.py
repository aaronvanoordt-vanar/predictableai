"""Servidor estático local: python3 server.py → http://127.0.0.1:3000

La app en producción habla directo con Supabase (edge functions); el proxy
de Apollo que vivía aquí (y en server.js) no lo usaba nada del frontend y
exponía la API key del desarrollador a cualquier página abierta en el
navegador (CORS *, escuchando en todas las interfaces). Se quitó el
2026-09-25. Este servidor solo sirve archivos y solo en localhost.
"""
import http.server
import os

PORT = 3000
DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def log_message(self, fmt, *args):
        print(f"  {args[0]} {args[1]}")


print(f"\n✅ Servidor corriendo en http://127.0.0.1:{PORT}")
print("   Abre esa URL en tu navegador\n")
http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
