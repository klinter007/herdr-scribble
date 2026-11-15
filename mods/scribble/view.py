#!/usr/bin/env python3
"""Helper for the scribble Herdr mod, and the `herdr-view` command.

  herdr-view <file>...        the file goes on the list of the Preview tab of this terminal's space
  view.py add <path>...       make dropped files showable; prints JSON
  view.py paste               the clipboard's image as an item; prints JSON
  view.py flatten <json>      draw the marks on the image, copy it; prints JSON
"""
import json, os, subprocess, sys, time, zlib
from pathlib import Path

HOME = Path(os.environ.get('HERDR_APP_HOME') or Path.home() / '.config/herdr-app')
DATA = HOME / 'data/scribble'
SRC, OUT, INBOX = DATA / 'src', DATA / 'out', DATA / 'inbox'
IMAGES = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic'}
NATIVE = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}
TEXTS = {'.md', '.markdown', '.mdx', '.txt'}
FONTS = ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf']


def kind(path):
    s = Path(path).suffix.lower()
    return 'image' if s in IMAGES else 'md' if s in TEXTS else None


def prune(folder, keep):
    files = sorted((p for p in folder.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime)
    for p in files[:-keep]:
        p.unlink(missing_ok=True)


def image_item(path):
    from PIL import Image
    path = Path(path).resolve()
    SRC.mkdir(parents=True, exist_ok=True)
    stamp = f'{zlib.crc32(str(path).encode()):08x}-{int(path.stat().st_mtime)}'
    with Image.open(path) as im:
        w, h = im.size
        if path.suffix.lower() in NATIVE:
            dest = SRC / f'{stamp}{path.suffix.lower()}'
            if not dest.exists():
                try: os.link(path, dest)
                except OSError: dest.write_bytes(path.read_bytes())
        else:
            dest = SRC / f'{stamp}.png'
            if not dest.exists(): im.convert('RGBA').save(dest)
    return {'kind': 'image', 'path': str(path), 'name': path.name, 'w': w, 'h': h,
            'rel': str(dest.relative_to(HOME))}


def add(paths):
    items = []
    for p in paths:
        p = os.path.expanduser(p)
        k = kind(p)
        try:
            if not os.path.isfile(p): raise ValueError('not a file')
            if k == 'image': items.append(image_item(p))
            elif k == 'md': items.append({'kind': 'md', 'path': str(Path(p).resolve()), 'name': Path(p).name})
            else: raise ValueError('not an image or a markdown file')
        except Exception as e:
            items.append({'kind': 'error', 'name': Path(p).name, 'error': str(e)})
    if SRC.exists(): prune(SRC, 60)
    return items


def paste():
    from PIL import ImageGrab
    im = ImageGrab.grabclipboard()
    if isinstance(im, list):
        return add(im)
    if im is None:
        return [{'kind': 'error', 'name': 'Clipboard', 'error': 'The clipboard holds no image'}]
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / f'pasted-{time.strftime("%Y%m%d-%H%M%S")}.png'
    im.save(dest)
    return add([str(dest)])


def font(size):
    from PIL import ImageFont
    for f in FONTS:
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default(size)


def project_dir(folder):
    """<project>/.scribble, kept out of Git through the repo's local exclude file."""
    if not folder or not os.path.isdir(folder) or Path(folder).resolve() == Path.home(): return None
    out = Path(folder) / '.scribble'
    try:
        out.mkdir(exist_ok=True)
        r = subprocess.run(['git', '-C', folder, 'rev-parse', '--git-path', 'info/exclude'], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            ex = Path(folder) / r.stdout.strip() if not os.path.isabs(r.stdout.strip()) else Path(r.stdout.strip())
            old = ex.read_text() if ex.exists() else ''
            if '.scribble/' not in old.split():
                ex.parent.mkdir(parents=True, exist_ok=True)
                ex.write_text(old + ('' if old.endswith('\n') or not old else '\n') + '.scribble/\n')
    except OSError:
        return None
    return out


def flatten(job):
    """job: {path, shapes: [{type, color, pts | a,b | at,text}], mode: image | path, dir: project}; coordinates 0..1."""
    import math
    from PIL import Image, ImageDraw
    im = Image.open(job['path']).convert('RGBA')
    w, h = im.size
    d = ImageDraw.Draw(im)
    lw = max(2, round(max(w, h) * job.get('line', 0.004)))
    px = lambda p: (p[0] * w, p[1] * h)
    for s in job.get('shapes', []):
        c = s.get('color', '#ff3b30')
        if s['type'] == 'pen':
            pts = [px(p) for p in s['pts']]
            if len(pts) == 1: pts.append(pts[0])
            d.line(pts, fill=c, width=lw, joint='curve')
            for x, y in (pts[0], pts[-1]):
                d.ellipse([x - lw / 2, y - lw / 2, x + lw / 2, y + lw / 2], fill=c)
        elif s['type'] == 'box':
            (x1, y1), (x2, y2) = px(s['a']), px(s['b'])
            d.rectangle([min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)], outline=c, width=lw)
        elif s['type'] == 'arrow':
            (x1, y1), (x2, y2) = px(s['a']), px(s['b'])
            ang, head = math.atan2(y2 - y1, x2 - x1), lw * 4.5
            bx, by = x2 - head * math.cos(ang), y2 - head * math.sin(ang)
            d.line([(x1, y1), (bx, by)], fill=c, width=lw)
            d.polygon([(x2, y2), (bx + head * 0.5 * math.sin(ang), by - head * 0.5 * math.cos(ang)),
                       (bx - head * 0.5 * math.sin(ang), by + head * 0.5 * math.cos(ang))], fill=c)
        elif s['type'] == 'text':
            size = max(12, round(max(w, h) * job.get('text', 0.022)))
            f, pad = font(size), round(size * 0.35)
            x, y = px(s['at'])
            l, t, r, b = d.textbbox((0, 0), s['text'], font=f)
            d.rounded_rectangle([x, y, x + (r - l) + 2 * pad, y + size * 1.25 + 2 * pad], radius=pad, fill=c)
            d.text((x + pad - l, y + pad), s['text'], font=f, fill='#ffffff')
    out = project_dir(job.get('dir')) or OUT
    out.mkdir(parents=True, exist_ok=True)
    dest = out / f'{Path(job["path"]).stem[:40]}-marked-{time.strftime("%Y%m%d-%H%M%S")}.png'
    im.convert('RGB').save(dest)
    prune(out, 30)
    if job.get('mode') == 'path':
        subprocess.run(['/usr/bin/pbcopy'], input=str(dest), text=True, check=True, timeout=5)
    else:
        subprocess.run(['/usr/bin/osascript', '-e',
                        f'set the clipboard to (read (POSIX file "{dest}") as «class PNGf»)'],
                       check=True, timeout=15, capture_output=True)
    return {'path': str(dest)}


def app(command, args):
    r = subprocess.run(['herdr-app', 'do', command, json.dumps(args)], capture_output=True, text=True, timeout=15)
    if r.returncode: raise SystemExit(r.stderr.strip() or f'herdr-app do {command} failed')
    return json.loads(r.stdout or '{}')


def space_of(terminal):
    """The space a terminal belongs to: its own label, else an ancestor's (a worker started by an
    agent has none), else the space its `where` label names, else the space whose folder holds
    its working directory. None when nothing says: never the space that happens to be in focus."""
    import json as _j, subprocess as _s
    def get(t):
        try: return _j.loads(_s.run(["herdr-core", "get", t, "--json"], capture_output=True, text=True, timeout=15).stdout)
        except Exception: return {}
    t, seen, first = terminal, set(), None
    while t and t not in seen:
        seen.add(t)
        g = get(t)
        first = first or g
        s = (g.get("labels") or {}).get("herdr.space")
        if s: return s
        t = g.get("parent")
    try: spaces = _j.loads(_s.run(["herdr-app", "ls"], capture_output=True, text=True, timeout=15).stdout).get("spaces", [])
    except Exception: spaces = []
    for s in spaces:
        if any(x.get("terminal") in seen for tab in s.get("tabs", []) for x in tab.get("terminals", [])): return s["id"]
    name = str(((first or {}).get("labels") or {}).get("where") or "").split(" / ")[0].strip()
    for s in spaces:
        if name and s.get("name") == name: return s["id"]
    cwd = str((first or {}).get("cwd") or "")
    best = max((s for s in spaces if s.get("folder") and (cwd + "/").startswith(s["folder"].rstrip("/") + "/")), key=lambda s: len(s["folder"]), default=None)
    return best["id"] if best else None


def queue(files, space):
    """Leave images for the tray. It takes them when it is alive, or the next time it opens; nothing opens by itself."""
    INBOX.mkdir(parents=True, exist_ok=True)
    q = INBOX / 'queue.jsonl'
    old = q.read_text().splitlines()[-49:] if q.exists() else []
    q.write_text('\n'.join(old + [json.dumps({'id': f'{time.time_ns()}', 'files': files, 'space': space})]) + '\n')


PREVIEWS = DATA / 'previews'


def source_of(terminal):
    """Who sent a file: the terminal, and a name a person reads (its own name, else tab and program)."""
    try: g = json.loads(subprocess.run(['herdr-core', 'get', terminal, '--json'], capture_output=True, text=True, timeout=15).stdout)
    except Exception: g = {}
    where = str((g.get('labels') or {}).get('where') or '')
    tab = where.split(' / ')[-1].strip() if ' / ' in where else ''
    program = str(((g.get('foreground') or {}).get('argv') or [''])[0]).split('/')[-1]
    name = g.get('name') or (tab if tab and not tab.isdigit() else ' '.join(x for x in (program, tab) if x)) or terminal or 'unknown'
    return {'terminal': terminal, 'name': name}


def preview_tab(space):
    """The one Preview tab of a space: made the first time, in the background, then reused."""
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    note = PREVIEWS / f'{space}.tab'
    known = note.read_text().strip() if note.exists() else ''
    try: listing = json.loads(subprocess.run(['herdr-app', 'ls'], capture_output=True, text=True, timeout=15).stdout).get('spaces', [])
    except Exception: listing = []
    mine = next((sp for sp in listing if sp['id'] == space), None)
    if not mine: return None
    if known and any(t['id'] == known for t in mine['tabs']): return known
    try: before = json.loads(subprocess.run(['herdr-app', 'status'], capture_output=True, text=True, timeout=15).stdout)
    except Exception: before = {}
    front = next((t['id'] for t in mine['tabs'] if t.get('active')), None)
    made = app('tab.new', {'space': space, 'name': 'Preview', 'mod': 'scribble', 'props': {'previews': True, 'space': space}}).get('tab')
    if made: note.write_text(made)
    # the space keeps the tab it showed, and the person keeps the pane they were in
    if front: subprocess.run(['herdr-app', 'do', 'tab.select', json.dumps({'id': front})], capture_output=True, timeout=15)
    if before.get('focused_pane'): subprocess.run(['herdr-app', 'do', 'pane.focus', json.dumps({'pane': before['focused_pane']})], capture_output=True, timeout=15)
    return made


def show(paths, terminal=None, record_only=False):
    """An agent shows files: each one goes on the list of its space's Preview tab, newest first.
    Nothing comes to the front: the tab's name says how many are new. `record_only`: the file was
    opened elsewhere (a browser); it is listed, and the tab is not made for it alone."""
    files = [str(Path(os.path.expanduser(p)).resolve()) for p in paths]
    for f in files:
        if not os.path.isfile(f): raise SystemExit(f'No such file: {f}')
    terminal = terminal or os.environ.get('HC_TERMINAL_ID')
    space = space_of(terminal)
    if not space:   # nothing says which space: in the background, never in the space in focus
        for f in files: subprocess.run(['/usr/bin/open', '-g', f], timeout=15)
        return {'shown': [], 'opened_outside': files}
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    listing = PREVIEWS / f'{space}.jsonl'
    old = [l for l in (listing.read_text().splitlines() if listing.exists() else []) if l.strip()]
    who, now = source_of(terminal), int(time.time() * 1000)
    new = [json.dumps({'id': f'{time.time_ns() + n}', 'path': f, 'kind': kind(f) or 'file', 'from': who, 't': now}) for n, f in enumerate(files)]
    listing.write_text('\n'.join((old + new)[-300:]) + '\n')
    tab = None if record_only else preview_tab(space)
    if not tab:
        note = PREVIEWS / f'{space}.tab'
        tab = note.read_text().strip() if note.exists() else None
    if tab:   # the tab says how many the person has not seen
        seen = PREVIEWS / f'{space}.seen'
        last = int(seen.read_text().strip() or 0) if seen.exists() else 0
        fresh = sum(1 for l in old + new if int(json.loads(l)['id']) > last)
        subprocess.run(['herdr-app', 'do', 'tab.rename', json.dumps({'id': tab, 'name': f'Preview · {fresh} new' if fresh else 'Preview'})], capture_output=True, timeout=15)
    return {'listed_in_preview': files, 'space': space}


def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        print(__doc__.strip()); return
    cmd, rest = argv[0], argv[1:]
    if cmd == 'add': out = add(rest)
    elif cmd == 'paste': out = paste()
    elif cmd == 'flatten': out = flatten(json.loads(rest[0]))
    elif cmd == 'show':
        terminal, record = None, False
        while rest[:1] and rest[0] in ('--terminal', '--record-only'):
            if rest[0] == '--terminal': terminal, rest = rest[1], rest[2:]
            else: record, rest = True, rest[1:]
        out = show(rest, terminal, record)
    else: out = show(argv)
    print(json.dumps(out))


if __name__ == '__main__':
    try: main(sys.argv[1:])
    except SystemExit: raise
    except Exception as e:
        print(json.dumps({'error': str(e)})); sys.exit(1)
