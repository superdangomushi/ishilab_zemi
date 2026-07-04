package com.ishilab.transcriber.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.ishilab.transcriber.audio.AudioChunker
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 文字起こしファイル/音声 outbox の「サーバー送信（成功するまでリトライ）」と、
 * サーバーからの「リマインドのローカル通知」を担う。
 *
 * 送信ポリシー:
 *  - 完了した文字起こしファイル（＝現在書き込み中の時刻ファイル以外）だけを送る。
 *  - 送信に成功した文字起こしファイル名は永続化し、二度送らない（サーバーは冪等だが無駄を省く）。
 *  - 音声アップロードに失敗して audio-outbox に退避された PCM は、成功したら削除する。
 *  - 失敗したものは [INTERVAL_MS]（5分）ごと、または [triggerNow] で即時に再送を試みる。
 *
 * ログイン済みのときだけ実働する。通信はブロッキングなので専用スレッドで回す。
 */
class BackgroundSync(private val context: Context) {

    private val accountStore = AccountStore(context)
    private val client = AiHelperClient()
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val lock = Object()
    @Volatile private var thread: Thread? = null
    @Volatile private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val running = AtomicBoolean(false)

    /** 現在書き込み中の時刻ファイル名。これは「未完了」として送らない。null なら全て送る。 */
    @Volatile private var currentHourFile: String? = null

    /** 送信すべきファイルが全て送れたときに呼ばれる（終了処理のドレイン判定に使う）。 */
    @Volatile var onAllSent: (() -> Unit)? = null

    fun start() {
        if (running.getAndSet(true)) return
        ensureChannel()
        registerNetworkCallback()
        thread = Thread({ loop() }, "AIHelper-sync").also { it.start() }
        Log.i(TAG, "background sync started")
    }

    fun stop() {
        running.set(false)
        unregisterNetworkCallback()
        synchronized(lock) { lock.notifyAll() }
        thread = null
    }

    /** 書き込み中ファイルを更新。null を渡すと全ファイルが送信対象になる（終了時など）。 */
    fun setCurrentHourFile(name: String?) {
        currentHourFile = name
    }

    /** すぐに送信パスを走らせる（時刻ファイルの切り替わりや終了時に呼ぶ）。 */
    fun triggerNow() {
        synchronized(lock) { lock.notifyAll() }
    }

    private fun loop() {
        while (running.get()) {
            try {
                if (accountStore.loggedIn) {
                    uploadPending()
                    uploadPendingAudio()
                    pollReminders()
                    syncCalendar()
                }
                // 送信対象が残っていなければドレイン完了を通知（未ログインも「これ以上送れない」扱い）。
                if (!accountStore.loggedIn || pendingCount() == 0) {
                    onAllSent?.invoke()
                }
            } catch (e: Exception) {
                Log.w(TAG, "sync cycle error: ${e.message}")
            }
            synchronized(lock) {
                if (running.get()) {
                    try {
                        lock.wait(INTERVAL_MS)
                    } catch (_: InterruptedException) {
                    }
                }
            }
        }
        Log.i(TAG, "background sync stopped")
    }

    private fun transcriptFiles(): List<File> {
        val dir = File(context.filesDir, "transcripts")
        return dir.listFiles { f -> f.isFile && f.name.endsWith(".txt") }?.toList() ?: emptyList()
    }

    private fun audioOutboxFiles(): List<File> {
        val dir = File(context.filesDir, "audio-outbox")
        return dir.listFiles { f -> f.isFile && f.name.endsWith(".pcm") }?.toList() ?: emptyList()
    }

    /** まだ送っていない「完了ファイル/退避音声」の数。 */
    fun pendingCount(): Int {
        val sent = sentSet()
        val skip = currentHourFile
        val textPending = transcriptFiles().count { it.name != skip && it.name !in sent }
        return textPending + audioOutboxFiles().size
    }

    /** 未送信の完了ファイルを送る。成功したら送信済みとして記録。 */
    private fun uploadPending() {
        val sent = sentSet().toMutableSet()
        val skip = currentHourFile
        var uploaded = 0
        for (file in transcriptFiles().sortedBy { it.name }) {
            if (file.name == skip || file.name in sent) continue
            when (client.upload(accountStore.baseUrl, accountStore.email, accountStore.token, file)) {
                is AiHelperClient.Result.Ok -> {
                    sent.add(file.name)
                    uploaded++
                }
                is AiHelperClient.Result.Error -> { /* 次のパスで再送される */ }
            }
        }
        if (uploaded > 0) {
            saveSentSet(sent)
            Log.i(TAG, "uploaded $uploaded file(s)")
        }
    }

    /** 未送信の退避音声を WAV として送る。成功したファイルから端末内 outbox から削除する。 */
    private fun uploadPendingAudio() {
        var uploaded = 0
        for (file in audioOutboxFiles().sortedBy { it.name }) {
            val result = client.uploadAudioPcm(
                accountStore.baseUrl,
                accountStore.email,
                accountStore.token,
                file,
                audioUploadName(file),
                AudioChunker.SAMPLE_RATE,
            )
            if (result.isSuccess) {
                if (file.delete()) uploaded++
            } else {
                Log.w(TAG, "audio outbox upload failed: ${result.exceptionOrNull()?.message}")
                break
            }
        }
        if (uploaded > 0) Log.i(TAG, "uploaded $uploaded audio outbox file(s)")
    }

    private fun audioUploadName(file: File): String {
        val millis = file.name.removePrefix("seg-").removeSuffix(".pcm").toLongOrNull()
            ?: file.lastModified()
        return SimpleDateFormat("yyyy-MM-dd_HH", Locale.JAPAN).format(Date(millis)) + ".wav"
    }

    private fun sentSet(): Set<String> =
        prefs.getStringSet(KEY_SENT, emptySet()) ?: emptySet()

    private fun saveSentSet(set: Set<String>) {
        // putStringSet は同じ参照を保持しうるため必ずコピーを渡す。
        prefs.edit().putStringSet(KEY_SENT, HashSet(set)).apply()
    }

    /** サーバーの未読リマインドをローカル通知として表示し、既読化する。 */
    private fun pollReminders() {
        ReminderNotifier.poll(context)
    }

    /** 端末の Google カレンダーから予定を読み取り、サーバーへ同期する。 */
    private fun syncCalendar() {
        try {
            val googleStore = com.ishilab.transcriber.google.GoogleAccountStore(context)
            val emails = googleStore.emails
            if (emails.isEmpty()) return
            val all = mutableListOf<com.ishilab.transcriber.google.CalendarEvent>()
            var loadedAnyAccount = false
            for (email in emails) {
                try {
                    val token = com.ishilab.transcriber.google.GoogleCalendarClient.accessToken(context, email)
                    val events = com.ishilab.transcriber.google.GoogleCalendarClient.listUpcomingEvents(token).getOrNull()
                    if (events != null) {
                        loadedAnyAccount = true
                        all += events.map { it.copy(accountEmail = email) }
                    }
                } catch (e: Exception) {
                    // Ignore auth exceptions in background
                }
            }
            if (loadedAnyAccount) {
                client.syncCalendar(accountStore.baseUrl, accountStore.email, accountStore.token, all)
            }
        } catch (e: Exception) {
            Log.w(TAG, "calendar sync error: ${e.message}")
        }
    }

    private fun ensureChannel() {
        ReminderNotifier.ensureChannel(context)
    }

    private fun registerNetworkCallback() {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                triggerNow()
            }
        }
        try {
            cm.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: Exception) {
            Log.w(TAG, "network callback registration failed: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        val callback = networkCallback ?: return
        networkCallback = null
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        try {
            cm.unregisterNetworkCallback(callback)
        } catch (_: Exception) {
        }
    }

    companion object {
        private const val TAG = "BackgroundSync"
        private const val PREFS = "sync_prefs"
        private const val KEY_SENT = "sent_files"
        // 再送の間隔（5分）。triggerNow でこの待機を打ち切って即時実行できる。
        private const val INTERVAL_MS = 5 * 60 * 1000L

        /**
         * 別アカウントでログインし直す前に呼ぶ。
         * 端末に残った未送信の文字起こし・退避音声は前アカウントの録音なので、
         * そのまま残すと新アカウントへアップロードされて他人のデータが混ざる。全て破棄する。
         */
        fun clearLocalPending(context: Context) {
            for (name in listOf("transcripts", "audio-outbox")) {
                File(context.filesDir, name).listFiles()?.forEach { it.delete() }
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().remove(KEY_SENT).apply()
            Log.i(TAG, "cleared local pending data (account switched)")
        }
    }
}
