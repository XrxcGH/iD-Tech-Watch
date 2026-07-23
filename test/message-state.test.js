"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { blockExpiryFromParams, messageWindowScript } = require("../agent/agent.js");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHub(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Hub did not become ready.");
}

function inboxFor(ws) {
  const messages = [];
  const waiters = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  };
  return {
    next(predicate, timeoutMs = 5000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const position = waiters.indexOf(waiter);
          if (position >= 0) waiters.splice(position, 1);
          reject(new Error("Timed out waiting for WebSocket message."));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function openSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { ws, inbox: inboxFor(ws) };
}

async function closeSocket(ws) {
  if (ws.readyState >= WebSocket.CLOSING) return;
  await new Promise((resolve) => {
    ws.onclose = resolve;
    ws.close();
    setTimeout(resolve, 1000);
  });
}

test("enforced message state is authoritative across clear, reconnect, and timeout", { timeout: 20000 }, async () => {
  const fixedNow = 2_000_000;
  assert.equal(blockExpiryFromParams({ expires_at: 2001 }, fixedNow), 2_001_000);
  assert.equal(blockExpiryFromParams({ expires_at: 2 }, fixedNow), null);
  assert.equal(blockExpiryFromParams({ expires_at: 0 }, fixedNow), 0);

  const hostileText = `</script> ' " ; Stop-Process -Name explorer`;
  const overlayScript = messageWindowScript({
    kind: "warning",
    text: hostileText,
    enforced: true,
    timeout_sec: 0,
  });
  assert.equal(overlayScript.includes(hostileText), false);
  const parsed = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$source=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;" +
        "[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)|Out-Null;" +
        "if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}",
    ],
    { input: overlayScript, encoding: "utf8", windowsHide: true }
  );
  assert.equal(parsed.status, 0, parsed.stdout || parsed.stderr);

  const repo = path.join(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(repo, ".message-test-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const hub = spawn(process.execPath, ["server/server.js"], {
    cwd: repo,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      IDT_ADMIN_PASSWORD: "message-test-password",
      IDT_CONFIG_PATH: path.join(tempDir, "config.json"),
    },
    stdio: "ignore",
  });
  const sockets = [];

  try {
    await waitForHub(baseUrl);

    const agent = await openSocket(`ws://127.0.0.1:${port}/ws/agent`);
    sockets.push(agent.ws);
    agent.ws.send(
      JSON.stringify({
        type: "register",
        device_id: "message-test-device",
        hostname: "Message Test",
        os: "Windows",
        location: "Test",
        building: "Test",
      })
    );
    const initial = await agent.inbox.next((message) => message.action === "message_state");
    assert.equal(initial.params.message, null);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "admin", password: "message-test-password" }),
    }).then((response) => response.json());
    const dashboard = await openSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
    sockets.push(dashboard.ws);
    dashboard.ws.send(JSON.stringify({ type: "auth", token: login.token }));
    await dashboard.inbox.next((message) => message.type === "auth_ok");

    for (const invalidTimeout of [0, -1, 86401, 1.5, "5"]) {
      dashboard.ws.send(
        JSON.stringify({
          type: "command",
          target: { scope: "device", deviceId: "message-test-device" },
          action: "message",
          params: { kind: "warning", text: "Invalid timeout", timeout_sec: invalidTimeout },
        })
      );
      const rejected = await dashboard.inbox.next(
        (message) => message.type === "error" && message.detail.startsWith("Message timeout")
      );
      assert.match(rejected.detail, /whole number/);
    }

    const warningText = `Close your game </script> ' " ; safely`;
    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "device", deviceId: "message-test-device" },
        action: "message",
        params: { kind: "warning", text: warningText },
      })
    );
    const warning = await agent.inbox.next(
      (message) => message.action === "message_state" && message.params.message
    );
    assert.equal(warning.params.message.kind, "warning");
    assert.equal(warning.params.message.text, warningText);
    const warningId = warning.params.message.id;
    const warningState = await dashboard.inbox.next(
      (message) =>
        message.type === "state" &&
        message.devices["message-test-device"]?.activeMessage?.id === warningId
    );
    assert.equal(warningState.devices["message-test-device"].activeMessage.expires_at, 0);

    await closeSocket(agent.ws);
    const reconnected = await openSocket(`ws://127.0.0.1:${port}/ws/agent`);
    sockets.push(reconnected.ws);
    reconnected.ws.send(
      JSON.stringify({
        type: "register",
        device_id: "message-test-device",
        hostname: "Message Test",
        os: "Windows",
        location: "Test",
        building: "Test",
      })
    );
    reconnected.ws.send(JSON.stringify({ type: "message_state_request" }));
    const restored = await reconnected.inbox.next(
      (message) => message.action === "message_state" && message.params.message?.id === warningId
    );
    assert.equal(restored.params.message.text, warningText);

    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "device", deviceId: "message-test-device" },
        action: "clear_message",
      })
    );
    const cleared = await reconnected.inbox.next(
      (message) => message.action === "message_state" && message.params.message === null
    );
    assert.equal(cleared.params.message, null);

    await closeSocket(reconnected.ws);
    const afterClear = await openSocket(`ws://127.0.0.1:${port}/ws/agent`);
    sockets.push(afterClear.ws);
    afterClear.ws.send(
      JSON.stringify({
        type: "register",
        device_id: "message-test-device",
        hostname: "Message Test",
        os: "Windows",
        location: "Test",
        building: "Test",
      })
    );
    afterClear.ws.send(JSON.stringify({ type: "message_state_request" }));
    const authoritativeNull = await afterClear.inbox.next(
      (message) => message.action === "message_state"
    );
    assert.equal(authoritativeNull.params.message, null);

    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "device", deviceId: "message-test-device" },
        action: "message",
        params: { kind: "info", text: "Dismissible information", timeout_sec: 5 },
      })
    );
    const info = await afterClear.inbox.next((message) => message.action === "message");
    assert.equal(info.params.kind, "info");
    assert.equal(info.params.text, "Dismissible information");
    assert.ok(info.params.expires_at > Date.now() / 1000);
    assert.ok(info.params.expires_at <= Date.now() / 1000 + 5);

    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "device", deviceId: "message-test-device" },
        action: "block_app",
        params: { pattern: "steam", duration_sec: 60 },
      })
    );
    const timedBlock = await afterClear.inbox.next((message) => message.action === "block_app");
    assert.equal(timedBlock.params.pattern, "steam");
    assert.equal(Object.hasOwn(timedBlock.params, "duration_sec"), false);
    assert.ok(timedBlock.params.expires_at > Date.now() / 1000 + 59);
    assert.ok(blockExpiryFromParams(timedBlock.params) > Date.now());

    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "device", deviceId: "message-test-device" },
        action: "block_site",
        params: { domain: "example.com" },
      })
    );
    const manualBlock = await afterClear.inbox.next((message) => message.action === "block_site");
    assert.equal(manualBlock.params.expires_at, 0);

    for (const invalidDuration of [0, -1, 72001, 1.5, "60"]) {
      dashboard.ws.send(
        JSON.stringify({
          type: "command",
          target: { scope: "device", deviceId: "message-test-device" },
          action: "block_app",
          params: { pattern: "steam", duration_sec: invalidDuration },
        })
      );
      const rejected = await dashboard.inbox.next(
        (message) => message.type === "error" && message.detail.startsWith("Block duration")
      );
      assert.match(rejected.detail, /whole number/);
    }

    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "device", deviceId: "message-test-device" },
        action: "message",
        params: { kind: "transition", text: "Switch activities", timeout_sec: 1 },
      })
    );
    const transition = await afterClear.inbox.next(
      (message) => message.action === "message_state" && message.params.message?.kind === "transition"
    );
    assert.ok(transition.params.message.expires_at > Date.now() / 1000);
    const timedOut = await afterClear.inbox.next(
      (message) => message.action === "message_state" && message.params.message === null,
      5000
    );
    assert.equal(timedOut.params.message, null);
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch (_) {}
    }
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
