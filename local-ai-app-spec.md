# Local AI Studio — technical spec

## 1. Purpose

A desktop application that lets a non-technical user generate images, video, and music locally, without manually installing Python environments, CUDA toolchains, or AI models. The user picks a task from a toolbar, the app handles hardware detection, model selection, dependency installation, and inference — the user never touches a terminal.

**Primary platform:** Windows. Architecture should not preclude a later Mac/Linux port, but no cross-platform code paths need to be built in v1 beyond avoiding hard Windows-only assumptions where it costs nothing.

## 2. Non-goals (v1)

- Not a general-purpose catalog of every community AI tool (that's Pinokio's niche). This app supports a small, curated, hand-tested list of models per task.
- Not a training/fine-tuning tool. Inference only.
- Not cloud-connected. Fully offline after initial model download.

## 3. Tech stack

- **Shell:** Electron (Node.js + Chromium). Chosen over Tauri because the core backend work is process/venv/download management, which Node's ecosystem handles with less friction, and Electron's packaging story for a later Mac/Linux port is mature.
- **Backend engines wrapped, not reimplemented:**
  - Image + video generation: **ComfyUI**, run headless as a local subprocess exposing its API on `localhost:<port>`. The app talks to it over HTTP, never opens ComfyUI's own UI.
  - Music generation: plain Python process running MusicGen or Stable Audio Open (no ComfyUI needed for audio-only tasks).
- **Python management:** app manages its own isolated Python venv per engine under the app's data directory — never touches or depends on a system Python install.
- **IPC:** Electron main process owns all subprocess/model logic; renderer (UI) talks to main via `ipcMain`/`ipcRenderer`, never spawns processes directly.

## 4. Core components

### 4.1 Hardware detection module

Runs once on first launch, re-runs on demand from settings.

Detects:
- OS + version
- GPU vendor and model (NVIDIA / AMD / Intel / none) — Windows: query via `wmic`/PowerShell `Get-CimInstance Win32_VideoController`, or a bundled tool like `nvidia-smi` when present for VRAM.
- VRAM (GB)
- System RAM (GB)
- Free disk space on the install drive

Output: a simple JSON hardware profile object, e.g.:
```json
{
  "os": "windows",
  "gpu_vendor": "nvidia",
  "gpu_model": "RTX 4070",
  "vram_gb": 12,
  "ram_gb": 32,
  "free_disk_gb": 220
}
```

### 4.2 Model registry / compatibility matrix

A flat JSON/YAML file bundled with the app (updatable independently of app releases — fetch a fresh copy from a hosted URL on launch if available, fall back to bundled copy offline).

Each entry:
```json
{
  "id": "sdxl-turbo",
  "task": "text-to-image",
  "label": "SDXL Turbo",
  "engine": "comfyui",
  "min_vram_gb": 6,
  "recommended_vram_gb": 8,
  "os_support": ["windows", "mac", "linux"],
  "disk_gb": 7,
  "content_policy": "moderate",
  "download_url": "...",
  "checksum": "sha256:...",
  "quality_tier": 2,
  "is_default_candidate": true
}
```

Default-selection logic on first pick of a task:
1. Filter entries where `task` matches, `min_vram_gb <= profile.vram_gb`, `os_support` includes current OS.
2. Sort remaining by `quality_tier` descending.
3. Top result becomes the default; front-load its download immediately.
4. Remaining entries populate the model dropdown as alternates.

User can mark any alternate as their new default for that task (persisted per-task in local settings, independent of the registry's own recommendation).

### 4.3 Install / download manager

Responsibilities:
- Resumable downloads (HTTP range requests) with progress events sent to the UI.
- Checksum verification after download; re-download on mismatch, surface a clear error if it fails twice.
- Per-model install steps run in an isolated venv: create venv → install pinned dependency versions → place model weights in the expected folder → run a lightweight smoke test (e.g. generate a tiny throwaway output) to confirm the install actually works before marking the model "ready."
- Never marks a model ready without the smoke test passing — this directly targets the failure mode that started this project (install completed but generation silently failed).

### 4.4 Runtime orchestrator

- Launches the relevant backend engine (ComfyUI or the audio Python process) as a subprocess when a task requiring it is first opened; keeps it warm while the app is open, kills it on app quit.
- Handles model swapping within a task: unload current model weights, load newly selected model, before accepting the next generate request. UI shows a brief "switching model" state during this.
- Only one model per task loaded at a time in v1 (simplifies VRAM management). Revisit multi-model concurrency later if hardware profiles support it.
- Exposes a single internal interface to the renderer regardless of backend differences:
  ```
  generate(task_type, model_id, inputs) → { status, output_path | error }
  ```

### 4.5 File output / save handling

- Every generation writes to a temp directory under the app's data folder (e.g. `%APPDATA%/LocalAIStudio/temp/`).
- Preview panel loads directly from that temp file.
- A "save" button in the preview panel opens the native OS save dialog (Electron `dialog.showSaveDialog`), defaulting to `Documents/LocalAIStudio/<task-type>/` with an auto-generated filename (e.g. `image_2026-07-30_1432.png`), user can rename or redirect.
- On app quit, the temp directory is cleared.
- On app launch, before anything else, check for and clear any leftover temp files from a previous session that ended in a crash (i.e. temp folder wasn't empty at startup) — prevents orphaned files from piling up.

## 5. UI structure

- **Top toolbar:** one button per task type (text-to-image, text-to-video, text-to-music, image-to-image, and a `+` to reveal more as they're added). Selecting a task swaps the left panel's fields.
- **Left panel (per task):**
  - Model dropdown (default pre-selected, alternates listed, "set as default" option)
  - Task-appropriate inputs: text prompt always; image upload field appears only for image-conditioned tasks; duration/length slider for video and music.
  - Generate button.
  - If the selected model isn't downloaded yet, this area shows install/download progress instead of being blocked — user sees exactly what's happening, not a spinner.
- **Right panel (preview):**
  - Empty state before first generation.
  - Shows image/video/audio player appropriate to the output type once generation completes.
  - Status line beneath showing which model produced it.
  - Save button at the bottom, opening the native save dialog as described in 4.5.

## 6. First-run flow

1. App launches, runs hardware detection, stores the profile locally.
2. No models downloaded yet — all toolbar options are visible but unconfigured.
3. User picks a task (e.g. text-to-image) → app immediately begins downloading the matrix-selected default model for that task, showing progress in the left panel.
4. Once installed and smoke-tested, the task becomes usable.
5. Other tasks remain undownloaded until the user selects them for the first time — no unnecessary upfront downloads for capabilities the user hasn't asked for.

## 7. Error handling principles

- Never let a "successful" install mask a broken generation path — the smoke test in 4.3 is mandatory, not optional.
- If a generation fails at runtime (OOM, engine crash, etc.), surface a plain-language message in the preview panel with a retry option, not a raw stack trace.
- If VRAM is insufficient for the currently selected model mid-session (e.g. another app is using the GPU), catch the OOM and suggest switching to a lighter alternate model from the same dropdown.

## 8. Suggested build order (for incremental testing)

1. Electron shell + toolbar UI skeleton (no backend yet, static preview placeholder).
2. Hardware detection module, tested standalone against a few known machines.
3. Model registry format + default-selection logic, unit-testable independent of UI.
4. Download/install manager for a single model (SDXL Turbo is a good first target: well documented, modest VRAM requirement).
5. ComfyUI subprocess wrapper + `generate()` interface for text-to-image only.
6. Wire UI to the working text-to-image path end to end, including save flow.
7. Repeat 4–6 for text-to-video, then text-to-music.
8. Model switching + "set as default" persistence.
9. Crash-recovery temp cleanup + polish error states.

## 9. Open items for later phases

- Mac/Linux hardware detection and engine compatibility (Metal/ROCm).
- Expanding the compatibility matrix beyond the initial curated list.
- Auto-updating the registry from a hosted source vs. bundling only.
- History/library view for past generations (currently out of scope — save-or-discard only).
