"""Finite, serial full-page OCR benchmark. Never imports the production recorder."""
import argparse
import ctypes
import hashlib
import importlib.metadata
import json
import math
import os
import sys
from pathlib import Path
import time
import traceback


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def encode(value):
    if isinstance(value, dict):
        return {str(key): encode(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]
    if hasattr(value, "tolist"):
        return encode(value.tolist())
    if hasattr(value, "item"):
        return value.item()
    return value


def write_new(file, value):
    with Path(file).open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(encode(value), handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--truth", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--engine", choices=["v5-mobile", "v5-server", "v6-small", "v6-medium"], required=True)
    parser.add_argument("--device", choices=["cpu", "gpu:0"], required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--cooldown", type=float, default=2.0)
    args = parser.parse_args()
    if not 1 <= args.threads <= 2 or not math.isfinite(args.cooldown) or not 0 <= args.cooldown <= 10:
        raise ValueError("This finite benchmark permits 1-2 CPU threads and 0-10 seconds cooldown")
    if args.output.exists():
        raise ValueError("Benchmark output already exists; keep the original result")
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
    for variable in ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"]:
        os.environ[variable] = str(args.threads)
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(args.cache.resolve())
    os.environ["PADDLE_PDX_MODEL_SOURCE"] = "BOS"
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["FLAGS_allocator_strategy"] = "auto_growth"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    truth = json.loads(args.truth.read_text(encoding="utf-8-sig"))
    review = json.loads(args.review.read_text(encoding="utf-8-sig"))
    if review.get("status") != "ACCEPTED_FINITE_REGION_TRUTH" or review.get("truthSha256") != digest(args.truth):
        raise ValueError("A separate hash-bound independent truth review is required")
    root = args.truth.resolve().parent
    samples = truth["samples"]
    if not samples or len(samples) > 12:
        raise ValueError("This benchmark is bounded to 1-12 pre-reviewed regions")
    pages = {}
    for sample in samples:
        image = (root / sample["image"]).resolve(strict=True)
        if image.parent != root or digest(image) != sample["sourceSha256"]:
            raise ValueError("Original page hash/path mismatch")
        region = (root / sample["regionImage"]).resolve(strict=True)
        if region.parent != root or digest(region) != sample["regionSha256"]:
            raise ValueError("Reviewed original-pixel region hash/path mismatch")
        pages.setdefault(str(image), []).append(sample)
    models = {"v5-mobile": ("PP-OCRv5_mobile_det", "PP-OCRv5_mobile_rec"),
              "v5-server": ("PP-OCRv5_server_det", "PP-OCRv5_server_rec"),
              "v6-small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
              "v6-medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec")}
    detector, recognizer = models[args.engine]
    result = {"schemaVersion": 1, "engine": args.engine, "device": args.device,
              "runnerSha256": digest(__file__), "pythonVersion": sys.version,
              "truthSha256": digest(args.truth), "models": [detector, recognizer],
              "truthReviewSha256": digest(args.review),
              "mode": "full-page-inference-region-scoring", "samples": [], "pages": [],
              "threads": args.threads, "cooldownSeconds": args.cooldown,
              "productionConnected": False, "cloudModelCalled": False}
    result["ocrParameters"] = {"use_doc_orientation_classify": False, "use_doc_unwarping": False,
        "use_textline_orientation": False, "enable_mkldnn": False, "cpu_threads": args.threads,
        "text_recognition_batch_size": 1}
    started = time.perf_counter()
    active_image = None
    try:
        import paddle
        import cv2
        from paddleocr import PaddleOCR
        cv2.setNumThreads(args.threads)
        result["opencvThreads"] = cv2.getNumThreads()
        result["paddleVersion"] = paddle.__version__
        distribution = "paddlepaddle-gpu" if paddle.is_compiled_with_cuda() else "paddlepaddle"
        result["packages"] = {name: importlib.metadata.version(name) for name in ["paddleocr", "paddlex", distribution]}
        result["compiledWithCuda"] = paddle.is_compiled_with_cuda()
        if args.device.startswith("gpu") and (not paddle.is_compiled_with_cuda() or paddle.device.cuda.device_count() < 1):
            raise RuntimeError("GPU requested but unavailable; no CPU fallback")
        paddle.set_device(args.device)
        probe = paddle.ones([64, 64]) @ paddle.ones([64, 64])
        if args.device.startswith("gpu"):
            paddle.device.cuda.synchronize()
        result["deviceProof"] = {"actualDevice": paddle.get_device(), "tensorPlace": str(probe.place),
                                 "matmulSum": float(probe.sum().item())}
        del probe
        if args.device.startswith("gpu") and not result["deviceProof"]["tensorPlace"].startswith("Place(gpu"):
            raise RuntimeError("GPU tensor execution was not established")
        initialized = time.perf_counter()
        pipeline = PaddleOCR(device=args.device, text_detection_model_name=detector,
                             text_recognition_model_name=recognizer, use_doc_orientation_classify=False,
                             use_doc_unwarping=False, use_textline_orientation=False,
                             enable_mkldnn=False, cpu_threads=args.threads, text_recognition_batch_size=1)
        result["initializationSeconds"] = round(time.perf_counter() - initialized, 4)
        result["modelFileHashes"] = {}
        for name in [detector, recognizer]:
            folder = args.cache / "official_models" / name
            if not folder.is_dir():
                raise RuntimeError("Expected isolated official-model directory missing")
            result["modelFileHashes"][name] = {file.relative_to(folder).as_posix(): digest(file)
                for file in sorted(folder.rglob("*")) if file.is_file() and file.suffix in
                [".json", ".yml", ".yaml", ".txt", ".pdiparams", ".pdmodel", ".safetensors"]}
            if not result["modelFileHashes"][name]:
                raise RuntimeError("Isolated model manifest is empty")
        actual_pipeline = pipeline.paddlex_pipeline
        result["ocrPredictors"] = []
        for role, attribute in [("detection", "text_det_model"), ("recognition", "text_rec_model")]:
            model = getattr(actual_pipeline, attribute)
            configuration = getattr(model, "engine_config", None)
            config_summary = {key: configuration.get(key) for key in
                              ["device_type", "device_id", "run_mode", "cpu_threads", "enable_new_ir", "enable_cinn"]}
            result["ocrPredictors"].append({"role": role, "modelName": model.model_name,
                "device": str(model.device), "engineConfig": config_summary,
                "runnerClass": type(model.runner).__name__})
            if args.device.startswith("gpu") and (not str(model.device).startswith("gpu") or config_summary["device_type"] != "gpu"):
                raise RuntimeError("An OCR submodel is not configured for GPU")
        # Warm only a small original-pixel region, never a different page or model.
        warm = root / samples[0]["regionImage"]
        list(pipeline.predict(input=str(warm)))
        if args.device.startswith("gpu"):
            paddle.device.cuda.synchronize()
        for image, region_samples in pages.items():
            active_image = image
            page_started = time.perf_counter()
            predictions = list(pipeline.predict(input=image))
            if args.device.startswith("gpu"):
                paddle.device.cuda.synchronize()
            seconds = time.perf_counter() - page_started
            if len(predictions) != 1:
                raise RuntimeError("Expected exactly one page prediction")
            raw = predictions[0].json
            if isinstance(raw, str):
                raw = json.loads(raw)
            raw = encode(raw)
            payload = raw.get("res", raw)
            texts = payload.get("rec_texts", [])
            boxes = payload.get("rec_boxes", [])
            polygons = payload.get("rec_polys", [])
            if len(texts) != len(boxes) and len(texts) != len(polygons):
                raise RuntimeError("OCR text/geometry count mismatch")
            page_lines = []
            for position, text in enumerate(texts):
                if len(boxes) == len(texts):
                    box = boxes[position]
                else:
                    xs, ys = zip(*polygons[position])
                    box = [min(xs), min(ys), max(xs), max(ys)]
                page_lines.append({"text": text, "bbox": box})
            for sample in region_samples:
                left, top, right, bottom = sample["bbox"]
                selected = [line for line in page_lines
                            if left <= (line["bbox"][0] + line["bbox"][2]) / 2 <= right
                            and top <= (line["bbox"][1] + line["bbox"][3]) / 2 <= bottom]
                result["samples"].append({"id": sample["id"], "kind": sample["kind"], "status": "ok",
                                          "text": "\n".join(line["text"] for line in selected), "seconds": round(seconds, 4),
                                          "bbox": sample["bbox"], "selectedLines": selected,
                                          "selectionPolicy": "center-in-region; boundary intersections retained for audit",
                                          "boundaryIntersections": [line for line in page_lines if
                                              max(left, line["bbox"][0]) < min(right, line["bbox"][2])
                                              and max(top, line["bbox"][1]) < min(bottom, line["bbox"][3])
                                              and line not in selected],
                                          "sourceSha256": sample["sourceSha256"]})
            result["pages"].append({"image": Path(image).name, "seconds": round(seconds, 4), "lines": page_lines})
            print(json.dumps({"page": Path(image).name, "seconds": round(seconds, 3), "lines": len(page_lines)}, ensure_ascii=False), flush=True)
            active_image = None
            time.sleep(args.cooldown)
        result["status"] = "completed"
    except Exception as error:
        result["status"] = "failed"
        result["error"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
        completed = {sample["id"] for sample in result["samples"]}
        for sample in samples:
            if sample["id"] not in completed:
                status = "failed" if active_image and str((root / sample["image"]).resolve()) == active_image else "NOT_RUN"
                result["samples"].append({"id": sample["id"], "kind": sample["kind"], "status": status, "text": "",
                                          "sourceSha256": sample["sourceSha256"]})
    result["totalSecondsIncludingInitializationAndCooldown"] = round(time.perf_counter() - started, 4)
    write_new(args.output, result)
    print(json.dumps({"engine": args.engine, "device": args.device, "status": result["status"], "output": str(args.output)}), flush=True)
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
