package com.ishilab.transcriber.net

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * AIHelper.jp とやり取りするためのクライアント。
 *
 * 追加ライブラリを増やさないため HttpURLConnection と org.json のみで実装する。
 * 通信はブロッキングなので必ずワーカースレッド（Dispatchers.IO）から呼ぶこと。
 */
class AiHelperClient {

    sealed interface Result {
        data class Ok(val message: String) : Result
        data class Error(val message: String) : Result
    }

    /** 秘書チャットの応答。reply は表示文、applied は実行された操作の件数。 */
    data class AskResult(val reply: String, val applied: Int)

    /** サーバーから取得したリマインド（端末でローカル通知として出す）。 */
    data class Reminder(val id: Long, val kind: String, val message: String)

    /** 課題/予定の1件。type は "kadai"(課題) / "yotei"(予定)。deadline は未定なら null。 */
    data class Task(
        val id: Long,
        val type: String,
        val content: String,
        val details: String,
        val deadline: String?,
        val dateOnly: Boolean,
        val done: Boolean,
    )

    /** Waseda から取り込んだ授業予定の1件。 */
    data class Course(
        val id: Long,
        val term: String,
        val day: String,
        val period: Int?,
        val name: String,
        val room: String,
        val startTime: String,
        val endTime: String,
    )

    /** サーバーに保存された文字起こし一覧の1件。 */
    data class ServerTranscript(
        val id: Long,
        val filename: String,
        val chars: Int,
        val updatedAt: String,
        val analyzed: Boolean,
    )

    /** サーバーに保存された文字起こし本文。 */
    data class ServerTranscriptDetail(
        val id: Long,
        val filename: String,
        val content: String,
        val summary: String,
        val updatedAt: String,
        val analyzed: Boolean,
    )

    /** サーバーに保存された秘書チャット履歴。role は "user" / "assistant"。 */
    data class ChatHistoryMessage(
        val role: String,
        val content: String,
        val createdAt: String,
    )

    /** 課題・予定の一覧を取得する。includeDone=true で完了済みも含める。 */
    fun fetchTasks(
        baseUrl: String, email: String, token: String, includeDone: Boolean,
    ): kotlin.Result<List<Task>> {
        val path = "/api/tasks?done=${if (includeDone) "1" else "0"}"
        val url = endpoint(baseUrl, path)
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                val arr = json.optJSONArray("tasks") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    Task(
                        id = o.optLong("id"),
                        type = o.optString("type"),
                        content = o.optString("content"),
                        details = o.optString("details"),
                        deadline = o.optString("deadline_at").ifBlank { null },
                        dateOnly = o.optInt("date_only", 0) == 1 || o.optBoolean("date_only", false),
                        done = o.optString("status") == "done",
                    )
                }
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** サーバーに保存された時間割を取得する。 */
    fun fetchCourses(baseUrl: String, email: String, token: String): kotlin.Result<List<Course>> {
        val path = "/api/courses"
        val url = endpoint(baseUrl, path)
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                val arr = json.optJSONArray("courses") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    Course(
                        id = o.optLong("id"),
                        term = o.optString("term"),
                        day = o.optString("day"),
                        period = if (o.isNull("period")) null else o.optInt("period"),
                        name = o.optString("name"),
                        room = o.optString("room"),
                        startTime = o.optString("start_time"),
                        endTime = o.optString("end_time"),
                    )
                }
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** サーバーに保存済みの文字起こし一覧を取得する。 */
    fun fetchServerTranscripts(
        baseUrl: String, email: String, token: String, limit: Int = 100,
    ): kotlin.Result<List<ServerTranscript>> {
        val path = "/api/transcripts?limit=$limit"
        val url = endpoint(baseUrl, path)
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                val arr = json.optJSONArray("transcripts") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    ServerTranscript(
                        id = o.optLong("id"),
                        filename = o.optString("filename"),
                        chars = o.optInt("chars"),
                        updatedAt = o.optString("updated_at"),
                        analyzed = !o.isNull("analyzed_at") && o.optString("analyzed_at").isNotBlank(),
                    )
                }
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** サーバーに保存済みの文字起こし本文を取得する。 */
    fun fetchServerTranscript(
        baseUrl: String, email: String, token: String, id: Long,
    ): kotlin.Result<ServerTranscriptDetail> {
        val path = "/api/transcripts/$id"
        val url = endpoint(baseUrl, path)
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                val o = json.getJSONObject("transcript")
                ServerTranscriptDetail(
                    id = o.optLong("id"),
                    filename = o.optString("filename"),
                    content = o.optString("content"),
                    summary = o.optString("summary"),
                    updatedAt = o.optString("updated_at"),
                    analyzed = !o.isNull("analyzed_at") && o.optString("analyzed_at").isNotBlank(),
                )
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** 今日の要約を取得する（未生成なら空文字）。 */
    fun fetchSummary(baseUrl: String, email: String, token: String): kotlin.Result<String> {
        val path = "/api/summary/today"
        val url = endpoint(baseUrl, path)
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                json.optString("summary")
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** 指定日(yyyy-MM-dd)の要約を取得する（未生成なら空文字）。 */
    fun fetchDaySummary(baseUrl: String, email: String, token: String, day: String): kotlin.Result<String> {
        val path = "/api/summary/$day"
        val url = endpoint(baseUrl, path)
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 15_000; readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) json.optString("summary")
            else throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
        }
    }

    /** 今日の要約をサーバー(Gemini)でいま生成し直す。生成された本文を返す。 */
    fun generateSummary(baseUrl: String, email: String, token: String): kotlin.Result<String> {
        val url = endpoint(baseUrl, "/api/summary/today/generate")
        val body = JSONObject().put("email", email).put("token", token).toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                json.optString("summary")
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** 課題・予定の完了/未完了を切り替える。 */
    fun setTaskDone(
        baseUrl: String, email: String, token: String, id: Long, done: Boolean,
    ): Result {
        val url = endpoint(baseUrl, "/api/tasks/$id/done")
        val body = JSONObject()
            .put("email", email).put("token", token)
            .put("status", if (done) "done" else "pending")
            .toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "更新しました")
        }.getOrElse { Result.Error(it.message ?: "更新に失敗しました") }
    }

    /** 課題・予定を編集する。deadline は空なら未定、日付のみなら date_only 扱いになる。 */
    fun updateTask(
        baseUrl: String, email: String, token: String, id: Long,
        type: String, content: String, details: String, deadline: String,
    ): Result {
        val url = endpoint(baseUrl, "/api/tasks/$id")
        val body = JSONObject()
            .put("email", email).put("token", token)
            .put("type", if (type == "yotei") "yotei" else "kadai")
            .put("content", content)
            .put("details", details)
            .put("deadline", deadline)
            .toString()
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "PATCH"
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 30_000
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "保存しました")
        }.getOrElse { Result.Error(it.message ?: "保存に失敗しました") }
    }

    /** 課題・予定を削除する。 */
    fun deleteTask(baseUrl: String, email: String, token: String, id: Long): Result {
        val url = endpoint(baseUrl, "/api/tasks/$id")
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "DELETE"
                connectTimeout = 15_000
                readTimeout = 30_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            readResult(conn, onOk = "削除しました")
        }.getOrElse { Result.Error(it.message ?: "削除に失敗しました") }
    }

    /** Moodle の iCal URL を取得する。 */
    fun fetchMoodleUrl(baseUrl: String, email: String, token: String): kotlin.Result<String> {
        val url = endpoint(baseUrl, "/api/moodle")
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 15_000; readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) json.optString("url")
            else throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
        }
    }

    /** Moodle の iCal URL を保存する。 */
    fun saveMoodleUrl(baseUrl: String, email: String, token: String, moodleUrl: String): Result {
        val url = endpoint(baseUrl, "/api/moodle")
        val body = JSONObject().put("email", email).put("token", token).put("url", moodleUrl).toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "保存しました")
        }.getOrElse { Result.Error(it.message ?: "保存に失敗しました") }
    }

    /** 音声認識クオリティ（"light"/"standard"/"high"）を取得する。 */
    fun fetchSttQuality(baseUrl: String, email: String, token: String): kotlin.Result<String> {
        val url = endpoint(baseUrl, "/api/stt-quality")
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 15_000; readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) json.optString("quality").ifBlank { "high" }
            else throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
        }
    }

    /** 音声認識クオリティを保存する。 */
    fun saveSttQuality(baseUrl: String, email: String, token: String, quality: String): Result {
        val url = endpoint(baseUrl, "/api/stt-quality")
        val body = JSONObject().put("email", email).put("token", token).put("quality", quality).toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "保存しました")
        }.getOrElse { Result.Error(it.message ?: "保存に失敗しました") }
    }

    /** Moodle をいま同期し、取り込んだ件数を返す。 */
    fun syncMoodle(baseUrl: String, email: String, token: String): kotlin.Result<Int> {
        val url = endpoint(baseUrl, "/api/moodle/sync")
        val body = JSONObject().put("email", email).put("token", token).toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) json.optInt("imported")
            else throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
        }
    }

    /** サーバーに保存済みの Waseda アカウント情報（ID と、パスワード保存の有無）を取得する。 */
    fun fetchWaseda(baseUrl: String, email: String, token: String): kotlin.Result<Pair<String, Boolean>> {
        val url = endpoint(baseUrl, "/api/waseda")
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 15_000; readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                json.optString("wasedaUser") to json.optBoolean("hasPassword")
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** Waseda の ID・パスワードをサーバーに保存する（パスワード空なら ID のみ更新）。 */
    fun saveWaseda(
        baseUrl: String, email: String, token: String,
        wasedaUser: String, wasedaPassword: String,
    ): Result {
        val url = endpoint(baseUrl, "/api/waseda")
        val body = JSONObject().put("email", email).put("token", token)
            .put("wasedaUser", wasedaUser).put("wasedaPassword", wasedaPassword)
            .toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "保存しました")
        }.getOrElse { Result.Error(it.message ?: "保存に失敗しました") }
    }

    /** Waseda 時間割の取り込みをサーバー側で開始する（スクレイパ実行。完了はステータスで確認）。 */
    fun startWasedaSync(baseUrl: String, email: String, token: String): Result {
        val url = endpoint(baseUrl, "/api/waseda/sync")
        val body = JSONObject().put("email", email).put("token", token).toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "取り込みを開始しました")
        }.getOrElse { Result.Error(it.message ?: "開始に失敗しました") }
    }

    /** Waseda 取り込みの進行状況。state は idle / running / done / error。 */
    fun fetchWasedaSyncStatus(baseUrl: String, email: String, token: String): kotlin.Result<Pair<String, String>> {
        val url = endpoint(baseUrl, "/api/waseda/sync/status")
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 15_000; readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                json.optString("state", "idle") to json.optString("message")
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** サインインした Google アカウントをサーバーのアカウントに紐付ける。 */
    fun linkGoogle(baseUrl: String, email: String, token: String, googleEmail: String): Result {
        val url = endpoint(baseUrl, "/api/google-link")
        val body = JSONObject().put("email", email).put("token", token)
            .put("googleEmail", googleEmail).toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "連携しました")
        }.getOrElse { Result.Error(it.message ?: "連携に失敗しました") }
    }

    /** メール＋パスワードでログインし、成功時は API 用トークンを返す（保存して以降の送信に使う）。 */
    fun login(baseUrl: String, email: String, password: String): kotlin.Result<String> =
        postCredentials(baseUrl, "/api/login", email, password)

    /** 新規登録し、成功時は API 用トークンを返す。 */
    fun register(baseUrl: String, email: String, password: String): kotlin.Result<String> =
        postCredentials(baseUrl, "/api/register", email, password)

    /** /api/login・/api/register 共通。{email,password} を送り、返ってきた token を取り出す。 */
    private fun postCredentials(
        baseUrl: String, path: String, email: String, password: String,
    ): kotlin.Result<String> {
        val url = endpoint(baseUrl, path)
        val body = JSONObject().put("email", email).put("password", password).toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                json.optString("token").ifBlank { throw RuntimeException("トークンが取得できませんでした") }
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** 文字起こしファイルを送信する。サーバー側で email＋トークンの一致を確認してから保存される。 */
    fun upload(baseUrl: String, email: String, token: String, file: File): Result {
        if (!file.exists()) return Result.Error("ファイルが見つかりません")
        val url = endpoint(baseUrl, "/api/upload")
        return runCatching {
            val conn = openPost(url, "text/plain; charset=utf-8").apply {
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("X-Account-Email", email)
                setRequestProperty("X-Filename", file.name)
            }
            conn.outputStream.use { out -> file.inputStream().use { it.copyTo(out) } }
            readResult(conn, onOk = "${file.name} を送信しました")
        }.getOrElse { Result.Error(it.message ?: "送信に失敗しました") }
    }

    /**
     * 録音した PCM16(16kHz/mono) の区間ファイルを WAV としてサーバーへアップロードし、
     * サーバー側の文字起こしジョブに登録する。成功時はジョブ ID を返す。
     * WAV ヘッダ(44バイト)＋PCM をストリーミング送信するので RAM を圧迫しない。
     */
    fun uploadAudioPcm(
        baseUrl: String, email: String, token: String,
        pcmFile: File, uploadName: String, sampleRate: Int,
    ): kotlin.Result<Long> {
        if (!pcmFile.exists()) return kotlin.Result.failure(RuntimeException("音声ファイルが見つかりません"))
        val url = endpoint(baseUrl, "/api/audio")
        val pcmBytes = pcmFile.length()
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 20_000
                readTimeout = 120_000
                setFixedLengthStreamingMode(44L + pcmBytes)
                setRequestProperty("Content-Type", "audio/wav")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("X-Account-Email", email)
                setRequestProperty("X-Filename", uploadName)
            }
            conn.outputStream.use { out ->
                out.write(wavHeader(pcmBytes, sampleRate))
                pcmFile.inputStream().use { it.copyTo(out, 1 shl 16) }
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) json.optLong("jobId")
            else throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
        }
    }

    /** PCM16/mono 用の WAV(RIFF) ヘッダ 44 バイトを組み立てる。 */
    private fun wavHeader(pcmBytes: Long, sampleRate: Int): ByteArray {
        val byteRate = sampleRate * 2
        val dataLen = pcmBytes.toInt()
        val buf = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray()); buf.putInt(36 + dataLen); buf.put("WAVE".toByteArray())
        buf.put("fmt ".toByteArray()); buf.putInt(16)
        buf.putShort(1)                 // PCM
        buf.putShort(1)                 // mono
        buf.putInt(sampleRate)
        buf.putInt(byteRate)
        buf.putShort(2)                 // block align
        buf.putShort(16)                // bits per sample
        buf.put("data".toByteArray()); buf.putInt(dataLen)
        return buf.array()
    }

    /** カレンダーの予定をサーバーに同期する。 */
    fun syncCalendar(
        baseUrl: String, email: String, token: String,
        events: List<com.ishilab.transcriber.google.CalendarEvent>
    ): Result {
        val url = endpoint(baseUrl, "/api/calendar/sync")
        val arr = JSONArray().apply {
            events.forEach { ev ->
                put(JSONObject()
                    .put("title", ev.title)
                    .put("whenText", ev.whenText)
                    .put("startMillis", ev.startMillis)
                )
            }
        }
        val body = JSONObject()
            .put("email", email)
            .put("token", token)
            .put("events", arr)
            .toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "同期完了")
        }.getOrElse { Result.Error(it.message ?: "同期に失敗しました") }
    }

    /**
     * 秘書チャット。質問への回答や、「予定入れといて」等の依頼の実行をサーバー（Gemini）に任せる。
     * 成功すると回答文と実行件数を返す。
     */
    fun ask(
        baseUrl: String, email: String, token: String, question: String,
        calendar: List<Pair<String, String>> = emptyList(),
    ): kotlin.Result<AskResult> {
        val url = endpoint(baseUrl, "/api/ask")
        val calArr = JSONArray().apply {
            calendar.forEach { (whenText, title) ->
                put(JSONObject().put("whenText", whenText).put("title", title))
            }
        }
        val body = JSONObject()
            .put("email", email).put("token", token).put("question", question)
            .put("calendar", calArr)
            .toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                AskResult(json.optString("reply"), json.optJSONArray("applied")?.length() ?: 0)
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** サーバーに保存された秘書チャット履歴を取得する。 */
    fun fetchChatHistory(baseUrl: String, email: String, token: String): kotlin.Result<List<ChatHistoryMessage>> {
        val path = "/api/chat/history"
        val url = endpoint(baseUrl, path)
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            val json = JSONObject(text)
            if (code in 200..299 && json.optBoolean("ok")) {
                val arr = json.optJSONArray("messages") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    ChatHistoryMessage(
                        role = o.optString("role"),
                        content = o.optString("content"),
                        createdAt = o.optString("created_at"),
                    )
                }
            } else {
                throw RuntimeException(json.optString("error").ifBlank { "HTTP $code" })
            }
        }
    }

    /** 未取得のリマインドを取得する。ローカル通知として表示したら ackReminders で既読化する。 */
    fun fetchReminders(baseUrl: String, email: String, token: String): List<Reminder> {
        val url = endpoint(baseUrl, "/api/reminders")
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
                setAuth(email, token)
            }
            val (code, text) = readBody(conn)
            if (code !in 200..299) return@runCatching emptyList<Reminder>()
            val arr = JSONObject(text).optJSONArray("reminders") ?: JSONArray()
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Reminder(o.optLong("id"), o.optString("kind"), o.optString("message"))
            }
        }.getOrDefault(emptyList())
    }

    /** リマインドを既読（表示済み）にする。 */
    fun ackReminders(baseUrl: String, email: String, token: String, ids: List<Long>) {
        if (ids.isEmpty()) return
        val url = endpoint(baseUrl, "/api/reminders/ack")
        val arr = JSONArray().apply { ids.forEach { put(it) } }
        val body = JSONObject().put("email", email).put("token", token).put("ids", arr).toString()
        runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            conn.responseCode
            conn.disconnect()
        }
    }

    private fun openPost(url: URL, contentType: String): HttpURLConnection =
        (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("Content-Type", contentType)
            setRequestProperty("Accept", "application/json")
        }

    private fun HttpURLConnection.setAuth(email: String, token: String) {
        setRequestProperty("X-Account-Email", email)
        setRequestProperty("Authorization", "Bearer $token")
    }

    private fun readResult(conn: HttpURLConnection, onOk: String): Result {
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        conn.disconnect()
        if (code in 200..299) return Result.Ok(onOk)
        val serverMsg = runCatching { JSONObject(text).optString("error") }.getOrNull()
        return Result.Error(
            serverMsg?.takeIf { it.isNotBlank() } ?: "サーバーエラー (HTTP $code)"
        )
    }

    /** レスポンスコードと本文をまとめて読み取り、接続を閉じる。 */
    private fun readBody(conn: HttpURLConnection): Pair<Int, String> {
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        conn.disconnect()
        return code to text
    }

    private fun endpoint(baseUrl: String, path: String): URL =
        URL(baseUrl.trimEnd('/') + path)
}
