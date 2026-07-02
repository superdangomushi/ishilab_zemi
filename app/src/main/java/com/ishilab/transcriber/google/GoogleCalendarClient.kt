package com.ishilab.transcriber.google

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import com.google.android.gms.auth.GoogleAuthUtil
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Google カレンダーの予定1件（表示用）。accountEmail はどの連携アカウント由来か。 */
data class CalendarEvent(
    val title: String,
    val whenText: String,
    val startMillis: Long,
    val accountEmail: String = "",
    /** 終了日時 "yyyy-MM-dd HH:mm"。終日予定など終了時刻がないときは空。 */
    val endText: String = "",
)

/**
 * 端末の Google アカウント（複数可）を使って Google Calendar を読み書きする。
 * 重い公式クライアントは使わず、アクセストークン＋Calendar v3 REST を直接叩く。
 * 通信はブロッキングなので必ず IO スレッドから呼ぶこと。
 */
object GoogleCalendarClient {

    // 予定の読み書きに必要なスコープ。
    const val SCOPE = "https://www.googleapis.com/auth/calendar.events"
    private const val API = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

    /** 端末の Google アカウントを1つ選ばせるシステムのアカウント選択画面。何度でも呼べる。 */
    fun chooseAccountIntent(): Intent =
        AccountManager.newChooseAccountIntent(
            null, null, arrayOf("com.google"), null, null, null, null
        )

    /**
     * 指定メールの Google アカウントの OAuth アクセストークンを取得する（ブロッキング）。
     * そのアカウントで初回利用時は UserRecoverableAuthException が投げられるので、
     * 呼び出し側で e.intent を起動して利用許可をもらってから再試行する。
     */
    fun accessToken(context: Context, email: String): String =
        GoogleAuthUtil.getToken(context, Account(email, "com.google"), "oauth2:$SCOPE")

    /** 直近の予定を取得する。 */
    fun listUpcomingEvents(token: String, max: Int = 20): kotlin.Result<List<CalendarEvent>> {
        val nowRfc = rfc3339(System.currentTimeMillis())
        val url = URL("$API?timeMin=${enc(nowRfc)}&maxResults=$max&singleEvents=true&orderBy=startTime")
        return runCatching {
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Accept", "application/json")
            }
            val (code, text) = readBody(conn)
            if (code !in 200..299) throw RuntimeException(errorOf(text, code))
            val arr = JSONObject(text).optJSONArray("items") ?: JSONArray()
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                val start = o.optJSONObject("start")
                val dt = start?.optString("dateTime")?.ifBlank { null }
                val d = start?.optString("date")?.ifBlank { null }
                val whenText = dt?.replace('T', ' ')?.take(16) ?: (d ?: "")
                val ms = parseMillis(dt ?: d)
                val endDt = o.optJSONObject("end")?.optString("dateTime")?.ifBlank { null }
                val endText = endDt?.replace('T', ' ')?.take(16) ?: ""
                CalendarEvent(o.optString("summary", "(無題)"), whenText, ms, endText = endText)
            }.sortedBy { it.startMillis }
        }
    }

    /**
     * 締切をカレンダーに登録する。deadline は "yyyy-MM-dd HH:mm[:ss]" または ISO。
     * dateOnly のときは終日予定、それ以外は締切時刻の30分イベントにする。
     */
    fun insertDeadline(
        token: String, title: String, deadline: String?, dateOnly: Boolean,
    ): kotlin.Result<Unit> {
        return runCatching {
            val body = JSONObject().put("summary", title)
            val at = parseMillis(deadline)
            if (deadline.isNullOrBlank() || at == 0L) {
                throw RuntimeException("期限が未設定のためカレンダーに登録できません")
            }
            if (dateOnly) {
                // 終日予定の end.date は排他的（翌日）を指定する。同日だと API が 400 を返す。
                body.put("start", JSONObject().put("date", dayString(at)))
                body.put("end", JSONObject().put("date", dayString(at + 24 * 3600_000L)))
            } else {
                body.put("start", JSONObject().put("dateTime", rfc3339(at - 30 * 60_000)))
                body.put("end", JSONObject().put("dateTime", rfc3339(at)))
            }
            val conn = (URL(API).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 20_000
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val (code, text) = readBody(conn)
            if (code !in 200..299) throw RuntimeException(errorOf(text, code))
            Unit
        }
    }

    // ---- helpers ----
    private fun readBody(conn: HttpURLConnection): Pair<Int, String> {
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        conn.disconnect()
        return code to text
    }

    private fun errorOf(text: String, code: Int): String =
        runCatching { JSONObject(text).optJSONObject("error")?.optString("message") }
            .getOrNull()?.takeIf { it.isNotBlank() } ?: "HTTP $code"

    private fun rfc3339(millis: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date(millis))

    private fun dayString(millis: Long): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(millis))

    /** サーバー由来の日時文字列を millis に。解釈できなければ 0。 */
    private fun parseMillis(s: String?): Long {
        if (s.isNullOrBlank()) return 0L
        val norm = s.replace('T', ' ')
        for (pat in arrayOf("yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd")) {
            runCatching {
                return SimpleDateFormat(pat, Locale.US).parse(norm.take(pat.length))!!.time
            }
        }
        return 0L
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")
}
