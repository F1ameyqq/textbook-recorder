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
from types import SimpleNamespace
from unittest import mock

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
        self.model_dirs = []
        for name in (ocr.DET_MODEL, ocr.REC_MODEL):
            folder = self.project / "model-fixtures" / name
            folder.mkdir(parents=True)
            for filename in ("inference.json", "inference.yml", "inference.pdiparams"):
                (folder / filename).write_bytes(b"unit-test-model-only")
            self.model_dirs.append(folder)
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
                    det_model_dir=self.model_dirs[0], rec_model_dir=self.model_dirs[1], dry_run=True, force=False,
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

    def fake_device_modules(self, device="gpu:0", cuda=True, predictor_device=None, tensor_place=None, runner_device=None, runner_threads=2):
        """Model no weights; simulate device refusal and an internal CPU fallback."""
        class Tensor:
            place = tensor_place or ("Place(gpu:0)" if device == "gpu:0" else "Place(cpu)")
            def __matmul__(self, other):
                return self
            def sum(self):
                return SimpleNamespace(item=lambda: 512.0)
        selected = predictor_device or device
        def predictor(name):
            return SimpleNamespace(model_name=name, device=selected,
                engine_config={"device_type": "gpu" if selected.startswith("gpu") else "cpu", "device_id": 0},
                runner=SimpleNamespace(_config={"device_type": runner_device or ("gpu" if selected.startswith("gpu") else "cpu"),
                                                "device_id": 0, "cpu_threads": runner_threads}))
        pipeline = SimpleNamespace(paddlex_pipeline=SimpleNamespace(text_det_model=predictor(ocr.DET_MODEL), text_rec_model=predictor(ocr.REC_MODEL)))
        factory = mock.Mock(return_value=pipeline)
        paddle = SimpleNamespace(__version__="fixture", is_compiled_with_cuda=lambda: cuda,
            set_device=mock.Mock(), get_device=lambda: device, ones=lambda shape: Tensor(),
            device=SimpleNamespace(cuda=SimpleNamespace(device_count=lambda: 1), synchronize=mock.Mock()))
        cv = SimpleNamespace(setNumThreads=mock.Mock(), getNumThreads=lambda: 2)
        return {"paddle": paddle, "cv2": cv, "paddleocr": SimpleNamespace(PaddleOCR=factory)}, factory

    def test_gpu_unavailable_fails_before_constructing_ocr_without_cpu_fallback(self):
        modules, factory = self.fake_device_modules(cuda=False)
        with mock.patch.dict(sys.modules, modules), mock.patch.dict(os.environ):
            with self.assertRaisesRegex(RuntimeError, "no CPU fallback"):
                ocr.initialize_pipeline(self.args(), self.project / "data" / "models")
        factory.assert_not_called()
        modules["paddle"].set_device.assert_not_called()

    def test_gpu_tensor_and_final_predictor_must_both_use_gpu(self):
        for overrides, message in (({"tensor_place": "Place(cpu)"}, "Tensor execution"),
                                   ({"predictor_device": "cpu"}, "predictor did not use"),
                                   ({"runner_device": "cpu"}, "predictor did not use"),
                                   ({"runner_threads": 10}, "thread limit")):
            modules, _ = self.fake_device_modules(**overrides)
            with self.subTest(overrides=overrides), mock.patch.dict(sys.modules, modules), mock.patch.dict(os.environ):
                with self.assertRaisesRegex(RuntimeError, message):
                    ocr.initialize_pipeline(self.args(), self.project / "data" / "models")

    def test_gpu_is_default_and_cpu_is_explicitly_supported(self):
        for device in ("gpu:0", "cpu"):
            modules, factory = self.fake_device_modules(device=device, cuda=(device == "gpu:0"))
            args = self.args() if device == "gpu:0" else self.args(device="cpu")
            with self.subTest(device=device), mock.patch.dict(sys.modules, modules), mock.patch.dict(os.environ):
                _, proof, sync = ocr.initialize_pipeline(args, self.project / "data" / "models")
                self.assertEqual(proof["actualDevice"], device)
                self.assertEqual(factory.call_args.kwargs["device"], device)
                self.assertEqual(factory.call_args.kwargs["text_recognition_batch_size"], 1)
                self.assertEqual(factory.call_args.kwargs["engine_config"]["cpu_threads"], 2)
                self.assertEqual(len(proof["predictors"]), 2)
                sync()
                self.assertEqual(modules["paddle"].device.synchronize.call_count, 2 if device == "gpu:0" else 0)

    def initialized_fixture(self, text="原图线索"):
        payload = {"rec_texts": [text], "rec_scores": [0.98], "rec_boxes": [[0, 0, 6, 4]]}
        pipeline = SimpleNamespace(predict=mock.Mock(return_value=[SimpleNamespace(json=payload)]))
        return pipeline, {"actualDevice": "fixture"}, mock.Mock()

    def test_device_change_cannot_reuse_cpu_result_and_identical_gpu_resume_skips(self):
        fixture = self.initialized_fixture()
        with mock.patch.object(ocr, "initialize_pipeline", return_value=fixture) as initialize:
            self.assertEqual(ocr.run(self.args(dry_run=False, device="cpu"), self.project), 0)
            cpu = json.loads((self.job / "ocr" / "page-0001.raw.json").read_text(encoding="utf-8"))
            self.assertEqual(ocr.run(self.args(dry_run=False), self.project), 0)
            gpu = json.loads((self.job / "ocr" / "page-0001.raw.json").read_text(encoding="utf-8"))
            self.assertNotEqual(cpu["configurationSha256"], gpu["configurationSha256"])
            self.assertEqual(gpu["engine"]["device"], "gpu:0")
            self.assertEqual(gpu["engine"]["cpuThreads"], 2)
            self.assertEqual(initialize.call_count, 2)
            self.assertEqual(ocr.run(self.args(dry_run=False), self.project), 0)
            self.assertEqual(initialize.call_count, 2)
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_initialization_error_is_retained_and_never_writes_completed_artifacts(self):
        with mock.patch.object(ocr, "initialize_pipeline", side_effect=RuntimeError("GPU unavailable")) as initialize:
            self.assertEqual(ocr.run(self.args(dry_run=False), self.project), 1)
            status = json.loads((self.job / "ocr" / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["pages"]["1"]["phase"], "initialization")
            self.assertEqual(status["pages"]["1"]["status"], "failed")
            self.assertEqual(len(status["failureHistory"]), 1)
            self.assertFalse((self.job / "ocr" / "page-0001.raw.json").exists())
            self.assertEqual(ocr.run(self.args(dry_run=False), self.project), 1)
            self.assertEqual(initialize.call_count, 1)

    def test_changed_weights_at_same_path_cannot_reuse_cached_result(self):
        with mock.patch.object(ocr, "initialize_pipeline", return_value=self.initialized_fixture()) as initialize:
            self.assertEqual(ocr.run(self.args(dry_run=False), self.project), 0)
            (self.model_dirs[1] / "inference.pdiparams").write_bytes(b"changed-model-weight-bytes")
            self.assertEqual(ocr.run(self.args(dry_run=False), self.project), 0)
            self.assertEqual(initialize.call_count, 2)

    def test_source_preflight_failure_prevents_all_inference(self):
        self.source.write_bytes(b"changed")
        second = self.job / "images" / "page-0002.png"
        second.write_bytes(self.raw)
        self.index["pages"].append({**self.index["pages"][0], "systemPage": 2, "file": "images/page-0002.png"})
        self.index_path.write_text(json.dumps(self.index), encoding="utf-8")
        with mock.patch.object(ocr, "initialize_pipeline") as initialize:
            self.assertEqual(ocr.run(self.args(dry_run=False, pages=[1, 2]), self.project), 1)
            initialize.assert_not_called()
        status = json.loads((self.job / "ocr" / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["pages"]["2"]["status"], "not_run")

    def test_first_prediction_error_stops_successors_without_retry(self):
        second = self.job / "images" / "page-0002.png"
        second.write_bytes(self.raw)
        self.index["pages"].append({**self.index["pages"][0], "systemPage": 2, "file": "images/page-0002.png"})
        self.index_path.write_text(json.dumps(self.index), encoding="utf-8")
        fixture = self.initialized_fixture()
        fixture[0].predict.side_effect = RuntimeError("GPU out of memory")
        with mock.patch.object(ocr, "initialize_pipeline", return_value=fixture):
            self.assertEqual(ocr.run(self.args(dry_run=False, pages=[1, 2]), self.project), 1)
        status = json.loads((self.job / "ocr" / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["pages"]["1"]["status"], "failed")
        self.assertEqual(status["pages"]["2"]["status"], "not_run")
        self.assertEqual(fixture[0].predict.call_count, 1)
        self.assertFalse((self.job / "ocr" / "page-0002.raw.json").exists())

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
