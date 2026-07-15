package com.ishilab.transcriber

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ishilab.transcriber.google.GoogleCalendarClient
import com.ishilab.transcriber.model.WhisperModel
import com.ishilab.transcriber.net.AiHelperClient
import com.ishilab.transcriber.service.AudioCaptureService
import com.ishilab.transcriber.service.DailyDigestScheduler
import com.ishilab.transcriber.service.DigestTimeStore
import com.ishilab.transcriber.service.NotificationPrefs
import com.ishilab.transcriber.service.ServiceState
import com.ishilab.transcriber.service.TravelAssistant
import com.ishilab.transcriber.service.TravelPrefs
import com.ishilab.transcriber.ui.ChatMessage
import com.ishilab.transcriber.ui.MainViewModel
import com.ishilab.transcriber.ui.TranscriptItem
import com.ishilab.transcriber.ui.UiState
import java.io.File

// AIタブのUI（チャット中心のメイン画面・折りたたみの要約/予定課題・タスクカード）。
// MainActivity.kt から分割。

/** AIHelper 連携（ログイン）・予定/課題の確認・AIチャットをまとめたタブ。 */
@Composable
internal fun AiTab(
    ui: UiState,
    onLogin: (String, String, String) -> Unit,
    onRegister: (String, String, String) -> Unit,
    onLogout: () -> Unit,
    onAsk: (String) -> Unit,
    onLoadTasks: () -> Unit,
    onToggleTask: (AiHelperClient.Task) -> Unit,
    onUpdateTask: (AiHelperClient.Task, String, String, String, String) -> Unit,
    onDeleteTask: (AiHelperClient.Task) -> Unit,
    onSetShowDone: (Boolean) -> Unit,
    onLoadSummary: () -> Unit,
    onGenerateSummary: () -> Unit,
    onConnectGoogle: () -> Unit,
    onDisconnectGoogle: (String) -> Unit,
    onSetDefaultGoogle: (String) -> Unit,
    onLoadCalendar: () -> Unit,
    onAddToCalendar: (AiHelperClient.Task) -> Unit,
    onSetSttQuality: (String) -> Unit,
    onLoadMoodle: () -> Unit,
    onSaveMoodleUrl: (String) -> Unit,
    onSyncMoodle: () -> Unit,
    onLoadWaseda: () -> Unit,
    onSaveWaseda: (String, String) -> Unit,
    onSyncWaseda: () -> Unit,
) {
    // 設定（連携・通知）画面を開いているかどうか。⚙で開き、戻るで一覧へ。
    var showSettings by rememberSaveable { mutableStateOf(false) }

    if (showSettings) {
        AiSettingsScreen(
            ui = ui,
            onBack = { showSettings = false },
            onLogin = onLogin, onRegister = onRegister, onLogout = onLogout,
            onSetSttQuality = onSetSttQuality,
            onConnectGoogle = onConnectGoogle, onDisconnectGoogle = onDisconnectGoogle,
            onSetDefaultGoogle = onSetDefaultGoogle, onLoadCalendar = onLoadCalendar,
            onLoadMoodle = onLoadMoodle, onSaveMoodleUrl = onSaveMoodleUrl, onSyncMoodle = onSyncMoodle,
            onLoadWaseda = onLoadWaseda, onSaveWaseda = onSaveWaseda, onSyncWaseda = onSyncWaseda,
        )
        return
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // ヘッダー: タイトルと設定（⚙）ボタン。
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("AIアシスタント", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { showSettings = true }) { Text("⚙ 連携・設定") }
        }

        if (!ui.account.loggedIn) {
            // 未ログイン時: チャットは使えないので設定へ誘導するだけ。
            Card(modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text("AIアシスタントを使うには", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "AIHelper にログインすると、今日の要約や予定・課題を見ながらAIに相談・登録を頼めます。",
                        style = MaterialTheme.typography.bodySmall
                    )
                    Button(onClick = { showSettings = true }) { Text("ログイン / 新規登録") }
                }
            }
            return
        }

        // ---- ログイン時: 折りたたみの要約・予定課題 + 主役のチャット ----
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            CollapsibleCard(title = "今日の要約") {
                SummaryContent(ui, onLoadSummary, onGenerateSummary)
            }
            CollapsibleCard(
                title = "予定・課題",
                badge = if (ui.tasks.isEmpty()) null else ui.tasks.size.toString(),
            ) {
                TasksContent(
                    ui, onLoadTasks, onSetShowDone, onToggleTask,
                    onUpdateTask, onDeleteTask, onAddToCalendar
                )
            }
        }
        Spacer(
            modifier = Modifier
                .padding(16.dp)
                .fillMaxWidth()
                .height(1.dp)
                .background(MaterialTheme.colorScheme.outlineVariant)
        )
        // チャットが残りの高さを全部使う。
        AiChatPanel(
            ui = ui,
            onAsk = onAsk,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 12.dp),
            expandMessages = true,
        )
    }
}
/**
 * 見出しタップで開閉するカード。既定は閉じた状態にして、チャットを広く見せる。
 */
@Composable
internal fun CollapsibleCard(
    title: String,
    badge: String? = null,
    content: @Composable () -> Unit,
) {
    var expanded by rememberSaveable(title) { mutableStateOf(false) }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(title, style = MaterialTheme.typography.titleSmall)
                    if (badge != null) {
                        Text(
                            badge,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier
                                .background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(50))
                                .padding(horizontal = 6.dp, vertical = 1.dp)
                        )
                    }
                }
                Text(
                    if (expanded) "▾" else "▸",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (expanded) {
                Spacer(Modifier.height(8.dp))
                content()
            }
        }
    }
}
/** 折りたたみ内の「今日の要約」中身（見出しは CollapsibleCard 側）。 */
@Composable
internal fun SummaryContent(
    ui: UiState,
    onLoadSummary: () -> Unit,
    onGenerateSummary: () -> Unit,
) {
    LaunchedEffect(ui.account.email) { onLoadSummary() }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically
        ) {
            TextButton(onClick = onGenerateSummary, enabled = !ui.summaryLoading) { Text("生成") }
            OutlinedButton(onClick = onLoadSummary, enabled = !ui.summaryLoading) { Text("更新") }
        }
        ui.summaryError?.let { Text("エラー: $it", color = MaterialTheme.colorScheme.error) }
        when {
            ui.summaryLoading && ui.summary.isNullOrBlank() ->
                Text("読み込み中…", style = MaterialTheme.typography.bodySmall)
            ui.summary.isNullOrBlank() ->
                Text(
                    "まだ今日の要約はありません。録音がたまるか「生成」で作成できます。",
                    style = MaterialTheme.typography.bodySmall
                )
            // 長文でもカード内に収まるよう高さを制限してスクロールさせる。
            else -> Text(
                ui.summary,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier
                    .heightIn(max = 320.dp)
                    .verticalScroll(rememberScrollState())
            )
        }
    }
}
/** 折りたたみ内の「予定・課題」中身。件数が多い場合に備え高さを制限してスクロールさせる。 */
@Composable
internal fun TasksContent(
    ui: UiState,
    onLoadTasks: () -> Unit,
    onSetShowDone: (Boolean) -> Unit,
    onToggleTask: (AiHelperClient.Task) -> Unit,
    onUpdateTask: (AiHelperClient.Task, String, String, String, String) -> Unit,
    onDeleteTask: (AiHelperClient.Task) -> Unit,
    onAddToCalendar: (AiHelperClient.Task) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            TextButton(onClick = { onSetShowDone(!ui.showDoneTasks) }) {
                Text(if (ui.showDoneTasks) "未完了のみ" else "完了も表示")
            }
            OutlinedButton(onClick = onLoadTasks) { Text("更新") }
        }
        ui.tasksError?.let { Text("取得エラー: $it", color = MaterialTheme.colorScheme.error) }
        when {
            ui.tasksLoading && ui.tasks.isEmpty() ->
                Text("読み込み中…", style = MaterialTheme.typography.bodySmall)
            ui.tasks.isEmpty() ->
                Text("表示できる予定・課題はありません。", style = MaterialTheme.typography.bodySmall)
            else -> LazyColumn(
                modifier = Modifier.heightIn(max = 320.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(ui.tasks) { task ->
                    TaskCard(
                        task = task,
                        actionInProgress = ui.taskActionInProgressId == task.id,
                        onToggleTask = onToggleTask,
                        onUpdateTask = onUpdateTask,
                        onDeleteTask = onDeleteTask,
                        onAddToCalendar = if (ui.googleConnected) onAddToCalendar else null,
                    )
                }
            }
        }
    }
}
/** 予定・課題1件のカード。チェックで完了/未完了を切替。onAddToCalendar があれば登録ボタンを出す。 */
@Composable
internal fun TaskCard(
    task: AiHelperClient.Task,
    actionInProgress: Boolean,
    onToggleTask: (AiHelperClient.Task) -> Unit,
    onUpdateTask: (AiHelperClient.Task, String, String, String, String) -> Unit,
    onDeleteTask: (AiHelperClient.Task) -> Unit,
    onAddToCalendar: ((AiHelperClient.Task) -> Unit)? = null,
) {
    var editing by rememberSaveable(task.id) { mutableStateOf(false) }
    val isYotei = task.type == "yotei"
    val label = if (isYotei) "予定" else "課題"
    val labelColor = if (isYotei) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.primary
    if (editing) {
        TaskEditDialog(
            task = task,
            saving = actionInProgress,
            onDismiss = { editing = false },
            onSave = { type, content, details, deadline ->
                onUpdateTask(task, type, content, details, deadline)
                editing = false
            },
            onDelete = {
                onDeleteTask(task)
                editing = false
            },
        )
    }
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.Top
        ) {
            Checkbox(
                checked = task.done,
                enabled = !actionInProgress,
                onCheckedChange = { onToggleTask(task) },
            )
            Column(modifier = Modifier.padding(start = 4.dp)) {
                Text("[$label]", color = labelColor, style = MaterialTheme.typography.labelMedium)
                Text(
                    task.content,
                    style = MaterialTheme.typography.bodyLarge,
                    textDecoration = if (task.done) TextDecoration.LineThrough else null
                )
                Text("期限: ${formatDeadline(task.deadline, task.dateOnly)}", style = MaterialTheme.typography.bodySmall)
                if (task.details.isNotBlank()) {
                    Text(
                        task.details,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (onAddToCalendar != null && !task.deadline.isNullOrBlank()) {
                    TextButton(
                        onClick = { onAddToCalendar(task) },
                        enabled = !actionInProgress,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)
                    ) { Text("カレンダーに追加") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(
                        onClick = { editing = true },
                        enabled = !actionInProgress,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)
                    ) { Text("編集") }
                    if (actionInProgress) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    }
                }
            }
        }
    }
}
@Composable
internal fun TaskEditDialog(
    task: AiHelperClient.Task,
    saving: Boolean,
    onDismiss: () -> Unit,
    onSave: (String, String, String, String) -> Unit,
    onDelete: () -> Unit,
) {
    var type by rememberSaveable(task.id) { mutableStateOf(task.type) }
    var content by rememberSaveable(task.id) { mutableStateOf(task.content) }
    var details by rememberSaveable(task.id) { mutableStateOf(task.details) }
    var deadline by rememberSaveable(task.id) { mutableStateOf(editableDeadline(task.deadline, task.dateOnly)) }

    Dialog(onDismissRequest = { if (!saving) onDismiss() }) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            tonalElevation = 8.dp,
            shadowElevation = 10.dp,
            modifier = Modifier.fillMaxWidth().widthIn(max = 560.dp)
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text("予定・課題を編集", style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = type != "yotei", onClick = { type = "kadai" }, enabled = !saving)
                    Text("課題", modifier = Modifier.padding(end = 12.dp))
                    RadioButton(selected = type == "yotei", onClick = { type = "yotei" }, enabled = !saving)
                    Text("予定")
                }
                OutlinedTextField(
                    value = content,
                    onValueChange = { content = it },
                    label = { Text("内容") },
                    enabled = !saving,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = deadline,
                    onValueChange = { deadline = it },
                    label = { Text("期限（YYYY-MM-DD または YYYY-MM-DD HH:MM）") },
                    enabled = !saving,
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = details,
                    onValueChange = { details = it },
                    label = { Text("詳細") },
                    enabled = !saving,
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    TextButton(onClick = onDelete, enabled = !saving) { Text("削除") }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = onDismiss, enabled = !saving) { Text("キャンセル") }
                        Button(
                            onClick = { onSave(type, content, details, deadline) },
                            enabled = !saving && content.trim().isNotEmpty()
                        ) { Text(if (saving) "保存中…" else "保存") }
                    }
                }
            }
        }
    }
}
internal fun editableDeadline(deadline: String?, dateOnly: Boolean): String {
    if (deadline.isNullOrBlank()) return ""
    val s = deadline.replace('T', ' ')
    return if (dateOnly) s.take(10) else s.take(16)
}
/** サーバーの deadline 文字列を "YYYY-MM-DD HH:MM"（日付のみなら日付）へ整形。 */
internal fun formatDeadline(deadline: String?, dateOnly: Boolean): String {
    if (deadline.isNullOrBlank()) return "未定"
    val s = deadline.replace('T', ' ')
    return if (dateOnly) s.take(10) else s.take(16)
}
