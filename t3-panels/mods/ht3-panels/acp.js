// Agent Client Protocol over a line transport: newline-delimited JSON-RPC 2.0.
// No Node or Herdr APIs here, so the bridge (Node) and a mod with a streaming
// `spawn` (QuickJS) share it. The caller feeds each stdout line to `feed` and
// passes `write(line)` for stdin.

export const PROTOCOL_VERSION = 1;

export class AcpError extends Error {
  constructor(error) {
    super(error?.message ?? "ACP error");
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class AcpConnection {
  // handlers.onNotification(method, params)
  // handlers.onRequest(method, params) -> result or Promise of one; throw AcpError to reply with an error
  constructor(write, handlers) {
    this.write = write;
    this.handlers = handlers;
    this.nextId = 1;
    this.pending = new Map();
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  feed(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // agents sometimes log to stdout; ignore what isn't JSON
    }
    if (msg.method && msg.id != null) this.answer(msg);
    else if (msg.method) this.handlers.onNotification?.(msg.method, msg.params);
    else if (msg.id != null) this.settle(msg);
  }

  // Rejects every waiting request, e.g. when the agent exits.
  close(reason) {
    for (const { reject } of this.pending.values()) reject(new AcpError({ message: reason }));
    this.pending.clear();
  }

  send(msg) {
    this.write(JSON.stringify(msg) + "\n");
  }

  settle(msg) {
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new AcpError(msg.error));
    else waiter.resolve(msg.result);
  }

  async answer(msg) {
    try {
      const result = await this.handlers.onRequest?.(msg.method, msg.params);
      if (result === undefined) throw new AcpError({ code: -32601, message: `Method not found: ${msg.method}` });
      this.send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      const code = e instanceof AcpError && e.code != null ? e.code : -32603;
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code, message: String(e?.message ?? e) } });
    }
  }
}

// Splits a stream of text chunks into lines for `feed`.
export function lineSplitter(onLine) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let n;
    while ((n = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, n));
      buf = buf.slice(n + 1);
    }
  };
}

// A session's options as the chat shows them: the agent's configOptions, or its older "modes" given the same shape.
// (session.js keeps its own copy of this for the first session; a fresh one in agent-acp.js uses this.)
export function configFrom(result) {
  if (result?.configOptions?.length) return result.configOptions;
  const modes = result?.modes;
  if (!modes?.availableModes?.length) return [];
  return [{
    id: "mode", name: "Mode", category: "mode", type: "select", legacyMode: true,
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description })),
  }];
}
