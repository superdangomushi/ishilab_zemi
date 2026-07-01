package com.ishilab.transcriber.net

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * moneybot.jp とやり取りするためのクライアント。
 *
 * 追加ライブラリを増やさないため HttpURLConnection と org.json のみで実装する。
 * 通信はブロッキングなので必ずワーカースレッド（Dispatchers.IO）から呼ぶこと。
 */
class MoneybotClient {

    sealed interface Result {
        data class Ok(val message: String) : Result
        data class Error(val message: String) : Result
    }

    /** 秘書チャットの応答。reply は表示文、applied は実行された操作の件数。 */
    data class AskResult(val reply: String, val applied: Int)

    /** サーバーから取得したリマインド（端末でローカル通知として出す）。 */
    data class Reminder(val id: Long, val kind: String, val message: String)

    /** ログイン照合。アプリで入力したアカウント情報＋トークンがサーバーと一致するか確認する。 */
    fun login(baseUrl: String, email: String, token: String): Result {
        val url = endpoint(baseUrl, "/api/login")
        val body = JSONObject().put("email", email).put("token", token).toString()
        return runCatching {
            val conn = openPost(url, "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            readResult(conn, onOk = "ログインしました")
        }.getOrElse { Result.Error(it.message ?: "通信に失敗しました") }
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
     * 秘書チャット。質問への回答や、「予定入れといて」等の依頼の実行をサーバー（Gemini）に任せる。
     * 成功すると回答文と実行件数を返す。
     */
    fun ask(baseUrl: String, email: String, token: String, question: String): kotlin.Result<AskResult> {
        val url = endpoint(baseUrl, "/api/ask")
        val body = JSONObject().put("email", email).put("token", token).put("question", question).toString()
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

    /** 未取得のリマインドを取得する。ローカル通知として表示したら ackReminders で既読化する。 */
    fun fetchReminders(baseUrl: String, email: String, token: String): List<Reminder> {
        val url = endpoint(baseUrl, "/api/reminders?email=${enc(email)}&token=${enc(token)}")
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Accept", "application/json")
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

    private fun enc(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8")

    private fun endpoint(baseUrl: String, path: String): URL =
        URL(baseUrl.trimEnd('/') + path)
}
