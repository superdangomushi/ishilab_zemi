#!/usr/bin/env python3
"""ローカル文字起こし（faster-whisper。GPU があれば自動で使う）。

使い方: transcribe.py <音声ファイル>
本文だけを stdout に出力する（進捗・ログは stderr）。audio.js から子プロセスとして呼ばれる。

既定値は「GPU なら精度最優先・CPU なら現実的な速度」になるよう自動で決まる:
  GPU (CUDA):  モデル large-v3 / compute float16 / バッチ推論 (batch=16)
  CPU:         モデル large-v3-turbo / compute int8 / 全コア使用
デコードも beam_size=10 / best_of=10 / patience=2.0 とデフォルトより広く探索し、
速度よりも精度を優先する（リソースをじゃぶじゃぶ使ってでも高精度にする方針）。

GPU の空き VRAM は他アプリ（デスクトップ環境等）や録音の長さで変動し、精度優先設定のまま
確保できず CUDA out of memory になることがある。その場合はバッチ→ビーム探索の順に設定を
軽くしながら自動で再試行し、それでも駄目なら CPU（large-v3-turbo/int8）にフォールバックする
ため、この関数がクラッシュして音声文字起こしジョブが失敗することはない。

環境変数（すべて任意。未設定なら上の自動判定）:
  WHISPER_DEVICE      ... cuda | cpu（既定: 自動判定）
  WHISPER_MODEL       ... モデル名（例 large-v3 / large-v3-turbo / medium）
  WHISPER_COMPUTE     ... compute_type（例 float16 / int8_float16 / int8）
  WHISPER_BATCH       ... バッチサイズ。0 でバッチ推論を無効化
  WHISPER_CPU_THREADS ... CPU 時のスレッド数（既定: 全コア）
  WHISPER_BEAM_SIZE   ... ビームサーチ幅（既定: 10）
  WHISPER_BEST_OF     ... サンプリング候補数（既定: 10）
  WHISPER_PATIENCE    ... ビーム探索の打ち切り猶予（既定: 2.0）

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


def _is_oom(err):
    s = str(err)
    return "out of memory" in s.lower() or "CUDA failed" in s


def _run_once(model_name, device, compute, cpu_threads, batch, decode_opts, path, base_opts):
    """1回分の文字起こしを実行する。結果を list 化した時点で実際の推論が走る
    （list() の中で例外＝OOM 等が起きても、途中まで stdout に出してしまわないよう
    ここで全部確定させてから main 側で出力する）。
    """
    from faster_whisper import BatchedInferencePipeline, WhisperModel
    model = WhisperModel(model_name, device=device, compute_type=compute, cpu_threads=cpu_threads)
    opts = dict(base_opts, **decode_opts)
    try:
        if batch > 0:
            pipeline = BatchedInferencePipeline(model=model)
            segments, info = pipeline.transcribe(path, batch_size=batch, **opts)
        else:
            segments, info = model.transcribe(path, **opts)
        return list(segments), info
    finally:
        del model


def main() -> int:
    if len(sys.argv) < 2:
        print("使い方: transcribe.py <音声ファイル>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"ファイルがありません: {path}", file=sys.stderr)
        return 2

    _ensure_cuda_libs()

    device = _pick_device()
    on_gpu = device == "cuda"
    model_name = os.environ.get("WHISPER_MODEL") or ("large-v3" if on_gpu else "large-v3-turbo")
    compute = os.environ.get("WHISPER_COMPUTE") or ("float16" if on_gpu else "int8")
    batch = int(os.environ.get("WHISPER_BATCH") or (16 if on_gpu else 0))
    cpu_threads = int(os.environ.get("WHISPER_CPU_THREADS") or (os.cpu_count() or 4))
    beam_size = int(os.environ.get("WHISPER_BEAM_SIZE") or 10)
    best_of = int(os.environ.get("WHISPER_BEST_OF") or 10)
    patience = float(os.environ.get("WHISPER_PATIENCE") or 2.0)

    # vad_filter で無音区間を飛ばす（ゼミ録音の長い沈黙対策 + 幻覚抑制）。
    base_opts = dict(language="ja", vad_filter=True)
    full_decode = dict(beam_size=beam_size, best_of=best_of, patience=patience)

    # GPU の空き VRAM は他アプリ（デスクトップ環境等）や録音の長さによって変動するため、
    # 精度優先の設定のまま素直に確保できるとは限らない。OOM になったら
    # バッチ→ビーム探索の順に設定を軽くしながら、空いているメモリの範囲で成功するまで再試行する。
    # 最終手段として CPU（large-v3-turbo / int8）にフォールバックし、必ず結果を返す。
    attempts = []
    if on_gpu:
        attempts = [
            (device, model_name, compute, batch, full_decode),
            (device, model_name, compute, max(1, batch // 2), full_decode),
            (device, model_name, compute, 0, full_decode),
            (device, model_name, compute, 0, dict(beam_size=5, best_of=5, patience=1.0)),
        ]
    else:
        attempts = [(device, model_name, compute, batch, full_decode)]

    results = info = None
    for i, (dv, mn, cp, bt, dec) in enumerate(attempts):
        tag = f"（{i+1}/{len(attempts)}回目・空きメモリに合わせて設定を落として再試行）" if i else ""
        print(f"モデル {mn} を読み込み中… (device={dv}, compute={cp}, batch={bt or 'off'}, "
              f"beam={dec['beam_size']}){tag}", file=sys.stderr)
        try:
            results, info = _run_once(mn, dv, cp, cpu_threads, bt, dec, path, base_opts)
            break
        except RuntimeError as e:
            if not (on_gpu and _is_oom(e)):
                raise
            print(f"GPU メモリ不足のため設定を落とします: {e}", file=sys.stderr)
            import gc
            gc.collect()

    if results is None:
        # GPU 側の全段階で OOM だった場合の最終手段。
        print("GPU では空きメモリが足りないため CPU にフォールバックします…", file=sys.stderr)
        cpu_model = os.environ.get("WHISPER_MODEL") or "large-v3-turbo"
        results, info = _run_once(
            cpu_model, "cpu", "int8", cpu_threads, 0,
            dict(beam_size=5, best_of=5, patience=1.0), path, base_opts,
        )

    total = getattr(info, "duration", 0) or 0
    for seg in results:
        text = seg.text.strip()
        if text:
            print(text, flush=True)
        if total:
            print(f"進捗 {seg.end:.0f}/{total:.0f} 秒 ({min(100, seg.end / total * 100):.0f}%)",
                  file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
