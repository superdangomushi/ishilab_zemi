import SwiftUI

/// AIHelper 連携（ログイン）・予定/課題の確認・秘書チャットをまとめたタブ。
struct SecretaryTabView: View {
    @EnvironmentObject var viewModel: MainViewModel

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                AiHelperCard()

                // Google 連携は端末側サインインなので AIHelper ログイン前でも表示する。
                GoogleCalendarCard()

                if !viewModel.ui.account.loggedIn {
                    Text("AIHelper にログインすると、Moodle 連携や予定・課題の確認、秘書チャットが使えます。")
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    // ---- 連携（アカウントに紐付く） ----
                    MoodleCard()
                    WasedaCard()

                    // ---- 1日のまとめ通知 ----
                    DigestCard()

                    // ---- 今日の要約 ----
                    SummaryCard()

                    // ---- 予定・課題 ----
                    HStack {
                        Text("予定・課題").font(.headline)
                        Spacer()
                        Button(viewModel.ui.showDoneTasks ? "未完了のみ" : "完了も表示") {
                            viewModel.loadTasks(includeDone: !viewModel.ui.showDoneTasks)
                        }
                        Button("更新") { viewModel.loadTasks() }
                            .buttonStyle(.bordered)
                    }

                    if let err = viewModel.ui.tasksError {
                        Text("取得エラー: \(err)")
                            .foregroundColor(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if viewModel.ui.tasksLoading && viewModel.ui.tasks.isEmpty {
                        Text("読み込み中…").font(.caption)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if viewModel.ui.tasks.isEmpty {
                        Text("表示できる予定・課題はありません。").font(.caption)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ForEach(viewModel.ui.tasks) { task in
                            TaskCardView(task: task)
                        }
                    }

                    if let msg = viewModel.ui.googleMessage {
                        Text(msg).font(.caption)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    // ---- 秘書チャット ----
                    CardView {
                        Text("秘書に聞く / 頼む").font(.headline)
                        SecretaryChatPanel(expandMessages: false)
                    }
                }
            }
            .padding(16)
        }
    }
}

/// AIHelper.jp のログイン / アカウント表示。
struct AiHelperCard: View {
    @EnvironmentObject var viewModel: MainViewModel

    var body: some View {
        CardView {
            Text("AIHelper.jp 連携").font(.headline)
            if viewModel.ui.account.loggedIn {
                Text("ログイン中: \(viewModel.ui.account.email)")
                Text(viewModel.ui.account.baseUrl).font(.caption)
                SttQualitySection()
                Button("ログアウト") { viewModel.logout() }
            } else {
                AiHelperLoginForm()
            }
        }
    }
}

// サーバー文字起こしのクオリティ選択肢。値はサーバー API（/api/stt-quality）と共通。
// 将来はプラン（課金）で選べるものを制限する想定だが、現時点では全員どれでも選べる。
private let sttQualityOptions: [(String, String)] = [
    ("light", "軽量（速い・精度低め）"),
    ("standard", "標準（バランス）"),
    ("high", "最高精度（推奨・現在の既定）"),
]

/// アカウントに紐付く音声認識クオリティの選択。
struct SttQualitySection: View {
    @EnvironmentObject var viewModel: MainViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("音声認識クオリティ").font(.subheadline.bold())
            Text("サーバーで文字起こしするときの精度と速さの設定です。").font(.caption)
            ForEach(sttQualityOptions, id: \.0) { value, label in
                RadioRow(selected: viewModel.ui.sttQuality == value,
                         enabled: !viewModel.ui.sttQualityBusy) {
                    viewModel.setSttQuality(value)
                } label: {
                    Text(label).font(.subheadline)
                }
            }
            if let msg = viewModel.ui.sttQualityMessage {
                Text(msg).font(.caption)
            }
        }
    }
}

struct AiHelperLoginForm: View {
    @EnvironmentObject var viewModel: MainViewModel
    @State private var baseUrl = ""
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: 8) {
            LabeledField(label: "サーバーURL", text: $baseUrl)
            LabeledField(label: "メールアドレス", text: $email)
            LabeledField(label: "パスワード", text: $password, secure: true)
            HStack(spacing: 8) {
                Button {
                    viewModel.login(baseUrl: baseUrl, email: email, password: password)
                } label: {
                    if viewModel.ui.loginInProgress {
                        ProgressView().scaleEffect(0.7)
                    } else {
                        Text("ログイン").frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.ui.loginInProgress)
                Button {
                    viewModel.register(baseUrl: baseUrl, email: email, password: password)
                } label: {
                    Text("新規登録").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.ui.loginInProgress)
            }
            if let err = viewModel.ui.loginError {
                Text("認証失敗: \(err)")
                    .foregroundColor(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onAppear {
            if baseUrl.isEmpty { baseUrl = viewModel.ui.account.baseUrl }
        }
    }
}

/// Google カレンダー連携カード。複数アカウントを連携でき、既定の登録先を選んで予定をまとめて表示。
struct GoogleCalendarCard: View {
    @EnvironmentObject var viewModel: MainViewModel

    var body: some View {
        CardView {
            HStack {
                Text("Google カレンダー").font(.headline)
                Spacer()
                if viewModel.ui.googleConnected {
                    Button("更新") { viewModel.loadCalendar() }
                        .buttonStyle(.bordered)
                        .disabled(viewModel.ui.googleBusy)
                }
            }
            if !viewModel.ui.googleConnected {
                Text("連携すると、課題・予定の締切をカレンダーに登録したり、直近の予定を表示できます。")
                    .font(.caption)
                Button("Google と連携") { viewModel.connectGoogle() }
                    .buttonStyle(.borderedProminent)
                // サインイン失敗の理由（OAuth 設定不備・キャンセル等）をここに表示する。
                if let msg = viewModel.ui.googleMessage {
                    Text(msg).foregroundColor(.red).font(.caption)
                }
            } else {
                if viewModel.ui.googleEmails.count > 1 {
                    Text("「カレンダーに追加」の登録先を選んでください。").font(.caption)
                }
                ForEach(viewModel.ui.googleEmails, id: \.self) { email in
                    HStack {
                        RadioRow(selected: email == viewModel.ui.googleDefault, enabled: true) {
                            viewModel.setDefaultGoogle(email)
                        } label: {
                            Text(email).font(.caption).lineLimit(1)
                        }
                        Button("解除") { viewModel.disconnectGoogle(email) }
                            .font(.caption)
                    }
                }
                Button("アカウントを追加") { viewModel.connectGoogle() }
                if viewModel.ui.calendarEvents.isEmpty {
                    Text(viewModel.ui.googleBusy ? "読み込み中…" : "直近の予定はありません。")
                        .font(.caption)
                } else {
                    ForEach(Array(viewModel.ui.calendarEvents.prefix(8).enumerated()), id: \.offset) { _, ev in
                        let owner = (viewModel.ui.googleEmails.count > 1 && !ev.accountEmail.isEmpty)
                            ? "（\(ev.accountEmail.split(separator: "@").first.map(String.init) ?? "")）"
                            : ""
                        Text("・\(ev.whenText)  \(ev.title)\(owner)")
                            .font(.subheadline)
                    }
                }
            }
        }
    }
}

/// Moodle（iCal）連携カード。URL を保存し、提出物・予定を取り込む。
struct MoodleCard: View {
    @EnvironmentObject var viewModel: MainViewModel
    @State private var url = ""

    var body: some View {
        CardView {
            Text("Moodle 連携").font(.headline)
            Text("Moodle のカレンダー → 書き出し →「カレンダーのURLを取得」で得た iCal URL を貼り付けてください。提出物・予定が課題一覧に取り込まれます。")
                .font(.caption)
            LabeledField(label: "Moodle iCal URL", text: $url)
            HStack(spacing: 8) {
                Button("保存") { viewModel.saveMoodleUrl(url) }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.ui.moodleBusy)
                Button("課題・予定を取り込む") { viewModel.syncMoodle() }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.ui.moodleBusy || url.isEmpty)
            }
            if viewModel.ui.moodleBusy {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let msg = viewModel.ui.moodleMessage {
                Text(msg).font(.caption)
            }
        }
        .onAppear {
            viewModel.loadMoodle()
        }
        .onChange(of: viewModel.ui.moodleUrl) { newValue in
            if url.isEmpty { url = newValue }
        }
    }
}

/// Waseda アカウント連携カード。各ユーザーが自分の Waseda ID・パスワードを保存する。
struct WasedaCard: View {
    @EnvironmentObject var viewModel: MainViewModel
    @State private var user = ""
    @State private var password = ""

    var body: some View {
        CardView {
            Text("Waseda アカウント連携").font(.headline)
            Text("MyWaseda のログイン情報を保存すると、科目登録（時間割）を自動取得できます。パスワードは暗号化して保存され、時間割取得にのみ使われます。")
                .font(.caption)
            LabeledField(label: "Waseda ID（例: xxxx@akane.waseda.jp）", text: $user)
            LabeledField(label: viewModel.ui.wasedaHasPassword ? "パスワード（変更時のみ入力）" : "パスワード",
                         text: $password, secure: true)
            HStack(spacing: 8) {
                Button("保存") {
                    viewModel.saveWaseda(user: user, password: password)
                    password = ""
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.ui.wasedaBusy || user.isEmpty
                          || (password.isEmpty && !viewModel.ui.wasedaHasPassword))
                Button("時間割を取り込む") { viewModel.syncWaseda() }
                    .buttonStyle(.bordered)
                    .disabled(!viewModel.ui.wasedaHasPassword || viewModel.ui.wasedaSyncRunning)
                if viewModel.ui.wasedaHasPassword {
                    Text("パスワード保存済み").font(.caption)
                }
            }
            if let msg = viewModel.ui.wasedaMessage {
                Text(msg).font(.caption)
            }
            // 取り込み実行中のステータスバー（サーバー側スクレイパの進行状況を表示）。
            if viewModel.ui.wasedaSyncRunning {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let msg = viewModel.ui.wasedaSyncMessage {
                Text(viewModel.ui.wasedaSyncRunning ? "取り込み中: \(msg)" : msg)
                    .font(.caption)
                    .foregroundColor(viewModel.ui.wasedaSyncRunning ? AppTheme.primary : .secondary)
            }
        }
        .onAppear {
            viewModel.loadWaseda()
        }
        .onChange(of: viewModel.ui.wasedaUser) { newValue in
            if user.isEmpty { user = newValue }
        }
    }
}

/// 「1日のまとめ通知」の時刻設定カード。
/// 設定した時刻（複数可）に今日の授業・予定・課題期限をまとめた通知を出す。
struct DigestCard: View {
    @State private var times = DigestTimeStore().times
    @State private var pickerShown = false
    @State private var pickedTime = Calendar.current.date(from: DateComponents(hour: 8, minute: 0)) ?? Date()

    var body: some View {
        CardView {
            Text("1日のまとめ通知").font(.subheadline.bold())
            Text("設定した時刻に、今日の授業・予定・課題の期限をまとめて通知します（複数設定可）。")
                .font(.caption)
            if times.isEmpty {
                Text("通知時刻は未設定です。").font(.caption)
            }
            ForEach(times, id: \.self) { t in
                HStack {
                    Text(t)
                    Spacer()
                    Button("削除") {
                        let store = DigestTimeStore()
                        store.remove(t)
                        times = store.times
                        DailyDigestScheduler.scheduleAll()
                    }
                    .font(.caption)
                }
            }
            if pickerShown {
                DatePicker("通知時刻", selection: $pickedTime, displayedComponents: .hourAndMinute)
                Button("追加") {
                    let c = Calendar.current.dateComponents([.hour, .minute], from: pickedTime)
                    let store = DigestTimeStore()
                    store.add(String(format: "%02d:%02d", c.hour ?? 8, c.minute ?? 0))
                    times = store.times
                    DailyDigestScheduler.scheduleAll()
                    pickerShown = false
                }
                .buttonStyle(.borderedProminent)
            } else {
                Button("＋ 通知時刻を追加") { pickerShown = true }
                    .buttonStyle(.bordered)
            }
        }
    }
}

/// 今日の要約カード。サーバーの日次要約を表示し、更新/生成し直しができる。
struct SummaryCard: View {
    @EnvironmentObject var viewModel: MainViewModel

    var body: some View {
        CardView {
            HStack {
                Text("今日の要約").font(.headline)
                Spacer()
                Button("生成") { viewModel.generateSummary() }
                    .disabled(viewModel.ui.summaryLoading)
                Button("更新") { viewModel.loadSummary() }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.ui.summaryLoading)
            }
            if let err = viewModel.ui.summaryError {
                Text("エラー: \(err)").foregroundColor(.red)
            }
            if viewModel.ui.summaryLoading && (viewModel.ui.summary ?? "").isEmpty {
                Text("読み込み中…").font(.caption)
            } else if (viewModel.ui.summary ?? "").isEmpty {
                Text("まだ今日の要約はありません。録音がたまるか「生成」で作成できます。")
                    .font(.caption)
            } else {
                Text(viewModel.ui.summary ?? "")
            }
        }
        .onAppear { viewModel.loadSummary() }
    }
}

/// 予定・課題1件のカード。チェックで完了/未完了を切替。Google 連携済みなら登録ボタンを出す。
struct TaskCardView: View {
    @EnvironmentObject var viewModel: MainViewModel
    let task: AiHelperClient.Task
    @State private var editing = false

    var body: some View {
        let actionInProgress = viewModel.ui.taskActionInProgressId == task.id
        let isYotei = task.type == "yotei"
        let label = isYotei ? "予定" : "課題"
        let labelColor = isYotei ? AppTheme.tertiary : AppTheme.primary
        CardView {
            HStack(alignment: .top, spacing: 8) {
                Button {
                    viewModel.toggleTaskDone(task)
                } label: {
                    Image(systemName: task.done ? "checkmark.square.fill" : "square")
                        .font(.title3)
                        .foregroundColor(task.done ? AppTheme.primary : .secondary)
                }
                .disabled(actionInProgress)
                VStack(alignment: .leading, spacing: 4) {
                    Text("[\(label)]")
                        .font(.caption.bold())
                        .foregroundColor(labelColor)
                    Text(task.content)
                        .strikethrough(task.done)
                    Text("期限: \(formatDeadline(task.deadline, dateOnly: task.dateOnly))")
                        .font(.caption)
                    if !task.details.isEmpty {
                        Text(task.details)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    if viewModel.ui.googleConnected, let dl = task.deadline, !dl.isEmpty {
                        Button("カレンダーに追加") { viewModel.addTaskToCalendar(task) }
                            .font(.caption)
                            .disabled(actionInProgress)
                    }
                    HStack(spacing: 8) {
                        Button("編集") { editing = true }
                            .font(.caption)
                            .disabled(actionInProgress)
                        if actionInProgress {
                            ProgressView().scaleEffect(0.6)
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $editing) {
            TaskEditView(
                task: task,
                saving: viewModel.ui.taskActionInProgressId == task.id,
                onSave: { type, content, details, deadline in
                    viewModel.updateTask(task, type: type, content: content, details: details, deadline: deadline)
                    editing = false
                },
                onDelete: {
                    viewModel.deleteTask(task)
                    editing = false
                },
                onDismiss: { editing = false }
            )
        }
    }
}
