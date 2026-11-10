// One ACP agent session as the chat pane shows it, whichever way the agent
// runs: under bridge.mjs in a herdr-core terminal, or in the mod itself through
// Herdr's `spawn`. No Node or Herdr APIs here. The runner passes
//   write(line)      a line for the agent's stdin
//   kill()           stop the agent
//   changed(urgent)  the state changed: save it and redraw, now when urgent
// and calls feed(line) for each stdout line, and exited() when the agent ends.

import { AcpConnection, PROTOCOL_VERSION } from "./acp.js";
import { emptyTranscript, addUser, addNotice, applyUpdate, endTurn, trim } from "./transcript.js";

export class ChatSession {
  // `old`: the chat's last state.json, to continue it.
  // `machine`: the Herdr machine the agent runs on, null for this computer.
  constructor({ argv, cwd, machine = null, old, write, kill, changed }) {
    this.kill = kill;
    this.changed = changed;
    this.pendingPermission = null; // resolve function for the agent's request
    this.state = {
      v: 1,
      seq: 0,
      status: "starting", // starting | ready | working | exited | stopped
      agentArgv: argv,
      agentInfo: null,
      cwd,
      machine,
      sessionId: null,
      configOptions: [],
      permission: null, // {title, options: [{optionId, name, kind}]}
      error: null,
      transcript: emptyTranscript(),
    };
    // A restarted agent continues the chat: it resumes the agent's own session
    // when the agent can load one, and otherwise keeps the old messages above a
    // new session.
    this.resumeId = null;
    if (old?.transcript?.items) {
      this.state.transcript = old.transcript;
      this.state.seq = old.seq ?? 0;
      endTurn(this.state.transcript);
      this.resumeId = old.sessionId ?? null;
    }
    const state = this.state;
    this.conn = new AcpConnection(write, {
      onNotification: (method, params) => {
        if (method !== "session/update" || params?.sessionId !== state.sessionId) return;
        const u = params.update;
        // The chat already shows what it sent; an agent echoing it mid-turn would double it.
        if (u.sessionUpdate === "user_message_chunk" && state.status === "working") return;
        if (u.sessionUpdate === "config_option_update" && u.configOptions) state.configOptions = u.configOptions;
        else if (u.sessionUpdate === "current_mode_update") this.setCurrent("mode", u.currentModeId);
        else applyUpdate(state.transcript, u);
        this.changed(false);
      },
      onRequest: (method, params) => {
        if (method !== "session/request_permission") return undefined;
        return new Promise((resolve) => {
          this.answerPermission({ outcome: "cancelled" }); // only one at a time
          this.pendingPermission = resolve;
          state.permission = {
            title: params.toolCall?.title ?? "The agent asks to continue",
            options: (params.options ?? []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
          };
          this.changed(false);
        });
      },
    });
  }

  feed(line) {
    this.conn.feed(line);
  }

  // `why`: how it ended, e.g. "code 1"; `stderr`: the end of what it wrote there.
  exited(why, stderr) {
    this.conn.close("agent exited");
    if (this.state.status !== "stopped") {
      this.state.status = "exited";
      this.state.error = `The agent exited (${why}).` + (stderr?.trim() ? `\n\n${stderr.trim()}` : "");
    }
    this.changed(true);
  }

  failed(message) {
    this.state.status = "exited";
    this.state.error = message;
    this.changed(true);
  }

  // The state as a file, at most maxBytes of transcript.
  snapshot(maxBytes) {
    this.state.seq++;
    trim(this.state.transcript, maxBytes);
    return JSON.stringify(this.state);
  }

  // Resolves once the session is ready, or has failed.
  async start() {
    const state = this.state;
    try {
      const init = await this.conn.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "herdr-acp-chat", version: "0.1.0" },
      });
      state.agentInfo = init?.agentInfo ?? null;
      state.promptCapabilities = init?.agentCapabilities?.promptCapabilities ?? {};
      if (!(this.resumeId && init?.agentCapabilities?.loadSession && (await this.resume(this.resumeId)))) {
        const session = await this.conn.request("session/new", { cwd: state.cwd, mcpServers: [] });
        state.sessionId = session.sessionId;
        state.configOptions = configFrom(session);
        if (state.transcript.items.length) addNotice(state.transcript, "New session: the agent doesn't remember the messages above.");
      }
      state.status = "ready";
    } catch (e) {
      state.error = `The agent didn't start a session: ${e.message}`;
      state.status = "exited";
      this.changed(true);
      this.kill();
      return false;
    }
    this.changed(true);
    return true;
  }

  // session/load replays the session's history as session/update notifications,
  // so the transcript is rebuilt from the agent instead of the old file.
  async resume(sessionId) {
    const kept = this.state.transcript;
    this.state.transcript = emptyTranscript();
    this.state.sessionId = sessionId;
    try {
      const r = await this.conn.request("session/load", { sessionId, cwd: this.state.cwd, mcpServers: [] });
      this.state.configOptions = configFrom(r);
      endTurn(this.state.transcript);
      addNotice(this.state.transcript, "Resumed the agent's session.");
      return true;
    } catch (e) {
      this.state.transcript = kept;
      this.state.sessionId = null;
      addNotice(this.state.transcript, `Couldn't resume the agent's session (${e.message}).`, "warn");
      return false;
    }
  }

  // {type: "prompt", text} | {type: "cancel"} | {type: "permission", optionId}
  // | {type: "config", configId, value} | {type: "stop"}
  handle(cmd) {
    switch (cmd.type) {
      case "prompt":
        return this.prompt(String(cmd.text ?? ""), Array.isArray(cmd.blocks) ? cmd.blocks : [], cmd.attachments ?? null);
      case "cancel":
        this.answerPermission({ outcome: "cancelled" });
        this.conn.notify("session/cancel", { sessionId: this.state.sessionId });
        return;
      case "permission":
        return this.answerPermission({ outcome: "selected", optionId: cmd.optionId });
      case "config":
        return this.setConfig(cmd.configId, cmd.value);
      case "stop":
        return this.stop();
    }
  }

  // `blocks`: ACP content blocks sent after the text (resource links for mentioned files, images).
  async prompt(text, blocks = [], attachments = null) {
    const state = this.state;
    if (!text.trim() && !blocks.length) return;
    if (state.status === "working") {
      addNotice(state.transcript, "Still working on the last message; send again when it's done.", "warn");
      return this.changed(false);
    }
    addUser(state.transcript, text, attachments);
    state.status = "working";
    state.error = null;
    this.changed(false);
    try {
      const r = await this.conn.request("session/prompt", { sessionId: state.sessionId, prompt: [...(text.trim() ? [{ type: "text", text }] : []), ...blocks] });
      if (r?.stopReason && r.stopReason !== "end_turn") addNotice(state.transcript, stopNote(r.stopReason), "warn");
    } catch (e) {
      addNotice(state.transcript, e.message, "error");
    }
    endTurn(state.transcript);
    if (state.status === "working") state.status = "ready";
    this.changed(false);
  }

  answerPermission(outcome) {
    if (!this.pendingPermission) return;
    this.pendingPermission({ outcome });
    this.pendingPermission = null;
    this.state.permission = null;
    this.changed(false);
  }

  setCurrent(id, value) {
    const opt = this.state.configOptions.find((o) => o.id === id);
    if (opt) opt.currentValue = value;
  }

  async setConfig(configId, value) {
    const opt = this.state.configOptions.find((o) => o.id === configId);
    try {
      if (opt?.legacyMode) {
        await this.conn.request("session/set_mode", { sessionId: this.state.sessionId, modeId: value });
        this.setCurrent(configId, value);
      } else {
        const r = await this.conn.request("session/set_config_option", { sessionId: this.state.sessionId, configId, value });
        if (r?.configOptions) this.state.configOptions = r.configOptions;
        else this.setCurrent(configId, value);
      }
    } catch (e) {
      addNotice(this.state.transcript, `Couldn't change ${opt?.name ?? configId}: ${e.message}`, "error");
    }
    this.changed(false);
  }

  stop() {
    this.state.status = "stopped";
    this.answerPermission({ outcome: "cancelled" });
    this.changed(true);
    this.kill();
  }
}

// Older agents report modes outside configOptions; show them the same way.
function configFrom(result) {
  if (result?.configOptions?.length) return result.configOptions;
  const modes = result?.modes;
  if (!modes?.availableModes?.length) return [];
  return [{
    id: "mode", name: "Mode", category: "mode", type: "select", legacyMode: true,
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description })),
  }];
}

function stopNote(reason) {
  return {
    cancelled: "Stopped.",
    max_tokens: "The reply hit the model's token limit.",
    max_turn_requests: "The agent hit its limit of model requests for one turn.",
    refusal: "The agent refused.",
  }[reason] ?? `The turn ended: ${reason}.`;
}
