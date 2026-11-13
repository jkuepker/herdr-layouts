// Runs bridge.mjs against fake-agent.mjs and drives it through its inbox, the
// same way the mod does. Run: node --test acp-chat/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(here, "../mods/acp-chat/bridge.mjs");
const agent = path.join(here, "fake-agent.mjs");

function startBridge(dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-chat-")), env = process.env) {
  const proc = spawn(process.execPath, [bridge, "--dir", dir, "--", process.execPath, agent], { stdio: "ignore", env });
  let n = 0;
  return {
    dir,
    proc,
    send(cmd) {
      fs.writeFileSync(path.join(dir, "inbox", `${Date.now()}-${n++}.json`), JSON.stringify(cmd));
    },
    state() {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
      } catch {
        return null;
      }
    },
    async until(pred, what) {
      for (let i = 0; i < 100; i++) {
        const s = this.state();
        if (s && pred(s)) return s;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.fail(`timed out waiting for ${what}: ${JSON.stringify(this.state())}`);
    },
    async halt() {
      if (proc.exitCode == null) {
        const exited = new Promise((r) => proc.on("exit", r));
        proc.kill("SIGTERM");
        await exited;
      }
    },
    async stop() {
      await this.halt();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const lastAgentText = (s) => s.transcript.items.filter((i) => i.kind === "agent").at(-1)?.text;

test("a prompt streams into one agent message", async (t) => {
  const b = startBridge();
  t.after(() => b.stop());
  await b.until((s) => s.status === "ready", "ready");
  b.send({ type: "prompt", text: "hi" });
  const s = await b.until((s) => s.status === "ready" && lastAgentText(s), "reply");
  assert.equal(lastAgentText(s), "(small) you said: hi");
  assert.deepEqual(s.transcript.items.map((i) => i.kind), ["user", "agent"]);
});

test("changing the model goes through set_config_option", async (t) => {
  const b = startBridge();
  t.after(() => b.stop());
  await b.until((s) => s.status === "ready", "ready");
  b.send({ type: "config", configId: "model", value: "large" });
  await b.until((s) => s.configOptions[0].currentValue === "large", "model change");
  b.send({ type: "prompt", text: "x" });
  const s = await b.until((s) => s.status === "ready" && lastAgentText(s), "reply");
  assert.match(lastAgentText(s), /^\(large\)/);
});

test("permission: allow finishes the tool, reject fails it", async (t) => {
  const b = startBridge();
  t.after(() => b.stop());
  await b.until((s) => s.status === "ready", "ready");

  b.send({ type: "prompt", text: "tool please" });
  let s = await b.until((s) => s.permission, "permission request");
  assert.equal(s.permission.title, "Edit notes.md");
  assert.deepEqual(s.permission.options.map((o) => o.optionId), ["yes", "no"]);
  b.send({ type: "permission", optionId: "yes" });
  s = await b.until((s) => s.status === "ready" && !s.permission, "allowed turn");
  assert.equal(s.transcript.items.find((i) => i.kind === "tool").status, "completed");

  b.send({ type: "prompt", text: "tool again" });
  await b.until((s) => s.permission, "second permission request");
  b.send({ type: "permission", optionId: "no" });
  s = await b.until((s) => s.status === "ready" && !s.permission, "rejected turn");
  assert.equal(s.transcript.items.filter((i) => i.kind === "tool").at(-1).status, "failed");
});

test("cancel answers a waiting permission as cancelled", async (t) => {
  const b = startBridge();
  t.after(() => b.stop());
  await b.until((s) => s.status === "ready", "ready");
  b.send({ type: "prompt", text: "tool" });
  await b.until((s) => s.permission, "permission request");
  b.send({ type: "cancel" });
  const s = await b.until((s) => s.status === "ready" && !s.permission, "cancelled turn");
  assert.ok(s.transcript.items.some((i) => i.kind === "notice" && i.text === "Stopped."));
});

test("a hang prompt never ends its turn, whatever cancel asks", async (t) => {
  const b = startBridge();
  t.after(() => b.stop());
  await b.until((s) => s.status === "ready", "ready");
  b.send({ type: "prompt", text: "hang" });
  await b.until((s) => lastAgentText(s) === "Hanging.", "the hanging turn");
  b.send({ type: "cancel" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(b.state().status, "working");
});

test("an agent that exits while it waits for an approval leaves none to answer", async (t) => {
  const b = startBridge();
  t.after(() => b.stop());
  await b.until((s) => s.status === "ready", "ready");
  b.send({ type: "prompt", text: "crash" });
  await b.until((s) => s.permission, "permission request");
  const s = await b.until((s) => s.status === "exited", "exit");
  assert.equal(s.permission, null);
  assert.match(s.error, /code 3/);
});

test("stop ends the bridge and leaves the chat on disk", async (t) => {
  const b = startBridge();
  t.after(() => b.stop());
  await b.until((s) => s.status === "ready", "ready");
  b.send({ type: "prompt", text: "keep me" });
  await b.until((s) => lastAgentText(s), "reply");
  const exited = new Promise((r) => b.proc.on("exit", r));
  b.send({ type: "stop" });
  await exited;
  assert.equal(b.state().status, "stopped");
  assert.ok(b.state().transcript.items.length >= 2);
});

test("a restarted bridge resumes the agent's session when it can load one", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-chat-"));
  const env = { ...process.env, FAKE_AGENT_STORE: path.join(dir, "fake-store.json") };
  const first = startBridge(dir, env);
  await first.until((s) => s.status === "ready", "ready");
  first.send({ type: "prompt", text: "remember me" });
  await first.until((s) => s.status === "ready" && lastAgentText(s), "reply");
  await first.halt();

  const second = startBridge(dir, env);
  t.after(() => second.stop());
  const s = await second.until((s) => s.status === "ready" && s.transcript.items.some((i) => i.text === "Resumed the agent's session."), "resume");
  assert.deepEqual(s.transcript.items.map((i) => i.kind), ["user", "agent", "notice"]);
  assert.equal(s.transcript.items[0].text, "remember me");
});

test("an agent that can't load sessions starts a new one below the old messages", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-chat-"));
  const first = startBridge(dir);
  await first.until((s) => s.status === "ready", "ready");
  first.send({ type: "prompt", text: "old" });
  await first.until((s) => s.status === "ready" && lastAgentText(s), "reply");
  await first.halt();

  const second = startBridge(dir);
  t.after(() => second.stop());
  const s = await second.until((s) => s.status === "ready" && s.transcript.items.some((i) => i.kind === "notice"), "new session");
  assert.equal(s.transcript.items[0].text, "old");
  assert.match(s.transcript.items.at(-1).text, /^New session/);
});
