package com.ishilab.transcriber.transcribe

import android.util.Log
import com.ishilab.transcriber.whisper.WhisperLib

/**
 * whisper.cpp を用いたローカル文字起こしエンジン。
 *
 * @param modelPath 端末上の ggml モデルファイルへの絶対パス
 * @param language  認識言語（既定 "ja"）
 */
class WhisperEngine(
    private val modelPath: String,
    private val language: String = "ja"
) : TranscriptionEngine {

    private var contextPtr: Long = 0L

    override val isLoaded: Boolean
        get() = contextPtr != 0L

    // 実時間に追いつけるよう、使えるコアを多めに使う（上限8）。
    private val numThreads: Int
        get() = maxOf(2, minOf(8, Runtime.getRuntime().availableProcessors()))

    override fun load() {
        if (isLoaded) return
        contextPtr = WhisperLib.initContext(modelPath)
        check(contextPtr != 0L) { "whisper モデルの読み込みに失敗しました: $modelPath" }
        Log.i(TAG, "whisper loaded. system=${WhisperLib.getSystemInfo()} threads=$numThreads")
    }

    @Synchronized
    override fun transcribe(samples: FloatArray): String {
        check(isLoaded) { "engine not loaded" }
        val rc = WhisperLib.fullTranscribe(contextPtr, numThreads, language, samples)
        if (rc != 0) {
            Log.w(TAG, "fullTranscribe returned $rc")
            return ""
        }
        val count = WhisperLib.getTextSegmentCount(contextPtr)
        val sb = StringBuilder()
        for (i in 0 until count) {
            sb.append(WhisperLib.getTextSegment(contextPtr, i).trim())
        }
        return sb.toString().trim()
    }

    @Synchronized
    override fun release() {
        if (contextPtr != 0L) {
            WhisperLib.freeContext(contextPtr)
            contextPtr = 0L
        }
    }

    companion object {
        private const val TAG = "WhisperEngine"
    }
}
