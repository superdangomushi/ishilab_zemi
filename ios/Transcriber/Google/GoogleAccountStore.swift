import Foundation

/// 連携済み Google アカウント（複数可）の保存。
/// defaultEmail は「カレンダーに追加」の登録先に使うアカウント（未設定なら先頭）。
/// iOS には Android のようなシステムアカウントが無いため、
/// OAuth のリフレッシュトークンもここで保持する。
final class GoogleAccountStore {

    private let prefs = UserDefaults.standard

    private(set) var emails: [String] {
        get { (prefs.string(forKey: Keys.emails) ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty } }
        set { prefs.set(newValue.joined(separator: ","), forKey: Keys.emails) }
    }

    var defaultEmail: String {
        get {
            let d = prefs.string(forKey: Keys.defaultEmail) ?? ""
            return emails.contains(d) ? d : (emails.first ?? "")
        }
        set { prefs.set(newValue, forKey: Keys.defaultEmail) }
    }

    func add(_ email: String) {
        let e = email.trimmingCharacters(in: .whitespaces)
        if e.isEmpty { return }
        var list = emails
        if !list.contains(e) {
            list.append(e)
            emails = list
        }
    }

    func remove(_ email: String) {
        emails = emails.filter { $0 != email }
        if prefs.string(forKey: Keys.defaultEmail) == email {
            prefs.removeObject(forKey: Keys.defaultEmail)
        }
        removeRefreshToken(email)
    }

    // ---- OAuth リフレッシュトークン ----

    func refreshToken(_ email: String) -> String? {
        prefs.string(forKey: Keys.refreshToken + email)
    }

    func saveRefreshToken(_ email: String, _ token: String) {
        prefs.set(token, forKey: Keys.refreshToken + email)
    }

    private func removeRefreshToken(_ email: String) {
        prefs.removeObject(forKey: Keys.refreshToken + email)
    }

    private enum Keys {
        static let emails = "google_accounts.emails"
        static let defaultEmail = "google_accounts.default_email"
        static let refreshToken = "google_accounts.refresh_token."
    }
}
