// Shared by the render scripts: a static server over this folder (pages fetch
// their maps and data, which file:// would refuse) and a Chromium to shoot with.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
export const { chromium } = (() => {
  try {
    return require("playwright");
  } catch {
    return require(
      require.resolve("playwright", { paths: [process.env.NODE_PATH ?? "/usr/lib/node_modules"] }),
    );
  }
})();

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

export function serve() {
  return new Promise((ok) => {
    const server = createServer(async (req, res) => {
      const path = resolve(root, "." + decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!path.startsWith(root)) return res.writeHead(403).end();
      try {
        const body = await readFile(path);
        res
          .writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" })
          .end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () =>
      ok({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}
