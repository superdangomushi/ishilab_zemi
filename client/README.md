# AIHelper local audio worker

This directory is for each user's local PC. The public server in `../server`
only stores audio jobs and exposes JSON/file APIs. This client polls the server
for every enabled account configured in the local UI, downloads matching jobs,
transcribes them locally with faster-whisper, and posts the text back to the
server.

## Setup

```bash
cd client
make install
```

If Node.js is already installed, `make stt-deps` is enough for the Whisper side.
GPU use is automatic when faster-whisper can see CUDA. If `gpu-check` says CUDA
is not visible, CPU transcription still works.

## Run

```bash
cd client
npm start
```

Then open the local UI:

```text
http://127.0.0.1:39123
```

Set the public server URL, then add one or more accounts with email and
password. The password is used only once for `/api/login`; the worker stores the
returned token in `client/accounts.json` and does not save the password.

The worker polls every enabled account every 10 seconds by default. Change it
with:

```bash
AUDIO_WORKER_POLL_SEC=5 npm start
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `AIHELPER_SERVER_URL` | `http://localhost:3000` | Public AIHelper server URL |
| `AUDIO_WORKER_UI_HOST` | `127.0.0.1` | Local UI bind host |
| `AUDIO_WORKER_UI_PORT` | `39123` | Local UI port |
| `AUDIO_WORKER_CONFIG` | `client/accounts.json` | Local account/token config file |
| `AIHELPER_EMAIL` | empty | Optional single legacy account email |
| `AIHELPER_TOKEN` | empty | Optional single legacy account token |
| `AUDIO_WORKER_POLL_SEC` | `10` | Polling interval in seconds |
| `AUDIO_WORKER_DIR` | `client/worker-audio` | Temporary audio download directory |
| `WHISPER_DEVICE` | auto | `cuda` or `cpu` override |
| `WHISPER_MODEL` | GPU: `large-v3`, CPU: `large-v3-turbo` | faster-whisper model |
| `WHISPER_COMPUTE` | GPU: `float16`, CPU: `int8` | faster-whisper compute type |
| `WHISPER_BATCH` | GPU: `16`, CPU: `0` | Batch size. `0` disables batched inference |
| `WHISPER_CPU_THREADS` | all cores | CPU thread count |
| `WHISPER_PYTHON` | `stt/.venv/bin/python3` | Custom Python executable |

## Flow

1. The local UI logs in with `POST /api/login` and stores tokens per account.
2. `POST /api/audio/worker/claim` claims one queued job for each enabled account.
3. `GET /api/audio/worker/jobs/:id/file` downloads the audio file.
4. `client/stt/transcribe.py` transcribes the file on this PC.
5. `POST /api/audio/worker/jobs/:id/result` sends `{ "text": "..." }` back.

The server then saves the returned text as a transcript and runs the same
Gemini analysis, task updates, cancellations, and daily-summary refresh as a
normal text upload.

## Multiple worker PCs

You can run this worker on several PCs at the same time, even with the same
account. Each claim atomically marks exactly one queued job as `processing`,
so concurrent workers always receive different jobs and the queue is spread
across whichever PCs are idle.

The **server** assigns an ID to each worker PC on its first claim and returns
it in the claim response. This client stores the ID per account in
`accounts.json`, shows it in the local UI, and echoes it back via the
`X-Worker-Id` header (it also sends its hostname as `X-Worker-Name` for
display). Older clients that send neither header still work: the server
recognizes them by their source IP and assigns an ID automatically.

On the server dashboard (files tab), each user can select which of their
worker PCs are allowed to process audio — multiple PCs can be checked at
once. Unchecked PCs keep polling but receive no jobs. The server also records
which worker claimed each job, so if a stalled job is re-queued and picked up
by another PC, a late result from the original PC is rejected instead of
being saved twice (for old clients that omit `X-Worker-Id`, this strict check
is skipped to keep them compatible).
