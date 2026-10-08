import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import os
import subprocess

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from crop_sources import crop_sources
import importlib.util
spec = importlib.util.spec_from_file_location("ocr_pages", Path(__file__).resolve().parents[2] / "scripts" / "ocr-pages.py")
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="recorder-python-")
        self.project = Path(self.temp.name).resolve()
        self.job = self.project / "data" / "jobs" / "synthetic"
        (self.job / "images").mkdir(parents=True)
        image = Image.new("RGB", (6, 4), "white")
        image.putpixel((2, 1), (10, 40, 180))
        encoded = io.BytesIO()
        image.save(encoded, format="PNG")
        self.raw = encoded.getvalue()
        self.source = self.job / "images" / "page-0001.png"
        self.source.write_bytes(self.raw)
        self.index = {"schemaVersion": 1, "bookId": 900001, "pages": [{"systemPage": 1,
            "file": "images/page-0001.png", "width": 6, "height": 4, "bytes": len(self.raw),
            "mimeType": "image/png", "sha256": hashlib.sha256(self.raw).hexdigest()}]}
        self.index_path = self.job / "index.json"
        self.index_path.write_text(json.dumps(self.index), encoding="utf-8")
        self.plan = {"schemaVersion": 1, "bookId": 900001,
                     "index": {"path": "index.json", "sha256": hashlib.sha256(self.index_path.read_bytes()).hexdigest()},
                     "crops": [{"id": "figure", "page": 1, "bbox": [1, 0, 4, 3], "purpose": "diagram"}]}

    def tearDown(self):
        self.temp.cleanup()

    def crop(self):
        self.plan_path = self.job / "crop-plan.json"
        self.plan_path.write_text(json.dumps(self.plan), encoding="utf-8")
        return crop_sources(self.project, self.plan_path, self.job / "source.json")

    def args(self, **extra):
        args = dict(index=self.index_path, pages=[1], output=None, model_cache=None,
                    det_model_dir=None, rec_model_dir=None, dry_run=True, force=False,
                    retry_failed=False, offline=False)
        args.update(extra)
        return argparse.Namespace(**args)

    def test_crop_exact_original_pixels_and_byte_bound_evidence(self):
        result = self.crop()
        self.assertFalse(result["sourceModified"])
        self.assertEqual(self.raw, self.source.read_bytes())
        crop = self.job / "figures" / "figure.png"
        with Image.open(crop) as image:
            self.assertEqual(image.size, (3, 3))
            self.assertEqual(image.getpixel((1, 1)), (10, 40, 180))
        evidence = json.loads((self.job / "source.json").read_text())
        self.assertEqual(evidence["crops"][0]["sha256"], hashlib.sha256(crop.read_bytes()).hexdigest())
        self.assertEqual(evidence["crops"][0]["sourceSha256"], self.index["pages"][0]["sha256"])

    def test_invalid_bbox_validation_writes_nothing(self):
        self.plan["crops"].append({"id": "bad", "page": 1, "bbox": [0, 0, 7, 4], "purpose": "table"})
        with self.assertRaisesRegex(ValueError, "BBox"):
            self.crop()
        self.assertFalse((self.job / "figures").exists())
        self.assertFalse((self.job / "source.json").exists())

    def test_source_and_index_changes_refuse_before_output(self):
        self.source.write_bytes(self.raw + b"changed")
        with self.assertRaisesRegex(ValueError, "SHA256"):
            self.crop()
        self.assertFalse((self.job / "figures").exists())
        self.source.write_bytes(self.raw)
        self.index_path.write_text("{}")
        with self.assertRaisesRegex(ValueError, "Index bytes"):
            self.crop()

    def test_cannot_overwrite_or_crop_whole_question_purpose(self):
        self.crop()
        before = (self.job / "source.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.crop()
        self.assertEqual(before, (self.job / "source.json").read_bytes())
        (self.job / "source.json").unlink()
        self.plan["crops"][0]["purpose"] = "whole-question"
        with self.assertRaisesRegex(ValueError, "Only diagram/table"):
            self.crop()

    def test_crop_external_output_refused(self):
        with self.assertRaisesRegex(ValueError, "data/jobs"):
            crop_sources(self.project, self.index_path, self.project / "outside.json")

    def test_reserved_device_filenames_are_rejected_on_all_platforms(self):
        self.plan["crops"][0]["id"] = "COM1"
        with self.assertRaisesRegex(ValueError, "reserved device"):
            self.crop()
        self.assertFalse((self.job / "figures").exists())

    def test_ocr_dry_run_selected_hash_checked_without_model_or_writes(self):
        self.assertEqual(ocr.run(self.args(), self.project), 0)
        self.assertFalse((self.job / "ocr").exists())
        self.assertFalse((self.project / "data" / "ocr-models").exists())
        self.assertEqual(ocr.run(self.args(pages=[2]), self.project), 2)
        self.source.write_bytes(b"changed")
        self.assertEqual(ocr.run(self.args(), self.project), 1)
        self.assertFalse((self.job / "ocr").exists())

    def test_ocr_outside_output_or_foreign_journal_refused(self):
        with self.assertRaisesRegex(ValueError, "within the job"):
            ocr.run(self.args(output=self.project / "outside"), self.project)
        folder = self.job / "ocr"
        folder.mkdir()
        (folder / "status.json").write_text(json.dumps({"schemaVersion": 1, "bookId": 900002, "pages": {}}))
        with self.assertRaisesRegex(ValueError, "different book"):
            ocr.run(self.args(), self.project)

    def test_symlink_escape_refused_where_platform_allows_symlinks(self):
        external = self.project / "outside"
        external.mkdir()
        try:
            (self.job / "figures").symlink_to(external, target_is_directory=True)
        except OSError:
            if os.name != 'nt':
                self.skipTest("Directory symlinks unavailable")
            created = subprocess.run(["cmd", "/c", "mklink", "/J", str(self.job / "figures"), str(external)], capture_output=True)
            self.assertEqual(created.returncode, 0, "The isolated test directory junction must be created")
        with self.assertRaisesRegex(ValueError, "leaves"):
            self.crop()
        self.assertEqual(list(external.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
