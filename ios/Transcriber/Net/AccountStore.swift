import Foundation

/// AIHelper.jp のログイン情報（接続先URL・アカウント・トークン）を端末に保存する。
/// ログインに成功したアカウントだけを保持し、送信時に再利用する。
/// （Android 版 AccountStore.kt の移植。SharedPreferences → UserDefaults）
final class AccountStore {

    private let prefs = UserDefaults.standard

    static let defaultBaseUrl = "https://AIHelper.jp"

    var baseUrl: String {
        get { prefs.string(forKey: Keys.baseUrl) ?? Self.defaultBaseUrl }
        set { prefs.set(newValue, forKey: Keys.baseUrl) }
    }

    private(set) var email: String {
        get { prefs.string(forKey: Keys.email) ?? "" }
        set { prefs.set(newValue, forKey: Keys.email) }
    }

    private(set) var token: String {
        get { prefs.string(forKey: Keys.token) ?? "" }
        set { prefs.set(newValue, forKey: Keys.token) }
    }

    var loggedIn: Bool {
        prefs.bool(forKey: Keys.loggedIn)
    }

    /// true なら端末の Whisper を使わず、録音音声をサーバーへアップロードして文字起こしする。
    var serverTranscribe: Bool {
        get { prefs.bool(forKey: Keys.serverTranscribe) }
        set { prefs.set(newValue, forKey: Keys.serverTranscribe) }
    }

    /// ログイン成功時に呼ぶ。以後の送信で使う認証情報を確定させる。
    func save(baseUrl: String, email: String, token: String) {
        prefs.set(baseUrl, forKey: Keys.baseUrl)
        prefs.set(email, forKey: Keys.email)
        prefs.set(token, forKey: Keys.token)
        prefs.set(true, forKey: Keys.loggedIn)
    }

    func logout() {
        prefs.removeObject(forKey: Keys.token)
        prefs.set(false, forKey: Keys.loggedIn)
    }

    private enum Keys {
        static let baseUrl = "AIHelper.base_url"
        static let email = "AIHelper.email"
        static let token = "AIHelper.token"
        static let loggedIn = "AIHelper.logged_in"
        static let serverTranscribe = "AIHelper.server_transcribe"
    }
}
