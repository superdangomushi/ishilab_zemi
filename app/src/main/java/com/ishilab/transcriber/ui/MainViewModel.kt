package com.ishilab.transcriber.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ishilab.transcriber.model.ModelManager
import com.ishilab.transcriber.model.WhisperModel
import com.ishilab.transcriber.net.AccountStore
import com.ishilab.transcriber.net.MoneybotClient
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

/** moneybot.jp のログイン状態。 */
data class AccountState(
    val loggedIn: Boolean = false,
    val baseUrl: String = "https://moneybot.jp",
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
    val sendMessage: String? = null,
    val chatLog: List<ChatMessage> = emptyList(),
    val askInProgress: Boolean = false,
    val tasks: List<MoneybotClient.Task> = emptyList(),
    val tasksLoading: Boolean = false,
    val tasksError: String? = null,
    val showDoneTasks: Boolean = false,
    val summary: String? = null,
    val summaryLoading: Boolean = false,
    val summaryError: String? = null,
) {
    val anyModelReady: Boolean get() = downloadedModels.isNotEmpty()
}

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val modelManager = ModelManager(app)
    private val accountStore = AccountStore(app)
    private val moneybot = MoneybotClient()

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui

    init {
        _ui.update { it.copy(account = currentAccount()) }
        refresh()
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

    /** moneybot.jp にログイン。サーバーでアカウント情報＋トークンの一致を確認する。 */
    fun login(baseUrl: String, email: String, token: String) {
        if (_ui.value.loginInProgress) return
        val url = baseUrl.trim()
        val mail = email.trim()
        val tok = token.trim()
        if (url.isEmpty() || mail.isEmpty() || tok.isEmpty()) {
            _ui.update { it.copy(loginError = "URL・メール・トークンをすべて入力してください") }
            return
        }
        _ui.update { it.copy(loginInProgress = true, loginError = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { moneybot.login(url, mail, tok) }
            when (result) {
                is MoneybotClient.Result.Ok -> {
                    accountStore.save(url, mail, tok)
                    _ui.update {
                        it.copy(loginInProgress = false, loginError = null, account = currentAccount())
                    }
                    loadTasks()
                    loadSummary()
                }
                is MoneybotClient.Result.Error -> {
                    _ui.update { it.copy(loginInProgress = false, loginError = result.message) }
                }
            }
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
                moneybot.fetchSummary(accountStore.baseUrl, accountStore.email, accountStore.token)
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
                moneybot.generateSummary(accountStore.baseUrl, accountStore.email, accountStore.token)
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
                moneybot.fetchTasks(
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
    fun toggleTaskDone(task: MoneybotClient.Task) {
        if (!accountStore.loggedIn) return
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                moneybot.setTaskDone(
                    accountStore.baseUrl, accountStore.email, accountStore.token,
                    task.id, !task.done
                )
            }
            when (result) {
                is MoneybotClient.Result.Ok -> loadTasks()
                is MoneybotClient.Result.Error ->
                    _ui.update { it.copy(tasksError = result.message) }
            }
        }
    }

    /** 文字起こしファイルを moneybot.jp に送信する。ログイン中のアカウントで送る。 */
    fun sendToMoneybot(item: TranscriptItem) {
        if (!accountStore.loggedIn) {
            _ui.update { it.copy(sendMessage = "先に moneybot.jp にログインしてください") }
            return
        }
        if (_ui.value.sendingFile != null) return
        _ui.update { it.copy(sendingFile = item.name, sendMessage = null) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                moneybot.upload(
                    accountStore.baseUrl, accountStore.email, accountStore.token, File(item.path)
                )
            }
            val message = when (result) {
                is MoneybotClient.Result.Ok -> result.message
                is MoneybotClient.Result.Error -> "送信失敗: ${result.message}"
            }
            _ui.update { it.copy(sendingFile = null, sendMessage = message) }
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
                it.copy(chatLog = it.chatLog + ChatMessage("先に moneybot.jp にログインしてください", false))
            }
            return
        }
        _ui.update {
            it.copy(chatLog = it.chatLog + ChatMessage(q, true), askInProgress = true)
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                moneybot.ask(accountStore.baseUrl, accountStore.email, accountStore.token, q)
            }
            val reply = result.fold(
                onSuccess = { it.reply.ifBlank { "（応答なし）" } },
                onFailure = { "エラー: ${it.message ?: "通信に失敗しました"}" }
            )
            _ui.update {
                it.copy(chatLog = it.chatLog + ChatMessage(reply, false), askInProgress = false)
            }
            // 「予定入れといて」等でタスクが増減した可能性があるので一覧を更新。
            val applied = result.getOrNull()?.applied ?: 0
            if (applied > 0) loadTasks()
        }
    }

    private fun currentAccount() = AccountState(
        loggedIn = accountStore.loggedIn,
        baseUrl = accountStore.baseUrl,
        email = accountStore.email,
    )
}
