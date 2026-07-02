package com.ishilab.transcriber.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ishilab.transcriber.model.ModelManager
import com.ishilab.transcriber.model.WhisperModel
import com.ishilab.transcriber.net.AccountStore
import com.ishilab.transcriber.net.AiHelperClient
import com.ishilab.transcriber.google.CalendarEvent
import com.ishilab.transcriber.google.GoogleCalendarClient
import com.google.android.gms.auth.api.signin.GoogleSignIn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

data class TranscriptItem(val name: String, val path: String, val sizeBytes: Long)

/** 秘書チャットの1メッセージ。fromUser=true なら利用者の発話。 */
data class ChatMessage(val text: String, val fromUser: Boolean)

/** AIHelper.jp のログイン状態。 */
data class AccountState(
    val loggedIn: Boolean = false,
    val baseUrl: String = "https://AIHelper.jp",
    val email: String = "",
)

data class UiState(
    val downloadedModels: Set<WhisperModel> = emptySet(),
    val selectedModel: WhisperModel? = null,
    val downloading: WhisperModel? = null,
    val downloadProgress: Float = 0f,
    val downloadError: String? = null,
    val transcripts: List<TranscriptItem> = emptyList(),
    val account: AccountState = AccountState(),
    val loginInProgress: Boolean = false,
    val loginError: String? = null,
    val sendingFile: String? = null,
    val sentFiles: Set<String> = emptySet(),
    val sendMessage: String? = null,
    val serverTranscripts: List<AiHelperClient.ServerTranscript> = emptyList(),
    val serverTranscriptsLoading: Boolean = false,
    val serverTranscriptsError: String? = null,
    val serverTranscriptDetail: AiHelperClient.ServerTranscriptDetail? = null,
    val serverTranscriptLoadingId: Long? = null,
    val chatLog: List<ChatMessage> = emptyList(),
    val chatHistoryLoading: Boolean = false,
    val askInProgress: Boolean = false,
    val tasks: List<AiHelperClient.Task> = emptyList(),
    val tasksLoading: Boolean = false,
    val tasksError: String? = null,
    val showDoneTasks: Boolean = false,
    val summary: String? = null,
    val summaryLoading: Boolean = false,
    val summaryError: String? = null,
    // Google カレンダー連携（複数アカウント対応）
    val googleEmails: List<String> = emptyList(),
    /** 「カレンダーに追加」の登録先アカウント。 */
    val googleDefault: String = "",
    val calendarEvents: List<CalendarEvent> = emptyList(),
    val googleBusy: Boolean = false,
    val googleMessage: String? = null,
    /** あるアカウントの初回利用許可が必要なとき、起動すべき同意画面の Intent。 */
    val googleConsentIntent: android.content.Intent? = null,
    // Moodle 連携
    val moodleUrl: String = "",
    val moodleBusy: Boolean = false,
    val moodleMessage: String? = null,
    // Waseda アカウント連携（時間割取り込み用）
    val wasedaUser: String = "",
    val wasedaHasPassword: Boolean = false,
    val wasedaBusy: Boolean = false,
    val wasedaMessage: String? = null,
    /** サーバー側で時間割取り込み（スクレイパ）実行中か。 */
    val wasedaSyncRunning: Boolean = false,
    val wasedaSyncMessage: String? = null,
    // カレンダー: 選択日の要約
    val daySummaryDay: String? = null,
    val daySummary: String? = null,
    /** true なら録音音声をサーバーへアップロードして文字起こしする（端末 Whisper を使わない）。 */
    val serverTranscribe: Boolean = false,
) {
    val anyModelReady: Boolean get() = downloadedModels.isNotEmpty()
    val googleConnected: Boolean get() = googleEmails.isNotEmpty()
}

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val modelManager = ModelManager(app)
    private val accountStore = AccountStore(app)
    private val googleStore = com.ishilab.transcriber.google.GoogleAccountStore(app)
    private val AIHelper = AiHelperClient()

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui

    init {
        _ui.update { it.copy(account = currentAccount(), serverTranscribe = accountStore.serverTranscribe) }
        refresh()
        // ログイン済みで起動した場合もカレンダー・予定タブにデータが出るよう最初に読み込む。
        if (accountStore.loggedIn) {
            loadTasks()
            loadSummary()
            loadServerTranscripts()
            loadChatHistory()
        }
    }

    fun refresh() {
        val downloaded = WhisperModel.entries.filter { modelManager.isDownloaded(it) }.toSet()
        val dir = File(getApplication<Application>().filesDir, "transcripts")
        val items = dir.listFiles { f -> f.isFile && f.name.endsWith(".txt") }
            ?.sortedByDescending { it.name }
            ?.map { TranscriptItem(it.name, it.absolutePath, it.length()) }
            ?: emptyList()
        _ui.update {
            it.copy(
                downloadedModels = downloaded,
                selectedModel = modelManager.activeModel(),
                transcripts = items,
            )
        }
    }

    /** 文字起こしを端末(Whisper)で行うか、音声をサーバーへ送って行うかを切り替える。 */
    fun setServerTranscribe(enabled: Boolean) {
        accountStore.serverTranscribe = enabled
        _ui.update { it.copy(serverTranscribe = enabled) }
    }

    /** 文字起こしに使うモデルを選び直す（ダウンロード済みのモデルのみ）。 */
    fun selectModel(model: WhisperModel) {
        if (!modelManager.isDownloaded(model)) return
        modelManager.setSelectedModel(model)
        _ui.update { it.copy(selectedModel = model) }
    }

    fun download(model: WhisperModel) {
        if (_ui.value.downloading != null) return
        _ui.update { it.copy(downloading = model, downloadProgress = 0f, downloadError = null) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    modelManager.download(model) { p ->
                        _ui.update { it.copy(downloadProgress = if (p < 0f) -1f else p) }
                    }
                }
                // 選択が未設定なら、今DLしたモデルを既定の使用モデルにする。
                if (modelManager.selectedModel() == null) modelManager.setSelectedModel(model)
                _ui.update { it.copy(downloading = null) }
                refresh()
            } catch (e: Exception) {
                _ui.update {
                    it.copy(downloading = null, downloadError = e.message ?: "ダウンロード失敗")
                }
            }
        }
    }

    /** AIHelper.jp にログイン（メール＋パスワード）。成功するとトークンを受け取り保存する。 */
    fun login(baseUrl: String, email: String, password: String) =
        authenticate(baseUrl, email, password, register = false)

    /** 新規登録（メール＋パスワード）。成功するとそのままログイン状態になる。 */
    fun register(baseUrl: String, email: String, password: String) =
        authenticate(baseUrl, email, password, register = true)

    private fun authenticate(baseUrl: String, email: String, password: String, register: Boolean) {
        if (_ui.value.loginInProgress) return
        val url = baseUrl.trim()
        val mail = email.trim()
        if (url.isEmpty() || mail.isEmpty() || password.isEmpty()) {
            _ui.update { it.copy(loginError = "URL・メール・パスワードをすべて入力してください") }
            return
        }
        _ui.update { it.copy(loginInProgress = true, loginError = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                if (register) AIHelper.register(url, mail, password) else AIHelper.login(url, mail, password)
            }
            result.fold(
                onSuccess = { token ->
                    accountStore.save(url, mail, token)
                    _ui.update {
                        it.copy(loginInProgress = false, loginError = null, account = currentAccount())
                    }
                    loadTasks()
                    loadSummary()
                    loadServerTranscripts()
                    loadChatHistory()
                    loadMoodle()
                    refreshGoogle()
                },
                onFailure = { e ->
                    _ui.update {
                        it.copy(loginInProgress = false, loginError = e.message ?: "認証に失敗しました")
                    }
                }
            )
        }
    }

    fun logout() {
        accountStore.logout()
        _ui.update {
            it.copy(
                account = currentAccount(), sendMessage = null,
                tasks = emptyList(), tasksError = null, chatLog = emptyList(),
                summary = null, summaryError = null,
                serverTranscripts = emptyList(),
                serverTranscriptsLoading = false,
                serverTranscriptsError = null,
                serverTranscriptDetail = null,
                serverTranscriptLoadingId = null,
                chatHistoryLoading = false,
            )
        }
    }

    /** サーバーに保存済みの文字起こし一覧を取得する。 */
    fun loadServerTranscripts() {
        if (!accountStore.loggedIn) return
        _ui.update { it.copy(serverTranscriptsLoading = true, serverTranscriptsError = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.fetchServerTranscripts(accountStore.baseUrl, accountStore.email, accountStore.token)
            }
            result.fold(
                onSuccess = { list ->
                    _ui.update { it.copy(serverTranscripts = list, serverTranscriptsLoading = false) }
                },
                onFailure = { e ->
                    _ui.update {
                        it.copy(
                            serverTranscriptsLoading = false,
                            serverTranscriptsError = e.message ?: "取得に失敗しました"
                        )
                    }
                }
            )
        }
    }

    /** サーバーに保存済みの文字起こし本文を取得する。 */
    fun loadServerTranscript(id: Long) {
        if (!accountStore.loggedIn || _ui.value.serverTranscriptLoadingId == id) return
        val cached = _ui.value.serverTranscriptDetail
        if (cached?.id == id && cached.content.isNotBlank()) return
        _ui.update { it.copy(serverTranscriptLoadingId = id, serverTranscriptsError = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.fetchServerTranscript(accountStore.baseUrl, accountStore.email, accountStore.token, id)
            }
            result.fold(
                onSuccess = { detail ->
                    _ui.update { it.copy(serverTranscriptDetail = detail, serverTranscriptLoadingId = null) }
                },
                onFailure = { e ->
                    _ui.update {
                        it.copy(
                            serverTranscriptLoadingId = null,
                            serverTranscriptsError = e.message ?: "本文取得に失敗しました"
                        )
                    }
                }
            )
        }
    }

    /** サーバーに保存された秘書チャット履歴を取得し、画面上の会話を復元する。 */
    fun loadChatHistory() {
        if (!accountStore.loggedIn || _ui.value.chatHistoryLoading) return
        _ui.update { it.copy(chatHistoryLoading = true) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.fetchChatHistory(accountStore.baseUrl, accountStore.email, accountStore.token)
            }
            result.fold(
                onSuccess = { history ->
                    _ui.update {
                        it.copy(
                            chatHistoryLoading = false,
                            chatLog = history.map { msg ->
                                ChatMessage(msg.content, fromUser = msg.role == "user")
                            }
                        )
                    }
                },
                onFailure = {
                    _ui.update { it.copy(chatHistoryLoading = false) }
                }
            )
        }
    }

    /** 今日の要約をサーバーから取得する。 */
    fun loadSummary() {
        if (!accountStore.loggedIn) return
        _ui.update { it.copy(summaryLoading = true, summaryError = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.fetchSummary(accountStore.baseUrl, accountStore.email, accountStore.token)
            }
            result.fold(
                onSuccess = { s -> _ui.update { it.copy(summary = s, summaryLoading = false) } },
                onFailure = { e ->
                    _ui.update {
                        it.copy(summaryLoading = false, summaryError = e.message ?: "取得に失敗しました")
                    }
                }
            )
        }
    }

    /** 今日の要約をいま生成し直す。 */
    fun generateSummary() {
        if (!accountStore.loggedIn || _ui.value.summaryLoading) return
        _ui.update { it.copy(summaryLoading = true, summaryError = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.generateSummary(accountStore.baseUrl, accountStore.email, accountStore.token)
            }
            result.fold(
                onSuccess = { s -> _ui.update { it.copy(summary = s, summaryLoading = false) } },
                onFailure = { e ->
                    _ui.update {
                        it.copy(summaryLoading = false, summaryError = e.message ?: "生成に失敗しました")
                    }
                }
            )
        }
    }

    /** 予定・課題の一覧をサーバーから取得する。 */
    fun loadTasks(includeDone: Boolean = _ui.value.showDoneTasks) {
        if (!accountStore.loggedIn) return
        _ui.update { it.copy(tasksLoading = true, tasksError = null, showDoneTasks = includeDone) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.fetchTasks(
                    accountStore.baseUrl, accountStore.email, accountStore.token, includeDone
                )
            }
            result.fold(
                onSuccess = { list -> _ui.update { it.copy(tasks = list, tasksLoading = false) } },
                onFailure = { e ->
                    _ui.update {
                        it.copy(tasksLoading = false, tasksError = e.message ?: "取得に失敗しました")
                    }
                }
            )
        }
    }

    /** 課題・予定の完了/未完了を切り替え、成功したら一覧を更新する。 */
    fun toggleTaskDone(task: AiHelperClient.Task) {
        if (!accountStore.loggedIn) return
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.setTaskDone(
                    accountStore.baseUrl, accountStore.email, accountStore.token,
                    task.id, !task.done
                )
            }
            when (result) {
                is AiHelperClient.Result.Ok -> loadTasks()
                is AiHelperClient.Result.Error ->
                    _ui.update { it.copy(tasksError = result.message) }
            }
        }
    }

    /** 文字起こしファイルを AIHelper.jp に送信する。ログイン中のアカウントで送る。 */
    fun sendToServer(item: TranscriptItem) {
        if (!accountStore.loggedIn) {
            _ui.update { it.copy(sendMessage = "先に AIHelper.jp にログインしてください") }
            return
        }
        if (_ui.value.sendingFile != null) return
        _ui.update { it.copy(sendingFile = item.name, sendMessage = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.upload(
                    accountStore.baseUrl, accountStore.email, accountStore.token, File(item.path)
                )
            }
            val message = when (result) {
                is AiHelperClient.Result.Ok -> result.message
                is AiHelperClient.Result.Error -> "送信失敗: ${result.message}"
            }
            _ui.update {
                val sent = if (result is AiHelperClient.Result.Ok) it.sentFiles + item.name else it.sentFiles
                it.copy(sendingFile = null, sentFiles = sent, sendMessage = message)
            }
            if (result is AiHelperClient.Result.Ok) loadServerTranscripts()
        }
    }

    fun clearSendMessage() {
        _ui.update { it.copy(sendMessage = null) }
    }

    /**
     * 秘書に質問・依頼する。サーバー(Gemini)が回答し、「予定入れといて」等は登録まで実行する。
     */
    fun ask(question: String) {
        val q = question.trim()
        if (q.isEmpty() || _ui.value.askInProgress) return
        if (!accountStore.loggedIn) {
            _ui.update {
                it.copy(chatLog = it.chatLog + ChatMessage("先に AIHelper.jp にログインしてください", false))
            }
            return
        }
        _ui.update {
            it.copy(chatLog = it.chatLog + ChatMessage(q, true), askInProgress = true)
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.ask(
                    accountStore.baseUrl, accountStore.email, accountStore.token, q,
                    _ui.value.calendarEvents.map { it.whenText to it.title }
                )
            }
            val reply = result.fold(
                onSuccess = { it.reply.ifBlank { "（応答なし）" } },
                onFailure = { "エラー: ${it.message ?: "通信に失敗しました"}" }
            )
            _ui.update {
                it.copy(chatLog = it.chatLog + ChatMessage(reply, false), askInProgress = false)
            }
            // 秘書が予定・課題を追加/完了した可能性があるので、成功時は必ず一覧を更新。
            if (result.isSuccess) {
                loadTasks()
            }
        }
    }

    /** カレンダーで選んだ日の要約を取得する。 */
    fun loadDaySummary(day: String) {
        if (!accountStore.loggedIn) {
            _ui.update { it.copy(daySummaryDay = day, daySummary = null) }
            return
        }
        _ui.update { it.copy(daySummaryDay = day, daySummary = null) }
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) {
                AIHelper.fetchDaySummary(accountStore.baseUrl, accountStore.email, accountStore.token, day)
            }
            r.onSuccess { s -> _ui.update { if (it.daySummaryDay == day) it.copy(daySummary = s) else it } }
        }
    }

    // ---- Google カレンダー連携（複数アカウント対応） ----

    /** システムのアカウント選択画面の結果を処理し、選ばれたアカウントを連携に追加する。 */
    fun onGoogleAccountPicked(data: android.content.Intent?) {
        val email = data?.getStringExtra(android.accounts.AccountManager.KEY_ACCOUNT_NAME)
        if (email.isNullOrBlank()) return
        googleStore.add(email)
        _ui.update {
            it.copy(
                googleEmails = googleStore.emails,
                googleDefault = googleStore.defaultEmail,
                googleMessage = null,
            )
        }
        loadCalendar() // 初回はここで利用許可（同意画面）が要求される
        linkGoogleToServer()
    }

    /** 指定アカウントの連携を解除する。他の連携アカウントはそのまま残る。 */
    fun disconnectGoogle(email: String) {
        googleStore.remove(email)
        _ui.update {
            it.copy(
                googleEmails = googleStore.emails,
                googleDefault = googleStore.defaultEmail,
                calendarEvents = it.calendarEvents.filter { ev -> ev.accountEmail != email },
                googleMessage = "$email の連携を解除しました",
            )
        }
        linkGoogleToServer()
    }

    /** 「カレンダーに追加」の登録先アカウントを選ぶ。 */
    fun setDefaultGoogle(email: String) {
        googleStore.defaultEmail = email
        _ui.update { it.copy(googleDefault = googleStore.defaultEmail) }
    }

    /** 同意画面を起動したら呼ぶ（同じ Intent を繰り返し起動しないようにクリア）。 */
    fun consentIntentLaunched() {
        _ui.update { it.copy(googleConsentIntent = null) }
    }

    /** 保存済みの連携アカウントを反映（起動時・復帰時に呼ぶ）。 */
    fun refreshGoogle() {
        // 旧バージョン（Google サインイン方式）で連携していたアカウントを一度だけ移行する。
        GoogleSignIn.getLastSignedInAccount(getApplication())?.email?.let { legacy ->
            if (legacy !in googleStore.emails) googleStore.add(legacy)
        }
        _ui.update {
            it.copy(googleEmails = googleStore.emails, googleDefault = googleStore.defaultEmail)
        }
        if (googleStore.emails.isNotEmpty()) {
            loadCalendar()
            linkGoogleToServer()
        }
    }

    /** 連携中の Google メール一覧をサーバーのアカウントにも記録する（ログイン済みのときだけ）。 */
    private fun linkGoogleToServer() {
        if (!accountStore.loggedIn) return
        val joined = googleStore.emails.joinToString(",")
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                AIHelper.linkGoogle(accountStore.baseUrl, accountStore.email, accountStore.token, joined)
            }
        }
    }

    /** サーバーに保存済みの Waseda アカウント情報を取得。 */
    fun loadWaseda() {
        if (!accountStore.loggedIn) return
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) {
                AIHelper.fetchWaseda(accountStore.baseUrl, accountStore.email, accountStore.token)
            }
            r.onSuccess { (user, hasPw) ->
                _ui.update { it.copy(wasedaUser = user, wasedaHasPassword = hasPw) }
            }
        }
    }

    /** Waseda の ID・パスワードをサーバーに保存する（各ユーザー自身のアカウントに紐付く）。 */
    fun saveWaseda(wasedaUser: String, wasedaPassword: String) {
        if (!accountStore.loggedIn || _ui.value.wasedaBusy) return
        _ui.update { it.copy(wasedaBusy = true, wasedaMessage = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.saveWaseda(
                    accountStore.baseUrl, accountStore.email, accountStore.token,
                    wasedaUser.trim(), wasedaPassword
                )
            }
            _ui.update {
                when (result) {
                    is AiHelperClient.Result.Ok -> it.copy(
                        wasedaBusy = false, wasedaMessage = "保存しました",
                        wasedaUser = wasedaUser.trim(),
                        wasedaHasPassword = it.wasedaHasPassword || wasedaPassword.isNotEmpty(),
                    )
                    is AiHelperClient.Result.Error ->
                        it.copy(wasedaBusy = false, wasedaMessage = result.message)
                }
            }
        }
    }

    /**
     * Waseda 時間割の取り込みをサーバーで実行し、完了までステータスをポーリングして表示する。
     * スクレイパのログイン〜取得は数分かかることがある。
     */
    fun syncWaseda() {
        if (!accountStore.loggedIn || _ui.value.wasedaSyncRunning) return
        _ui.update { it.copy(wasedaSyncRunning = true, wasedaSyncMessage = "取り込みを開始しています…") }
        viewModelScope.launch {
            val start = withContext(Dispatchers.IO) {
                AIHelper.startWasedaSync(accountStore.baseUrl, accountStore.email, accountStore.token)
            }
            if (start is AiHelperClient.Result.Error && !start.message.contains("実行中")) {
                _ui.update { it.copy(wasedaSyncRunning = false, wasedaSyncMessage = start.message) }
                return@launch
            }
            // 3秒間隔で最長15分ポーリング。
            repeat(300) {
                kotlinx.coroutines.delay(3_000)
                val status = withContext(Dispatchers.IO) {
                    AIHelper.fetchWasedaSyncStatus(accountStore.baseUrl, accountStore.email, accountStore.token)
                }.getOrNull() ?: return@repeat
                val (state, message) = status
                if (state == "running") {
                    _ui.update { it.copy(wasedaSyncMessage = message.ifBlank { "取り込み中…" }) }
                } else {
                    _ui.update { it.copy(wasedaSyncRunning = false, wasedaSyncMessage = message) }
                    if (state == "done") loadTasks()
                    return@launch
                }
            }
            _ui.update { it.copy(wasedaSyncRunning = false, wasedaSyncMessage = "取り込みの完了を確認できませんでした") }
        }
    }

    /** Moodle の iCal URL を取得。 */
    fun loadMoodle() {
        if (!accountStore.loggedIn) return
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) {
                AIHelper.fetchMoodleUrl(accountStore.baseUrl, accountStore.email, accountStore.token)
            }
            r.onSuccess { u -> _ui.update { it.copy(moodleUrl = u) } }
        }
    }

    /** Moodle の iCal URL を保存。 */
    fun saveMoodleUrl(url: String) {
        if (!accountStore.loggedIn) return
        _ui.update { it.copy(moodleBusy = true, moodleMessage = null, moodleUrl = url) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.saveMoodleUrl(accountStore.baseUrl, accountStore.email, accountStore.token, url.trim())
            }
            _ui.update {
                when (result) {
                    is AiHelperClient.Result.Ok -> it.copy(moodleBusy = false, moodleMessage = "保存しました")
                    is AiHelperClient.Result.Error -> it.copy(moodleBusy = false, moodleMessage = result.message)
                }
            }
        }
    }

    /** Moodle をいま同期して課題・予定を取り込む。 */
    fun syncMoodle() {
        if (!accountStore.loggedIn || _ui.value.moodleBusy) return
        _ui.update { it.copy(moodleBusy = true, moodleMessage = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                AIHelper.syncMoodle(accountStore.baseUrl, accountStore.email, accountStore.token)
            }
            result.fold(
                onSuccess = { n ->
                    _ui.update { it.copy(moodleBusy = false, moodleMessage = "$n 件取り込みました") }
                    loadTasks()
                },
                onFailure = { e ->
                    _ui.update { it.copy(moodleBusy = false, moodleMessage = "同期失敗: ${e.message}") }
                }
            )
        }
    }

    /** 連携中の全アカウントから直近の予定を読み込み、開始時刻順にまとめて表示する。 */
    fun loadCalendar() {
        val app = getApplication<Application>()
        val emails = googleStore.emails
        if (emails.isEmpty()) return
        _ui.update { it.copy(googleBusy = true, googleMessage = null) }
        viewModelScope.launch {
            val all = mutableListOf<CalendarEvent>()
            var consent: android.content.Intent? = null
            var error: String? = null
            withContext(Dispatchers.IO) {
                for (email in emails) {
                    try {
                        val token = GoogleCalendarClient.accessToken(app, email)
                        val events = GoogleCalendarClient.listUpcomingEvents(token).getOrThrow()
                        all += events.map { it.copy(accountEmail = email) }
                    } catch (e: com.google.android.gms.auth.UserRecoverableAuthException) {
                        // このアカウントの初回利用許可が必要。同意画面の Intent を UI に渡して起動してもらう。
                        consent = e.intent
                        error = "$email のカレンダー利用許可が必要です"
                    } catch (e: Exception) {
                        error = "$email: ${e.message}"
                    }
                }
            }
            
            // サーバーにもカレンダー予定を同期する
            if (all.isNotEmpty()) {
                withContext(Dispatchers.IO) {
                    AIHelper.syncCalendar(
                        accountStore.baseUrl,
                        accountStore.email,
                        accountStore.token,
                        all
                    )
                }
            }
            
            _ui.update {
                it.copy(
                    calendarEvents = all.sortedBy { ev -> ev.startMillis },
                    googleBusy = false,
                    googleMessage = error,
                    googleConsentIntent = consent,
                )
            }
        }
    }

    /** 課題・予定の締切を「既定」の Google アカウントのカレンダーに登録する。 */
    fun addTaskToCalendar(task: AiHelperClient.Task) {
        val app = getApplication<Application>()
        val email = googleStore.defaultEmail
        if (email.isBlank()) {
            _ui.update { it.copy(googleMessage = "先に Google 連携してください") }
            return
        }
        _ui.update { it.copy(googleBusy = true, googleMessage = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val token = GoogleCalendarClient.accessToken(app, email)
                    GoogleCalendarClient.insertDeadline(token, task.content, task.deadline, task.dateOnly).getOrThrow()
                }
            }
            result.fold(
                onSuccess = {
                    _ui.update {
                        it.copy(googleBusy = false, googleMessage = "「${task.content}」を $email のカレンダーに登録しました")
                    }
                    loadCalendar()
                },
                onFailure = { e ->
                    if (e is com.google.android.gms.auth.UserRecoverableAuthException) {
                        _ui.update {
                            it.copy(
                                googleBusy = false,
                                googleMessage = "$email のカレンダー利用許可が必要です",
                                googleConsentIntent = e.intent,
                            )
                        }
                    } else {
                        _ui.update { it.copy(googleBusy = false, googleMessage = "登録失敗: ${e.message}") }
                    }
                }
            )
        }
    }

    private fun currentAccount() = AccountState(
        loggedIn = accountStore.loggedIn,
        baseUrl = accountStore.baseUrl,
        email = accountStore.email,
    )
}
