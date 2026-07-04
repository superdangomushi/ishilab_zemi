import Foundation
import SwiftUI
import AuthenticationServices

struct TranscriptItem: Identifiable, Equatable {
    var id: String { name }
    let name: String
    let path: String
    let sizeBytes: Int64
}

/// 秘書チャットの1メッセージ。fromUser=true なら利用者の発話。
struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let fromUser: Bool
}

/// AIHelper.jp のログイン状態。
struct AccountState: Equatable {
    var loggedIn = false
    var baseUrl = AccountStore.defaultBaseUrl
    var email = ""
}

struct UiState {
    var downloadedModels: Set<WhisperModel> = []
    var selectedModel: WhisperModel? = nil
    var downloading: WhisperModel? = nil
    var downloadProgress: Float = 0
    var downloadError: String? = nil
    var transcripts: [TranscriptItem] = []
    var account = AccountState()
    var loginInProgress = false
    var loginError: String? = nil
    var sendingFile: String? = nil
    var sentFiles: Set<String> = []
    var sendMessage: String? = nil
    var serverTranscripts: [AiHelperClient.ServerTranscript] = []
    var serverTranscriptsLoading = false
    var serverTranscriptsError: String? = nil
    var serverTranscriptDetail: AiHelperClient.ServerTranscriptDetail? = nil
    var serverTranscriptLoadingId: Int64? = nil
    var chatLog: [ChatMessage] = []
    var chatHistoryLoading = false
    var askInProgress = false
    var tasks: [AiHelperClient.Task] = []
    var tasksLoading = false
    var tasksError: String? = nil
    var taskActionInProgressId: Int64? = nil
    var showDoneTasks = false
    var courses: [AiHelperClient.Course] = []
    var coursesLoading = false
    var coursesError: String? = nil
    var summary: String? = nil
    var summaryLoading = false
    var summaryError: String? = nil
    // Google カレンダー連携（複数アカウント対応）
    var googleEmails: [String] = []
    /// 「カレンダーに追加」の登録先アカウント。
    var googleDefault = ""
    var calendarEvents: [CalendarEvent] = []
    var googleBusy = false
    var googleMessage: String? = nil
    // Moodle 連携
    var moodleUrl = ""
    var moodleBusy = false
    var moodleMessage: String? = nil
    // Waseda アカウント連携（時間割取り込み用）
    var wasedaUser = ""
    var wasedaHasPassword = false
    var wasedaBusy = false
    var wasedaMessage: String? = nil
    /// サーバー側で時間割取り込み（スクレイパ）実行中か。
    var wasedaSyncRunning = false
    var wasedaSyncMessage: String? = nil
    // カレンダー: 選択日の要約
    var daySummaryDay: String? = nil
    var daySummary: String? = nil
    /// true なら録音音声をサーバーへアップロードして文字起こしする（端末 Whisper を使わない）。
    var serverTranscribe = false
    // サーバー文字起こしのクオリティ（"light"/"standard"/"high"）。アカウントに紐付く。
    var sttQuality = "high"
    var sttQualityBusy = false
    var sttQualityMessage: String? = nil

    var anyModelReady: Bool { !downloadedModels.isEmpty }
    var googleConnected: Bool { !googleEmails.isEmpty }
}

@MainActor
final class MainViewModel: ObservableObject {

    private let modelManager = ModelManager()
    private let accountStore = AccountStore()
    private let googleStore = GoogleAccountStore()
    private let aiHelper = AiHelperClient()
    private let transcriptStore = TranscriptStore()
    private var foregroundSyncTask: _Concurrency.Task<Void, Never>?

    @Published var ui = UiState()

    init() {
        ui.account = currentAccount()
        ui.serverTranscribe = accountStore.serverTranscribe
        refresh()
        // ログイン済みで起動した場合もカレンダー・予定タブにデータが出るよう最初に読み込む。
        if accountStore.loggedIn {
            loadTasks()
            loadCourses()
            loadSummary()
            loadServerTranscripts()
            loadChatHistory()
            loadSttQuality()
        }
    }

    func refresh() {
        let downloaded = Set(WhisperModel.allCases.filter { modelManager.isDownloaded($0) })
        let items: [TranscriptItem] = transcriptStore.list().map { url in
            let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
            let size = (attrs?[.size] as? Int64) ?? 0
            return TranscriptItem(name: url.lastPathComponent, path: url.path, sizeBytes: size)
        }
        ui.downloadedModels = downloaded
        ui.selectedModel = modelManager.activeModel()
        ui.transcripts = items
    }

    /// アプリが前面にいる間だけ、サーバー側で変わる予定・要約などを短い間隔で反映する。
    func startForegroundSync() {
        if foregroundSyncTask != nil { return }
        foregroundSyncTask = _Concurrency.Task { [weak self] in
            while !_Concurrency.Task.isCancelled {
                self?.refresh()
                await self?.syncForegroundData()
                try? await _Concurrency.Task.sleep(nanoseconds: Self.foregroundSyncIntervalNs)
            }
        }
    }

    func stopForegroundSync() {
        foregroundSyncTask?.cancel()
        foregroundSyncTask = nil
    }

    private func syncForegroundData() async {
        guard accountStore.loggedIn else { return }
        let includeDone = ui.showDoneTasks
        let baseUrl = accountStore.baseUrl
        let email = accountStore.email
        let token = accountStore.token
        let client = aiHelper

        let tasks = await run { client.fetchTasks(baseUrl: baseUrl, email: email, token: token, includeDone: includeDone) }
        if case .success(let list) = tasks {
            ui.tasks = list
            ui.tasksError = nil
            ui.showDoneTasks = includeDone
        }

        let courses = await run { client.fetchCourses(baseUrl: baseUrl, email: email, token: token) }
        if case .success(let list) = courses {
            ui.courses = list
            ui.coursesError = nil
        }

        if !ui.summaryLoading {
            let summary = await run { client.fetchSummary(baseUrl: baseUrl, email: email, token: token) }
            if case .success(let s) = summary {
                ui.summary = s
                ui.summaryError = nil
            }
        }

        if !ui.serverTranscriptsLoading {
            let transcripts = await run { client.fetchServerTranscripts(baseUrl: baseUrl, email: email, token: token) }
            if case .success(let list) = transcripts {
                ui.serverTranscripts = list
                ui.serverTranscriptsError = nil
            }
        }

        await run { ReminderNotifier.poll() }
        await syncCalendarSilently()
    }

    private func syncCalendarSilently() async {
        let emails = googleStore.emails
        if emails.isEmpty { return }
        let store = googleStore
        let account = accountStore
        let client = aiHelper
        let all: [CalendarEvent] = await run {
            var all: [CalendarEvent] = []
            var loadedAnyAccount = false
            for email in emails {
                guard let token = try? GoogleCalendarClient.accessToken(store, email: email) else {
                    // フォアグラウンド同期では再連携ダイアログやエラー表示を出さず、手動更新に任せる。
                    continue
                }
                if case .success(let events) = GoogleCalendarClient.listUpcomingEvents(token: token) {
                    loadedAnyAccount = true
                    all += events.map { ev in
                        var e = ev
                        e.accountEmail = email
                        return e
                    }
                }
            }
            if loadedAnyAccount && account.loggedIn {
                _ = client.syncCalendar(baseUrl: account.baseUrl, email: account.email,
                                        token: account.token, events: all)
            }
            return loadedAnyAccount ? all : []
        }
        if !all.isEmpty {
            ui.calendarEvents = all.sorted { $0.startMillis < $1.startMillis }
        }
    }

    /// 文字起こしを端末(Whisper)で行うか、音声をサーバーへ送って行うかを切り替える。
    func setServerTranscribe(_ enabled: Bool) {
        accountStore.serverTranscribe = enabled
        ui.serverTranscribe = enabled
    }

    /// 文字起こしに使うモデルを選び直す（ダウンロード済みのモデルのみ）。
    func selectModel(_ model: WhisperModel) {
        if !modelManager.isDownloaded(model) { return }
        modelManager.setSelectedModel(model)
        ui.selectedModel = model
    }

    func download(_ model: WhisperModel) {
        if ui.downloading != nil { return }
        ui.downloading = model
        ui.downloadProgress = 0
        ui.downloadError = nil
        let manager = modelManager
        _Concurrency.Task {
            do {
                try await _Concurrency.Task.detached(priority: .utility) {
                    try manager.download(model) { p in
                        _Concurrency.Task { @MainActor [weak self] in
                            self?.ui.downloadProgress = p < 0 ? -1 : p
                        }
                    }
                }.value
                // 選択が未設定なら、今DLしたモデルを既定の使用モデルにする。
                if manager.selectedModel() == nil { manager.setSelectedModel(model) }
                ui.downloading = nil
                refresh()
            } catch {
                ui.downloading = nil
                ui.downloadError = error.localizedDescription
            }
        }
    }

    /// AIHelper.jp にログイン（メール＋パスワード）。成功するとトークンを受け取り保存する。
    func login(baseUrl: String, email: String, password: String) {
        authenticate(baseUrl: baseUrl, email: email, password: password, register: false)
    }

    /// 新規登録（メール＋パスワード）。成功するとそのままログイン状態になる。
    func register(baseUrl: String, email: String, password: String) {
        authenticate(baseUrl: baseUrl, email: email, password: password, register: true)
    }

    private func authenticate(baseUrl: String, email: String, password: String, register: Bool) {
        if ui.loginInProgress { return }
        let url = baseUrl.trimmingCharacters(in: .whitespaces)
        let mail = email.trimmingCharacters(in: .whitespaces)
        if url.isEmpty || mail.isEmpty || password.isEmpty {
            ui.loginError = "URL・メール・パスワードをすべて入力してください"
            return
        }
        ui.loginInProgress = true
        ui.loginError = nil
        let client = aiHelper
        _Concurrency.Task {
            let result = await run {
                register ? client.register(baseUrl: url, email: mail, password: password)
                         : client.login(baseUrl: url, email: mail, password: password)
            }
            switch result {
            case .success(let token):
                accountStore.save(baseUrl: url, email: mail, token: token)
                ui.loginInProgress = false
                ui.loginError = nil
                ui.account = currentAccount()
                loadTasks()
                loadCourses()
                loadSummary()
                loadServerTranscripts()
                loadChatHistory()
                loadMoodle()
                loadSttQuality()
                refreshGoogle()
            case .failure(let e):
                ui.loginInProgress = false
                ui.loginError = e.localizedDescription
            }
        }
    }

    func logout() {
        accountStore.logout()
        ui.account = currentAccount()
        ui.sendMessage = nil
        ui.tasks = []
        ui.tasksError = nil
        ui.chatLog = []
        ui.courses = []
        ui.coursesError = nil
        ui.coursesLoading = false
        ui.summary = nil
        ui.summaryError = nil
        ui.sttQuality = "high"
        ui.sttQualityMessage = nil
        ui.serverTranscripts = []
        ui.serverTranscriptsLoading = false
        ui.serverTranscriptsError = nil
        ui.serverTranscriptDetail = nil
        ui.serverTranscriptLoadingId = nil
        ui.chatHistoryLoading = false
    }

    /// サーバーに保存済みの文字起こし一覧を取得する。
    func loadServerTranscripts() {
        guard accountStore.loggedIn else { return }
        ui.serverTranscriptsLoading = true
        ui.serverTranscriptsError = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.fetchServerTranscripts(baseUrl: base, email: email, token: token) }
            switch result {
            case .success(let list):
                ui.serverTranscripts = list
                ui.serverTranscriptsLoading = false
            case .failure(let e):
                ui.serverTranscriptsLoading = false
                ui.serverTranscriptsError = e.localizedDescription
            }
        }
    }

    /// サーバーに保存済みの文字起こし本文を取得する。
    func loadServerTranscript(_ id: Int64) {
        guard accountStore.loggedIn, ui.serverTranscriptLoadingId != id else { return }
        if let cached = ui.serverTranscriptDetail, cached.id == id, !cached.content.isEmpty { return }
        ui.serverTranscriptLoadingId = id
        ui.serverTranscriptsError = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.fetchServerTranscript(baseUrl: base, email: email, token: token, id: id) }
            switch result {
            case .success(let detail):
                ui.serverTranscriptDetail = detail
                ui.serverTranscriptLoadingId = nil
            case .failure(let e):
                ui.serverTranscriptLoadingId = nil
                ui.serverTranscriptsError = e.localizedDescription
            }
        }
    }

    /// サーバーに保存された秘書チャット履歴を取得し、画面上の会話を復元する。
    func loadChatHistory() {
        guard accountStore.loggedIn, !ui.chatHistoryLoading else { return }
        ui.chatHistoryLoading = true
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.fetchChatHistory(baseUrl: base, email: email, token: token) }
            switch result {
            case .success(let history):
                ui.chatHistoryLoading = false
                ui.chatLog = history.map { ChatMessage(text: $0.content, fromUser: $0.role == "user") }
            case .failure:
                ui.chatHistoryLoading = false
            }
        }
    }

    /// 今日の要約をサーバーから取得する。
    func loadSummary() {
        guard accountStore.loggedIn else { return }
        ui.summaryLoading = true
        ui.summaryError = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.fetchSummary(baseUrl: base, email: email, token: token) }
            switch result {
            case .success(let s):
                ui.summary = s
                ui.summaryLoading = false
            case .failure(let e):
                ui.summaryLoading = false
                ui.summaryError = e.localizedDescription
            }
        }
    }

    /// 今日の要約をいま生成し直す。
    func generateSummary() {
        guard accountStore.loggedIn, !ui.summaryLoading else { return }
        ui.summaryLoading = true
        ui.summaryError = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.generateSummary(baseUrl: base, email: email, token: token) }
            switch result {
            case .success(let s):
                ui.summary = s
                ui.summaryLoading = false
            case .failure(let e):
                ui.summaryLoading = false
                ui.summaryError = e.localizedDescription
            }
        }
    }

    /// 予定・課題の一覧をサーバーから取得する。
    func loadTasks(includeDone: Bool? = nil) {
        guard accountStore.loggedIn else { return }
        let include = includeDone ?? ui.showDoneTasks
        ui.tasksLoading = true
        ui.tasksError = nil
        ui.showDoneTasks = include
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.fetchTasks(baseUrl: base, email: email, token: token, includeDone: include) }
            switch result {
            case .success(let list):
                ui.tasks = list
                ui.tasksLoading = false
            case .failure(let e):
                ui.tasksLoading = false
                ui.tasksError = e.localizedDescription
            }
        }
    }

    /// Waseda から取り込んだ時間割をサーバーから取得する。
    func loadCourses() {
        guard accountStore.loggedIn else { return }
        ui.coursesLoading = true
        ui.coursesError = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.fetchCourses(baseUrl: base, email: email, token: token) }
            switch result {
            case .success(let list):
                ui.courses = list
                ui.coursesLoading = false
            case .failure(let e):
                ui.coursesLoading = false
                ui.coursesError = e.localizedDescription
            }
        }
    }

    /// 課題・予定の完了/未完了を切り替え、成功したら一覧を更新する。
    func toggleTaskDone(_ task: AiHelperClient.Task) {
        guard accountStore.loggedIn, ui.taskActionInProgressId != task.id else { return }
        ui.taskActionInProgressId = task.id
        ui.tasksError = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run {
                client.setTaskDone(baseUrl: base, email: email, token: token, id: task.id, done: !task.done)
            }
            switch result {
            case .ok:
                ui.taskActionInProgressId = nil
                loadTasks()
            case .error(let message):
                ui.taskActionInProgressId = nil
                ui.tasksError = message
            }
        }
    }

    /// 課題・予定を編集し、成功したら一覧とカレンダー表示を更新する。
    func updateTask(_ task: AiHelperClient.Task, type: String, content: String, details: String, deadline: String) {
        guard accountStore.loggedIn, ui.taskActionInProgressId != task.id else { return }
        let trimmed = content.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            ui.tasksError = "内容を入力してください"
            return
        }
        ui.taskActionInProgressId = task.id
        ui.tasksError = nil
        let (client, base, email, token) = context()
        let detailsTrimmed = details.trimmingCharacters(in: .whitespaces)
        let deadlineTrimmed = deadline.trimmingCharacters(in: .whitespaces)
        _Concurrency.Task {
            let result = await run {
                client.updateTask(baseUrl: base, email: email, token: token, id: task.id,
                                  type: type, content: trimmed, details: detailsTrimmed, deadline: deadlineTrimmed)
            }
            switch result {
            case .ok:
                ui.taskActionInProgressId = nil
                loadTasks()
            case .error(let message):
                ui.taskActionInProgressId = nil
                ui.tasksError = message
            }
        }
    }

    /// 課題・予定を削除する。
    func deleteTask(_ task: AiHelperClient.Task) {
        guard accountStore.loggedIn, ui.taskActionInProgressId != task.id else { return }
        ui.taskActionInProgressId = task.id
        ui.tasksError = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.deleteTask(baseUrl: base, email: email, token: token, id: task.id) }
            switch result {
            case .ok:
                ui.taskActionInProgressId = nil
                loadTasks()
            case .error(let message):
                ui.taskActionInProgressId = nil
                ui.tasksError = message
            }
        }
    }

    /// 文字起こしファイルを AIHelper.jp に送信する。ログイン中のアカウントで送る。
    func sendToServer(_ item: TranscriptItem) {
        if !accountStore.loggedIn {
            ui.sendMessage = "先に AIHelper.jp にログインしてください"
            return
        }
        if ui.sendingFile != nil { return }
        ui.sendingFile = item.name
        ui.sendMessage = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run {
                client.upload(baseUrl: base, email: email, token: token, file: URL(fileURLWithPath: item.path))
            }
            switch result {
            case .ok(let message):
                ui.sendingFile = nil
                ui.sentFiles.insert(item.name)
                ui.sendMessage = message
                loadServerTranscripts()
            case .error(let message):
                ui.sendingFile = nil
                ui.sendMessage = "送信失敗: \(message)"
            }
        }
    }

    func clearSendMessage() {
        ui.sendMessage = nil
    }

    /// 秘書に質問・依頼する。サーバー(Gemini)が回答し、「予定入れといて」等は登録まで実行する。
    func ask(_ question: String) {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty || ui.askInProgress { return }
        if !accountStore.loggedIn {
            ui.chatLog.append(ChatMessage(text: "先に AIHelper.jp にログインしてください", fromUser: false))
            return
        }
        ui.chatLog.append(ChatMessage(text: q, fromUser: true))
        ui.askInProgress = true
        let (client, base, email, token) = context()
        let calendar = ui.calendarEvents.map { ($0.whenText, $0.title) }
        _Concurrency.Task {
            let result = await run {
                client.ask(baseUrl: base, email: email, token: token, question: q, calendar: calendar)
            }
            let reply: String
            switch result {
            case .success(let r):
                reply = r.reply.isEmpty ? "（応答なし）" : r.reply
            case .failure(let e):
                reply = "エラー: \(e.localizedDescription)"
            }
            ui.chatLog.append(ChatMessage(text: reply, fromUser: false))
            ui.askInProgress = false
            // 秘書が予定・課題を追加/完了した可能性があるので、成功時は必ず一覧を更新。
            if case .success = result {
                loadTasks()
            }
        }
    }

    /// カレンダーで選んだ日の要約を取得する。
    func loadDaySummary(_ day: String) {
        if !accountStore.loggedIn {
            ui.daySummaryDay = day
            ui.daySummary = nil
            return
        }
        ui.daySummaryDay = day
        ui.daySummary = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let r = await run { client.fetchDaySummary(baseUrl: base, email: email, token: token, day: day) }
            if case .success(let s) = r, ui.daySummaryDay == day {
                ui.daySummary = s
            }
        }
    }

    // ---- Google カレンダー連携（複数アカウント対応） ----

    /// ブラウザで Google サインイン→同意を行い、選ばれたアカウントを連携に追加する。
    func connectGoogle() {
        let anchor = PresentationAnchorProvider.shared
        GoogleCalendarClient.signIn(presentationContext: anchor) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let (email, refreshToken)):
                self.googleStore.add(email)
                self.googleStore.saveRefreshToken(email, refreshToken)
                self.ui.googleEmails = self.googleStore.emails
                self.ui.googleDefault = self.googleStore.defaultEmail
                self.ui.googleMessage = nil
                self.loadCalendar()
                self.linkGoogleToServer()
            case .failure(let e):
                self.ui.googleMessage = e.localizedDescription
            }
        }
    }

    /// 指定アカウントの連携を解除する。他の連携アカウントはそのまま残る。
    func disconnectGoogle(_ email: String) {
        googleStore.remove(email)
        ui.googleEmails = googleStore.emails
        ui.googleDefault = googleStore.defaultEmail
        ui.calendarEvents = ui.calendarEvents.filter { $0.accountEmail != email }
        ui.googleMessage = "\(email) の連携を解除しました"
        linkGoogleToServer()
    }

    /// 「カレンダーに追加」の登録先アカウントを選ぶ。
    func setDefaultGoogle(_ email: String) {
        googleStore.defaultEmail = email
        ui.googleDefault = googleStore.defaultEmail
    }

    /// 保存済みの連携アカウントを反映（起動時・復帰時に呼ぶ）。
    func refreshGoogle() {
        ui.googleEmails = googleStore.emails
        ui.googleDefault = googleStore.defaultEmail
        if !googleStore.emails.isEmpty {
            loadCalendar()
            linkGoogleToServer()
        }
    }

    /// 連携中の Google メール一覧をサーバーのアカウントにも記録する（ログイン済みのときだけ）。
    private func linkGoogleToServer() {
        guard accountStore.loggedIn else { return }
        let joined = googleStore.emails.joined(separator: ",")
        let (client, base, email, token) = context()
        _Concurrency.Task {
            _ = await run { client.linkGoogle(baseUrl: base, email: email, token: token, googleEmail: joined) }
        }
    }

    /// 連携中の全アカウントから直近の予定を読み込み、開始時刻順にまとめて表示する。
    func loadCalendar() {
        let emails = googleStore.emails
        if emails.isEmpty { return }
        ui.googleBusy = true
        ui.googleMessage = nil
        let store = googleStore
        let account = accountStore
        let client = aiHelper
        _Concurrency.Task {
            let (all, error, loadedAnyAccount): ([CalendarEvent], String?, Bool) = await run {
                var all: [CalendarEvent] = []
                var error: String? = nil
                var loadedAny = false
                for email in emails {
                    do {
                        let token = try GoogleCalendarClient.accessToken(store, email: email)
                        let events = try GoogleCalendarClient.listUpcomingEvents(token: token).get()
                        loadedAny = true
                        all += events.map { ev in
                            var e = ev
                            e.accountEmail = email
                            return e
                        }
                    } catch let e {
                        error = "\(email): \(e.localizedDescription)"
                    }
                }
                // サーバーにもカレンダー予定を同期する
                if loadedAny {
                    _ = client.syncCalendar(baseUrl: account.baseUrl, email: account.email,
                                            token: account.token, events: all)
                }
                return (all, error, loadedAny)
            }
            _ = loadedAnyAccount
            ui.calendarEvents = all.sorted { $0.startMillis < $1.startMillis }
            ui.googleBusy = false
            ui.googleMessage = error
        }
    }

    /// 課題・予定の締切を「既定」の Google アカウントのカレンダーに登録する。
    func addTaskToCalendar(_ task: AiHelperClient.Task) {
        let email = googleStore.defaultEmail
        if email.isEmpty {
            ui.googleMessage = "先に Google 連携してください"
            return
        }
        ui.googleBusy = true
        ui.googleMessage = nil
        let store = googleStore
        _Concurrency.Task {
            let result: Result<Void, Error> = await run {
                do {
                    let token = try GoogleCalendarClient.accessToken(store, email: email)
                    try GoogleCalendarClient.insertDeadline(
                        token: token, title: task.content, deadline: task.deadline, dateOnly: task.dateOnly
                    ).get()
                    return .success(())
                } catch {
                    return .failure(error)
                }
            }
            switch result {
            case .success:
                ui.googleBusy = false
                ui.googleMessage = "「\(task.content)」を \(email) のカレンダーに登録しました"
                loadCalendar()
            case .failure(let e):
                ui.googleBusy = false
                ui.googleMessage = "登録失敗: \(e.localizedDescription)"
            }
        }
    }

    // ---- Waseda / Moodle / STT ----

    /// サーバーに保存済みの Waseda アカウント情報を取得。
    func loadWaseda() {
        guard accountStore.loggedIn else { return }
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let r = await run { client.fetchWaseda(baseUrl: base, email: email, token: token) }
            if case .success(let (user, hasPw)) = r {
                ui.wasedaUser = user
                ui.wasedaHasPassword = hasPw
            }
        }
    }

    /// Waseda の ID・パスワードをサーバーに保存する（各ユーザー自身のアカウントに紐付く）。
    func saveWaseda(user wasedaUser: String, password wasedaPassword: String) {
        guard accountStore.loggedIn, !ui.wasedaBusy else { return }
        ui.wasedaBusy = true
        ui.wasedaMessage = nil
        let (client, base, email, token) = context()
        let trimmedUser = wasedaUser.trimmingCharacters(in: .whitespaces)
        _Concurrency.Task {
            let result = await run {
                client.saveWaseda(baseUrl: base, email: email, token: token,
                                  wasedaUser: trimmedUser, wasedaPassword: wasedaPassword)
            }
            switch result {
            case .ok:
                ui.wasedaBusy = false
                ui.wasedaMessage = "保存しました"
                ui.wasedaUser = trimmedUser
                ui.wasedaHasPassword = ui.wasedaHasPassword || !wasedaPassword.isEmpty
            case .error(let message):
                ui.wasedaBusy = false
                ui.wasedaMessage = message
            }
        }
    }

    /// Waseda 時間割の取り込みをサーバーで実行し、完了までステータスをポーリングして表示する。
    /// スクレイパのログイン〜取得は数分かかることがある。
    func syncWaseda() {
        guard accountStore.loggedIn, !ui.wasedaSyncRunning else { return }
        ui.wasedaSyncRunning = true
        ui.wasedaSyncMessage = "取り込みを開始しています…"
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let start = await run { client.startWasedaSync(baseUrl: base, email: email, token: token) }
            if case .error(let message) = start, !message.contains("実行中") {
                ui.wasedaSyncRunning = false
                ui.wasedaSyncMessage = message
                return
            }
            // 3秒間隔で最長15分ポーリング。
            for _ in 0..<300 {
                try? await _Concurrency.Task.sleep(nanoseconds: 3_000_000_000)
                let status = await run { client.fetchWasedaSyncStatus(baseUrl: base, email: email, token: token) }
                guard case .success(let (state, message)) = status else { continue }
                if state == "running" {
                    ui.wasedaSyncMessage = message.isEmpty ? "取り込み中…" : message
                } else {
                    ui.wasedaSyncRunning = false
                    ui.wasedaSyncMessage = message
                    if state == "done" {
                        loadTasks()
                        loadCourses()
                    }
                    return
                }
            }
            ui.wasedaSyncRunning = false
            ui.wasedaSyncMessage = "取り込みの完了を確認できませんでした"
        }
    }

    /// サーバー文字起こしのクオリティ設定を取得。
    func loadSttQuality() {
        guard accountStore.loggedIn else { return }
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let r = await run { client.fetchSttQuality(baseUrl: base, email: email, token: token) }
            if case .success(let q) = r { ui.sttQuality = q }
        }
    }

    /// サーバー文字起こしのクオリティを変更して保存する。
    /// 将来はプラン（課金）で選べるクオリティを制限する想定。現時点では制限なし。
    func setSttQuality(_ quality: String) {
        guard accountStore.loggedIn, !ui.sttQualityBusy else { return }
        let prev = ui.sttQuality
        ui.sttQuality = quality
        ui.sttQualityBusy = true
        ui.sttQualityMessage = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.saveSttQuality(baseUrl: base, email: email, token: token, quality: quality) }
            switch result {
            case .ok:
                ui.sttQualityBusy = false
                ui.sttQualityMessage = "保存しました"
            case .error(let message):
                ui.sttQualityBusy = false
                ui.sttQuality = prev
                ui.sttQualityMessage = message
            }
        }
    }

    /// Moodle の iCal URL を取得。
    func loadMoodle() {
        guard accountStore.loggedIn else { return }
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let r = await run { client.fetchMoodleUrl(baseUrl: base, email: email, token: token) }
            if case .success(let u) = r { ui.moodleUrl = u }
        }
    }

    /// Moodle の iCal URL を保存。
    func saveMoodleUrl(_ url: String) {
        guard accountStore.loggedIn else { return }
        ui.moodleBusy = true
        ui.moodleMessage = nil
        ui.moodleUrl = url
        let (client, base, email, token) = context()
        let trimmed = url.trimmingCharacters(in: .whitespaces)
        _Concurrency.Task {
            let result = await run { client.saveMoodleUrl(baseUrl: base, email: email, token: token, moodleUrl: trimmed) }
            switch result {
            case .ok:
                ui.moodleBusy = false
                ui.moodleMessage = "保存しました"
            case .error(let message):
                ui.moodleBusy = false
                ui.moodleMessage = message
            }
        }
    }

    /// Moodle をいま同期して課題・予定を取り込む。
    func syncMoodle() {
        guard accountStore.loggedIn, !ui.moodleBusy else { return }
        ui.moodleBusy = true
        ui.moodleMessage = nil
        let (client, base, email, token) = context()
        _Concurrency.Task {
            let result = await run { client.syncMoodle(baseUrl: base, email: email, token: token) }
            switch result {
            case .success(let n):
                ui.moodleBusy = false
                ui.moodleMessage = "\(n) 件取り込みました"
                loadTasks()
            case .failure(let e):
                ui.moodleBusy = false
                ui.moodleMessage = "同期失敗: \(e.localizedDescription)"
            }
        }
    }

    // ---- helpers ----

    private func currentAccount() -> AccountState {
        AccountState(loggedIn: accountStore.loggedIn, baseUrl: accountStore.baseUrl, email: accountStore.email)
    }

    private func context() -> (AiHelperClient, String, String, String) {
        (aiHelper, accountStore.baseUrl, accountStore.email, accountStore.token)
    }

    /// ブロッキング処理をワーカースレッドで実行する（Dispatchers.IO 相当）。
    private func run<T>(_ block: @escaping () -> T) async -> T {
        await _Concurrency.Task.detached(priority: .userInitiated) { block() }.value
    }

    private static let foregroundSyncIntervalNs: UInt64 = 10_000_000_000 // 10秒
}

/// ASWebAuthenticationSession の表示先アンカー。
final class PresentationAnchorProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = PresentationAnchorProvider()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
