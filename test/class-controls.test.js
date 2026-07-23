"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  closeForegroundWindowScript,
  normalizeExecutableIdentifier,
} = require("../agent/agent.js");

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
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
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

test("focused-window results and class application rules use authorized exact protocols", { timeout: 20000 }, async () => {
  assert.equal(normalizeExecutableIdentifier("Steam.exe"), "steam");
  assert.equal(normalizeExecutableIdentifier("steam-helper"), "steam-helper");
  assert.equal(normalizeExecutableIdentifier("steam*"), null);

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
    { input: closeForegroundWindowScript(), encoding: "utf8", windowsHide: true }
  );
  assert.equal(parsed.status, 0, parsed.stdout || parsed.stderr);

  const repo = path.join(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(repo, ".class-controls-test-"));
  const configPath = path.join(tempDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      locations: [
        {
          id: "loc-test",
          name: "Test Campus",
          aliases: ["test campus"],
          buildings: [
            {
              id: "building-test",
              name: "Test Building",
              aliases: ["test building"],
              code: "8676",
              classes: [
                {
                  id: "class-test",
                  name: "Test Class",
                  instructor: "Instructor",
                  room: "101",
                },
              ],
            },
          ],
        },
      ],
      assignments: { "class-controls-device": "class-test" },
      layouts: {},
      schedules: [],
      auth: {},
    })
  );

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const hub = spawn(process.execPath, ["server/server.js"], {
    cwd: repo,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      IDT_ADMIN_PASSWORD: "class-controls-password",
      IDT_CONFIG_PATH: configPath,
      IDT_CLOSE_RESULT_TIMEOUT_MS: "500",
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
        device_id: "class-controls-device",
        hostname: "Class Controls",
        os: "Windows",
        location: "Test Campus",
        building: "Test Building",
      })
    );
    const initialRules = await agent.inbox.next(
      (message) => message.action === "sync_class_app_rules"
    );
    assert.deepEqual(initialRules.params.rules, []);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "instructor", code: "" }),
    }).then((response) => response.json());
    assert.equal(login.role, "instructor");

    const dashboard = await openSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
    sockets.push(dashboard.ws);
    dashboard.ws.send(JSON.stringify({ type: "auth", token: login.token }));
    await dashboard.inbox.next((message) => message.type === "auth_ok");
    const initialState = await dashboard.inbox.next((message) => message.type === "state");
    assert.deepEqual(
      initialState.org[0].buildings[0].classes[0].blockedApplications,
      []
    );

    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "device", deviceId: "class-controls-device" },
        action: "close_foreground",
      })
    );
    const closeRequest = await agent.inbox.next(
      (message) => message.action === "close_foreground"
    );
    assert.ok(closeRequest.request_id);
    agent.ws.send(
      JSON.stringify({
        type: "command_result",
        action: "close_foreground",
        request_id: closeRequest.request_id,
        status: "success",
        detail: "Graceful close request delivered.",
      })
    );
    const closeResult = await dashboard.inbox.next(
      (message) => message.type === "command_result" && message.request_id === closeRequest.request_id
    );
    assert.equal(closeResult.status, "success");
    assert.equal(closeResult.deviceId, "class-controls-device");

    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "class", classId: "class-test" },
        action: "close_foreground",
      })
    );
    const wrongScope = await dashboard.inbox.next(
      (message) => message.type === "error" && message.detail.includes("one selected computer")
    );
    assert.match(wrongScope.detail, /selected computer/);

    dashboard.ws.send(
      JSON.stringify({
        type: "command",
        target: { scope: "device", deviceId: "class-controls-device" },
        action: "close_foreground",
      })
    );
    const unanswered = await agent.inbox.next(
      (message) => message.action === "close_foreground" && message.request_id !== closeRequest.request_id
    );
    const timedOut = await dashboard.inbox.next(
      (message) => message.type === "command_result" && message.request_id === unanswered.request_id,
      3000
    );
    assert.equal(timedOut.status, "timed_out");

    dashboard.ws.send(
      JSON.stringify({
        type: "class_app_rule",
        op: "add",
        classId: "class-test",
        displayName: "Steam",
        executable: "Steam.exe",
      })
    );
    const ruleSync = await agent.inbox.next(
      (message) =>
        message.action === "sync_class_app_rules" &&
        message.params.rules[0]?.executable === "steam"
    );
    assert.equal(ruleSync.params.rules[0].display_name, "Steam");
    const ruleId = ruleSync.params.rules[0].id;
    const ruleState = await dashboard.inbox.next(
      (message) =>
        message.type === "state" &&
        message.org[0].buildings[0].classes[0].blockedApplications[0]?.id === ruleId
    );
    assert.equal(
      ruleState.org[0].buildings[0].classes[0].blockedApplications[0].executable,
      "steam"
    );

    for (const executable of ["steam", "steam*"]) {
      dashboard.ws.send(
        JSON.stringify({
          type: "class_app_rule",
          op: "add",
          classId: "class-test",
          displayName: "Invalid duplicate",
          executable,
        })
      );
      const rejected = await dashboard.inbox.next((message) => message.type === "error");
      assert.ok(rejected.detail);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(
      persisted.locations[0].buildings[0].classes[0].blockedApplications[0].executable,
      "steam"
    );

    await closeSocket(agent.ws);
    const reconnected = await openSocket(`ws://127.0.0.1:${port}/ws/agent`);
    sockets.push(reconnected.ws);
    reconnected.ws.send(
      JSON.stringify({
        type: "register",
        device_id: "class-controls-device",
        hostname: "Class Controls",
        os: "Windows",
        location: "Test Campus",
        building: "Test Building",
      })
    );
    const restoredRules = await reconnected.inbox.next(
      (message) => message.action === "sync_class_app_rules"
    );
    assert.equal(restoredRules.params.rules[0].executable, "steam");

    dashboard.ws.send(
      JSON.stringify({
        type: "class_app_rule",
        op: "remove",
        classId: "class-test",
        ruleId,
      })
    );
    const removedRules = await reconnected.inbox.next(
      (message) => message.action === "sync_class_app_rules"
    );
    assert.deepEqual(removedRules.params.rules, []);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterRemoval = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(
      afterRemoval.locations[0].buildings[0].classes[0].blockedApplications,
      []
    );
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
