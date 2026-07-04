import Foundation

/// 録音した PCM16(16kHz/mono) を一旦ディスクへ書き出しておくためのライタ。
/// 1時間分でも RAM を圧迫しないよう、逐次ファイルへ追記する。
final class PcmSegmentWriter {
    let file: URL
    private(set) var samples: Int64 = 0
    private let handle: FileHandle

    init?(file: URL) {
        self.file = file
        FileManager.default.createFile(atPath: file.path, contents: nil)
        guard let h = try? FileHandle(forWritingTo: file) else { return nil }
        handle = h
    }

    /// PCM16 サンプルをリトルエンディアンのバイト列として書き出す。
    func append(_ src: UnsafePointer<Int16>, count: Int) {
        // Int16 はリトルエンディアン環境ではそのまま書ける。
        let data = Data(bytes: src, count: count * 2)
        try? handle.write(contentsOf: data)
        samples += Int64(count)
    }

    func close() {
        try? handle.synchronize()
        try? handle.close()
    }
}

enum PcmSegment {
    /// PCM ファイルを windowSamples ごとの float(-1.0..1.0) 配列にして順に渡す。
    /// onWindow が false を返すと途中で打ち切る。メモリは1窓ぶんしか使わない。
    static func forEachWindow(file: URL, windowSamples: Int, onWindow: ([Float]) -> Bool) {
        guard let input = InputStream(url: file) else { return }
        input.open()
        defer { input.close() }
        let byteCount = windowSamples * 2
        var byteBuf = [UInt8](repeating: 0, count: byteCount)
        while true {
            var read = 0
            while read < byteCount {
                let n = input.read(&byteBuf[read], maxLength: byteCount - read)
                if n <= 0 { break }
                read += n
            }
            if read <= 0 { break }
            let count = read / 2
            var floats = [Float](repeating: 0, count: count)
            for i in 0..<count {
                let lo = Int(byteBuf[i * 2])
                let hi = Int(Int8(bitPattern: byteBuf[i * 2 + 1])) // 符号拡張される（上位バイト）
                floats[i] = Float((hi << 8) | lo) / 32768.0
            }
            if !onWindow(floats) { break }
            if read < byteCount { break } // 最後の半端窓で終了
        }
    }
}
