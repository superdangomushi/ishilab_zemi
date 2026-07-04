import Foundation

/// 録音サンプルまわりの共有定数と簡易 VAD。
/// （Android 版 AudioChunker.kt の移植。iOS 版はチャンク蓄積を PcmSegment 側で行うため
/// 定数と isSilent のみ使用する。）
enum AudioChunker {
    static let sampleRate = 16_000
    static let chunkSeconds = 30

    /// 簡易VAD: チャンクの RMS がしきい値未満なら「ほぼ無音」とみなす。
    /// 無音チャンクは文字起こしせず破棄し、CPU/バッテリーを節約する。
    static func isSilent(_ samples: [Float], threshold: Float = 0.012) -> Bool {
        if samples.isEmpty { return true }
        var sumSq = 0.0
        for s in samples { sumSq += Double(s * s) }
        let rms = (sumSq / Double(samples.count)).squareRoot()
        return rms < Double(threshold)
    }
}
