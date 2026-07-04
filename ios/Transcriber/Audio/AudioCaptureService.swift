import Foundation
import AVFoundation
import UIKit

/// UI へ公開するサービス状態（Android 版 ServiceState の移植）。
struct ServiceState {
    var active = false
    var paused = false
    var modelName: String? = nil
    var chunksDone = 0
    var dropped = 0
    var queueSize = 0
    var lastText = ""
    var currentFile: String? = nil
    var transcribing = false
    /// 処理中の音声区間の表示ラベル（例: 「7/2 14時台」）。
    var transcribeLabel: String? = nil
    /// 現在処理中区間の進捗 0.0..1.0。
    var transcribeProgress: Float = 0
    var draining = false
    var overloaded = false
    var error: String? = nil
    /// 現在のマイク稼働区間の開始時刻(systemUptime ms)。0 のとき計測停止中。
    var recordingStartedElapsed: Int64 = 0
    /// 過去の稼働区間の積算録音時間(ms)。一時停止をまたいだ合計に使う。
    var accumulatedRecordMs: Int64 = 0
}

/// バックグラウンド録音＋ローカル文字起こしを行うサービス。
///
/// Android 版 AudioCaptureService（foreground service）の移植。iOS では
/// UIBackgroundModes=audio ＋ アクティブな AVAudioSession によって
/// 録音中はバックグラウンドでも動作し続ける（フォアグラウンドサービス相当）。
///
/// 文字起こしは「録音しながら」ではなく、区切りが確定した音声を**まとめて**行う:
/// - 録音タップ: マイク入力を 16kHz/mono/PCM16 に変換し、PCM を**区間ファイル**へ書き出す。
/// - 実時刻で1時間ごとに区間を締め、直前1時間ぶんの音声をワーカーがまとめて文字起こしする。
/// - 終了ボタンが押された時点でも、その区間をまとめて文字起こしする（これらのどちらか早い方）。
/// - 文字起こしが済んだテキストは TranscriptStore に保存し、即サーバー送信（失敗時は再送）。
final class AudioCaptureService: ObservableObject {

    static let shared = AudioCaptureService()

    @Published private(set) var state = ServiceState()

    private let store = TranscriptStore()
    private let modelManager = ModelManager()
    private var engine: TranscriptionEngine?
    private let accountStore = AccountStore()
    private let aiHelper = AiHelperClient()
    /// 送信に失敗した音声区間の退避先（BackgroundSync が接続復帰時にまとめて再送する）。
    private let audioOutboxDir: URL
    private let segmentsDir: URL

    private(set) var backgroundSync: BackgroundSync?
    private var shutdownDone = false

    /// 文字起こし待ちの「確定した音声区間」。録音とは非同期にワーカーが処理する。
    private enum QueueItem {
        case segment(Segment)
        case poison
    }
    private struct Segment {
        let file: URL
        let startMillis: Int64
        let label: String
    }
    private let segmentQueue = BlockingQueue<QueueItem>()
    private var segWriter: PcmSegmentWriter?
    private var segStartMillis: Int64 = 0
    private var segHourKey = ""
    private let segLock = NSLock()

    private let audioEngine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var recording = false      // マイク稼働中か
    private var serviceActive = false  // サービス全体が生存しているか
    private var workerDone: DispatchSemaphore?

    // 開始/一時停止/再開/終了の各処理はブロッキングを含むため、
    // メインスレッドをふさがないよう専用キューで直列実行する。
    private let control = DispatchQueue(label: "com.ishilab.transcriber.control")
    private let stateLock = NSLock()
    private var internalState = ServiceState()

    private let hourKeyFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.dateFormat = "yyyy-MM-dd_HH"
        return f
    }()
    private let hourLabelFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.dateFormat = "M/d H時台"
        return f
    }()

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        segmentsDir = docs.appendingPathComponent("segments", isDirectory: true)
        audioOutboxDir = docs.appendingPathComponent("audio-outbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: segmentsDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: audioOutboxDir, withIntermediateDirectories: true)
        observeInterruptions()
    }

    // ---- ライフサイクル制御 -------------------------------------------------

    func start() {
        control.async { self.doStart() }
    }

    func stop() {
        control.async { self.stopEverything() }
    }

    func pauseMic() {
        control.async {
            self.stopRecording()
            self.pushState { $0.paused = true }
        }
    }

    func resumeMic() {
        control.async {
            guard self.serviceActive else { return }
            self.startRecording()
            self.pushState { $0.paused = false }
        }
    }

    private func doStart() {
        if serviceActive { return }
        serviceActive = true
        shutdownDone = false

        // 新しいセッション開始。録音時間の計測をリセット。
        pushState {
            $0.active = true
            $0.paused = false
            $0.error = nil
            $0.accumulatedRecordMs = 0
            $0.recordingStartedElapsed = 0
        }
        // モデル読み込み＋ワーカー起動はバックグラウンドで
        let done = DispatchSemaphore(value: 0)
        workerDone = done
        Thread.detachNewThread { [weak self] in
            Thread.current.name = "transcribe-worker"
            self?.runWorker()
            done.signal()
        }
        startRecording()
        // 定期アップロード＋リマインド通知（ログイン済みのときだけ実働）。
        let sync = BackgroundSync()
        backgroundSync = sync
        sync.start()
    }

    private func stopEverything() {
        let wasActive = serviceActive
        serviceActive = false
        // バックグラウンドへ回っても後始末を続けられるよう実行猶予をもらう。
        var bgTask: UIBackgroundTaskIdentifier = .invalid
        bgTask = UIApplication.shared.beginBackgroundTask {
            UIApplication.shared.endBackgroundTask(bgTask)
        }
        defer { if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) } }

        stopRecording()
        if wasActive {
            // 終了時: 録音済みの残り区間を確定させ、文字起こし対象に積む。
            finalizeSegment()
            // ワーカーに終了を通知。積んである区間は poison より前なので必ず処理される。
            segmentQueue.offer(.poison)
            // 最後の区間の文字起こし＋保存が終わるまで待つ（長時間になり得るので余裕を持つ）。
            let stuck = workerDone?.wait(timeout: .now() + Self.workerJoinSeconds) == .timedOut
            workerDone = nil
            // 文字起こし実行中に release() するとロック待ちでブロックし得るため、
            // ワーカーが確実に終わっているときだけ解放する。
            if !stuck {
                engine?.release()
                engine = nil
            } else {
                NSLog("AudioCaptureService: transcription still running; skip release to avoid deadlock")
            }
        }
        pushState {
            $0.active = false
            $0.paused = false
            $0.transcribing = false
            $0.recordingStartedElapsed = 0
        }
        // 録音・文字起こしは止めるが、未送信ファイル/音声の送信が終わるまで送信を続ける。
        startDraining()
    }

    /// 終了後、未送信の文字起こしファイル/音声が全て送れるまで送信を続け、完了したら片付ける。
    private func startDraining() {
        guard let sync = backgroundSync else {
            finishShutdown()
            return
        }
        sync.setCurrentHourFile(nil)       // 現在の時刻ファイルも送信対象に含める
        sync.onAllSent = { [weak self] in self?.control.async { self?.finishShutdown() } }
        pushState { $0.draining = true }
        sync.triggerNow()                  // すぐに送信パスを走らせる
    }

    /// 送信完了（または送信不能）時の最終後始末。多重実行を防ぐ。
    private func finishShutdown() {
        if shutdownDone { return }
        shutdownDone = true
        backgroundSync?.stop()
        backgroundSync = nil
        pushState { $0.draining = false }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// 録音中に経過した時間を積算し、計測を停止状態にする。
    private func accrueRecordingTime() {
        pushState {
            if $0.recordingStartedElapsed > 0 {
                $0.accumulatedRecordMs += Self.nowElapsedMs() - $0.recordingStartedElapsed
                $0.recordingStartedElapsed = 0
            }
        }
    }

    // ---- 録音 ---------------------------------------------------------------

    private func startRecording() {
        if recording { return }
        let session = AVAudioSession.sharedInstance()
        guard session.recordPermission == .granted else {
            pushState { $0.error = "録音権限がありません" }
            return
        }
        do {
            try session.setCategory(.record, mode: .measurement, options: [.allowBluetooth])
            try session.setActive(true)

            let input = audioEngine.inputNode
            let inFormat = input.outputFormat(forBus: 0)
            guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                                sampleRate: Double(AudioChunker.sampleRate),
                                                channels: 1, interleaved: true),
                  let conv = AVAudioConverter(from: inFormat, to: outFormat) else {
                pushState { $0.error = "オーディオ変換の初期化に失敗しました" }
                return
            }
            converter = conv

            ensureSegmentWriter()
            input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
                self?.handleBuffer(buffer, outFormat: outFormat)
            }
            audioEngine.prepare()
            try audioEngine.start()
            recording = true
            pushState { $0.recordingStartedElapsed = Self.nowElapsedMs() }
            NSLog("AudioCaptureService: recording started")
        } catch {
            pushState { $0.error = "マイク初期化に失敗: \(error.localizedDescription)" }
        }
    }

    private func stopRecording() {
        if !recording { return }
        recording = false
        accrueRecordingTime()
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        converter = nil
        // マイクを完全に手放す（Android の pause と同じくマイクインジケータも消える）。
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        NSLog("AudioCaptureService: recording stopped (mic released)")
    }

    /// マイク入力を 16kHz/mono/PCM16 に変換して区間ファイルへ追記する。
    private func handleBuffer(_ buffer: AVAudioPCMBuffer, outFormat: AVAudioFormat) {
        guard recording, let converter else { return }
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var convError: NSError?
        converter.convert(to: out, error: &convError) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if convError != nil { return }
        let frames = Int(out.frameLength)
        guard frames > 0, let ch = out.int16ChannelData else { return }

        segLock.lock()
        segWriter?.append(ch[0], count: frames)
        // 実時刻の「時」が変わったら、直前1時間ぶんを確定して文字起こしへ回す。
        let key = hourKey(Date())
        let rotate = key != segHourKey
        segLock.unlock()
        if rotate { rotateSegment() }
    }

    /// 現在の区間ライタが無ければ作る。
    private func ensureSegmentWriter() {
        segLock.lock(); defer { segLock.unlock() }
        if segWriter != nil { return }
        let now = Date()
        segStartMillis = Int64(now.timeIntervalSince1970 * 1000)
        segHourKey = hourKey(now)
        let f = segmentsDir.appendingPathComponent("seg-\(segStartMillis).pcm")
        segWriter = PcmSegmentWriter(file: f)
    }

    /// 実時刻の時が変わったとき: 現区間を閉じてキューに積み、新しい区間を開始する。
    private func rotateSegment() {
        finalizeSegment()
        ensureSegmentWriter()
    }

    /// 現区間を閉じ、十分な長さがあれば文字起こしキューへ積む。
    private func finalizeSegment() {
        segLock.lock()
        guard let w = segWriter else {
            segLock.unlock()
            return
        }
        segWriter = nil
        let startMillis = segStartMillis
        segLock.unlock()
        w.close()
        if w.samples >= Self.minSegmentSamples {
            let seg = Segment(file: w.file, startMillis: startMillis, label: hourLabel(startMillis))
            segmentQueue.offer(.segment(seg))
            pushState { $0.queueSize = self.segmentQueue.count }
        } else {
            try? FileManager.default.removeItem(at: w.file) // 短すぎる区間は破棄
        }
    }

    /// 実時刻の「時」を表すキー（TranscriptStore のファイル名と揃える）。
    private func hourKey(_ date: Date) -> String { hourKeyFormat.string(from: date) }

    /// 「7/2 14時台」のような表示用ラベル。
    private func hourLabel(_ millis: Int64) -> String {
        hourLabelFormat.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }

    // ---- 文字起こしワーカー -------------------------------------------------

    private func runWorker() {
        // サーバー文字起こしモード: 端末では Whisper を回さず、音声をアップロードするだけ。
        let serverMode = accountStore.serverTranscribe && accountStore.loggedIn
        if serverMode {
            pushState { $0.modelName = "サーバー処理（音声アップロード）" }
            backgroundSync?.triggerNow() // 前回送れなかった区間があれば同期ループで再送する
        } else {
            // モデル読み込み（利用者が選択したモデルを優先。未DLならDL済みの先頭）
            guard let model = modelManager.activeModel() else {
                pushState { $0.error = "モデル未ダウンロード" }
                control.async { self.stopEverything() }
                return
            }
            do {
                let e = WhisperEngine(modelPath: modelManager.modelFile(model).path)
                try e.load()
                engine = e
                pushState { $0.modelName = model.displayName }
            } catch {
                NSLog("AudioCaptureService: model load failed: %@", error.localizedDescription)
                pushState { $0.error = "モデル読み込み失敗: \(error.localizedDescription)" }
                control.async { self.stopEverything() }
                return
            }
        }

        // poison が来るまで（＝終了指示まで）は、積まれた区間を全て処理し切る。
        while true {
            let item = segmentQueue.take()
            guard case .segment(let seg) = item else { break }
            if serverMode { uploadSegment(seg) } else { transcribeSegment(seg) }
            pushState { $0.queueSize = self.segmentQueue.count }
        }
        NSLog("AudioCaptureService: worker finished")
    }

    /// サーバー文字起こしモード: 区間 PCM を WAV としてアップロードする。
    /// 失敗したら outbox に退避し、次の機会（次区間成功時・次回起動時）に再送する。
    private func uploadSegment(_ seg: Segment) {
        pushState {
            $0.transcribing = true
            $0.transcribeLabel = "\(seg.label) を送信"
            $0.transcribeProgress = 0
        }
        let uploadName = hourKey(Date(timeIntervalSince1970: Double(seg.startMillis) / 1000)) + ".wav"
        var ok = false
        for attempt in 1...3 {
            let r = aiHelper.uploadAudioPcm(
                baseUrl: accountStore.baseUrl, email: accountStore.email, token: accountStore.token,
                pcmFile: seg.file, uploadName: uploadName, sampleRate: AudioChunker.sampleRate
            )
            if case .success = r { ok = true; break }
            if case .failure(let e) = r {
                NSLog("AudioCaptureService: audio upload failed (try %d): %@", attempt, e.localizedDescription)
            }
            Thread.sleep(forTimeInterval: 5.0 * Double(attempt))
        }
        if ok {
            try? FileManager.default.removeItem(at: seg.file)
            pushState {
                $0.transcribing = false
                $0.transcribeLabel = nil
                $0.chunksDone += 1
                $0.lastText = "\(seg.label) をサーバーへ送信しました（サーバーで文字起こし中）"
            }
            backgroundSync?.triggerNow() // 通信が生きているうちに滞留分も送る
        } else {
            // ファイル名に開始時刻が入っているので、そのまま outbox へ移して後で再送する。
            moveToAudioOutbox(seg.file)
            backgroundSync?.triggerNow()
            pushState {
                $0.transcribing = false
                $0.transcribeLabel = nil
                $0.error = "音声のアップロードに失敗しました（次回自動再送します）"
            }
        }
    }

    /// 区間ファイルを outbox に残す。
    private func moveToAudioOutbox(_ file: URL) {
        let moved = audioOutboxDir.appendingPathComponent(file.lastPathComponent)
        try? FileManager.default.removeItem(at: moved)
        do {
            try FileManager.default.moveItem(at: file, to: moved)
        } catch {
            NSLog("AudioCaptureService: failed to move audio segment to outbox: %@", error.localizedDescription)
        }
    }

    /// 1区間(最大1時間)を30秒窓で順に文字起こしし、テキストを保存して送信をトリガする。
    private func transcribeSegment(_ seg: Segment) {
        let windowSamples = AudioChunker.sampleRate * AudioChunker.chunkSeconds
        let attrs = try? FileManager.default.attributesOfItem(atPath: seg.file.path)
        let fileBytes = (attrs?[.size] as? Int64) ?? 0
        let totalWindows = max(1, Int(fileBytes / 2) / windowSamples + 1)
        var sb = ""
        var index = 0
        pushState {
            $0.transcribing = true
            $0.transcribeLabel = seg.label
            $0.transcribeProgress = 0
        }
        PcmSegment.forEachWindow(file: seg.file, windowSamples: windowSamples) { window in
            if !AudioChunker.isSilent(window) {
                let part = engine?.transcribe(window) ?? ""
                if !part.isEmpty { sb += part + " " }
            }
            index += 1
            let progress = min(1, max(0, Float(index) / Float(totalWindows)))
            pushState { $0.transcribeProgress = progress }
            // サービス終了要求が来ていても、終了区間は処理し切りたいので中断しない。
            return true
        }
        try? FileManager.default.removeItem(at: seg.file) // 音声データは保持しない
        pushState {
            $0.transcribing = false
            $0.transcribeProgress = 0
            $0.transcribeLabel = nil
        }

        let text = sb.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            let at = Date(timeIntervalSince1970: Double(seg.startMillis) / 1000)
            store.append(text, at: at)
            let fileName = store.fileFor(at).lastPathComponent
            pushState {
                $0.chunksDone += 1
                $0.lastText = text
                $0.currentFile = fileName
            }
            backgroundSync?.triggerNow() // 文字起こしできたら即送信（失敗時はリトライ）
        }
    }

    // ---- 割り込み対応（通話など） -------------------------------------------

    private func observeInterruptions() {
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(), queue: .main
        ) { [weak self] note in
            guard let self, let info = note.userInfo,
                  let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
            switch type {
            case .began:
                // 通話などでマイクを奪われたら一時停止扱いにする。
                if self.internalStateSnapshot().active && !self.internalStateSnapshot().paused {
                    self.control.async {
                        self.stopRecording()
                        self.pushState { $0.paused = true }
                    }
                }
            case .ended:
                let optRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                if AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume) {
                    self.resumeMic()
                }
            @unknown default:
                break
            }
        }
    }

    // ---- 状態 ---------------------------------------------------------------

    private func internalStateSnapshot() -> ServiceState {
        stateLock.lock(); defer { stateLock.unlock() }
        return internalState
    }

    private func pushState(_ block: @escaping (inout ServiceState) -> Void) {
        stateLock.lock()
        block(&internalState)
        let snapshot = internalState
        stateLock.unlock()
        DispatchQueue.main.async { self.state = snapshot }
    }

    static func nowElapsedMs() -> Int64 {
        Int64(ProcessInfo.processInfo.systemUptime * 1000)
    }

    // これ未満の長さの区間は文字起こししない（1秒）。
    private static let minSegmentSamples: Int64 = 16_000
    // 終了時、最後の区間の文字起こし完了を待つ上限。
    private static let workerJoinSeconds: TimeInterval = 30 * 60
}

/// Android の LinkedBlockingQueue 相当の簡易ブロッキングキュー。
final class BlockingQueue<T> {
    private var items: [T] = []
    private let cond = NSCondition()

    func offer(_ item: T) {
        cond.lock()
        items.append(item)
        cond.signal()
        cond.unlock()
    }

    func take() -> T {
        cond.lock()
        while items.isEmpty { cond.wait() }
        let item = items.removeFirst()
        cond.unlock()
        return item
    }

    var count: Int {
        cond.lock(); defer { cond.unlock() }
        return items.count
    }
}
