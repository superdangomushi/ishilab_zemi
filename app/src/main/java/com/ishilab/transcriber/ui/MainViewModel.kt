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
    val chatLog: List<ChatMessage> = emptyList(),
    val askInProgress: Boolean = false,
    val tasks: List<AiHelperClient.Task> = emptyList(),
    val tasksLoading: Boolean = false,
    val tasksError: String? = null,
    val showDoneTasks: Boolean = false,
    val summary: String? = null,
    val summaryLoading: Boolean = false,
    val summaryError: String? = null,
    // Google カレンダー連携
    val googleEmail: String? = null,
    val calendarEvents: List<CalendarEvent> = emptyList(),
    val googleBusy: Boolean = false,
    val googleMessage: String? = null,
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
    val googleConnected: Boolean get() = googleEmail != null
}

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val modelManager = ModelManager(app)
    private val accountStore = AccountStore(app)
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
                summary = null, summaryError = null
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
            if (result.isSuccess) loadTasks()
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

    // ---- Google カレンダー連携 ----

    /**
     * Google サインイン画面の結果を処理する。失敗理由（SHA-1 未登録の DEVELOPER_ERROR 等）を
     * 握りつぶさず googleMessage に出す。成功時はアカウントを反映して予定を読み込む。
     */
    fun onGoogleSignInResult(data: android.content.Intent?) {
        try {
            val account = GoogleSignIn.getSignedInAccountFromIntent(data)
                .getResult(com.google.android.gms.common.api.ApiException::class.java)
            _ui.update { it.copy(googleEmail = account.email, googleMessage = null) }
            refreshGoogle()
        } catch (e: com.google.android.gms.common.api.ApiException) {
            val hint = when (e.statusCode) {
                com.google.android.gms.common.api.CommonStatusCodes.DEVELOPER_ERROR ->
                    "設定エラー(10): Google Cloud Console にこのアプリの OAuth クライアント" +
                        "（パッケージ名と SHA-1）が登録されていません"
                com.google.android.gms.common.api.CommonStatusCodes.NETWORK_ERROR ->
                    "ネットワークエラー。通信環境を確認してください"
                com.google.android.gms.common.api.CommonStatusCodes.SIGN_IN_REQUIRED, 12501 ->
                    "サインインがキャンセルされました"
                else -> "サインイン失敗 (コード ${e.statusCode})"
            }
            _ui.update { it.copy(googleMessage = hint) }
        }
    }

    /** サインイン済みアカウントを反映（サインイン結果後・起動時に呼ぶ）。 */
    fun refreshGoogle() {
        val acc = GoogleSignIn.getLastSignedInAccount(getApplication())
        _ui.update { it.copy(googleEmail = acc?.email) }
        if (acc != null) {
            loadCalendar()
            // サーバーのアカウントにも Google メールを紐付ける（ログイン済みのときだけ）。
            val gEmail = acc.email
            if (accountStore.loggedIn && !gEmail.isNullOrBlank()) {
                viewModelScope.launch {
                    withContext(Dispatchers.IO) {
                        AIHelper.linkGoogle(accountStore.baseUrl, accountStore.email, accountStore.token, gEmail)
                    }
                }
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

    fun onGoogleDisconnected() {
        _ui.update { it.copy(googleEmail = null, calendarEvents = emptyList(), googleMessage = null) }
    }

    /** 直近の予定を読み込む。 */
    fun loadCalendar() {
        val app = getApplication<Application>()
        val acc = GoogleSignIn.getLastSignedInAccount(app) ?: return
        _ui.update { it.copy(googleBusy = true, googleMessage = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val token = GoogleCalendarClient.accessToken(app, acc)
                    GoogleCalendarClient.listUpcomingEvents(token).getOrThrow()
                }
            }
            result.fold(
                onSuccess = { list -> _ui.update { it.copy(calendarEvents = list, googleBusy = false) } },
                onFailure = { e ->
                    _ui.update { it.copy(googleBusy = false, googleMessage = "カレンダー取得失敗: ${e.message}") }
                }
            )
        }
    }

    /** 課題・予定の締切を Google カレンダーに登録する。 */
    fun addTaskToCalendar(task: AiHelperClient.Task) {
        val app = getApplication<Application>()
        val acc = GoogleSignIn.getLastSignedInAccount(app)
        if (acc == null) {
            _ui.update { it.copy(googleMessage = "先に Google 連携してください") }
            return
        }
        _ui.update { it.copy(googleBusy = true, googleMessage = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val token = GoogleCalendarClient.accessToken(app, acc)
                    GoogleCalendarClient.insertDeadline(token, task.content, task.deadline, task.dateOnly).getOrThrow()
                }
            }
            result.fold(
                onSuccess = {
                    _ui.update { it.copy(googleBusy = false, googleMessage = "「${task.content}」をカレンダーに登録しました") }
                    loadCalendar()
                },
                onFailure = { e ->
                    _ui.update { it.copy(googleBusy = false, googleMessage = "登録失敗: ${e.message}") }
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
