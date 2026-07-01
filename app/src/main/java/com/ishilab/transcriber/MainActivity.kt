package com.ishilab.transcriber

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ishilab.transcriber.model.WhisperModel
import com.ishilab.transcriber.service.AudioCaptureService
import com.ishilab.transcriber.service.ServiceState
import com.ishilab.transcriber.ui.MainViewModel
import com.ishilab.transcriber.ui.TranscriptItem
import com.ishilab.transcriber.ui.UiState
import java.io.File

class MainActivity : ComponentActivity() {

    private val viewModel: MainViewModel by viewModels()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNeededPermissions()
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val ui by viewModel.ui.collectAsState()
                    val service by AudioCaptureService.state.collectAsStateWithLifecycle()
                    MainScreen(
                        ui = ui,
                        service = service,
                        onDownload = viewModel::download,
                        onStart = { AudioCaptureService.start(this) },
                        onStop = { AudioCaptureService.stop(this) },
                        onRefresh = viewModel::refresh,
                        onLogin = viewModel::login,
                        onLogout = viewModel::logout,
                        onSend = viewModel::sendToMoneybot,
                        onAsk = viewModel::ask,
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.refresh()
    }

    private fun requestNeededPermissions() {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        val toRequest = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (toRequest.isNotEmpty()) permissionLauncher.launch(toRequest.toTypedArray())
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainScreen(
    ui: UiState,
    service: ServiceState,
    onDownload: (WhisperModel) -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRefresh: () -> Unit,
    onLogin: (String, String, String) -> Unit,
    onLogout: () -> Unit,
    onSend: (TranscriptItem) -> Unit,
    onAsk: (String) -> Unit,
) {
    val context = LocalContext.current
    Scaffold(
        topBar = { TopAppBar(title = { Text("常時録音・ローカル文字起こし") }) }
    ) { padding ->
        // 画面全体を単一の LazyColumn にして常にスクロール可能にする。
        // （Column の中に LazyColumn をネストすると上部がスクロールできない問題を回避）
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item { StatusCard(service) }

            item {
                if (!ui.anyModelReady) {
                    ModelDownloadCard(ui, onDownload)
                } else {
                    ControlRow(service, onStart, onStop)
                }
            }

            service.error?.let { err ->
                item { Text("エラー: $err", color = MaterialTheme.colorScheme.error) }
            }

            item { MoneybotCard(ui, onLogin, onLogout) }

            if (ui.account.loggedIn) {
                item { SecretaryCard(ui, onAsk) }
            }

            ui.sendMessage?.let { msg ->
                item { Text(msg, style = MaterialTheme.typography.bodySmall) }
            }

            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("文字起こしファイル", style = MaterialTheme.typography.titleMedium)
                    OutlinedButton(onClick = onRefresh) { Text("更新") }
                }
            }

            if (ui.transcripts.isEmpty()) {
                item {
                    Text("まだファイルがありません。", style = MaterialTheme.typography.bodySmall)
                }
            } else {
                items(ui.transcripts) { item ->
                    TranscriptCard(item, ui, onSend, context)
                }
            }
        }
    }
}

@Composable
private fun StatusCard(service: ServiceState) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            val status = when {
                !service.active -> "停止中"
                service.paused -> "一時停止中（マイク解放中）"
                else -> "録音・文字起こし中"
            }
            Text("状態: $status", style = MaterialTheme.typography.titleMedium)
            if (service.active) {
                val elapsedMs = rememberRecordingElapsed(service)
                Text("録音時間: ${formatDuration(elapsedMs)}")
            }
            service.modelName?.let { Text("モデル: $it") }
            Text("処理済チャンク: ${service.chunksDone}  待機: ${service.queueSize}  破棄: ${service.dropped}")
            service.currentFile?.let { Text("出力中: $it") }
            if (service.lastText.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "直近: ${service.lastText}",
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }
    }
}

/**
 * 録音の合計継続時間(ms)を返し、録音中は毎秒再計算してカウントアップさせる。
 * 一時停止中は積算値で止まる。
 */
@Composable
private fun rememberRecordingElapsed(service: ServiceState): Long {
    var now by remember { mutableStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(service.active, service.recordingStartedElapsed) {
        while (service.active) {
            now = SystemClock.elapsedRealtime()
            delay(1000)
        }
    }
    val running = if (service.recordingStartedElapsed > 0L) {
        (now - service.recordingStartedElapsed).coerceAtLeast(0L)
    } else 0L
    return service.accumulatedRecordMs + running
}

private fun formatDuration(ms: Long): String {
    val totalSec = ms / 1000
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}

@Composable
private fun ControlRow(service: ServiceState, onStart: () -> Unit, onStop: () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Button(onClick = onStart, enabled = !service.active) { Text("録音開始") }
        OutlinedButton(onClick = onStop, enabled = service.active) { Text("終了") }
    }
    Text(
        "※ 一時停止/再開は通知バーのボタンから行えます。",
        style = MaterialTheme.typography.bodySmall
    )
}

@Composable
private fun ModelDownloadCard(ui: UiState, onDownload: (WhisperModel) -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("初回はモデルのダウンロードが必要です", style = MaterialTheme.typography.titleMedium)
            Text(
                "ダウンロード後はオフラインで動作します。日本語は base 以上を推奨。",
                style = MaterialTheme.typography.bodySmall
            )
            if (ui.downloading != null) {
                Text("ダウンロード中: ${ui.downloading.displayName}")
                if (ui.downloadProgress >= 0f) {
                    LinearProgressIndicator(
                        progress = { ui.downloadProgress },
                        modifier = Modifier.fillMaxWidth()
                    )
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
            } else {
                WhisperModel.entries.forEach { model ->
                    Button(
                        onClick = { onDownload(model) },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("${model.displayName}  約${model.approxMb}MB") }
                }
            }
            ui.downloadError?.let {
                Text("ダウンロード失敗: $it", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/** moneybot.jp のログイン / アカウント表示。 */
@Composable
private fun MoneybotCard(
    ui: UiState,
    onLogin: (String, String, String) -> Unit,
    onLogout: () -> Unit,
) {
    val account = ui.account
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("moneybot.jp 連携", style = MaterialTheme.typography.titleMedium)
            if (account.loggedIn) {
                Text("ログイン中: ${account.email}")
                Text(account.baseUrl, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = onLogout) { Text("ログアウト") }
            } else {
                MoneybotLoginForm(ui, onLogin)
            }
        }
    }
}

@Composable
private fun MoneybotLoginForm(
    ui: UiState,
    onLogin: (String, String, String) -> Unit,
) {
    var baseUrl by rememberSaveable { mutableStateOf(ui.account.baseUrl) }
    var email by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }

    OutlinedTextField(
        value = baseUrl,
        onValueChange = { baseUrl = it },
        label = { Text("サーバーURL") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth()
    )
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text("アカウント (メール)") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth()
    )
    OutlinedTextField(
        value = token,
        onValueChange = { token = it },
        label = { Text("トークン") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth()
    )
    Button(
        onClick = { onLogin(baseUrl, email, token) },
        enabled = !ui.loginInProgress,
        modifier = Modifier.fillMaxWidth()
    ) {
        if (ui.loginInProgress) {
            CircularProgressIndicator(
                modifier = Modifier.height(18.dp),
                strokeWidth = 2.dp
            )
        } else {
            Text("ログイン")
        }
    }
    ui.loginError?.let {
        Text("ログイン失敗: $it", color = MaterialTheme.colorScheme.error)
    }
}

/** 秘書チャット: 「今日の予定は？」と聞けば回答、「予定入れといて」で登録まで実行。 */
@Composable
private fun SecretaryCard(ui: UiState, onAsk: (String) -> Unit) {
    var question by rememberSaveable { mutableStateOf("") }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("秘書に聞く / 頼む", style = MaterialTheme.typography.titleMedium)
            if (ui.chatLog.isEmpty()) {
                Text(
                    "例) 今日の予定は？ / 来週月曜10時にゼミ入れといて / 数学の宿題が出てるらしい",
                    style = MaterialTheme.typography.bodySmall
                )
            }
            ui.chatLog.takeLast(8).forEach { msg ->
                val prefix = if (msg.fromUser) "あなた: " else "秘書: "
                Text(
                    "$prefix${msg.text}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (msg.fromUser) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurface
                )
            }
            OutlinedTextField(
                value = question,
                onValueChange = { question = it },
                label = { Text("メッセージ") },
                modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { onAsk(question); question = "" },
                enabled = !ui.askInProgress && question.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) {
                if (ui.askInProgress) {
                    CircularProgressIndicator(modifier = Modifier.height(18.dp), strokeWidth = 2.dp)
                } else {
                    Text("送信")
                }
            }
        }
    }
}

@Composable
private fun TranscriptCard(
    item: TranscriptItem,
    ui: UiState,
    onSend: (TranscriptItem) -> Unit,
    context: android.content.Context,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(item.name, style = MaterialTheme.typography.titleSmall)
            Text("${item.sizeBytes} bytes", style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { shareFile(context, item.path) }) {
                    Text("共有")
                }
                val sending = ui.sendingFile == item.name
                Button(
                    onClick = { onSend(item) },
                    enabled = ui.account.loggedIn && ui.sendingFile == null
                ) {
                    Text(if (sending) "送信中…" else "moneybotへ送信")
                }
            }
        }
    }
}

private fun shareFile(context: android.content.Context, path: String) {
    val file = File(path)
    val uri = FileProvider.getUriForFile(
        context, "${context.packageName}.fileprovider", file
    )
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "共有").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
}
