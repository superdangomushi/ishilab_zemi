import Foundation

/// 文字起こしエンジンの抽象。現在は WhisperEngine のみだが、
/// 将来差し替えられるよう protocol 化している。
protocol TranscriptionEngine: AnyObject {
    /// モデルを読み込む。失敗時は例外。
    func load() throws

    /// 16kHz/mono・float PCM(-1.0..1.0) を文字起こししてテキストを返す。
    /// 無音や認識不能の場合は空文字を返すことがある。
    func transcribe(_ samples: [Float]) -> String

    /// リソース解放。
    func release()

    var isLoaded: Bool { get }
}
