#!/usr/bin/env python3
"""Helper for the scribble Herdr mod, and the `herdr-view` command.

  herdr-view <file>...        show images / markdown in a View pane beside this terminal
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


def where(terminal):
    """The tab and pane that hold a terminal, from the open window."""
    r = subprocess.run(['herdr-app', 'ls'], capture_output=True, text=True, timeout=15)
    if r.returncode: raise SystemExit(r.stderr.strip() or 'The Herdr window is not open')
    for space in json.loads(r.stdout).get('spaces', []):
        for tab in space['tabs']:
            for t in tab['terminals']:
                if t['terminal'] == terminal: return space['id'], tab['id'], t['pane']
    return None, None, None


def offer(box, files, tries, space=None):
    """Leave files in an inbox; true when a live View took them."""
    INBOX.mkdir(parents=True, exist_ok=True)
    ident = f'{time.time_ns()}'
    ack = INBOX / f'{box}.ack'
    (INBOX / f'{box}.json').write_text(json.dumps({'id': ident, 'files': files, 'space': space}))
    for _ in range(tries):
        time.sleep(0.1)
        if ack.exists() and ack.read_text().strip() == ident: return True
    return False


def show(paths, terminal=None):
    """Show files in the View pane of the caller's tab; split one beside the caller when there is none."""
    files = [str(Path(os.path.expanduser(p)).resolve()) for p in paths]
    for f in files:
        if not os.path.isfile(f): raise SystemExit(f'No such file: {f}')
        if not kind(f): raise SystemExit(f'herdr-view shows images and markdown/text. Use `open` for: {f}')
    # The layout's View block first (shown if hidden), then a View pane of the caller's tab.
    space, tab, pane = where(terminal or os.environ.get('HC_TERMINAL_ID'))
    pages = [f for f in files if kind(f) == 'md']
    for f in pages:  # markdown: a tab of its own in the caller's space
        args = {'name': Path(f).name, 'mod': 'scribble', 'props': {'page': f}}
        if space: args['space'] = space
        app('tab.new', args)
    files = [f for f in files if kind(f) == 'image']
    if not files: return {'shown': pages, 'pane': 'tab'}
    if offer('dock', files, 15, space): return {'shown': files, 'pane': 'dock'}
    if tab and offer(tab, files, 8): return {'shown': files, 'pane': 'existing'}
    args = {'direction': 'right', 'mod': 'scribble', 'props': {'files': files, 'tab': tab}}
    if pane: args['pane'] = pane
    app('pane.split', args)
    return {'shown': files, 'pane': 'new'}


def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        print(__doc__.strip()); return
    cmd, rest = argv[0], argv[1:]
    if cmd == 'add': out = add(rest)
    elif cmd == 'paste': out = paste()
    elif cmd == 'flatten': out = flatten(json.loads(rest[0]))
    elif cmd == 'show':
        terminal = None
        if rest[:1] == ['--terminal']: terminal, rest = rest[1], rest[2:]
        out = show(rest, terminal)
    else: out = show(argv)
    print(json.dumps(out))


if __name__ == '__main__':
    try: main(sys.argv[1:])
    except SystemExit: raise
    except Exception as e:
        print(json.dumps({'error': str(e)})); sys.exit(1)
