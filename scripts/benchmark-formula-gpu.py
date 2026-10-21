"""Bounded PP-FormulaNet_plus-S GPU trial of exactly two reviewed, original-pixel crops."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback
import uuid

MODEL = "PP-FormulaNet_plus-S"
MODEL_FILES = ("config.json", "inference.json", "inference.pdiparams", "inference.yml")
LIMITS = {"minimumFreeRamMiB": 1536, "maximumTotalGpuUsedMiB": 6400, "maximumGpuTemperatureC": 85,
          "maximumStartupGpuUtilizationPercent": 70, "maximumSeconds": 1800,
          "requiredConsecutiveViolations": 2, "pollSeconds": 3}


def digest(file):
    checksum = hashlib.sha256()
    with Path(file).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def read_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def write_new(file, value):
    file = Path(file)
    if file.exists():
        raise FileExistsError("Evidence already exists: " + str(file))
    partial = file.with_name(file.name + ".partial-" + uuid.uuid4().hex)
    with partial.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    # Windows rename is atomic and refuses an existing destination; never publish half a readiness record.
    partial.rename(file)


def object_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def paths(root, label):
    return {"result": root / "results" / (label + "-formula.json"),
            "monitor": root / "results" / (label + "-formula-resource-monitor.json"),
            "log": root / "logs" / (label + "-formula.txt"),
            "ready": root / "results" / (label + "-formula-worker.json"),
            "go": root / "results" / (label + "-formula-go.json")}


def environment(root):
    env = dict(os.environ)
    for name, folder in {"TEMP": "temp", "TMP": "tmp", "HF_HOME": "hf", "XDG_CACHE_HOME": "xdg",
                         "CUDA_CACHE_PATH": "cuda", "MPLCONFIGDIR": "mpl"}.items():
        target = root / "cache" / folder
        target.mkdir(parents=True, exist_ok=True)
        env[name] = str(target)
    env.update({"OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2",
                "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
                "TOKENIZERS_PARALLELISM": "false", "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_XET": "1",
                "PADDLE_PDX_CACHE_HOME": str(root / "models"), "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
                "PADDLE_PDX_DISABLE_DEVICE_FALLBACK": "1", "PADDLE_PDX_DRY_RUN": "0", "PADDLE_PDX_INFER_BENCHMARK": "0",
                "PADDLE_PDX_PIPELINE_BENCHMARK": "0", "FLAGS_allocator_strategy": "auto_growth"})
    return env


def freeze_inputs(root, model_dir):
    from PIL import Image
    import yaml
    sample_root = (root / "samples").resolve(strict=True)
    truth_file, review_file = sample_root / "ground-truth.json", sample_root / "TRUTH-REVIEW.json"
    truth, review = read_json(truth_file), read_json(review_file)
    truth_hash, review_hash = digest(truth_file), digest(review_file)
    if review.get("status") != "ACCEPTED_FINITE_REGION_TRUTH" or review.get("truthSha256") != truth_hash:
        raise ValueError("Hash-bound independent truth review is required")
    samples = truth.get("samples")
    if truth.get("schemaVersion") != 1 or not isinstance(samples, list):
        raise ValueError("Invalid reviewed truth schema")
    selected = [sample for sample in samples if sample.get("kind") == "formula"]
    if len(selected) != 2 or len({sample.get("id") for sample in selected}) != 2:
        raise ValueError("This trial requires exactly two unique kind=formula regions")
    records = []
    for sample in selected:
        resolved = {}
        for key, hash_key in (("image", "sourceSha256"), ("regionImage", "regionSha256")):
            name = sample.get(key)
            if not isinstance(name, str) or not name or "/" in name or "\\" in name or Path(name).name != name:
                raise ValueError("Images must be explicit filenames within the isolated samples directory")
            file = (sample_root / name).resolve(strict=True)
            if file.parent != sample_root or not re.fullmatch(r"[a-f0-9]{64}", sample.get(hash_key, "")) or digest(file) != sample[hash_key]:
                raise ValueError("Copied original/crop hash or path mismatch: " + key)
            resolved[key] = file
        box = sample.get("bbox")
        if (not isinstance(box, list) or len(box) != 4 or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in box)
                or box[0] >= box[2] or box[1] >= box[3]):
            raise ValueError("Invalid original-pixel crop bbox")
        with Image.open(resolved["image"]) as original, Image.open(resolved["regionImage"]) as region:
            if box[2] > original.width or box[3] > original.height:
                raise ValueError("Crop bbox exceeds copied original")
            expected = original.convert("RGB").crop(tuple(box))
            actual = region.convert("RGB")
            if actual.size != expected.size or actual.tobytes() != expected.tobytes():
                raise ValueError("Crop pixels differ from the copied original bbox")
        records.append({key: sample[key] for key in ("id", "kind", "image", "regionImage", "sourceSha256", "regionSha256", "bbox")})
    model_dir = model_dir.resolve(strict=True)
    if not model_dir.is_dir() or not model_dir.is_relative_to((root / "models").resolve(strict=True)):
        raise ValueError("Model directory must stay within this isolated benchmark's models")
    model_hashes = {}
    for name in MODEL_FILES:
        file = (model_dir / name).resolve(strict=True)
        if file.parent != model_dir or not file.is_file() or file.stat().st_size == 0:
            raise ValueError("Model file is missing, empty or outside the model directory: " + name)
        model_hashes[name] = digest(file)
    with (model_dir / "inference.yml").open(encoding="utf-8") as handle:
        configuration = yaml.safe_load(handle)
    if configuration.get("Global", {}).get("model_name") != MODEL:
        raise ValueError("Local inference.yml model identity mismatch")
    helper = Path(__file__).resolve().with_name("run-guarded-ocr.py")
    return {"truthSha256": truth_hash, "truthReviewSha256": review_hash, "runnerSha256": digest(__file__),
            "resourceHelperSha256": digest(helper), "modelName": MODEL, "modelDirectory": model_dir.relative_to(root).as_posix(),
            "modelFileHashes": model_hashes, "samples": records}


def load_guard():
    file = Path(__file__).resolve().with_name("run-guarded-ocr.py")
    spec = importlib.util.spec_from_file_location("formula_resource_helpers", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def over(sample):
    for key in ("freeRamMiB", "totalGpuUsedMiB", "gpuTemperatureC", "totalGpuUtilizationPercent"):
        value = sample.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid sampled resource observation: " + key)
    return (sample["freeRamMiB"] < LIMITS["minimumFreeRamMiB"] or sample["totalGpuUsedMiB"] > LIMITS["maximumTotalGpuUsedMiB"]
            or sample["gpuTemperatureC"] > LIMITS["maximumGpuTemperatureC"])


def set_below_normal_priority():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.GetCurrentProcess.restype = wintypes.HANDLE
    api.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    api.SetPriorityClass.restype = wintypes.BOOL
    api.GetPriorityClass.argtypes = [wintypes.HANDLE]
    api.GetPriorityClass.restype = wintypes.DWORD
    handle = api.GetCurrentProcess()
    if not api.SetPriorityClass(handle, 0x00004000) or api.GetPriorityClass(handle) != 0x00004000:
        raise ctypes.WinError(ctypes.get_last_error())
    return "BELOW_NORMAL_PRIORITY_CLASS"


def process_creation_time(handle=None):
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.GetCurrentProcess.restype = wintypes.HANDLE
    api.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    api.GetProcessTimes.restype = wintypes.BOOL
    times = [wintypes.FILETIME() for _ in range(4)]
    if not api.GetProcessTimes(handle or api.GetCurrentProcess(), *[ctypes.byref(value) for value in times]):
        raise ctypes.WinError(ctypes.get_last_error())
    return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime


class OwnedWorker:
    """Retain a handle to the nonce-bound worker, so PID reuse cannot redirect cleanup."""
    def __init__(self, pid, expected_creation_time):
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.api.OpenProcess.restype = wintypes.HANDLE
        self.api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.api.WaitForSingleObject.restype = wintypes.DWORD
        self.api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.api.TerminateProcess.restype = wintypes.BOOL
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.api.CloseHandle.restype = wintypes.BOOL
        self.handle = self.api.OpenProcess(0x00100000 | 0x1000 | 0x0001, False, pid)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if process_creation_time(self.handle) != expected_creation_time:
                raise ValueError("Worker PID was reused; refusing to control the mismatched process handle")
        except BaseException:
            self.api.CloseHandle(self.handle)
            self.handle = None
            raise

    def exited(self, milliseconds=0):
        value = self.api.WaitForSingleObject(self.handle, milliseconds)
        if value not in (0, 258):
            raise ctypes.WinError(ctypes.get_last_error())
        return value == 0

    def stop(self, evidence):
        if not self.exited(2000):
            evidence["boundWorkerTerminateRequested"] = True
            if not self.api.TerminateProcess(self.handle, 123):
                raise ctypes.WinError(ctypes.get_last_error())
        evidence["boundWorkerExitConfirmed"] = self.exited(5000)

    def close(self):
        self.api.CloseHandle(self.handle)


def worker(args):
    files = paths(args.root, args.label)
    started = time.monotonic()
    result = {"schemaVersion": 1, "kind": "finite-formula-crop-recognition", "mode": "crop-only-formula-recognition",
              "modelName": MODEL, "engine": "paddle_static", "device": "gpu:0", "threads": 2,
              "inputBindingSha256": args._binding_sha, "runnerSha256": digest(__file__), "samples": [],
              "status": "failed", "productionConnected": False, "cloudModelCalled": False,
              "wholePageDetectionTested": False, "unicodeCERComputed": False, "mathematicalAccuracy": None,
              "semanticReview": "PENDING_INDEPENDENT_ORIGINAL_IMAGE_REVIEW",
              "limitations": ["Exactly two reviewed original-pixel crop files; not a whole-page location/detection test.",
                "Model preprocessing may crop margins, resize and pad its inputs.",
                "Raw LaTeX needs independent semantic comparison with the original images; no confidence or Unicode CER proves mathematical correctness."]}
    model = None
    try:
        if os.name != "nt":
            raise RuntimeError("This isolated runner requires the audited Windows environment")
        result["priority"] = set_below_normal_priority()
        write_new(files["ready"], {"pid": os.getpid(), "parentPid": os.getppid(), "nonce": args._nonce,
                                  "creationTime100ns": process_creation_time(),
                                  "inputBindingSha256": args._binding_sha, "runnerSha256": digest(__file__)})
        deadline = time.monotonic() + 15
        while not files["go"].exists():
            if time.monotonic() > deadline:
                raise TimeoutError("Supervisor did not confirm the owned worker handle")
            time.sleep(0.05)
        if read_json(files["go"]) != {"nonce": args._nonce, "pid": os.getpid()}:
            raise ValueError("Supervisor/worker readiness mismatch")
        frozen = freeze_inputs(args.root, args.model_dir)
        if object_hash(frozen) != args._binding_sha:
            raise ValueError("Inputs changed before worker execution")
        result["inputs"] = frozen
        result["samples"] = [dict(sample, status="NOT_RUN") for sample in frozen["samples"]]
        import paddle
        import cv2
        from paddleocr import FormulaRecognition
        cv2.setNumThreads(2)
        if not paddle.is_compiled_with_cuda() or paddle.device.cuda.device_count() < 1:
            raise RuntimeError("GPU required; CPU fallback is forbidden")
        paddle.set_device("gpu:0")
        result["packages"] = {name: importlib.metadata.version(name) for name in
                              ("paddlepaddle-gpu", "paddleocr", "paddlex", "tokenizers", "ftfy")}
        result["compiledWithCuda"], result["paddleDevice"], result["opencvThreads"] = True, paddle.get_device(), cv2.getNumThreads()
        initialized = time.monotonic()
        model = FormulaRecognition(model_name=MODEL, model_dir=str(args.model_dir), device="gpu:0", engine="paddle_static",
                                   engine_config={"run_mode": "paddle", "cpu_threads": 2, "enable_cinn": False})
        result["initializationSeconds"] = round(time.monotonic() - initialized, 4)
        predictor = model.paddlex_predictor
        config = predictor.engine_config
        actual_config = predictor.runner._config
        keys = ("device_type", "device_id", "run_mode", "cpu_threads", "enable_new_ir", "enable_cinn")
        result["predictor"] = {"modelName": predictor.model_name, "device": str(predictor.device),
                              "engineConfig": {key: config.get(key) for key in keys},
                              "runnerClass": type(predictor.runner).__name__,
                              "runnerConfig": {key: actual_config.get(key) for key in keys}}
        if (predictor.model_name != MODEL or str(predictor.device) != "gpu:0"
                or config.get("device_type") != "gpu" or actual_config.get("device_type") != "gpu"
                or config.get("device_id") != 0 or actual_config.get("device_id") != 0 or actual_config.get("cpu_threads") != 2
                or type(predictor.runner).__name__ != "PaddleStaticRunner"):
            raise RuntimeError("Final formula predictor GPU configuration was not established")
        for sample in result["samples"]:
            sample["status"] = "failed"
            crop = str(args.root / "samples" / sample["regionImage"])
            paddle.device.cuda.synchronize()
            predicted_at = time.monotonic()
            outputs = list(model.predict_iter(input=crop, batch_size=1))
            paddle.device.cuda.synchronize()
            seconds = time.monotonic() - predicted_at
            if len(outputs) != 1 or not isinstance(outputs[0]["rec_formula"], str) or not outputs[0]["rec_formula"].strip():
                raise RuntimeError("Expected exactly one non-blank LaTeX result per crop")
            sample.update({"status": "ok", "latex": outputs[0]["rec_formula"], "seconds": round(seconds, 4)})
            print(json.dumps({"sample": sample["id"], "seconds": sample["seconds"], "outputKind": "raw-latex"}, ensure_ascii=False), flush=True)
        if object_hash(freeze_inputs(args.root, args.model_dir)) != args._binding_sha:
            raise ValueError("Inputs changed during formula execution")
        result["status"] = "completed"
    except BaseException as error:
        result["error"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
    finally:
        if model is not None:
            try:
                model.close()
            except BaseException as error:
                result["status"] = "failed"
                result["closeError"] = {"type": type(error).__name__, "message": str(error)}
        result["totalSeconds"] = round(time.monotonic() - started, 4)
        write_new(files["result"], result)
    return 0 if result["status"] == "completed" else 1


def validate_result(result, frozen, binding):
    if (result.get("status") != "completed" or result.get("mode") != "crop-only-formula-recognition"
            or result.get("device") != "gpu:0" or result.get("engine") != "paddle_static" or result.get("modelName") != MODEL
            or result.get("inputBindingSha256") != binding or result.get("runnerSha256") != frozen["runnerSha256"]
            or result.get("inputs") != frozen):
        raise ValueError("Formula result identity/hash/status mismatch")
    actual = result.get("samples", [])
    if len(actual) != 2 or [sample.get("id") for sample in actual] != [sample["id"] for sample in frozen["samples"]]:
        raise ValueError("Formula result must contain the complete two-region inventory")
    for expected, sample in zip(frozen["samples"], actual):
        if (any(sample.get(key) != value for key, value in expected.items()) or sample.get("status") != "ok"
                or not isinstance(sample.get("latex"), str) or not sample["latex"].strip()
                or not isinstance(sample.get("seconds"), (int, float)) or not math.isfinite(sample["seconds"]) or sample["seconds"] <= 0):
            raise ValueError("Formula result has an unsuccessful or mismatched region")


def supervise(args):
    files = paths(args.root, args.label)
    if any(file.exists() for file in files.values()):
        raise ValueError("Formula evidence already exists; choose a fresh label")
    for directory in (args.root / "results", args.root / "logs"):
        directory.mkdir(parents=True, exist_ok=True)
    evidence = {"schemaVersion": 1, "kind": "isolated-formula-resource-monitor", "status": "NOT_RUN", "accepted": False,
                "label": args.label, "runnerSha256": digest(__file__), "limits": LIMITS, "samples": [],
                "scope": "Sampled shared-resource checks are not hard caps. GPU utilization gates startup only.",
                "acceptanceScope": "Execution integrity only; raw LaTeX semantics require independent original-image review.",
                "semanticReview": "PENDING_INDEPENDENT_ORIGINAL_IMAGE_REVIEW",
                "productionProcessesModified": False}
    process, owned = None, None
    helper = load_guard()
    started = time.monotonic()
    try:
        frozen = freeze_inputs(args.root, args.model_dir)
        binding = object_hash(frozen)
        evidence.update({"inputs": frozen, "inputBindingSha256": binding})
        baseline = helper.resources()
        baseline["elapsed"] = 0
        evidence["samples"].append(baseline)
        if over(baseline) or baseline["totalGpuUtilizationPercent"] > LIMITS["maximumStartupGpuUtilizationPercent"]:
            evidence["reason"] = "Startup resource gate; no formula child started"
        else:
            nonce = uuid.uuid4().hex
            command = [sys.executable, "-B", str(Path(__file__).resolve()), "--root", str(args.root), "--label", args.label,
                       "--model-dir", str(args.model_dir), "--_worker", "--_binding-sha", binding, "--_nonce", nonce]
            with files["log"].open("x", encoding="utf-8") as log:
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=environment(args.root),
                                           creationflags=subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
                evidence["launcherPid"] = process.pid
                deadline = time.monotonic() + 15
                while not files["ready"].exists():
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Formula child failed before owned-worker readiness")
                    time.sleep(0.05)
                ready = read_json(files["ready"])
                if (ready.get("nonce") != nonce or ready.get("parentPid") != process.pid or ready.get("pid") in (os.getpid(), process.pid)
                        or ready.get("runnerSha256") != frozen["runnerSha256"] or ready.get("inputBindingSha256") != binding):
                    raise ValueError("Formula worker ownership binding mismatch")
                owned = OwnedWorker(ready["pid"], ready["creationTime100ns"])
                evidence["worker"] = ready
                write_new(files["go"], {"nonce": nonce, "pid": ready["pid"]})
                violations = 0
                while process.poll() is None:
                    time.sleep(LIMITS["pollSeconds"])
                    if process.poll() is not None:
                        break
                    sample = helper.resources()
                    sample["elapsed"] = round(time.monotonic() - started, 3)
                    evidence["samples"].append(sample)
                    violations = violations + 1 if over(sample) else 0
                    if violations >= LIMITS["requiredConsecutiveViolations"] or time.monotonic() - started > LIMITS["maximumSeconds"]:
                        evidence["status"] = "ABORTED_OWN_PROCESS"
                        evidence["reason"] = "Sampled resource/time threshold reached"
                        owned.stop(evidence)
                        helper.stop_own_child(process, evidence)
                        break
                if evidence["status"] == "NOT_RUN":
                    evidence["status"] = "PROCESS_EXITED"
                evidence["exitCode"] = process.returncode
                evidence["boundWorkerExitConfirmed"] = owned.exited(5000)
                if not evidence["boundWorkerExitConfirmed"]:
                    owned.stop(evidence)
                    raise RuntimeError("Launcher exited while its bound worker was still alive; the worker was stopped")
            if evidence["status"] == "PROCESS_EXITED" and evidence["exitCode"] == 0:
                if not evidence["boundWorkerExitConfirmed"]:
                    raise RuntimeError("Launcher exited but the nonce-bound formula worker has not exited")
                if object_hash(freeze_inputs(args.root, args.model_dir)) != binding:
                    raise ValueError("Inputs changed during supervised formula execution")
                validate_result(read_json(files["result"]), frozen, binding)
                evidence["resultValidated"] = True
    except BaseException as error:
        evidence.update({"status": "MONITOR_ERROR", "errorType": type(error).__name__, "reason": str(error)})
        if owned is not None:
            try:
                owned.stop(evidence)
            except BaseException as cleanup_error:
                evidence["boundWorkerCleanupError"] = str(cleanup_error)
        if process is not None:
            helper.stop_own_child(process, evidence)
    finally:
        if owned is not None:
            owned.close()
        for role in ("result", "log", "ready", "go"):
            if files[role].exists():
                try:
                    evidence[role] = {"path": files[role].relative_to(args.root).as_posix(), "sha256": digest(files[role])}
                except BaseException as error:
                    evidence.setdefault("evidenceErrors", []).append({"role": role, "error": str(error)})
        evidence["seconds"] = round(time.monotonic() - started, 3)
        evidence["accepted"] = (evidence["status"] == "PROCESS_EXITED" and evidence.get("exitCode") == 0
                                and evidence.get("resultValidated") is True and evidence.get("boundWorkerExitConfirmed") is True
                                and "result" in evidence and "log" in evidence and not evidence.get("evidenceErrors"))
        write_new(files["monitor"], evidence)
    print(json.dumps({"status": evidence["status"], "accepted": evidence["accepted"],
                      "result": str(files["result"]), "monitor": str(files["monitor"]),
                      "semanticReview": "PENDING_INDEPENDENT_ORIGINAL_IMAGE_REVIEW"}), flush=True)
    return 0 if evidence["accepted"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Isolated benchmark data directory")
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--label", default="formula-plus-s-gpu")
    parser.add_argument("--check-only", action="store_true", help="Only validate copied inputs and model files; never import Paddle or start inference")
    parser.add_argument("--_worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--_binding-sha", help=argparse.SUPPRESS)
    parser.add_argument("--_nonce", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9-]+", args.label):
        raise ValueError("Use a simple fresh formula label")
    args.root = args.root.resolve(strict=True)
    args.model_dir = (args.model_dir or args.root / "models" / "official_models" / MODEL).resolve(strict=True)
    os.environ.update(environment(args.root))
    if args.check_only:
        frozen = freeze_inputs(args.root, args.model_dir)
        print(json.dumps({"status": "INPUTS_AND_MODEL_PREPARED_NO_INFERENCE", "inputBindingSha256": object_hash(frozen),
                          "formulaRegionCount": len(frozen["samples"]), "modelName": MODEL, "inputs": frozen,
                          "formulaInferenceStarted": False}, ensure_ascii=False))
        return 0
    if args._worker:
        if not re.fullmatch(r"[a-f0-9]{64}", args._binding_sha or "") or not re.fullmatch(r"[a-f0-9]{32}", args._nonce or ""):
            raise ValueError("Internal worker requires explicit supervisor binding")
        return worker(args)
    return supervise(args)


if __name__ == "__main__":
    raise SystemExit(main())
