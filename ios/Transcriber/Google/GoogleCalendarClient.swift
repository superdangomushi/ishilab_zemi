import Foundation
import AuthenticationServices
import CryptoKit

/// Google カレンダーの予定1件（表示用）。accountEmail はどの連携アカウント由来か。
struct CalendarEvent: Equatable {
    let title: String
    let whenText: String
    let startMillis: Int64
    var accountEmail: String = ""
    /// 終了日時 "yyyy-MM-dd HH:mm"。終日予定など終了時刻がないときは空。
    var endText: String = ""
}

/// Google カレンダーを読み書きするクライアント。
///
/// Android 版はシステムの Google アカウント＋GoogleAuthUtil を使うが、iOS には
/// 相当機能が無いため、OAuth 2.0（PKCE）を ASWebAuthenticationSession で行い、
/// リフレッシュトークンを保存して都度アクセストークンを得る。
/// Calendar v3 REST を直接叩く部分は Android 版と同じ。
/// 通信はブロッキングなので必ずワーカースレッドから呼ぶこと。
enum GoogleCalendarClient {

    // 予定の読み書きに必要なスコープ。email はアカウント識別用。
    static let scope = "https://www.googleapis.com/auth/calendar.events openid email"
    private static let api = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    private static let authEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
    private static let tokenEndpoint = "https://oauth2.googleapis.com/token"

    struct GoogleError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static var clientID: String {
        (Bundle.main.object(forInfoDictionaryKey: "GoogleOAuthClientID") as? String) ?? ""
    }

    /// クライアント ID を逆順にしたカスタム URL スキーム（Google の iOS クライアント標準）。
    static var redirectScheme: String {
        let parts = clientID.split(separator: ".").map(String.init)
        return parts.reversed().joined(separator: ".")
    }

    private static var redirectURI: String { "\(redirectScheme):/oauth2redirect" }

    // ---- サインイン（Android の chooseAccountIntent ＋ 同意画面に相当） ----

    /// ブラウザで Google サインイン→同意を行い、(email, refreshToken) を返す。
    /// メインスレッドから呼ぶこと（結果はコールバック）。
    @MainActor
    static func signIn(presentationContext: ASWebAuthenticationPresentationContextProviding,
                       completion: @escaping (Result<(String, String), Error>) -> Void) {
        guard !clientID.isEmpty, !clientID.hasPrefix("YOUR_") else {
            completion(.failure(GoogleError(message: "Info.plist の GoogleOAuthClientID を設定してください")))
            return
        }
        // PKCE
        let verifier = randomURLSafe(64)
        let challenge = sha256Base64URL(verifier)

        var comps = URLComponents(string: authEndpoint)!
        comps.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            // 複数アカウント連携のため毎回アカウント選択を出す。
            URLQueryItem(name: "prompt", value: "select_account consent"),
        ]
        let session = ASWebAuthenticationSession(
            url: comps.url!, callbackURLScheme: redirectScheme
        ) { callbackURL, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let callbackURL,
                  let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
                      .queryItems?.first(where: { $0.name == "code" })?.value else {
                completion(.failure(GoogleError(message: "認可コードを取得できませんでした")))
                return
            }
            DispatchQueue.global().async {
                let result = exchangeCode(code, verifier: verifier)
                DispatchQueue.main.async { completion(result) }
            }
        }
        session.presentationContextProvider = presentationContext
        session.prefersEphemeralWebBrowserSession = false
        session.start()
    }

    /// 認可コードをトークンに交換し、id_token から email を取り出す。
    private static func exchangeCode(_ code: String, verifier: String) -> Result<(String, String), Error> {
        let params = [
            "client_id": clientID,
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirectURI,
        ]
        return postForm(tokenEndpoint, params).flatMap { json in
            guard let refresh = json["refresh_token"] as? String else {
                return .failure(GoogleError(message: "リフレッシュトークンを取得できませんでした"))
            }
            guard let idToken = json["id_token"] as? String,
                  let email = emailFromIdToken(idToken) else {
                return .failure(GoogleError(message: "アカウントのメールアドレスを取得できませんでした"))
            }
            return .success((email, refresh))
        }
    }

    /// 指定メールの Google アカウントの OAuth アクセストークンを取得する（ブロッキング）。
    /// リフレッシュトークン未保存・失効時はエラーを投げるので、呼び出し側で再連携を促す。
    static func accessToken(_ store: GoogleAccountStore, email: String) throws -> String {
        guard let refresh = store.refreshToken(email) else {
            throw GoogleError(message: "\(email) の再連携が必要です")
        }
        let params = [
            "client_id": clientID,
            "refresh_token": refresh,
            "grant_type": "refresh_token",
        ]
        switch postForm(tokenEndpoint, params) {
        case .success(let json):
            guard let token = json["access_token"] as? String else {
                throw GoogleError(message: "\(email) のアクセストークンを取得できませんでした")
            }
            return token
        case .failure(let e):
            throw e
        }
    }

    // ---- Calendar v3 REST（Android 版と同一） ----

    /// 直近の予定を取得する。
    static func listUpcomingEvents(token: String, max: Int = 20) -> Result<[CalendarEvent], Error> {
        let nowRfc = rfc3339(Int64(Date().timeIntervalSince1970 * 1000))
        guard let url = URL(string: "\(api)?timeMin=\(enc(nowRfc))&maxResults=\(max)&singleEvents=true&orderBy=startTime") else {
            return .failure(GoogleError(message: "URL が不正です"))
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (code, data, error) = sync(request)
        if let error { return .failure(error) }
        guard (200...299).contains(code),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failure(GoogleError(message: errorOf(data, code)))
        }
        let items = json["items"] as? [[String: Any]] ?? []
        let events = items.map { o -> CalendarEvent in
            let start = o["start"] as? [String: Any]
            let dt = (start?["dateTime"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let d = (start?["date"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let whenText = dt.map { String($0.replacingOccurrences(of: "T", with: " ").prefix(16)) } ?? (d ?? "")
            let ms = parseMillis(dt ?? d)
            let endDt = ((o["end"] as? [String: Any])?["dateTime"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let endText = endDt.map { String($0.replacingOccurrences(of: "T", with: " ").prefix(16)) } ?? ""
            return CalendarEvent(
                title: (o["summary"] as? String) ?? "(無題)",
                whenText: whenText, startMillis: ms, endText: endText
            )
        }.sorted { $0.startMillis < $1.startMillis }
        return .success(events)
    }

    /// 締切をカレンダーに登録する。deadline は "yyyy-MM-dd HH:mm[:ss]" または ISO。
    /// dateOnly のときは終日予定、それ以外は締切時刻の30分イベントにする。
    static func insertDeadline(token: String, title: String, deadline: String?, dateOnly: Bool) -> Result<Void, Error> {
        var body: [String: Any] = ["summary": title]
        let at = parseMillis(deadline)
        guard let deadline, !deadline.isEmpty, at != 0 else {
            return .failure(GoogleError(message: "期限が未設定のためカレンダーに登録できません"))
        }
        if dateOnly {
            // 終日予定の end.date は排他的（翌日）を指定する。同日だと API が 400 を返す。
            body["start"] = ["date": dayString(at)]
            body["end"] = ["date": dayString(at + 24 * 3600_000)]
        } else {
            body["start"] = ["dateTime": rfc3339(at - 30 * 60_000)]
            body["end"] = ["dateTime": rfc3339(at)]
        }
        guard let url = URL(string: api) else {
            return .failure(GoogleError(message: "URL が不正です"))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let (code, data, error) = sync(request)
        if let error { return .failure(error) }
        guard (200...299).contains(code) else {
            return .failure(GoogleError(message: errorOf(data, code)))
        }
        return .success(())
    }

    // ---- helpers ----

    private static func sync(_ request: URLRequest) -> (Int, Data, Error?) {
        let semaphore = DispatchSemaphore(value: 0)
        var outData = Data()
        var outCode = 0
        var outError: Error?
        URLSession.shared.dataTask(with: request) { data, response, error in
            outData = data ?? Data()
            outCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            outError = error
            semaphore.signal()
        }.resume()
        semaphore.wait()
        return (outCode, outData, outError)
    }

    private static func postForm(_ endpoint: String, _ params: [String: String]) -> Result<[String: Any], Error> {
        guard let url = URL(string: endpoint) else {
            return .failure(GoogleError(message: "URL が不正です"))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = params.map { "\($0.key)=\(enc($0.value))" }.joined(separator: "&").data(using: .utf8)
        let (code, data, error) = sync(request)
        if let error { return .failure(error) }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failure(GoogleError(message: "HTTP \(code)"))
        }
        guard (200...299).contains(code) else {
            let msg = (json["error_description"] as? String) ?? (json["error"] as? String) ?? "HTTP \(code)"
            return .failure(GoogleError(message: msg))
        }
        return .success(json)
    }

    /// id_token(JWT) のペイロードから email を取り出す（署名検証はここでは不要）。
    private static func emailFromIdToken(_ idToken: String) -> String? {
        let parts = idToken.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return json["email"] as? String
    }

    private static func errorOf(_ data: Data, _ code: Int) -> String {
        if let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let err = json["error"] as? [String: Any],
           let msg = err["message"] as? String, !msg.isEmpty {
            return msg
        }
        return "HTTP \(code)"
    }

    private static func rfc3339(_ millis: Int64) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXX"
        return f.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }

    private static func dayString(_ millis: Int64) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }

    /// サーバー由来の日時文字列を millis に。解釈できなければ 0。
    static func parseMillis(_ s: String?) -> Int64 {
        guard let s, !s.isEmpty else { return 0 }
        let norm = s.replacingOccurrences(of: "T", with: " ")
        for pat in ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone.current
            f.dateFormat = pat
            if let d = f.date(from: String(norm.prefix(pat.count))) {
                return Int64(d.timeIntervalSince1970 * 1000)
            }
        }
        return 0
    }

    private static func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
    }

    private static func randomURLSafe(_ length: Int) -> String {
        let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
        return String((0..<length).map { _ in chars.randomElement()! })
    }

    private static func sha256Base64URL(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
