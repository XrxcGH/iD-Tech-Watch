"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHub(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Hub did not become ready.");
}

test("agent download is fixed-path, authenticated, and named safely", async () => {
  const repo = path.join(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-download-"));
  const configPath = path.join(tempDir, "config.json");
  const exePath = path.join(tempDir, "built-client.exe");
  const payload = Buffer.from("test-windows-executable");
  fs.writeFileSync(exePath, payload);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const hub = spawn(process.execPath, ["server/server.js"], {
    cwd: repo,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      IDT_CONFIG_PATH: configPath,
      IDT_AGENT_EXE_PATH: exePath,
    },
    stdio: "ignore",
  });

  try {
    await waitForHub(baseUrl);
    const unauthenticated = await fetch(`${baseUrl}/download/id-tech-watch.exe`);
    assert.equal(unauthenticated.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "instructor" }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const headers = { authorization: `Bearer ${token}` };

    const download = await fetch(`${baseUrl}/download/id-tech-watch.exe`, { headers });
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get("content-disposition"),
      'attachment; filename="iD-Tech-Watch.exe"'
    );
    assert.equal(
      download.headers.get("content-type"),
      "application/vnd.microsoft.portable-executable"
    );
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload);

    const traversal = await fetch(
      `${baseUrl}/download/id-tech-watch.exe%2f..%2f..%2fserver%2fserver.js`,
      { headers }
    );
    assert.equal(traversal.status, 404);
    const wrongMethod = await fetch(`${baseUrl}/download/id-tech-watch.exe`, {
      method: "POST",
      headers,
    });
    assert.equal(wrongMethod.status, 405);

    fs.rmSync(exePath);
    const missing = await fetch(`${baseUrl}/download/id-tech-watch.exe`, { headers });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /build-agent-exe\.ps1/);
  } finally {
    hub.kill();
    await new Promise((resolve) => {
      if (hub.exitCode !== null) resolve();
      else {
        hub.once("exit", resolve);
        setTimeout(resolve, 2000);
      }
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
