// T3 Code's chat and file panels for the Herdr T3 layout. One mod, four faces, picked by
// how a copy is opened:
// - props.panel "chat": the chat pane, split beside a terminal
//   (`pane.split {"mod": "ht3-panels", "props": {"panel": "chat", ...}}`, see chat.js);
// - props.panel "editor": the file panel, a block in the layout's right column (editor.js);
// - props.panel "buttons": the two buttons in the layout's tab bar that open them;
// - as an overlay (`mod.open {"name": "ht3-panels"}`): the New chat dialog (launcher.js).

import { View } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, nextCommand, run, layout } from "herdr";
import { tokens, iconButton } from "./look.js";
import { ChatPanel, openLauncher } from "./chat.js";
import { FilePanel } from "./editor.js";
import { Launcher } from "./launcher.js";

export const SIDE = "ht3-side"; // the layout's right column

// Whether the layout's right column shows.
function sideShown(node = layout()) {
  if (!node || typeof node !== "object") return null;
  if (node.id === SIDE) return !node.hidden;
  for (const child of node.children ?? []) {
    const r = sideShown(child);
    if (r !== null) return r;
  }
  return null;
}

class Buttons {
  init() {}
  close() {}
  command() {}
  render() {
    const k = tokens();
    return h_flex().id("ht3-panel-buttons").size_full().gap(4).items_center().justify_end().pr(4)
      .child(iconButton(k, "open-chat", "message-square", () => openLauncher(), { size: "sm", tip: "New chat (Cmd+Shift+O)" }))
      .child(iconButton(k, "open-files", "panel-right", () => run("layout.toggle", { id: SIDE }), { size: "sm", on: sideShown() === true, tip: "Files (Cmd+Shift+E)" }));
  }
}

export default class T3Panels extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.face = p.overlay ? new Launcher() : p.panel === "editor" ? new FilePanel() : p.panel === "buttons" ? new Buttons() : new ChatPanel();
    this.face.init(p, cx);
    // Key commands from keys.json's "mod:ht3-panels" section (save), and "focus" from pane.go.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.face.command(c, cx);
      }
    });
  }

  async close(cx) {
    await this.face.close(cx);
  }

  render(cx) {
    return this.face.render(cx);
  }
}
