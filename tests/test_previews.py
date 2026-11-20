import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

VIEW_PATH = Path(__file__).resolve().parents[1] / "mods" / "scribble" / "view.py"


def load_view(home_dir: Path):
    prev = os.environ.get("HERDR_APP_HOME")
    os.environ["HERDR_APP_HOME"] = str(home_dir)
    try:
        spec = importlib.util.spec_from_file_location("scribble_view", VIEW_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if prev is None:
            os.environ.pop("HERDR_APP_HOME", None)
        else:
            os.environ["HERDR_APP_HOME"] = prev


class PreviewLogicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "app-home"
        self.home.mkdir()
        self.view = load_view(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def test_parse_dedup_missing_and_counts(self):
        md_ok = self.root / "doc.md"
        md_ok.write_text("# hi\n")
        img_ok = self.root / "pic.png"
        img_ok.write_bytes(b"fake")
        mp4_ok = self.root / "clip.mp4"
        mp4_ok.write_bytes(b"fake")
        missing = self.root / "gone.md"

        lines = [
            json.dumps({"id": "100", "path": str(md_ok), "kind": "md", "t": 1}),
            json.dumps({"id": "200", "path": str(md_ok), "kind": "md", "t": 2}),
            json.dumps({"id": "300", "path": str(missing), "kind": "md", "t": 3}),
            json.dumps({"id": "400", "path": str(mp4_ok), "kind": "file", "record_only": True, "t": 4}),
            json.dumps({"id": "500", "path": str(img_ok), "kind": "image", "t": 5}),
            "not valid json",
            "",
        ]
        entries, max_id = self.view.parse_preview_lines("\n".join(lines), existing_only=True)
        self.assertEqual(max_id, 500)
        self.assertEqual([e["path"] for e in entries], [str(img_ok), str(mp4_ok), str(md_ok)])
        self.assertEqual(self.view.fresh_count(entries, 0), 2)
        self.assertEqual(self.view.fresh_count(entries, 200), 1)
        self.assertEqual(self.view.fresh_count(entries, 500), 0)
        self.assertEqual(self.view.preview_tab_name(2), "Preview · 2 new")
        self.assertEqual(self.view.preview_tab_name(0), "Preview")

    def test_list_and_counts_missing_seen_and_read_only(self):
        previews = self.view.PREVIEWS
        previews.mkdir(parents=True)
        md_a = self.root / "a.md"
        md_a.write_text("a")
        html_b = self.root / "b.html"
        html_b.write_text("<html/>")
        gone = self.root / "deleted.md"

        jsonl = previews / "sp1.jsonl"
        raw = "\n".join([
            json.dumps({"id": "10", "path": str(md_a), "kind": "md", "t": 10}),
            json.dumps({"id": "20", "path": str(html_b), "kind": "file", "t": 20}),
            json.dumps({"id": "30", "path": str(gone), "kind": "md", "t": 30}),
        ]) + "\n"
        jsonl.write_text(raw)
        (previews / "sp1.tab").write_text("tb1")

        listed = self.view.list_previews("sp1")
        self.assertEqual(listed["seen"], "0")
        self.assertEqual(listed["max_id"], "30")
        self.assertEqual(listed["fresh"], 1)
        self.assertEqual(listed["tab"], "tb1")
        self.assertEqual([e["path"] for e in listed["entries"]], [str(html_b), str(md_a)])

        counts = self.view.preview_counts()
        self.assertEqual(counts["sp1"], {"tab": "tb1", "fresh": 1, "total": 2})
        # Read-only: jsonl was not modified by list_previews or preview_counts
        self.assertEqual(jsonl.read_text(), raw)

    def test_old_mtime_image_survives_prune(self):
        from PIL import Image

        self.view.SRC.mkdir(parents=True)
        for i in range(65):
            p = self.view.SRC / f"newer-{i:02d}.png"
            p.write_bytes(b"x")

        old_img = self.root / "old.png"
        Image.new("RGB", (32, 24), (10, 20, 30)).save(old_img)
        os.utime(old_img, (1577836800, 1577836800))  # 2020-01-01

        items = self.view.add([str(old_img)])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["kind"], "image")
        cached = self.home / items[0]["rel"]
        self.assertTrue(cached.is_file(), "newly added old-mtime image was pruned")
        self.assertEqual(cached.stat().st_nlink, 1)


if __name__ == "__main__":
    unittest.main()
