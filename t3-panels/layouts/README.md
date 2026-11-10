# Layout fragment

`ht3-panels` is a mod for a layout you already have (the Herdr T3 layout, `layouts/herdr-t3.json`), so this folder holds no layout file. Add these three things to that layout:

1. In `tabs-row`, before `tabs-end`, the two buttons:

```json
{ "id": "ht3-panel-buttons", "type": "block", "size": { "px": 68 }, "window_drag": true,
  "content": { "mod": "ht3-panels", "props": { "panel": "buttons" } } }
```

2. In `work-body`, after `main`, the right column with the file panel (hidden until toggled):

```json
{ "id": "ht3-side", "type": "column", "size": { "px": 540 }, "min": 360, "max": 900, "hidden": true,
  "background": "background", "radius": 8,
  "children": [
    { "id": "ht3-files", "type": "block", "content": { "mod": "ht3-panels", "props": { "panel": "editor" } } } ] }
```

3. On the root, the themes:

```json
"theme": { "light": "t3code-light", "dark": "t3code-dark" }
```

The column's id must stay `ht3-side`: the buttons and the `cmd-shift-e` key toggle it by that name.
