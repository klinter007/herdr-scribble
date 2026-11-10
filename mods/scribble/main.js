// View: images and markdown inside Herdr, in two parts.
// The tray (the layout's `view` block, props { dock: true }): a small drop area with the items under
// it. Drop files on it, or click it and press Cmd+V. A new item, or a click on one, opens the editor.
// The editor (a dialog, props { editor: true, item, terminal, folder }): an image to draw on (pen,
// box, arrow, text label) or a markdown file to read. Insert to chat saves the marked image in the
// project (<folder>/.scribble), closes the dialog and pastes the image into the chat.
// Each space has its own items (kept in this copy's localStorage). The tray is a child of the
// layout's `panel-body` stack, beside Files and Changes; the Images button in the tab bar
// (props { button: true }) and the key command `scribble.toggle` open and close it.
// `herdr-view <file>` (view.py) sends files to the tray through data/scribble/inbox/<dock | tab>.json.
// Marks are kept per file in shared "scribble.marks", so an image reopens with them.

import { View, div, image, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input } from "gpui-base";
import { exec, props, focused, panes, spaces, run, theme, notify, appHome, readTextFile, watchFolder, shared, setShared, openOverlay, closeOverlay, layout, nextCommand } from "herdr";
import * as fs from "fs/promises";

const PY = "python3";   // needs Pillow: python3 -m pip install pillow
const SCRIPT = () => `${appHome()}/mods/scribble/view.py`;
const INBOX = () => `${appHome()}/data/scribble/inbox`;
const MARKS = "scribble.marks";
const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"];
const TOOLS = [["pen", "Pen"], ["box", "Box"], ["arrow", "Arrow"], ["text", "Text"]];
const LINE = 0.004, TEXT = 0.022;   // line width and label text size, as parts of the image's long side
const DROP = 96;                    // the drop area's height
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fail = (title, e) => notify({ title, body: String(e?.message ?? e), level: "error" });

async function script(args) {
  const r = await exec(PY, [SCRIPT(), ...args], { timeout: 60000 });
  let d = null;
  try { d = JSON.parse(r.stdout); } catch { /* reported below */ }
  if (!d || d.error) throw new Error(d?.error || r.stderr || "view.py failed");
  return d;
}

export default class Viewer extends View {
  init(_p, cx) {
    this.editor = Boolean(props()?.editor);
    this.handle = cx.focus_handle();
    if (this.editor) return this.initEditor(cx);
    if (props()?.button) return this.initButton(cx);
    if (props()?.page) {   // a markdown file as a tab's only pane
      this.reader = true;
      this.it = { kind: "md", path: props().page, name: String(props().page).split("/").pop() };
      this.load(cx); cx.timer.every(3000, (cx) => this.load(cx));
      return;
    }
    try { this.by = JSON.parse(localStorage.getItem("items") ?? "{}"); } catch { this.by = {}; }
    this.box = props()?.tab || "dock";
    const first = props()?.files ?? [];
    if (first.length) this.add(first, cx, null);
    cx.spawn(async (cx) => {
      if (!this.box) return;
      const file = `${INBOX()}/${this.box}.json`;
      await fs.mkdir(INBOX(), { recursive: true }).catch(() => {});
      const read = async () => { try { return JSON.parse(await readTextFile(file)); } catch { return null; } };
      this.seen = (await read())?.id ?? null;   // an older request is not for this copy
      for (;;) {
        await watchFolder(INBOX());
        const m = await read();
        if (!m || m.id === this.seen) continue;
        this.seen = m.id;
        await fs.writeFile(`${INBOX()}/${this.box}.ack`, String(m.id)).catch(() => {});
        this.add(m.files ?? [], cx, m.space ?? null);
      }
    });
  }

  // ---- the tray --------------------------------------------------------------------------

  space() { return spaces().find((s) => s.active)?.id ?? "none"; }
  get items() { return (this.by[this.space()] ??= []); }

  save() {
    const live = new Set(spaces().map((s) => s.id));
    for (const k of Object.keys(this.by)) if (!live.has(k) && k !== "none") delete this.by[k];
    localStorage.setItem("items", JSON.stringify(this.by));
  }

  // New items go to a space's list (default: the shown space). The last one opens when that space shows.
  take(found, space) {
    const key = space || this.space(), list = (this.by[key] ??= []);
    let last = null;
    for (const it of found) {
      if (it.kind === "error") { fail(`Can't show ${it.name}`, it.error); continue; }
      // Markdown is read in a tab of its own, not in the tray.
      if (it.kind === "md") { run("tab.new", { space: key === "none" ? undefined : key, name: it.name, mod: "scribble", props: { page: it.path } }); continue; }
      const at = list.findIndex((x) => x.path === it.path);
      if (at >= 0) list.splice(at, 1);
      list.unshift(it);
      last = it;
    }
    list.length = Math.min(list.length, 30);
    this.save();
    if (!last) return;
    if (key === this.space()) this.open(last);
    else notify({ title: `Added to ${spaces().find((s) => s.id === key)?.name ?? "another space"}`, body: last.name });
  }

  add(paths, cx, space) {
    if (!paths?.length) return;
    const key = space || this.space();
    cx.spawn(async (cx) => {
      try { this.take(await script(["add", ...paths]), key); } catch (e) { fail("Can't open the files", e); }
      cx.notify();
    });
  }

  // ---- the tab bar's button --------------------------------------------------------------

  initButton(cx) {
    this.button = true;
    const panels = shared("workspace.panels") ?? ["files", "changes"];
    if (!panels.includes("view")) setShared("workspace.panels", [...panels, "view"]);   // the tab bar restores it per space
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "toggle") this.toggle(); cx.notify(); } });
  }

  shown() {
    const find = (n, id) => (!n ? null : n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    this.sync(panel, body?.active);
    return Boolean(panel && !panel.hidden && body?.active === "view");
  }

  // The panel is half as wide for Images as for Files and Changes. On a change between them, the
  // width the person left for each side is kept and the other side's width is set.
  sync(panel, active) {
    const side = panel && !panel.hidden ? (active === "view" ? "view" : "files") : null;
    if (!side) return;
    const px = panel.size?.px;
    if (this.side && this.side !== side) {
      if (px) localStorage.setItem(`width-${this.side}`, String(px));
      const want = Number(localStorage.getItem(`width-${side}`)) || (side === "view" ? 184 : 368);
      if (want !== px) run("layout.resize", { id: "panel", px: want });
    } else if (!this.side && side === "view" && !localStorage.getItem("width-view") && px !== 184) {
      run("layout.resize", { id: "panel", px: 184 });
    }
    this.side = side;
  }

  toggle() {
    if (this.shown()) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child: "view" }); run("layout.show", { id: "panel" }); }
  }

  bar_button(t) {
    const on = this.shown();
    return h_flex().size_full().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("panel-view").h(26).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.toggle())
        .child(svg(props()?.icon ?? "mods/scribble/image.svg").size(14)).child("Images"));
  }

  paste(cx) {
    const key = this.space();
    cx.spawn(async (cx) => {
      try { this.take(await script(["paste"]), key); } catch (e) { fail("Can't paste", e); }
      cx.notify();
    });
  }

  // The chat to insert into: the focused terminal, else the shown tab's agent, else its first terminal.
  target() {
    const f = focused();
    if (f?.terminal) return f.terminal;
    const here = panes().filter((p) => p.tab === f?.tab && p.terminal);
    return (here.find((p) => p.status) ?? here[0])?.terminal ?? null;
  }

  open(it) {
    const space = spaces().find((s) => s.active);
    openOverlay({ mod: "scribble", kind: "dialog", modal: true, width: 0.92, height: 0.92,
      props: { editor: true, item: it, terminal: this.target(), folder: space && !space.machine ? space.folder : null } });
  }

  remove(n) {
    const [it] = this.items.splice(n, 1);
    this.save();
    const marks = { ...(shared(MARKS) ?? {}) };
    if (it && marks[it.path]) { delete marks[it.path]; setShared(MARKS, marks); }
  }

  // A drawer under 100 px wide: a "+" square to drop on or click, then thumbnails only
  // (a click opens one, a right click removes it).
  slim(t, on) {
    const side = Math.max(28, Math.round((this.width ?? 80) - 12));
    return v_flex().id("root").size_full().py(4).gap(4).items_center().bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "v" || !(e.modifiers?.platform || e.modifiers?.control)) return;
        cx.stop_propagation(); this.paste(cx);
      })
      .on_drop((e, cx) => this.add(e.paths ?? [], cx))
      .child(div().id("drop").w(side).h(Math.round(side * 0.6)).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
        .border(1).border_dashed().border_color(on ? t.accent : t.input).bg(on ? t.surface : t.background)
        .text_size(16).text_color(on ? t.accent : t.muted).hover((s) => s.bg(t.surface))
        .on_drop((e, cx) => { cx.stop_propagation(); this.add(e.paths ?? [], cx); })
        .on_click((_e, cx) => { this.handle.focus(); cx.notify(); })
        .child("+"))
      .child(v_flex().id("items").flex_1().min_h(0).gap(4).items_center().overflow_hidden().children(this.items.map((it, n) =>
        div().id(`item-${n}`).size(side).flex_none().rounded(4).overflow_hidden().cursor_pointer().bg(t.raised)
          .flex().items_center().justify_center().text_size(10).text_color(t.muted)
          .border(1).border_color(t.border).hover((s) => s.border_color(t.accent))
          .on_click(() => this.open(it))
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.remove(n); cx.notify(); })
          .child(it.kind === "image" ? image(it.rel).size_full() : "MD"))));
  }

  tray(t) {
    const on = this.handle.is_focused();
    if ((this.width ?? 80) < 120) return this.slim(t, on);
    return v_flex().id("root").size_full().p(8).gap(8).bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "v" || !(e.modifiers?.platform || e.modifiers?.control)) return;
        cx.stop_propagation(); this.paste(cx);
      })
      .on_drop((e, cx) => this.add(e.paths ?? [], cx))
      .child(v_flex().id("drop").h(DROP).flex_none().items_center().justify_center().gap(4).rounded(8).cursor_pointer()
        .border(1).border_dashed().border_color(on ? t.accent : t.input).bg(on ? t.surface : t.background)
        .hover((s) => s.bg(t.surface))
        .on_drop((e, cx) => { cx.stop_propagation(); this.add(e.paths ?? [], cx); })
        .on_click((_e, cx) => { this.handle.focus(); cx.notify(); })
        .child(div().text_size(13).text_color(on ? t.foreground : t.muted).child(on ? "Press Cmd+V to paste" : "Drop an image"))
        .child(div().text_size(11).text_color(t.dim).child(on ? "or drop a file here" : "or click, then Cmd+V")))
      .child(v_flex().id("items").flex_1().min_h(0).gap(4).overflow_y_scrollbar().children(this.items.map((it, n) =>
        h_flex().id(`item-${n}`).h(76).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.surface))
          .on_click(() => this.open(it))
          .child(div().size(64).flex_none().rounded(4).overflow_hidden().bg(t.raised).flex().items_center().justify_center()
            .text_size(10).text_color(t.muted)
            .child(it.kind === "image" ? image(it.rel).size_full() : "MD"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(it.name))
          .child(div().id(`x-${n}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.remove(n); cx.notify(); })
            .child("×")))));
  }

  // ---- the editor ------------------------------------------------------------------------

  initEditor(cx) {
    this.it = props().item;
    this.shapes = [...(shared(MARKS)?.[this.it.path] ?? [])];
    this.tool = "pen"; this.color = COLORS[0];
    this.draw = null; this.pending = null; this.stage = null; this.busy = "";
    this.input = InputState.new({ placeholder: "Type the label, then press Enter" });
    this.input.on("submit", (_e, cx) => this.label(cx));
    cx.timer.after(0, () => this.handle.focus());
    if (this.it.kind === "md") { this.load(cx); cx.timer.every(3000, (cx) => this.load(cx)); }
  }

  load(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(this.it.path).catch(() => null);
      if (text !== this.text) { this.text = text ?? "(can't read the file)"; cx.notify(); }
    });
  }

  keep() { setShared(MARKS, { ...(shared(MARKS) ?? {}), [this.it.path]: this.shapes }); }
  shut() { closeOverlay(props()?.overlay); }

  flatten(mode) {
    return script(["flatten", JSON.stringify({ path: this.it.path, shapes: this.shapes, mode, dir: props()?.folder, line: LINE, text: TEXT })]);
  }

  copy(mode, cx) {
    if (this.busy) return;
    this.busy = mode;
    cx.spawn(async (cx) => {
      try {
        const d = await this.flatten(mode);
        notify({ title: mode === "path" ? "Copied the file path" : "Copied the image with its marks", body: d.path });
      } catch (e) { fail("Can't copy", e); }
      this.busy = ""; cx.notify();
    });
  }

  // Saves the marked image in the project and puts it on the clipboard (a markdown file: its path),
  // closes the dialog, then pastes into the chat. The paste runs outside this copy, which is closing.
  insert(cx) {
    const terminal = props()?.terminal;
    if (this.busy) return;
    if (!terminal) return fail("No chat to insert into", "Click a terminal, then open the item again.");
    this.busy = "insert";
    cx.spawn(async (cx) => {
      try {
        if (this.it.kind === "image") {
          const d = await this.flatten("image");
          notify({ title: "Inserted. Saved a copy:", body: d.path });
        } else await exec("/bin/sh", ["-c", 'printf "%s " "$1" | /usr/bin/pbcopy', "copy", this.it.path]);
        exec("/bin/sh", ["-c", 'sleep 0.15; herdr-app do pane.focus "$1"; sleep 0.15; herdr-app do terminal.paste', "insert", JSON.stringify({ terminal })]).catch(() => {});
        this.shut();
      } catch (e) { fail("Can't insert", e); this.busy = ""; cx.notify(); }
    });
  }

  label(cx) {
    const text = this.input.value().trim();
    if (text && this.pending) { this.shapes.push({ type: "text", at: this.pending, text, color: this.color }); this.keep(); }
    this.pending = null; this.input.set_value(""); this.handle.focus(); cx.notify();
  }

  key(e, cx) {
    if (!(e.modifiers?.platform || e.modifiers?.control) || this.it.kind !== "image") return;
    if (e.key === "z") { this.shapes.pop(); this.keep(); }
    else if (e.key === "c") this.copy("image", cx);
    else if (e.key === "enter") this.insert(cx);
    else return;
    cx.stop_propagation(); cx.notify();
  }

  // The image's drawn rect in the stage: fitted, never above 100%.
  rect() {
    const it = this.it, s = this.stage ?? { width: 900, height: 600 };
    const k = Math.min(1, Math.max(40, s.width - 24) / it.w, Math.max(40, s.height - 24) / it.h);
    const w = it.w * k, h = it.h * k;
    return { k, w, h, left: (s.width - w) / 2, top: (s.height - h) / 2 };
  }

  point(e, r) { const p = e.local_position; return p ? [clamp01(p.x / r.w), clamp01(p.y / r.h)] : null; }

  down(e, r, cx) {
    const p = this.point(e, r);
    if (!p) return;
    cx.stop_propagation();
    if (this.tool === "text") { this.pending = p; cx.timer.after(0, () => this.input.focus()); }
    else {
      this.handle.focus();
      this.draw = this.tool === "pen" ? { type: "pen", pts: [p], color: this.color } : { type: this.tool, a: p, b: p, color: this.color };
    }
    cx.notify();
  }

  move(e, r, cx) {
    const d = this.draw, p = d && this.point(e, r);
    if (!p) return;
    if (d.type === "pen") {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot((p[0] - last[0]) * r.w, (p[1] - last[1]) * r.h) < 2) return;
      d.pts.push(p);
    } else d.b = p;
    cx.notify();
  }

  up(cx) {
    const d = this.draw;
    if (!d) return;
    this.draw = null;
    const moved = d.type === "pen" ? d.pts.length > 1 : Math.hypot(d.a[0] - d.b[0], d.a[1] - d.b[1]) > 0.004;
    if (moved) { this.shapes.push(d); this.keep(); }
    cx.notify();
  }

  // One mark as painted layers over the image (pixels of the drawn rect).
  layers(s, r, n) {
    const it = this.it, lw = Math.max(1.5, Math.max(it.w, it.h) * LINE * r.k);
    const px = (p) => [p[0] * r.w, p[1] * r.h];
    const layer = (path) => window.paint_path(path, s.color).absolute().left(0).top(0).size_full();
    if (s.type === "pen") {
      if (s.pts.length < 2) return [];
      let path = PathBuilder.stroke(lw);
      s.pts.forEach((p, i) => { const [x, y] = px(p); path = i ? path.line_to(x, y) : path.move_to(x, y); });
      return [layer(path.build())];
    }
    if (s.type === "box") {
      const [x1, y1] = px(s.a), [x2, y2] = px(s.b);
      return [layer(PathBuilder.stroke(lw).add_polygon([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], true).build())];
    }
    if (s.type === "arrow") {
      const [x1, y1] = px(s.a), [x2, y2] = px(s.b);
      const ang = Math.atan2(y2 - y1, x2 - x1), head = lw * 4.5;
      const bx = x2 - head * Math.cos(ang), by = y2 - head * Math.sin(ang);
      const sx = head * 0.5 * Math.sin(ang), sy = head * 0.5 * Math.cos(ang);
      return [layer(PathBuilder.stroke(lw).move_to(x1, y1).line_to(bx, by).build()),
        layer(PathBuilder.fill().add_polygon([[x2, y2], [bx + sx, by - sy], [bx - sx, by + sy]], true).build())];
    }
    const size = Math.max(12, Math.max(it.w, it.h) * TEXT) * r.k, pad = size * 0.35, [x, y] = px(s.at);
    return [div().id(`label-${n}`).absolute().left(x).top(y).px(pad).h(size * 1.25 + 2 * pad).flex().items_center().rounded(pad)
      .bg(s.color).text_color(s.color === "#ffffff" || s.color === "#ffcc00" ? "#000000" : "#ffffff")
      .text_size(size).whitespace_nowrap().child(s.text)];
  }

  btn(id, label, t, act, on = false, primary = false) {
    return div().id(id).h(28).px(primary ? 12 : 10).flex_none().flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .when(primary, (el) => el.font_semibold().bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); act(cx); cx.notify(); })
      .child(label);
  }

  rule(t) { return div().w(1).h(18).mx(4).flex_none().bg(t.border); }

  bar(t) {
    const pic = this.it.kind === "image";
    return h_flex().flex_none().flex_wrap().px(10).py(7).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().max_w(260).min_w(0).truncate().mr(6).text_size(13).font_medium().child(this.it.name))
      .when(pic, (el) => el
        .children(TOOLS.map(([id, label]) => this.btn(`tool-${id}`, label, t, () => { this.tool = id; this.pending = null; }, this.tool === id)))
        .child(this.rule(t))
        .children(COLORS.map((c, n) => div().id(`color-${n}`).size(18).flex_none().rounded(9).cursor_pointer().bg(c)
          .border(2).border_color(c === this.color ? t.foreground : t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.color = c; cx.notify(); })))
        .child(this.rule(t))
        .child(this.btn("undo", "Undo", t, () => { this.shapes.pop(); this.keep(); }))
        .child(this.btn("clear", "Clear", t, () => { this.shapes = []; this.pending = null; this.keep(); })))
      .child(div().flex_1())
      .when(pic, (el) => el
        .child(div().text_size(11).text_color(t.dim).flex_none().mr(4).child(`${this.it.w} × ${this.it.h}`))
        .child(this.btn("copy", this.busy === "image" ? "Copying…" : "Copy image", t, (cx) => this.copy("image", cx)))
        .child(this.btn("copy-path", this.busy === "path" ? "Copying…" : "Copy path", t, (cx) => this.copy("path", cx))))
      .when(!pic, (el) => el
        .child(this.btn("md-open", "Open outside", t, () => { exec("/usr/bin/open", [this.it.path]); }))
        .child(this.btn("md-reveal", "Reveal", t, () => { exec("/usr/bin/open", ["-R", this.it.path]); })))
      .child(this.btn("insert", this.busy === "insert" ? "Inserting…" : "Insert to chat", t, (cx) => this.insert(cx), false, true))
      .child(this.btn("close", "Close", t, () => this.shut()));
  }

  picture(t) {
    const r = this.rect();
    const shapes = this.draw ? [...this.shapes, this.draw] : this.shapes;
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.pending), (el) => el.child(h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).flex_1().h(28).px(8).rounded(5).bg(t.input).text_size(13))
        .child(this.btn("label-add", "Add", t, (cx) => this.label(cx)))
        .child(this.btn("label-cancel", "Cancel", t, () => { this.pending = null; }))))
      .child(div().id("stage").relative().flex_1().min_h(0).w_full().overflow_hidden().bg(t.canvas)
        .on_size_change((size, cx) => { this.stage = size; cx.notify(); })
        .child(div().id("picture").absolute().left(Math.round(r.left)).top(Math.round(r.top)).w(Math.round(r.w)).h(Math.round(r.h))
          .cursor_crosshair().overflow_hidden()
          .on_mouse_down("left", (e, cx) => this.down(e, r, cx))
          .on_mouse_move((e, cx) => this.move(e, r, cx))
          .child(image(this.it.rel).size_full())
          .children(shapes.flatMap((s, n) => this.layers(s, r, n)))
          .when(Boolean(this.pending), (el) => el.child(div().absolute().left(this.pending[0] * r.w - 4).top(this.pending[1] * r.h - 4)
            .size(8).rounded(4).bg(this.color).border(1).border_color("#ffffff")))));
  }

  page(t) {
    return div().id("page").flex_1().min_h(0).w_full().overflow_y_scrollbar().px(28).py(18)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().w_full().max_w(900).min_w(0).text_size(14).text_color(t.foreground)
        .child(TextView.markdown("md", String(this.text ?? " ")).selectable(true)));
  }

  render() {
    const t = theme();
    if (this.button) return this.bar_button(t);
    if (this.reader) return v_flex().id("reader").size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().flex_none().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.it.path))
        .child(this.btn("md-copy", "Copy path", t, () => { exec("/bin/sh", ["-c", 'printf "%s" "$1" | /usr/bin/pbcopy', "copy", this.it.path]); }))
        .child(this.btn("md-open", "Open outside", t, () => { exec("/usr/bin/open", [this.it.path]); }))
        .child(this.btn("md-reveal", "Reveal", t, () => { exec("/usr/bin/open", ["-R", this.it.path]); })))
      .child(this.page(t));
    if (!this.editor) return this.tray(t);
    return v_flex().id("editor").size_full().bg(t.background).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_up("left", (_e, cx) => this.up(cx))
      .child(this.bar(t))
      .child(this.it.kind === "image" ? this.picture(t) : this.page(t));
  }
}
