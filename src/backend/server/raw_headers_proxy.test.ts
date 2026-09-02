import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { rawRouter } from "./raw"
import { saveDb } from "../internal/model/db"

// alias 挂载到 webdav 存储根，alias.get() 会透传底层 webdav driver 的
// raw_url_headers（Authorization）。真实驱动链路下验证：外层 driver 是
// alias 时也必须强制代理而不是 302（重定向传不了 Authorization）。
const WEBDAV_UPSTREAM = "https://webdav.example.com"

const TEST_DB = () => ({
  settings: [],
  users: [
    {
      id: 1,
      username: "guest",
      password: "",
      role: 1,
      permission: 0,
      base_path: "/",
      disabled: false,
    },
  ],
  storages: [
    {
      id: 10,
      mount_path: "/webdav",
      driver: "webdav",
      addition: JSON.stringify({
        address: `${WEBDAV_UPSTREAM}/dav`,
        username: "user",
        password: "pass",
      }),
      disabled: false,
    },
    {
      id: 11,
      mount_path: "/alias",
      driver: "alias",
      addition: JSON.stringify({ paths: "/:/webdav" }),
      disabled: false,
    },
  ],
  shares: [],
})

async function setupApp(t: any) {
  const upstream: { url: string; headers: Record<string, string> }[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    if (url.startsWith(WEBDAV_UPSTREAM)) {
      upstream.push({ url, headers: init?.headers || {} })
      // PROPFIND (stat) / GET (proxy download) 两种请求都走这里
      const isPropfind = init?.method === "PROPFIND"
      if (isPropfind) {
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/file.txt</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>file.txt</d:displayname>
        <d:getcontentlength>12</d:getcontentlength>
        <d:getlastmodified>Mon, 01 Sep 2026 00:00:00 GMT</d:getlastmodified>
        <d:resourcetype/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`,
          { status: 207, headers: { "content-type": "application/xml" } },
        )
      }
      return new Response("file-content", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  }) as any
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await saveDb(TEST_DB() as any)

  const app = new Hono()
  app.route("/d", rawRouter)
  return { app, upstream }
}

test("raw: alias over webdav download is proxied with auth headers, not 302", async (t) => {
  const { app, upstream } = await setupApp(t)

  const res = await app.request("/d/alias/file.txt")

  assert.notEqual(res.status, 302, "must not 302-redirect when headers present")
  assert.equal(res.status, 200, `expected proxied 200, got ${res.status}`)
  assert.equal(await res.text(), "file-content")

  const download = upstream.find(
    (r) => !r.url.includes("PROPFIND") && r.headers["Authorization"],
  )
  assert.ok(download, "proxy fetch must hit upstream with Authorization")
  assert.match(download.url, /webdav\.example\.com/)
})
