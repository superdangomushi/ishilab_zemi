import Foundation

/// whisper.cpp を用いたローカル文字起こしエンジン。
/// Android 版は JNI (WhisperLib) 経由だったが、iOS ではブリッジングヘッダから
/// C API を直接呼ぶ。
final class WhisperEngine: TranscriptionEngine {

    private let modelPath: String
    private let language: String
    private var ctx: OpaquePointer?
    private let lock = NSLock()

    var isLoaded: Bool { ctx != nil }

    /// 実時間に追いつけるよう、使えるコアを多めに使う（上限8）。
    private var numThreads: Int32 {
        Int32(max(2, min(8, ProcessInfo.processInfo.processorCount)))
    }

    init(modelPath: String, language: String = "ja") {
        self.modelPath = modelPath
        self.language = language
    }

    func load() throws {
        if isLoaded { return }
        var cparams = whisper_context_default_params()
        cparams.use_gpu = false // Android と同じ CPU バックエンドのみ
        ctx = whisper_init_from_file_with_params(modelPath, cparams)
        guard ctx != nil else {
            throw NSError(domain: "WhisperEngine", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "whisper モデルの読み込みに失敗しました: \(modelPath)"])
        }
        NSLog("WhisperEngine: whisper loaded. system=%@ threads=%d",
              String(cString: whisper_print_system_info()), numThreads)
    }

    func transcribe(_ samples: [Float]) -> String {
        lock.lock(); defer { lock.unlock() }
        guard let ctx else { return "" }
        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        params.print_realtime = false
        params.print_progress = false
        params.print_timestamps = false
        params.print_special = false
        params.translate = false
        params.n_threads = numThreads
        params.offset_ms = 0
        params.no_context = true
        params.single_segment = false

        let rc: Int32 = language.withCString { lang in
            params.language = lang
            return samples.withUnsafeBufferPointer { buf in
                whisper_full(ctx, params, buf.baseAddress, Int32(buf.count))
            }
        }
        if rc != 0 {
            NSLog("WhisperEngine: whisper_full returned %d", rc)
            return ""
        }
        let count = whisper_full_n_segments(ctx)
        var out = ""
        for i in 0..<count {
            if let text = whisper_full_get_segment_text(ctx, i) {
                out += String(cString: text).trimmingCharacters(in: .whitespaces)
            }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func release() {
        lock.lock(); defer { lock.unlock() }
        if let c = ctx {
            whisper_free(c)
            ctx = nil
        }
    }
}
