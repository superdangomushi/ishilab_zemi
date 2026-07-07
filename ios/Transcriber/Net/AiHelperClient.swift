import Foundation

/// AIHelper.jp とやり取りするためのクライアント。
///
/// Android 版（HttpURLConnection + org.json）と同じくブロッキング実装なので、
/// 必ずワーカースレッド（Task.detached 等）から呼ぶこと。
final class AiHelperClient {

    enum OpResult {
        case ok(String)
        case error(String)
    }

    /// 秘書チャットの応答。reply は表示文、applied は実行された操作の件数。
    struct AskResult {
        let reply: String
        let applied: Int
    }

    /// サーバーから取得したリマインド（端末でローカル通知として出す）。
    struct Reminder {
        let id: Int64
        let kind: String
        let message: String
    }

    /// 課題/予定の1件。type は "kadai"(課題) / "yotei"(予定)。deadline は未定なら nil。
    struct Task: Identifiable, Equatable {
        let id: Int64
        let type: String
        let content: String
        let details: String
        let deadline: String?
        let dateOnly: Bool
        let done: Bool
    }

    /// Waseda から取り込んだ授業予定の1件。
    struct Course: Identifiable, Equatable {
        let id: Int64
        let term: String
        let day: String
        let period: Int?
        let name: String
        let room: String
        let startTime: String
        let endTime: String
    }

    /// サーバーに保存された文字起こし一覧の1件。
    struct ServerTranscript: Identifiable, Equatable {
        let id: Int64
        let filename: String
        let chars: Int
        let updatedAt: String
        let analyzed: Bool
    }

    /// サーバーに保存された文字起こし本文。
    struct ServerTranscriptDetail: Equatable {
        let id: Int64
        let filename: String
        let content: String
        let summary: String
        let updatedAt: String
        let analyzed: Bool
    }

    /// サーバーに保存された秘書チャット履歴。role は "user" / "assistant"。
    struct ChatHistoryMessage {
        let role: String
        let content: String
        let createdAt: String
    }

    struct ClientError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: - 取得系

    /// 課題・予定の一覧を取得する。includeDone=true で完了済みも含める。
    func fetchTasks(baseUrl: String, email: String, token: String, includeDone: Bool) -> Result<[Task], Error> {
        let path = "/api/tasks?done=\(includeDone ? "1" : "0")"
        return getJson(baseUrl, path, email: email, token: token).map { json in
            let arr = json["tasks"] as? [[String: Any]] ?? []
            return arr.map { o in
                Task(
                    id: int64(o["id"]),
                    type: str(o["type"]),
                    content: str(o["content"]),
                    details: str(o["details"]),
                    deadline: str(o["deadline_at"]).isEmpty ? nil : str(o["deadline_at"]),
                    dateOnly: int64(o["date_only"]) == 1 || (o["date_only"] as? Bool ?? false),
                    done: str(o["status"]) == "done"
                )
            }
        }
    }

    /// サーバーに保存された時間割を取得する。
    func fetchCourses(baseUrl: String, email: String, token: String) -> Result<[Course], Error> {
        let path = "/api/courses"
        return getJson(baseUrl, path, email: email, token: token).map { json in
            let arr = json["courses"] as? [[String: Any]] ?? []
            return arr.map { o in
                Course(
                    id: int64(o["id"]),
                    term: str(o["term"]),
                    day: str(o["day"]),
                    period: (o["period"] is NSNull || o["period"] == nil) ? nil : Int(int64(o["period"])),
                    name: str(o["name"]),
                    room: str(o["room"]),
                    startTime: str(o["start_time"]),
                    endTime: str(o["end_time"])
                )
            }
        }
    }

    /// サーバーに保存済みの文字起こし一覧を取得する。
    func fetchServerTranscripts(baseUrl: String, email: String, token: String, limit: Int = 100) -> Result<[ServerTranscript], Error> {
        let path = "/api/transcripts?limit=\(limit)"
        return getJson(baseUrl, path, email: email, token: token).map { json in
            let arr = json["transcripts"] as? [[String: Any]] ?? []
            return arr.map { o in
                ServerTranscript(
                    id: int64(o["id"]),
                    filename: str(o["filename"]),
                    chars: Int(int64(o["chars"])),
                    updatedAt: str(o["updated_at"]),
                    analyzed: !(o["analyzed_at"] is NSNull) && !str(o["analyzed_at"]).isEmpty
                )
            }
        }
    }

    /// サーバーに保存済みの文字起こし本文を取得する。
    func fetchServerTranscript(baseUrl: String, email: String, token: String, id: Int64) -> Result<ServerTranscriptDetail, Error> {
        let path = "/api/transcripts/\(id)"
        return getJson(baseUrl, path, email: email, token: token).flatMap { json in
            guard let o = json["transcript"] as? [String: Any] else {
                return .failure(ClientError(message: "本文取得に失敗しました"))
            }
            return .success(ServerTranscriptDetail(
                id: int64(o["id"]),
                filename: str(o["filename"]),
                content: str(o["content"]),
                summary: str(o["summary"]),
                updatedAt: str(o["updated_at"]),
                analyzed: !(o["analyzed_at"] is NSNull) && !str(o["analyzed_at"]).isEmpty
            ))
        }
    }

    /// 今日の要約を取得する（未生成なら空文字）。
    func fetchSummary(baseUrl: String, email: String, token: String) -> Result<String, Error> {
        getJson(baseUrl, "/api/summary/today", email: email, token: token)
            .map { str($0["summary"]) }
    }

    /// 指定日(yyyy-MM-dd)の要約を取得する（未生成なら空文字）。
    func fetchDaySummary(baseUrl: String, email: String, token: String, day: String) -> Result<String, Error> {
        getJson(baseUrl, "/api/summary/\(day)", email: email, token: token)
            .map { str($0["summary"]) }
    }

    /// 今日の要約をサーバー(Gemini)でいま生成し直す。生成された本文を返す。
    func generateSummary(baseUrl: String, email: String, token: String) -> Result<String, Error> {
        postJson(baseUrl, "/api/summary/today/generate", body: ["email": email, "token": token])
            .map { str($0["summary"]) }
    }

    // MARK: - 課題・予定の操作

    /// 課題・予定の完了/未完了を切り替える。
    func setTaskDone(baseUrl: String, email: String, token: String, id: Int64, done: Bool) -> OpResult {
        let body: [String: Any] = ["email": email, "token": token, "status": done ? "done" : "pending"]
        return opResult(postJson(baseUrl, "/api/tasks/\(id)/done", body: body), onOk: "更新しました")
    }

    /// 課題・予定を編集する。deadline は空なら未定、日付のみなら date_only 扱いになる。
    func updateTask(baseUrl: String, email: String, token: String, id: Int64,
                    type: String, content: String, details: String, deadline: String) -> OpResult {
        let body: [String: Any] = [
            "email": email, "token": token,
            "type": type == "yotei" ? "yotei" : "kadai",
            "content": content, "details": details, "deadline": deadline,
        ]
        return opResult(requestJson(baseUrl, "/api/tasks/\(id)", method: "PATCH", body: body), onOk: "保存しました")
    }

    /// 課題・予定を削除する。
    func deleteTask(baseUrl: String, email: String, token: String, id: Int64) -> OpResult {
        return opResult(requestJson(baseUrl, "/api/tasks/\(id)", method: "DELETE", body: nil, email: email, token: token), onOk: "削除しました")
    }

    // MARK: - Moodle / STT / Waseda / Google

    /// Moodle の iCal URL を取得する。
    func fetchMoodleUrl(baseUrl: String, email: String, token: String) -> Result<String, Error> {
        getJson(baseUrl, "/api/moodle", email: email, token: token).map { str($0["url"]) }
    }

    /// Moodle の iCal URL を保存する。
    func saveMoodleUrl(baseUrl: String, email: String, token: String, moodleUrl: String) -> OpResult {
        opResult(postJson(baseUrl, "/api/moodle", body: ["email": email, "token": token, "url": moodleUrl]),
                 onOk: "保存しました")
    }

    /// 音声認識クオリティ（"light"/"standard"/"high"）を取得する。
    func fetchSttQuality(baseUrl: String, email: String, token: String) -> Result<String, Error> {
        getJson(baseUrl, "/api/stt-quality", email: email, token: token)
            .map { let q = str($0["quality"]); return q.isEmpty ? "high" : q }
    }

    /// 音声認識クオリティを保存する。
    func saveSttQuality(baseUrl: String, email: String, token: String, quality: String) -> OpResult {
        opResult(postJson(baseUrl, "/api/stt-quality", body: ["email": email, "token": token, "quality": quality]),
                 onOk: "保存しました")
    }

    /// Moodle をいま同期し、取り込んだ件数を返す。
    func syncMoodle(baseUrl: String, email: String, token: String) -> Result<Int, Error> {
        postJson(baseUrl, "/api/moodle/sync", body: ["email": email, "token": token])
            .map { Int(int64($0["imported"])) }
    }

    /// サーバーに保存済みの Waseda アカウント情報（ID と、パスワード保存の有無）を取得する。
    func fetchWaseda(baseUrl: String, email: String, token: String) -> Result<(String, Bool), Error> {
        getJson(baseUrl, "/api/waseda", email: email, token: token)
            .map { (str($0["wasedaUser"]), $0["hasPassword"] as? Bool ?? false) }
    }

    /// Waseda の ID・パスワードをサーバーに保存する（パスワード空なら ID のみ更新）。
    func saveWaseda(baseUrl: String, email: String, token: String,
                    wasedaUser: String, wasedaPassword: String) -> OpResult {
        let body: [String: Any] = ["email": email, "token": token,
                                   "wasedaUser": wasedaUser, "wasedaPassword": wasedaPassword]
        return opResult(postJson(baseUrl, "/api/waseda", body: body), onOk: "保存しました")
    }

    /// Waseda 時間割の取り込みをサーバー側で開始する（スクレイパ実行。完了はステータスで確認）。
    func startWasedaSync(baseUrl: String, email: String, token: String) -> OpResult {
        opResult(postJson(baseUrl, "/api/waseda/sync", body: ["email": email, "token": token]),
                 onOk: "取り込みを開始しました")
    }

    /// Waseda 取り込みの進行状況。state は idle / running / done / error。
    func fetchWasedaSyncStatus(baseUrl: String, email: String, token: String) -> Result<(String, String), Error> {
        getJson(baseUrl, "/api/waseda/sync/status", email: email, token: token)
            .map { (str($0["state"]).isEmpty ? "idle" : str($0["state"]), str($0["message"])) }
    }

    /// サインインした Google アカウントをサーバーのアカウントに紐付ける。
    func linkGoogle(baseUrl: String, email: String, token: String, googleEmail: String) -> OpResult {
        let body: [String: Any] = ["email": email, "token": token, "googleEmail": googleEmail]
        return opResult(postJson(baseUrl, "/api/google-link", body: body), onOk: "連携しました")
    }

    // MARK: - 認証

    /// メール＋パスワードでログインし、成功時は API 用トークンを返す（保存して以降の送信に使う）。
    func login(baseUrl: String, email: String, password: String) -> Result<String, Error> {
        postCredentials(baseUrl, "/api/login", email: email, password: password)
    }

    /// 新規登録し、成功時は API 用トークンを返す。
    func register(baseUrl: String, email: String, password: String) -> Result<String, Error> {
        postCredentials(baseUrl, "/api/register", email: email, password: password)
    }

    private func postCredentials(_ baseUrl: String, _ path: String, email: String, password: String) -> Result<String, Error> {
        postJson(baseUrl, path, body: ["email": email, "password": password]).flatMap { json in
            let token = str(json["token"])
            if token.isEmpty { return .failure(ClientError(message: "トークンが取得できませんでした")) }
            return .success(token)
        }
    }

    // MARK: - アップロード

    /// 文字起こしファイルを送信する。サーバー側で email＋トークンの一致を確認してから保存される。
    func upload(baseUrl: String, email: String, token: String, file: URL) -> OpResult {
        guard FileManager.default.fileExists(atPath: file.path) else {
            return .error("ファイルが見つかりません")
        }
        guard let url = endpoint(baseUrl, "/api/upload"), let data = try? Data(contentsOf: file) else {
            return .error("ファイルの読み込みに失敗しました")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(email, forHTTPHeaderField: "X-Account-Email")
        request.setValue(file.lastPathComponent, forHTTPHeaderField: "X-Filename")
        request.httpBody = data
        let (code, body, error) = sync(request)
        if let error { return .error(error.localizedDescription) }
        if (200...299).contains(code) { return .ok("\(file.lastPathComponent) を送信しました") }
        return .error(serverError(body, code))
    }

    /// 録音した PCM16(16kHz/mono) の区間ファイルを WAV としてサーバーへアップロードし、
    /// サーバー側の文字起こしジョブに登録する。成功時はジョブ ID を返す。
    func uploadAudioPcm(baseUrl: String, email: String, token: String,
                        pcmFile: URL, uploadName: String, sampleRate: Int) -> Result<Int64, Error> {
        guard FileManager.default.fileExists(atPath: pcmFile.path) else {
            return .failure(ClientError(message: "音声ファイルが見つかりません"))
        }
        guard let url = endpoint(baseUrl, "/api/audio"),
              let pcmData = try? Data(contentsOf: pcmFile) else {
            return .failure(ClientError(message: "音声ファイルの読み込みに失敗しました"))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(email, forHTTPHeaderField: "X-Account-Email")
        request.setValue(uploadName, forHTTPHeaderField: "X-Filename")
        var body = wavHeader(pcmBytes: Int64(pcmData.count), sampleRate: sampleRate)
        body.append(pcmData)
        request.httpBody = body
        let (code, data, error) = sync(request)
        if let error { return .failure(error) }
        guard (200...299).contains(code), let json = parse(data), json["ok"] as? Bool == true else {
            return .failure(ClientError(message: serverError(data, code)))
        }
        return .success(int64(json["jobId"]))
    }

    /// PCM16/mono 用の WAV(RIFF) ヘッダ 44 バイトを組み立てる。
    private func wavHeader(pcmBytes: Int64, sampleRate: Int) -> Data {
        var data = Data(capacity: 44)
        func putU32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func putU16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        let dataLen = UInt32(truncatingIfNeeded: pcmBytes)
        data.append(contentsOf: Array("RIFF".utf8)); putU32(36 + dataLen); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); putU32(16)
        putU16(1)                       // PCM
        putU16(1)                       // mono
        putU32(UInt32(sampleRate))
        putU32(UInt32(sampleRate * 2))  // byte rate
        putU16(2)                       // block align
        putU16(16)                      // bits per sample
        data.append(contentsOf: Array("data".utf8)); putU32(dataLen)
        return data
    }

    // MARK: - カレンダー同期・秘書チャット・リマインド

    /// カレンダーの予定をサーバーに同期する。
    func syncCalendar(baseUrl: String, email: String, token: String, events: [CalendarEvent]) -> OpResult {
        let arr: [[String: Any]] = events.map {
            ["title": $0.title, "whenText": $0.whenText, "startMillis": $0.startMillis]
        }
        let body: [String: Any] = ["email": email, "token": token, "events": arr]
        return opResult(postJson(baseUrl, "/api/calendar/sync", body: body), onOk: "同期完了")
    }

    /// 秘書チャット。質問への回答や、「予定入れといて」等の依頼の実行をサーバー（Gemini）に任せる。
    /// 成功すると回答文と実行件数を返す。
    func ask(baseUrl: String, email: String, token: String, question: String,
             calendar: [(String, String)] = []) -> Result<AskResult, Error> {
        let calArr: [[String: Any]] = calendar.map { ["whenText": $0.0, "title": $0.1] }
        let body: [String: Any] = ["email": email, "token": token, "question": question, "calendar": calArr]
        return postJson(baseUrl, "/api/ask", body: body).map { json in
            AskResult(reply: str(json["reply"]), applied: (json["applied"] as? [Any])?.count ?? 0)
        }
    }

    /// サーバーに保存された秘書チャット履歴を取得する。
    func fetchChatHistory(baseUrl: String, email: String, token: String) -> Result<[ChatHistoryMessage], Error> {
        getJson(baseUrl, "/api/chat/history", email: email, token: token).map { json in
            let arr = json["messages"] as? [[String: Any]] ?? []
            return arr.map {
                ChatHistoryMessage(role: str($0["role"]), content: str($0["content"]), createdAt: str($0["created_at"]))
            }
        }
    }

    /// 未取得のリマインドを取得する。ローカル通知として表示したら ackReminders で既読化する。
    func fetchReminders(baseUrl: String, email: String, token: String) -> [Reminder] {
        guard let url = endpoint(baseUrl, "/api/reminders") else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(email, forHTTPHeaderField: "X-Account-Email")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (code, data, error) = sync(request)
        guard error == nil, (200...299).contains(code), let json = parse(data) else { return [] }
        let arr = json["reminders"] as? [[String: Any]] ?? []
        return arr.map { Reminder(id: int64($0["id"]), kind: str($0["kind"]), message: str($0["message"])) }
    }

    /// リマインドを既読（表示済み）にする。
    func ackReminders(baseUrl: String, email: String, token: String, ids: [Int64]) {
        if ids.isEmpty { return }
        _ = postJson(baseUrl, "/api/reminders/ack", body: ["email": email, "token": token, "ids": ids])
    }

    // MARK: - HTTP helpers

    private func endpoint(_ baseUrl: String, _ path: String) -> URL? {
        var trimmed = baseUrl
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return URL(string: trimmed + path)
    }

    /// URLSession を同期実行する（Android の HttpURLConnection 相当）。
    private func sync(_ request: URLRequest) -> (Int, Data, Error?) {
        let semaphore = DispatchSemaphore(value: 0)
        var outData = Data()
        var outCode = 0
        var outError: Error?
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            outData = data ?? Data()
            outCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            outError = error
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()
        return (outCode, outData, outError)
    }

    private func getJson(_ baseUrl: String, _ path: String) -> Result<[String: Any], Error> {
        requestJson(baseUrl, path, method: "GET", body: nil)
    }

    private func getJson(_ baseUrl: String, _ path: String, email: String, token: String) -> Result<[String: Any], Error> {
        requestJson(baseUrl, path, method: "GET", body: nil, email: email, token: token)
    }

    private func postJson(_ baseUrl: String, _ path: String, body: [String: Any]) -> Result<[String: Any], Error> {
        requestJson(baseUrl, path, method: "POST", body: body)
    }

    /// JSON リクエストを送り、`{"ok": true, ...}` の本文を返す。ok でなければ error メッセージを投げる。
    private func requestJson(_ baseUrl: String, _ path: String, method: String,
                             body: [String: Any]?) -> Result<[String: Any], Error> {
        requestJson(baseUrl, path, method: method, body: body, email: nil, token: nil)
    }

    private func requestJson(_ baseUrl: String, _ path: String, method: String,
                             body: [String: Any]?, email: String?, token: String?) -> Result<[String: Any], Error> {
        guard let url = endpoint(baseUrl, path) else {
            return .failure(ClientError(message: "URL が不正です"))
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let email, let token {
            request.setValue(email, forHTTPHeaderField: "X-Account-Email")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let (code, data, error) = sync(request)
        if let error { return .failure(error) }
        guard let json = parse(data) else {
            return .failure(ClientError(message: "HTTP \(code)"))
        }
        if (200...299).contains(code), json["ok"] as? Bool == true {
            return .success(json)
        }
        let msg = str(json["error"])
        return .failure(ClientError(message: msg.isEmpty ? "HTTP \(code)" : msg))
    }

    private func opResult(_ result: Result<[String: Any], Error>, onOk: String) -> OpResult {
        switch result {
        case .success: return .ok(onOk)
        case .failure(let e): return .error(e.localizedDescription)
        }
    }

    private func parse(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func serverError(_ data: Data, _ code: Int) -> String {
        if let json = parse(data) {
            let msg = str(json["error"])
            if !msg.isEmpty { return msg }
        }
        return "サーバーエラー (HTTP \(code))"
    }

}

// JSON の値取り出しヘルパー（org.json の optString/optLong 相当）。
private func str(_ v: Any?) -> String {
    switch v {
    case let s as String: return s
    case let n as NSNumber: return n.stringValue
    default: return ""
    }
}

private func int64(_ v: Any?) -> Int64 {
    switch v {
    case let n as NSNumber: return n.int64Value
    case let s as String: return Int64(s) ?? 0
    default: return 0
    }
}
