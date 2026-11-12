// For T3 Panels (not in herdr-t3): the tasks that are ready to merge, of every project, for the list's "Ready to merge"
// group. Pure: no Herdr imports, so node can test it. It reads what ht3-panels keeps (tasks.js, tasklist.js): shared
// "ht3-panels.tasks", { "<machine or empty>:<project folder>": [{ id, title, run?: { ready?, merged? } }] }, where the
// coordinator's `ready` sets run.ready and the person's Merge sets run.merged. tests/ready-flow.test.mjs holds it to
// ht3-panels' own reading (tasklist.js readyTasks, showCommand).

// -> [{ key, id, title, project (the folder's name), on (machine or null), command }], the projects by key and each
// project's tasks in its list's order. `command`: what a click sends to ht3-panels (main.js `tasks-show`): that
// project's space and its Tasks surface, with the task in view.
export function readyRows(all) {
  if (!all || typeof all !== "object") return [];
  return Object.keys(all).sort().flatMap((key) => {
    const at = key.indexOf(":"), root = key.slice(at + 1), on = key.slice(0, Math.max(at, 0)) || null, list = all[key];
    if (at < 0 || !root.startsWith("/") || !Array.isArray(list)) return [];
    const seen = new Set();
    return list.filter((t) => {
      const id = String(t?.id ?? "");
      if (!id || seen.has(id) || !String(t.title ?? "").trim()) return false;
      seen.add(id);
      return !!t.run && typeof t.run === "object" && !!t.run.chat && !!t.run.ready && typeof t.run.ready === "object" && !(t.run.merged && typeof t.run.merged === "object");
    }).map((t) => ({ key, id: String(t.id), title: String(t.title).trim(), project: root.split("/").filter(Boolean).pop() ?? root, on,
      command: `tasks-show:${JSON.stringify({ project: root, ...(on ? { machine: on } : {}), id: String(t.id) })}` }));
  });
}
