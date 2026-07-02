#!/usr/bin/env python3
"""ローカル文字起こし（faster-whisper。GPU があれば自動で使う）。

使い方: transcribe.py <音声ファイル>
本文だけを stdout に出力する（進捗・ログは stderr）。audio.js から子プロセスとして呼ばれる。

既定値は「GPU なら精度最優先・CPU なら現実的な速度」になるよう自動で決まる:
  GPU (CUDA):  モデル large-v3 / compute float16 / バッチ推論 (batch=16)
  CPU:         モデル large-v3-turbo / compute int8 / 全コア使用

環境変数（すべて任意。未設定なら上の自動判定）:
  WHISPER_DEVICE      ... cuda | cpu（既定: 自動判定）
  WHISPER_MODEL       ... モデル名（例 large-v3 / large-v3-turbo / medium）
  WHISPER_COMPUTE     ... compute_type（例 float16 / int8_float16 / int8）
  WHISPER_BATCH       ... バッチサイズ。0 でバッチ推論を無効化
  WHISPER_CPU_THREADS ... CPU 時のスレッド数（既定: 全コア）

初回実行時にモデルを ~/.cache/huggingface へ自動ダウンロードする（large-v3 で約 3GB）。
GPU 用の cuDNN/cuBLAS は pip（stt/requirements.txt）で入り、下の _ensure_cuda_libs が
LD_LIBRARY_PATH へ自動で通すので、CUDA Toolkit のシステムインストールは不要
（NVIDIA ドライバだけあればよい。導入は `make gpu-driver`）。
"""

import glob
import os
import site
import sys


def _ensure_cuda_libs():
    """pip で入れた nvidia-cudnn/cublas の .so を dlopen できるようにする。

    LD_LIBRARY_PATH は起動時にしか読まれないため、不足していれば足して自分を再実行する。
    再実行後は不足がなくなるので無限ループにはならない。
    """
    dirs = []
    for sp in site.getsitepackages():
        dirs += glob.glob(os.path.join(sp, "nvidia", "*", "lib"))
    if not dirs:
        return
    current = os.environ.get("LD_LIBRARY_PATH", "")
    missing = [d for d in dirs if d not in current.split(":")]
    if not missing:
        return
    os.environ["LD_LIBRARY_PATH"] = ":".join(missing + ([current] if current else []))
    os.execv(sys.executable, [sys.executable] + sys.argv)


def _pick_device():
    forced = os.environ.get("WHISPER_DEVICE", "").strip().lower()
    if forced in ("cuda", "cpu"):
        return forced
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception as e:
        print(f"CUDA 判定に失敗（CPU で続行）: {e}", file=sys.stderr)
    return "cpu"


def main() -> int:
    if len(sys.argv) < 2:
        print("使い方: transcribe.py <音声ファイル>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"ファイルがありません: {path}", file=sys.stderr)
        return 2

    _ensure_cuda_libs()

    from faster_whisper import BatchedInferencePipeline, WhisperModel

    device = _pick_device()
    on_gpu = device == "cuda"
    model_name = os.environ.get("WHISPER_MODEL") or ("large-v3" if on_gpu else "large-v3-turbo")
    compute = os.environ.get("WHISPER_COMPUTE") or ("float16" if on_gpu else "int8")
    batch = int(os.environ.get("WHISPER_BATCH") or (16 if on_gpu else 0))
    cpu_threads = int(os.environ.get("WHISPER_CPU_THREADS") or (os.cpu_count() or 4))

    print(f"モデル {model_name} を読み込み中… (device={device}, compute={compute}, "
          f"batch={batch or 'off'})", file=sys.stderr)
    model = WhisperModel(model_name, device=device, compute_type=compute, cpu_threads=cpu_threads)

    # vad_filter で無音区間を飛ばす（ゼミ録音の長い沈黙対策 + 幻覚抑制）。
    opts = dict(language="ja", vad_filter=True)
    if batch > 0:
        pipeline = BatchedInferencePipeline(model=model)
        segments, info = pipeline.transcribe(path, batch_size=batch, **opts)
    else:
        segments, info = model.transcribe(path, **opts)

    total = getattr(info, "duration", 0) or 0
    for seg in segments:
        text = seg.text.strip()
        if text:
            print(text, flush=True)
        if total:
            print(f"進捗 {seg.end:.0f}/{total:.0f} 秒 ({min(100, seg.end / total * 100):.0f}%)",
                  file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
