import Foundation
import Network

/// 文字起こしファイル/音声 outbox の「サーバー送信（成功するまでリトライ）」と、
/// サーバーからの「リマインドのローカル通知」を担う。
///
/// 送信ポリシー:
///  - 完了した文字起こしファイル（＝現在書き込み中の時刻ファイル以外）だけを送る。
///  - 送信に成功した文字起こしファイル名は永続化し、二度送らない（サーバーは冪等だが無駄を省く）。
///  - 音声アップロードに失敗して audio-outbox に退避された PCM は、成功したら削除する。
///  - 失敗したものは5分ごと、または triggerNow で即時に再送を試みる。
///
/// ログイン済みのときだけ実働する。通信はブロッキングなので専用スレッドで回す。
/// （録音中は UIBackgroundModes=audio によりバックグラウンドでも動き続ける。）
final class BackgroundSync {

    private let accountStore = AccountStore()
    private let client = AiHelperClient()
    private let prefs = UserDefaults.standard

    private let cond = NSCondition()
    private var running = false
    private var pathMonitor: NWPathMonitor?

    private let transcriptsDir: URL
    private let audioOutboxDir: URL

    /// 現在書き込み中の時刻ファイル名。これは「未完了」として送らない。nil なら全て送る。
    private var currentHourFile: String?

    /// 送信すべきファイルが全て送れたときに呼ばれる（終了処理のドレイン判定に使う）。
    var onAllSent: (() -> Void)?

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        transcriptsDir = docs.appendingPathComponent("transcripts", isDirectory: true)
        audioOutboxDir = docs.appendingPathComponent("audio-outbox", isDirectory: true)
    }

    func start() {
        cond.lock()
        if running {
            cond.unlock()
            return
        }
        running = true
        cond.unlock()
        registerNetworkCallback()
        Thread.detachNewThread { [weak self] in
            Thread.current.name = "AIHelper-sync"
            self?.loop()
        }
        NSLog("BackgroundSync: background sync started")
    }

    func stop() {
        cond.lock()
        running = false
        cond.broadcast()
        cond.unlock()
        pathMonitor?.cancel()
        pathMonitor = nil
    }

    /// 書き込み中ファイルを更新。nil を渡すと全ファイルが送信対象になる（終了時など）。
    func setCurrentHourFile(_ name: String?) {
        currentHourFile = name
    }

    /// 別アカウントでログインし直す前に呼ぶ。
    /// 端末に残った未送信の文字起こし・退避音声は前アカウントの録音なので、
    /// そのまま残すと新アカウントへアップロードされて他人のデータが混ざる。全て破棄する。
    static func clearLocalPending() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        for name in ["transcripts", "audio-outbox"] {
            let dir = docs.appendingPathComponent(name, isDirectory: true)
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for file in files {
                try? FileManager.default.removeItem(at: file)
            }
        }
        UserDefaults.standard.removeObject(forKey: keySent)
        NSLog("BackgroundSync: cleared local pending data (account switched)")
    }

    /// すぐに送信パスを走らせる（時刻ファイルの切り替わりや終了時に呼ぶ）。
    func triggerNow() {
        cond.lock()
        cond.broadcast()
        cond.unlock()
    }

    /// 1回だけ同期パスを実行する（BGAppRefreshTask 用）。ブロッキング。
    func runOnce() {
        guard accountStore.loggedIn else { return }
        uploadPending()
        uploadPendingAudio()
        ReminderNotifier.poll()
        syncCalendar()
    }

    private func loop() {
        while isRunning() {
            if accountStore.loggedIn {
                uploadPending()
                uploadPendingAudio()
                ReminderNotifier.poll()
                syncCalendar()
            }
            // 送信対象が残っていなければドレイン完了を通知（未ログインも「これ以上送れない」扱い）。
            if !accountStore.loggedIn || pendingCount() == 0 {
                onAllSent?()
            }
            cond.lock()
            if running {
                cond.wait(until: Date().addingTimeInterval(Self.intervalSeconds))
            }
            cond.unlock()
        }
        NSLog("BackgroundSync: background sync stopped")
    }

    private func isRunning() -> Bool {
        cond.lock(); defer { cond.unlock() }
        return running
    }

    private func transcriptFiles() -> [URL] {
        let files = (try? FileManager.default.contentsOfDirectory(at: transcriptsDir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "txt" }
    }

    private func audioOutboxFiles() -> [URL] {
        let files = (try? FileManager.default.contentsOfDirectory(at: audioOutboxDir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "pcm" }
    }

    /// まだ送っていない「完了ファイル/退避音声」の数。
    func pendingCount() -> Int {
        let sent = sentSet()
        let skip = currentHourFile
        let textPending = transcriptFiles().filter { $0.lastPathComponent != skip && !sent.contains($0.lastPathComponent) }.count
        return textPending + audioOutboxFiles().count
    }

    /// 未送信の完了ファイルを送る。成功したら送信済みとして記録。
    private func uploadPending() {
        var sent = sentSet()
        let skip = currentHourFile
        var uploaded = 0
        for file in transcriptFiles().sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let name = file.lastPathComponent
            if name == skip || sent.contains(name) { continue }
            switch client.upload(baseUrl: accountStore.baseUrl, email: accountStore.email,
                                 token: accountStore.token, file: file) {
            case .ok:
                sent.insert(name)
                uploaded += 1
            case .error:
                break // 次のパスで再送される
            }
        }
        if uploaded > 0 {
            saveSentSet(sent)
            NSLog("BackgroundSync: uploaded %d file(s)", uploaded)
        }
    }

    /// 未送信の退避音声を WAV として送る。成功したファイルから端末内 outbox から削除する。
    private func uploadPendingAudio() {
        var uploaded = 0
        for file in audioOutboxFiles().sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let result = client.uploadAudioPcm(
                baseUrl: accountStore.baseUrl, email: accountStore.email, token: accountStore.token,
                pcmFile: file, uploadName: audioUploadName(file), sampleRate: AudioChunker.sampleRate
            )
            switch result {
            case .success:
                try? FileManager.default.removeItem(at: file)
                uploaded += 1
            case .failure(let e):
                NSLog("BackgroundSync: audio outbox upload failed: %@", e.localizedDescription)
                return
            }
        }
        if uploaded > 0 { NSLog("BackgroundSync: uploaded %d audio outbox file(s)", uploaded) }
    }

    private func audioUploadName(_ file: URL) -> String {
        let name = file.lastPathComponent
        let millisStr = name.replacingOccurrences(of: "seg-", with: "").replacingOccurrences(of: ".pcm", with: "")
        let millis = Int64(millisStr)
            ?? Int64((((try? FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate]) as? Date) ?? Date()).timeIntervalSince1970 * 1000)
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.dateFormat = "yyyy-MM-dd_HH"
        return f.string(from: Date(timeIntervalSince1970: Double(millis) / 1000)) + ".wav"
    }

    private func sentSet() -> Set<String> {
        Set(prefs.stringArray(forKey: Self.keySent) ?? [])
    }

    private func saveSentSet(_ set: Set<String>) {
        prefs.set(Array(set), forKey: Self.keySent)
    }

    /// 端末に連携済みの Google カレンダーから予定を読み取り、サーバーへ同期する。
    private func syncCalendar() {
        let googleStore = GoogleAccountStore()
        let emails = googleStore.emails
        if emails.isEmpty { return }
        var all: [CalendarEvent] = []
        var loadedAnyAccount = false
        for email in emails {
            guard let token = try? GoogleCalendarClient.accessToken(googleStore, email: email) else { continue }
            if case .success(let events) = GoogleCalendarClient.listUpcomingEvents(token: token) {
                loadedAnyAccount = true
                all += events.map { ev in
                    var e = ev
                    e.accountEmail = email
                    return e
                }
            }
        }
        if loadedAnyAccount {
            _ = client.syncCalendar(baseUrl: accountStore.baseUrl, email: accountStore.email,
                                    token: accountStore.token, events: all)
        }
    }

    private func registerNetworkCallback() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            if path.status == .satisfied { self?.triggerNow() }
        }
        monitor.start(queue: DispatchQueue(label: "com.ishilab.transcriber.network"))
        pathMonitor = monitor
    }

    private static let keySent = "sync_prefs.sent_files"
    // 再送の間隔（5分）。triggerNow でこの待機を打ち切って即時実行できる。
    private static let intervalSeconds: TimeInterval = 5 * 60
}
