# Scribble

Draw on an image inside [Herdr](https://herdr.dev), then send it to your agent.

Some things are hard to say in words: move this, fix that corner, make this part
bigger. Scribble is a Herdr mod that lets you point at them. Drop an image into a
small tray, mark it up, and one click pastes the marked image into your agent's chat.

![Scribble](preview.png)

## What it does

- **Tray.** A narrow column on the right of the window. Drop an image on it, or
  click it and press Cmd+V to paste a screenshot. Each space keeps its own images.
- **Editor.** A new image, or a click on a thumbnail, opens a large dialog. Draw
  with Pen, Box, Arrow and Text in six colors. Undo with Cmd+Z.
- **Insert to chat.** Saves the marked image, closes the dialog and pastes the
  image into the terminal that had the focus (Cmd+Enter does the same). Copy image
  and Copy path are there too.
- **A copy in your project.** Every marked image is also saved in
  `<project>/.scribble/`, where the project is the folder of the active space.
  In a Git repository the folder is added to `.git/info/exclude`, so it stays
  out of your commits.
- **For agents.** `python3 ~/.config/herdr-app/mods/scribble/view.py <image>`
  puts an image in the tray and opens it, so an agent can show you a picture
  inside Herdr. A markdown file given to the same command opens in a tab of its own.

## Install

Ask your agent in Herdr:

> Add the mod herdr.dev/mods/klinter007/herdr-scribble

Or by hand:

```sh
git clone https://github.com/klinter007/herdr-scribble
cp -R herdr-scribble/mods/scribble ~/.config/herdr-app/mods/
python3 -m pip install pillow
herdr-app check ~/.config/herdr-app/mods/scribble
```

Herdr docks the tray on the right the first time it sees the folder.

## Requirements

- Herdr desktop app (built on 0.1.x), macOS.
- `python3` on your PATH with [Pillow](https://pypi.org/project/pillow/). The mod
  uses it to draw the marks on the full-size image.

## What it touches

Scribble is trusted local code, like every Herdr mod. It runs `python3`,
`osascript`, `pbcopy`, `open` and `herdr-app`; it reads the images you give it;
it writes under `~/.config/herdr-app/data/scribble/` and `<project>/.scribble/`.
It does not use the network.

## License

MIT
