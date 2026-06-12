import { createServer } from "node:http";
import { once } from "node:events";
import { parseAuditRequest } from "../dist/config/audit-config.js";
import { runOnceLighthouse } from "../dist/lighthouse/run-once.js";

const basicUsername = "stage-user";
const basicPassword = "stage-pass";
const loginUsername = "demo@example.com";
const loginPassword = "app-pass";
const sessionCookie = "session=ok";

const server = createServer(async (request, response) => {
  if (!hasBasicAuth(request)) {
    response.writeHead(401, { "WWW-Authenticate": "Basic realm=\"lh-smoke\"" });
    response.end("Unauthorized");
    return;
  }

  if (request.method === "GET" && request.url === "/login") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html>
      <html>
        <body>
          <form method="post" action="/login">
            <input name="email" />
            <input name="password" type="password" />
            <button type="submit">Sign in</button>
          </form>
        </body>
      </html>`);
    return;
  }

  if (request.method === "POST" && request.url === "/login") {
    const body = await readBody(request);
    const params = new URLSearchParams(body);
    if (params.get("email") === loginUsername && params.get("password") === loginPassword) {
      response.writeHead(302, { "Set-Cookie": `${sessionCookie}; Path=/; HttpOnly`, Location: "/protected" });
      response.end();
      return;
    }
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (request.method === "GET" && request.url === "/protected") {
    if (!String(request.headers.cookie ?? "").includes(sessionCookie)) {
      response.writeHead(302, { Location: "/login" });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(`<!doctype html>
      <html>
        <head><title>Protected Lighthouse Fixture</title></head>
        <body>
          <main id="protected-marker">
            <h1>Authenticated page</h1>
            <p>This page proves Basic Auth and form-login cookies survived the audit.</p>
          </main>
        </body>
      </html>`);
    return;
  }

  response.writeHead(404);
  response.end("Not found");
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = parseAuditRequest({
    baseUrl,
    paths: ["/protected"],
    formFactors: ["mobile"],
    categories: ["performance"],
    runsPerPage: 1,
    basicAuth: {
      enabled: true,
      username: basicUsername,
      password: basicPassword
    },
    formLogin: {
      enabled: true,
      loginUrl: `${baseUrl}/login`,
      usernameSelector: "input[name=\"email\"]",
      username: loginUsername,
      passwordSelector: "input[name=\"password\"]",
      password: loginPassword,
      submitSelector: "button[type=\"submit\"]",
      postLogin: {
        mode: "selector",
        selector: "#protected-marker",
        timeoutMs: 30_000
      }
    }
  });

  const lhr = await runOnceLighthouse({
    url: `${baseUrl}/protected`,
    formFactor: "mobile",
    config,
    timeoutMs: 120_000
  });

  if (!String(lhr.finalDisplayedUrl ?? lhr.finalUrl ?? "").includes("/protected")) {
    throw new Error(`Expected audit to stay on /protected, got ${lhr.finalDisplayedUrl ?? lhr.finalUrl}`);
  }
  if (typeof lhr.categories?.performance?.score !== "number") {
    throw new Error("Expected a numeric performance score");
  }

  console.log(JSON.stringify({
    ok: true,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
    lighthouseVersion: lhr.lighthouseVersion,
    performance: Math.round(lhr.categories.performance.score * 100)
  }));
} finally {
  server.closeAllConnections();
  server.close();
}

function hasBasicAuth(request) {
  const expected = `Basic ${Buffer.from(`${basicUsername}:${basicPassword}`).toString("base64")}`;
  return request.headers.authorization === expected;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}
