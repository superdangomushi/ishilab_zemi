import Foundation

/// 文字起こし結果をアプリ内ストレージに「1時間=1ファイル」で保存する。
///
/// 例: Documents/transcripts/2026-06-14_15.txt （15時台ぶんの文字起こし）
/// チャンク完了ごとに追記し、毎時の境界では時刻からパスが変わるため自動的に
/// 新しいファイルへ切り替わる（＝1時間に1回テキスト出力）。
final class TranscriptStore {

    let directory: URL

    private let fileFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.dateFormat = "yyyy-MM-dd_HH"
        return f
    }()
    private let lineFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.dateFormat = "HH:mm:ss"
        return f
    }()
    private let lock = NSLock()

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        directory = docs.appendingPathComponent("transcripts", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// 指定時刻が属する「時」のファイル。
    func fileFor(_ at: Date) -> URL {
        lock.lock(); defer { lock.unlock() }
        return directory.appendingPathComponent("\(fileFormat.string(from: at)).txt")
    }

    /// タイムスタンプ付きで1行追記する。空テキストは無視。
    func append(_ text: String, at: Date = Date()) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return }
        lock.lock(); defer { lock.unlock() }
        let file = directory.appendingPathComponent("\(fileFormat.string(from: at)).txt")
        let line = "[\(lineFormat.string(from: at))] \(trimmed)\n"
        if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(line.utf8))
        } else {
            try? Data(line.utf8).write(to: file)
        }
    }

    /// 生成済みファイルを新しい順に列挙。
    func list() -> [URL] {
        lock.lock(); defer { lock.unlock() }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files
            .filter { $0.pathExtension == "txt" }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
    }
}
