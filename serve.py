"""Aperçu local de HARES RUN : python serve.py, puis http://localhost:8000.

La géolocalisation du navigateur n'est permise que sur https ou sur
localhost : ouvrir index.html directement (file://) ne la donnerait pas.
"""

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")


class Gestionnaire(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    serveur = ThreadingHTTPServer(("127.0.0.1", port), partial(Gestionnaire, directory=SITE))
    print(f"HARES RUN → http://localhost:{port}  (Ctrl+C pour arrêter)")
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
