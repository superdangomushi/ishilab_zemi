import Foundation

/// ggml(whisper) モデルの選択と初回ダウンロードを管理する。
/// ダウンロード後は Documents/models/ に保存され、以降は完全オフラインで動作する。
///
/// 日本語を扱うため多言語モデル(.en ではない版)を使う。
enum WhisperModel: String, CaseIterable, Identifiable {
    case tiny
    case base
    case small

    var id: String { rawValue }

    var fileName: String {
        switch self {
        case .tiny: return "ggml-tiny.bin"
        case .base: return "ggml-base.bin"
        case .small: return "ggml-small.bin"
        }
    }

    var displayName: String {
        switch self {
        case .tiny: return "tiny（最軽量・低精度）"
        case .base: return "base（標準・推奨）"
        case .small: return "small（高精度・低速）"
        }
    }

    var approxMb: Int {
        switch self {
        case .tiny: return 75
        case .base: return 142
        case .small: return 466
        }
    }

    var downloadUrl: URL {
        URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/\(fileName)")!
    }
}

final class ModelManager {

    static let defaultModel: WhisperModel = .base

    private let modelsDir: URL
    private let prefs = UserDefaults.standard
    private static let keySelected = "model_prefs.selected_model"

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        modelsDir = docs.appendingPathComponent("models", isDirectory: true)
        try? FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)
    }

    func modelFile(_ model: WhisperModel) -> URL {
        modelsDir.appendingPathComponent(model.fileName)
    }

    func isDownloaded(_ model: WhisperModel) -> Bool {
        let f = modelFile(model)
        let size = (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return FileManager.default.fileExists(atPath: f.path) && size > 1_000_000 // 破損/中断検出の簡易チェック
    }

    /// 利用者が選んだモデル（永続化）。未設定なら nil。
    func selectedModel() -> WhisperModel? {
        prefs.string(forKey: Self.keySelected).flatMap { WhisperModel(rawValue: $0) }
    }

    /// 使用するモデルを記録する。
    func setSelectedModel(_ model: WhisperModel) {
        prefs.set(model.rawValue, forKey: Self.keySelected)
    }

    /// 実際に文字起こしに使うモデルを解決する。
    /// 選択済みかつダウンロード済みならそれを、無ければダウンロード済みの先頭を返す。
    func activeModel() -> WhisperModel? {
        if let sel = selectedModel(), isDownloaded(sel) { return sel }
        return WhisperModel.allCases.first { isDownloaded($0) }
    }

    /// モデルをダウンロードする（ブロッキング。ワーカースレッドから呼ぶこと）。
    /// - Parameter onProgress: 0.0..1.0（Content-Length 不明時は -1 を渡す）
    func download(_ model: WhisperModel, onProgress: @escaping (Float) -> Void) throws {
        let target = modelFile(model)
        let tmp = target.appendingPathExtension("part")
        defer { try? FileManager.default.removeItem(at: tmp) }

        var request = URLRequest(url: model.downloadUrl)
        request.timeoutInterval = 60

        let semaphore = DispatchSemaphore(value: 0)
        var resultError: Error?
        var tempLocation: URL?
        var response: URLResponse?

        let delegate = DownloadProgressDelegate(onProgress: onProgress)
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let task = session.downloadTask(with: request) { location, resp, error in
            // completionHandler の戻りでテンポラリが消えるため、この場で退避する。
            if let location {
                try? FileManager.default.removeItem(at: tmp)
                do {
                    try FileManager.default.moveItem(at: location, to: tmp)
                    tempLocation = tmp
                } catch {
                    resultError = error
                }
            }
            response = resp
            resultError = resultError ?? error
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()

        if let error = resultError { throw error }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(code) else {
            throw NSError(domain: "ModelManager", code: code,
                          userInfo: [NSLocalizedDescriptionKey: "ダウンロード失敗 HTTP \(code)"])
        }
        guard let moved = tempLocation else {
            throw NSError(domain: "ModelManager", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "モデルの保存に失敗しました"])
        }
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: moved, to: target)
        NSLog("ModelManager: model downloaded: %@", target.path)
    }
}

/// ダウンロード進捗を報告するデリゲート。
private final class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate {
    private let onProgress: (Float) -> Void
    init(onProgress: @escaping (Float) -> Void) { self.onProgress = onProgress }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        if totalBytesExpectedToWrite > 0 {
            onProgress(Float(totalBytesWritten) / Float(totalBytesExpectedToWrite))
        } else {
            onProgress(-1)
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        // completionHandler 版の downloadTask を使っているためここでは何もしない。
    }
}
