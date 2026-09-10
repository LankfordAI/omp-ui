import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

/**
 * The loopback origin the headless verifier loads its page from (issue #442
 * §8.2). It serves exactly the built verifier page directory, only beneath an
 * unguessable per-run prefix, only regular files: no directory listing, no
 * SPA fallback, nothing outside `dir`. The browser side aborts every request
 * to any OTHER origin, so this is the one place bytes enter the page from.
 */
export interface VerifierOrigin {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** Path segment every served file sits beneath; fresh per process. */
  prefix: string;
  close(): Promise<void>;
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

export function startVerifierOrigin(dir: string): Promise<VerifierOrigin> {
  const root = path.resolve(dir);
  const prefix = randomBytes(16).toString("base64url");
  const mount = `/${prefix}/`;

  const server = http.createServer((req, res) => {
    const notFound = (): void => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      notFound();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      notFound();
      return;
    }
    if (!pathname.startsWith(mount)) {
      notFound();
      return;
    }
    // Same safety ordering as packages/server serveStatic: decode first, then
    // path.resolve, then containment — encoded separators only become
    // separators here, and the check after this line rejects them.
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname.slice(mount.length));
    } catch {
      notFound();
      return;
    }
    const resolved = path.resolve(root, decoded);
    if (resolved === root || !resolved.startsWith(root + path.sep)) {
      notFound();
      return;
    }
    fs.stat(resolved, (statErr, stat) => {
      if (statErr !== null || !stat.isFile()) {
        notFound();
        return;
      }
      const headers = {
        "Content-Type": MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      const stream = fs.createReadStream(resolved);
      stream.once("open", () => {
        res.writeHead(200, headers);
        stream.pipe(res);
      });
      stream.once("error", (err) => {
        if (!res.headersSent) notFound();
        else res.destroy(err);
      });
    });
  });
  server.keepAliveTimeout = 1000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("verifier origin bound no TCP port"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        prefix,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
