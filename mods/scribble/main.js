// View: images and markdown inside Herdr, in two parts.
// The tray (the layout's `view` block, props { dock: true }): a small drop area with the items under
// it. Drop files on it, or click it and press Cmd+V: the image opens in the editor. An image an
// agent sends (view.py) does not open and takes no focus: it waits in the tray of that agent's
// space with a mark, and the Images button shows a dot, until the person opens it.
// The editor (a tab of its own, props { editor: true, item, terminal, folder }): an image to draw
// on (pen, box, arrow, text label). Insert to chat saves the marked image in the project
// (<folder>/.scribble), closes the tab and pastes the image into the chat it was opened from.
// Each space has its own items (kept in this copy's localStorage). The tray is a child of the
// layout's `panel-body` stack, beside Files and Changes; the Images button in the tab bar
// (props { button: true }) and the key command `scribble.toggle` open and close it.
// `herdr-view <file>` (view.py) sends files to the tray through data/scribble/inbox/<dock | tab>.json.
// Marks are kept per file in shared "scribble.marks", so an image reopens with them.

import { View, div, image, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input } from "gpui-base";
import { exec, props, focused, panes, spaces, agents, run, theme, notify, appHome, readTextFile, watchFolder, shared, setShared, openOverlay, closeOverlay, layout, nextCommand } from "herdr";
import * as fs from "fs/promises";

const PY = "python3";   // needs Pillow: python3 -m pip install pillow
const SCRIPT = () => `${appHome()}/mods/scribble/view.py`;
const INBOX = () => `${appHome()}/data/scribble/inbox`;
const QUEUE = () => `${INBOX()}/queue.jsonl`;
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
    if (props()?.previews) return this.initPreviews(cx);
    if (props()?.page) {   // a markdown file as a tab's only pane
      this.reader = true;
      this.it = { kind: "md", path: props().page, name: String(props().page).split("/").pop() };
      this.load(cx); cx.timer.every(3000, (cx) => this.load(cx));
      return;
    }
    try { this.by = JSON.parse(localStorage.getItem("items") ?? "{}"); } catch { this.by = {}; }
    // A tab opened for one file (the `open` wrapper: props { files: [path], terminal? }) is the
    // editor for that image, in place: no tray, no second tab.
    const first = props()?.files ?? [];
    if (first.length) {
      this.viewer = true;
      cx.spawn(async (cx) => {
        try {
          const it = (await script(["add", ...first])).find((x) => x.kind === "image");
          if (it) { this.editor = true; this.initEditor(cx, it); } else this.viewerError = "This file is not an image.";
        } catch (e) { this.viewerError = String(e?.message ?? e); }
        cx.notify();
      });
      return;
    }
    // What agents send (view.py) waits in a queue file. This tray takes what is newer than what
    // it took last, also what came while it was closed; nothing opens and nothing moves.
    // Only the tray takes from the queue; a pane opened for some files (an older view.py) does not.
    this.isTray = !props()?.files && !props()?.tab;
    if (this.isTray) cx.spawn(async (cx) => {
      await fs.mkdir(INBOX(), { recursive: true }).catch(() => {});
      this.taken = BigInt(localStorage.getItem("taken") ?? "0");
      const drain = async () => {
        const text = await readTextFile(QUEUE()).catch(() => "");
        for (const line of text.split("\n")) {
          let m = null;
          try { m = JSON.parse(line); } catch { continue; }
          if (!m?.id || BigInt(m.id) <= this.taken) continue;
          this.taken = BigInt(m.id);
          this.add(m.files ?? [], cx, m.space ?? null, true);
        }
        localStorage.setItem("taken", String(this.taken));
        if (Object.keys(shared("scribble.pending") ?? {}).length) setShared("scribble.pending", {});
        if (shared("scribble.taken") !== String(this.taken)) setShared("scribble.taken", String(this.taken));
      };
      await drain();
      for (;;) { await watchFolder(INBOX()); await drain().catch(() => {}); }
    });
  }

  // ---- the Preview tab ------------------------------------------------------------------
  // One per space (props { previews: true, space }): what the agents of the space showed, newest
  // first, in a list at the left; the chosen file at the right. view.py writes the list
  // (data/scribble/previews/<space>.jsonl) and names the tab "Preview · N new"; looking at the
  // tab marks all of it seen.

  initPreviews(cx) {
    this.previews = true;
    this.entries = [];      // newest first, one per path
    this.pick = null;       // the chosen entry's id
    this.sort = localStorage.getItem("sort") === "agent" ? "agent" : "time";
    this.made = {};         // path -> what view.py add made of an image
    this.docs = {};         // path -> text
    this.lastSeen = "0";
    const dir = `${appHome()}/data/scribble/previews`, sp = props().space;
    const read = async (cx) => {
      const text = await readTextFile(`${dir}/${sp}.jsonl`).catch(() => "");
      const seen = (await readTextFile(`${dir}/${sp}.seen`).catch(() => "0")).trim() || "0";
      if (text === this.listText && seen === this.lastSeen) return false;   // nothing new
      this.listText = text;
      const byPath = new Map();
      for (const line of text.split("\n")) { try { const e = JSON.parse(line); if (e?.path) byPath.set(e.path, e); } catch { /* not a line */ } }
      const next = [...byPath.values()].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      const followed = !this.pick || this.pick === this.entries[0]?.id;   // on the newest: stay on the newest
      this.entries = next;
      this.lastSeen = seen;
      if (followed || !next.some((e) => e.id === this.pick)) this.choose(next[0], cx);
      return true;
    };
    cx.spawn(async (cx) => {
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
      await read(cx).catch(() => {}); cx.notify();
      for (;;) { await watchFolder(dir); if (await read(cx).catch(() => false)) cx.notify(); }
    });
    // The watch can miss a save (it did): the list is also read again every few seconds.
    cx.timer.every(4000, (cx) => cx.spawn(async (cx) => { if (await read(cx).catch(() => false)) cx.notify(); }));
    cx.timer.every(3000, (cx) => { const e = this.chosen(); if (e?.kind === "md") this.loadDoc(e, cx); });
    cx.timer.every(30000, (cx) => cx.notify());   // the ages
  }

  chosen() { return this.entries.find((e) => e.id === this.pick) ?? null; }

  choose(e, cx) {
    this.pick = e?.id ?? null;
    if (!e) return;
    if (e.kind === "md") this.loadDoc(e, cx);
    else if (e.kind === "image" && !this.made[e.path]) cx.spawn(async (cx) => {
      try { this.made[e.path] = (await script(["add", e.path]))[0]; } catch (err) { this.made[e.path] = { kind: "error", error: String(err?.message ?? err) }; }
      cx.notify();
    });
  }

  loadDoc(e, cx) {
    cx.spawn(async (cx) => {
      const text = (await readTextFile(e.path).catch(() => null)) ?? "(can't read the file)";
      if (text !== this.docs[e.path]) { this.docs[e.path] = text; cx.notify(); }
    });
  }

  // The person looked: everything on the list is seen, and the tab is "Preview" again.
  looked(cx) {
    const top = this.entries[0]?.id;
    if (!top || top === this.lastSeen || this.marking) return;
    this.marking = true;
    this.lastSeen = top;
    const dir = `${appHome()}/data/scribble/previews`, sp = props().space;
    cx.spawn(async (cx) => {
      await fs.writeFile(`${dir}/${sp}.seen`, top).catch(() => {});
      const tab = (await readTextFile(`${dir}/${sp}.tab`).catch(() => "")).trim();
      if (tab) run("tab.rename", { id: tab, name: "Preview" });
      this.marking = false;
      cx.notify();
    });
  }

  annotate(e) {
    const it = this.made[e.path];
    if (!it || it.kind !== "image") return;
    const space = spaces().find((s) => s.id === props().space);
    run("tab.new", { space: props().space, name: it.name, mod: "scribble",
      props: { editor: true, item: it, terminal: e.from?.terminal ?? null, folder: space && !space.machine ? space.folder : null } });
  }

  previewList(t) {
    const fresh = (e) => BigInt(e.id) > BigInt(this.lastSeen || "0");
    const when = (e) => { const s = (Date.now() - e.t) / 1000; return s < 90 ? "now" : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
    const TAG = { image: ["IMG", "#5aa9ff"], md: ["MD", "#4cd08a"], file: ["FILE", "#b48cff"] };
    const row = (e) => {
      const on = e.id === this.pick, [tag, color] = TAG[e.kind] ?? TAG.file;
      return h_flex().id(`pv-${e.id}`).h(46).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.choose(e, cx); cx.notify(); })
        .on_mouse_down("right", () => { exec("/usr/bin/open", ["-R", e.path]); })   // right click: show it in Finder
        .child(div().w(34).h(22).flex_none().rounded(4).bg(`${color}26`).flex().items_center().justify_center().text_size(9).font_semibold().text_color(color).child(tag))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12.5).text_color(on || fresh(e) ? t.foreground : t.muted).when(fresh(e), (el) => el.font_semibold()).child(e.path.split("/").pop()))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${e.from?.name ?? "unknown"} · ${when(e)}`)))
        .when(fresh(e), (el) => el.child(div().size(7).flex_none().rounded_full().bg(t.accent)));
    };
    let rows;
    if (this.sort === "agent") {
      const names = [...new Set(this.entries.map((e) => e.from?.name ?? "unknown"))];
      rows = names.flatMap((n) => [div().id(`pv-agent-${n}`).h(22).flex_none().px(8).pt(6).text_size(10.5).font_medium().text_color(t.dim).child(n),
        ...this.entries.filter((e) => (e.from?.name ?? "unknown") === n).map(row)]);
    } else rows = this.entries.map(row);
    const tab = (id, label) => div().id(`sort-${id}`).h(22).px(8).flex().items_center().rounded(5).cursor_pointer().text_size(11)
      .bg(this.sort === id ? t.selected : t.background).text_color(this.sort === id ? t.foreground : t.muted)
      .on_click((_e, cx) => { this.sort = id; localStorage.setItem("sort", id); cx.notify(); }).child(label);
    return v_flex().w(264).flex_none().h_full().border_r(1).border_color(t.border)
      .child(h_flex().h(38).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(12).font_semibold().child(`${this.entries.length} files`))
        .child(tab("time", "Newest")).child(tab("agent", "By agent")))
      .child(v_flex().id("pv-list").flex_1().min_h(0).p(4).gap(1).overflow_y_scrollbar().children(rows));
  }

  previewPane(t) {
    const e = this.chosen();
    if (!e) return div().flex_1().flex().items_center().justify_center().text_size(12.5).text_color(t.muted).child("Nothing shown here yet");
    const it = this.made[e.path];
    const head = h_flex().flex_none().flex_wrap().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(120)
        .child(div().truncate().text_size(13).font_medium().child(e.path.split("/").pop()))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(`from ${e.from?.name ?? "unknown"} · ${e.path}`)))
      .when(e.kind === "image" && it?.kind === "image", (el) => el.child(this.btn("pv-annotate", "Annotate", t, () => this.annotate(e), false, true)))
      .child(this.btn("pv-open", e.kind === "file" ? "Play / open" : "Open", t, () => { exec("/usr/bin/open", [e.path]); }))
      .child(this.btn("pv-reveal", "Show in Finder", t, () => { exec("/usr/bin/open", ["-R", e.path]); }))
      .child(this.btn("pv-copy", "Copy path", t, () => { exec("/bin/sh", ["-c", 'printf "%s" "$1" | /usr/bin/pbcopy', "copy", e.path]); }));
    let body;
    if (e.kind === "md") {
      const text = this.docs[e.path] ?? "";
      body = div().id(`pv-doc-${e.id}`).flex_1().min_h(0).w_full().overflow_y_scrollbar().px(24).py(16)
        .child(div().w_full().max_w(900).min_w(0).text_size(14).text_color(t.foreground)
          .child(/\.(md|markdown|mdx)$/i.test(e.path) ? TextView.markdown(`pv-md-${e.id}`, text || " ").selectable(true)
            : div().font_family("Menlo").text_size(12.5).children(text.split("\n").slice(0, 4000).map((l) => div().min_h(17).child(l || " ")))));
    } else if (e.kind === "image") {
      const s = this.stage ?? { width: 600, height: 400 };
      if (it?.kind === "image") {
        const k = Math.min(1, (s.width - 24) / it.w, (s.height - 24) / it.h), w = it.w * k, h = it.h * k;
        body = div().id("pv-stage").relative().flex_1().min_h(0).w_full().overflow_hidden().bg(t.canvas)
          .on_size_change((size, cx) => { this.stage = size; cx.notify(); })
          .child(div().absolute().left(Math.round((s.width - w) / 2)).top(Math.round((s.height - h) / 2)).w(Math.round(w)).h(Math.round(h)).child(image(it.rel).size_full()));
      } else body = div().id("pv-stage").flex_1().flex().items_center().justify_center().text_size(12.5).text_color(it ? t.blocked : t.muted)
        .on_size_change((size, cx) => { this.stage = size; cx.notify(); }).child(it ? `Can't show it: ${it.error ?? "not an image"}` : "Opening…");
    } else {
      body = v_flex().flex_1().items_center().justify_center().gap(8).text_color(t.muted)
        .child(div().text_size(13).child("This kind of file opens outside Herdr."))
        .child(div().text_size(11.5).text_color(t.dim).child("Use Play / open, or Show in Finder."));
    }
    return v_flex().flex_1().min_w(0).h_full().child(head).child(body);
  }

  previewsView(t) {
    return h_flex().id("previews").size_full().bg(t.background).text_color(t.foreground)
      .on_mouse_move((_e, cx) => this.looked(cx))
      .child(this.previewList(t)).child(this.previewPane(t));
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
  // How many images wait unopened in each space, for the Images button's dot.
  countFresh() {
    if (!this.isTray) return;
    const n = Object.fromEntries(Object.entries(this.by).map(([k, list]) => [k, list.filter((x) => x.fresh).length]).filter(([, c]) => c > 0));
    if (JSON.stringify(n) !== JSON.stringify(shared("scribble.fresh") ?? {})) setShared("scribble.fresh", n);
  }

  // `sent`: an agent sent these; they wait in the tray and nothing opens.
  take(found, space, sent = false) {
    const key = space || this.space(), list = (this.by[key] ??= []);
    let last = null;
    for (const it of found) {
      if (it.kind === "error") { fail(`Can't show ${it.name}`, it.error); continue; }
      // Markdown is read in a tab of its own, not in the tray.
      if (it.kind === "md") { run("tab.new", { space: key === "none" ? undefined : key, name: it.name, mod: "scribble", props: { page: it.path } }); continue; }
      const at = list.findIndex((x) => x.path === it.path);
      if (at >= 0) list.splice(at, 1);
      list.unshift(sent ? { ...it, fresh: true } : it);
      last = it;
    }
    list.length = Math.min(list.length, 30);
    this.save();
    this.countFresh();
    if (!last) return;
    if (sent) notify({ title: `An image waits in Images${key === this.space() ? "" : ` (${spaces().find((s) => s.id === key)?.name ?? "another space"})`}`, body: last.name, timeout: 5000 });
    else if (key === this.space()) this.open(last);
    else notify({ title: `Added to ${spaces().find((s) => s.id === key)?.name ?? "another space"}`, body: last.name });
  }

  add(paths, cx, space, sent = false) {
    if (!paths?.length) return;
    const key = space || this.space();
    cx.spawn(async (cx) => {
      try { this.take(await script(["add", ...paths]), key, sent); } catch (e) { fail("Can't open the files", e); }
      cx.notify();
    });
  }

  // ---- the tab bar's button --------------------------------------------------------------

  initButton(cx) {
    this.button = true;
    // The panels this bar opens: Images (the tray), and any others the layout names in
    // props.buttons [{ child, label, icon, width }], each a child of the `panel-body` stack.
    this.bar = props()?.buttons ?? [{ child: "view", label: "Images", icon: props()?.icon ?? "mods/scribble/image.svg", width: 184 }];
    const panels = shared("workspace.panels") ?? ["files", "changes"];
    const more = this.bar.map((b) => b.child).filter((c) => !panels.includes(c));
    if (more.length) setShared("workspace.panels", [...panels, ...more]);   // the tab bar restores them per space
    // Key commands: scribble.toggle (Images), scribble.toggle-<child>.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle") this.toggle("view");
        else if (typeof c === "string" && c.startsWith("toggle-")) this.toggle(c.slice(7));
        cx.notify();
      }
    });
    // Images that agents sent while the tray was never opened: counted here, for the button's dot.
    cx.spawn(async (cx) => {
      await fs.mkdir(INBOX(), { recursive: true }).catch(() => {});
      const count = async () => {
        const text = await readTextFile(QUEUE()).catch(() => ""), taken = BigInt(shared("scribble.taken") ?? "0"), n = {};
        for (const line of text.split("\n")) {
          try { const m = JSON.parse(line); if (m?.id && BigInt(m.id) > taken && m.space) n[m.space] = (n[m.space] ?? 0) + 1; } catch { /* not a line */ }
        }
        if (JSON.stringify(n) !== JSON.stringify(shared("scribble.pending") ?? {})) setShared("scribble.pending", n);
      };
      await count();
      for (;;) { await watchFolder(INBOX()); await count(); cx.notify(); }
    });
  }

  // The panel child that shows now, or null when the panel is closed.
  active() {
    const find = (n, id) => (!n ? null : n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    this.sync(panel, body?.active);
    return panel && !panel.hidden ? body?.active ?? null : null;
  }

  // Each of this bar's panels has its own width; Files and Changes share one. On a change
  // between them, the width the person left is kept and the other side's width is set.
  sync(panel, active) {
    if (!panel || panel.hidden) return;
    const mine = this.bar.find((b) => b.child === active);
    const side = mine ? mine.child : "files", usual = mine?.width ?? 368;
    const px = panel.size?.px, kept = Number(localStorage.getItem(`width-${side}`));
    if (this.side && this.side !== side) {
      if (px) localStorage.setItem(`width-${this.side}`, String(px));
      if ((kept || usual) !== px) run("layout.resize", { id: "panel", px: kept || usual });
    } else if (!this.side && mine && !kept && px !== usual) {
      run("layout.resize", { id: "panel", px: usual });
    }
    this.side = side;
  }

  toggle(child) {
    if (this.active() === child) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child }); run("layout.show", { id: "panel" }); }
  }

  // Images that wait unopened in the shown space: in the tray, or not taken by it yet.
  waiting() {
    const id = spaces().find((s) => s.active)?.id;
    return ((shared("scribble.fresh") ?? {})[id] ?? 0) + ((shared("scribble.pending") ?? {})[id] ?? 0);
  }

  bar_button(t) {
    const now = this.active();
    return h_flex().size_full().pr(10).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .children(this.bar.map((b) => h_flex().id(`panel-${b.child}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(12).bg(now === b.child ? t.selected : t.chrome).text_color(now === b.child ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.toggle(b.child))
        .child(svg(b.icon ?? "mods/scribble/image.svg").size(14)).child(b.label)
        // an image waits unopened in this space
        .when(b.child === "view" && this.waiting() > 0, (el) => el.child(div().size(6).flex_none().rounded_full().bg(t.accent)))));
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

  // The editor, as a tab of the shown space: it waits there like any tab and covers nothing.
  open(it) {
    const space = spaces().find((s) => s.active);
    if (it.fresh) { delete it.fresh; this.save(); this.countFresh(); }
    const { fresh: _f, ...item } = it;
    run("tab.new", { space: space?.id, name: it.name, mod: "scribble",
      props: { editor: true, item, terminal: this.target(), folder: space && !space.machine ? space.folder : null } });
  }

  remove(n) {
    const [it] = this.items.splice(n, 1);
    this.save();
    this.countFresh();
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
          .border(it.fresh ? 2 : 1).border_color(it.fresh ? t.accent : t.border).hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => { this.open(it); cx.notify(); })
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
          .on_click((_e, cx) => { this.open(it); cx.notify(); })
          .when(Boolean(it.fresh), (el) => el.child(div().size(7).flex_none().rounded_full().bg(t.accent)))
          .child(div().size(64).flex_none().rounded(4).overflow_hidden().bg(t.raised).flex().items_center().justify_center()
            .when(Boolean(it.fresh), (el) => el.border(2).border_color(t.accent))
            .text_size(10).text_color(t.muted)
            .child(it.kind === "image" ? image(it.rel).size_full() : "MD"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(it.name))
          .child(div().id(`x-${n}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.remove(n); cx.notify(); })
            .child("×")))));
  }

  // ---- the editor ------------------------------------------------------------------------

  initEditor(cx, item = props().item) {
    this.it = item;
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
  // The editor is a tab (an older caller may still open it as a dialog).
  shut() { props()?.overlay ? closeOverlay(props().overlay) : run("tab.close"); }

  flatten(mode) {
    return script(["flatten", JSON.stringify({ path: this.it.path, shapes: this.shapes, mode, dir: this.projectFolder(), line: LINE, text: TEXT })]);
  }

  // The chat this image belongs to: the one it was opened from, else the terminal that sent it,
  // else the most recent agent of the shown space.
  chat() {
    if (props()?.terminal) return props().terminal;
    const space = spaces().find((s) => s.active)?.id;
    return agents().filter((a) => a.space === space).sort((a, b) => b.seq - a.seq)[0]?.address ?? null;
  }

  // Where the marked copy is saved: the folder given, else the folder of the chat's space.
  projectFolder() {
    if (props()?.folder) return props().folder;
    const a = agents().find((x) => x.address === this.chat());
    const space = spaces().find((s) => s.id === a?.space) ?? spaces().find((s) => s.active);
    return space && !space.machine ? space.folder : null;
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
    const terminal = this.chat();
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
    if (this.previews) return this.previewsView(t);
    if (this.reader) return v_flex().id("reader").size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().flex_none().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.it.path))
        .child(this.btn("md-copy", "Copy path", t, () => { exec("/bin/sh", ["-c", 'printf "%s" "$1" | /usr/bin/pbcopy', "copy", this.it.path]); }))
        .child(this.btn("md-open", "Open outside", t, () => { exec("/usr/bin/open", [this.it.path]); }))
        .child(this.btn("md-reveal", "Reveal", t, () => { exec("/usr/bin/open", ["-R", this.it.path]); })))
      .child(this.page(t));
    if (this.viewer && !this.editor) return div().size_full().flex().items_center().justify_center().bg(t.background).text_size(12.5)
      .text_color(this.viewerError ? t.blocked : t.muted).child(this.viewerError ?? "Opening…");
    if (!this.editor) return this.tray(t);
    return v_flex().id("editor").size_full().bg(t.background).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_up("left", (_e, cx) => this.up(cx))
      .child(this.bar(t))
      .child(this.it.kind === "image" ? this.picture(t) : this.page(t));
  }
}
