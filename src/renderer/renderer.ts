interface TaskDefinition {
  id: string;
  label: string;
  hasImageInput: boolean;
  hasDurationInput: boolean;
}

const TASKS: TaskDefinition[] = [
  { id: "text-to-image", label: "Text to Image", hasImageInput: false, hasDurationInput: false },
  { id: "text-to-video", label: "Text to Video", hasImageInput: false, hasDurationInput: true },
  { id: "text-to-music", label: "Text to Music", hasImageInput: false, hasDurationInput: true },
  { id: "image-to-image", label: "Image to Image", hasImageInput: true, hasDurationInput: false }
];

interface ModelOption {
  id: string;
  label: string;
  installed: boolean;
  downloadAvailable: boolean;
  min_vram_gb: number;
  content_policy: "strict" | "moderate" | "unrestricted";
  workflow?: string;
}

interface ModelSelectionPayload {
  default: ModelOption | null;
  alternates: ModelOption[];
}

interface InstallProgress {
  phase:
    | "cloning-source"
    | "installing-custom-nodes"
    | "configuring-model-paths"
    | "creating-venv"
    | "installing-torch"
    | "installing-requirements"
    | "downloading"
    | "verifying"
    | "installing-dependencies"
    | "smoke-testing"
    | "ready"
    | "failed";
  detail?: string;
  downloadProgress?: { downloadedBytes: number; totalBytes: number | null };
}

type GenerateResult = { status: "success"; output_path: string } | { status: "error"; error: string };

interface Window {
  api: {
    getHardwareProfile(): Promise<unknown>;
    getModelSelection(taskType: string): Promise<ModelSelectionPayload>;
    installModel(modelId: string): Promise<{ success: boolean; error?: string }>;
    setDefaultModel(taskType: string, modelId: string): Promise<void>;
    onInstallProgress(callback: (payload: { modelId: string; event: InstallProgress }) => void): () => void;
    generate(
      taskType: string,
      modelId: string,
      inputs: { prompt: string; durationSeconds?: number; sourceImagePath?: string; lyrics?: string }
    ): Promise<GenerateResult>;
    saveOutput(sourcePath: string, taskType: string): Promise<{ saved: boolean; path?: string; error?: string }>;
  };
}

let activeTaskId: string | null = null;
let currentSelection: ModelSelectionPayload | null = null;
let selectedModelId: string | null = null;
/** Kept outside the DOM so the prompt survives renderLeftPanel() rebuilds (e.g. when Generate flips isGenerating), not just user edits. */
let currentPrompt = "";
/** Same reasoning as currentPrompt — without this, the duration slider silently snapped back to its hardcoded default every time Generate re-rendered the panel. */
let currentDurationSeconds = 5;
/** Same reasoning as currentPrompt. Only shown for models that can sing (ACE-Step). */
let currentLyrics = "";
let installProgress: InstallProgress | null = null;
let installError: string | null = null;
let isGenerating = false;
let generatingIsModelSwitch = false;
let lastResult: GenerateResult | null = null;
let saveMessage: string | null = null;
let unsubscribeInstallProgress: (() => void) | null = null;
/** Which model actually produced the last generation, per task — drives the "switching model" label (spec §4.4). */
const lastGeneratedModelByTask: Record<string, string> = {};

function renderToolbar(): void {
  const container = document.getElementById("toolbar-tasks")!;
  container.innerHTML = "";

  for (const task of TASKS) {
    const button = document.createElement("button");
    button.className = "task-button" + (task.id === activeTaskId ? " active" : "");
    button.textContent = task.label;
    button.addEventListener("click", () => selectTask(task.id));
    container.appendChild(button);
  }
}

async function selectTask(taskId: string): Promise<void> {
  activeTaskId = taskId;
  currentSelection = null;
  selectedModelId = null;
  installProgress = null;
  installError = null;
  lastResult = null;
  saveMessage = null;
  currentPrompt = "";
  currentDurationSeconds = 5;
  currentLyrics = "";
  unsubscribeInstallProgress?.();
  unsubscribeInstallProgress = null;

  renderToolbar();
  renderLeftPanel();
  renderRightPanel();

  currentSelection = await window.api.getModelSelection(taskId);
  selectedModelId = currentSelection.default?.id ?? null;
  renderLeftPanel();

  const selected = findSelectedOption();
  if (selected && selected.downloadAvailable && !selected.installed) {
    startInstall(selected.id);
  }
}

function findSelectedOption(): ModelOption | null {
  if (!currentSelection || !selectedModelId) return null;
  if (currentSelection.default?.id === selectedModelId) return currentSelection.default;
  return currentSelection.alternates.find((option) => option.id === selectedModelId) ?? null;
}

/** Spec §7: "catch the OOM and suggest switching to a lighter alternate model from the same dropdown." */
function isLikelyOomError(message: string): boolean {
  return /out of memory|\boom\b|cuda error|insufficient (gpu )?memory/i.test(message);
}

function findLighterInstalledAlternatives(): ModelOption[] {
  if (!currentSelection) return [];
  const current = findSelectedOption();
  if (!current) return [];

  const all = currentSelection.default ? [currentSelection.default, ...currentSelection.alternates] : currentSelection.alternates;
  return all
    .filter((option) => option.installed && option.id !== current.id && option.min_vram_gb < current.min_vram_gb)
    .sort((a, b) => a.min_vram_gb - b.min_vram_gb);
}

function startInstall(modelId: string): void {
  installProgress = { phase: "downloading" };
  installError = null;
  renderLeftPanel();

  unsubscribeInstallProgress?.();
  unsubscribeInstallProgress = window.api.onInstallProgress((payload) => {
    if (payload.modelId !== modelId) return;
    installProgress = payload.event;
    renderLeftPanel();
  });

  window.api
    .installModel(modelId)
    .then((result) => {
      if (!result.success) {
        installError = result.error ?? "Install failed";
      }
    })
    .finally(() => {
      unsubscribeInstallProgress?.();
      unsubscribeInstallProgress = null;
      refreshSelectionAfterInstall(modelId);
    });
}

async function refreshSelectionAfterInstall(modelId: string): Promise<void> {
  if (!activeTaskId) return;
  currentSelection = await window.api.getModelSelection(activeTaskId);
  if (selectedModelId === modelId) {
    renderLeftPanel();
  }
}

async function handleSetDefault(): Promise<void> {
  if (!activeTaskId || !selectedModelId) return;

  await window.api.setDefaultModel(activeTaskId, selectedModelId);
  currentSelection = await window.api.getModelSelection(activeTaskId);
  renderLeftPanel();
}

function onModelSelected(modelId: string): void {
  selectedModelId = modelId;
  installProgress = null;
  installError = null;
  renderLeftPanel();

  const selected = findSelectedOption();
  if (selected && selected.downloadAvailable && !selected.installed) {
    startInstall(selected.id);
  }
}

function renderLeftPanel(): void {
  const panel = document.getElementById("left-panel")!;
  const task = TASKS.find((t) => t.id === activeTaskId);

  if (!task) {
    panel.innerHTML = `<p class="empty-state">Select a task above to get started.</p>`;
    return;
  }

  if (!currentSelection) {
    panel.innerHTML = `<p class="empty-state">Loading models…</p>`;
    return;
  }

  panel.innerHTML = "";

  const options = currentSelection.default
    ? [currentSelection.default, ...currentSelection.alternates]
    : currentSelection.alternates;

  const modelGroup = document.createElement("div");
  modelGroup.className = "field-group";
  const selectEl = document.createElement("select");
  selectEl.id = "model-select";
  selectEl.disabled = options.length === 0 || isGenerating;
  if (options.length === 0) {
    selectEl.innerHTML = `<option>No compatible model for this hardware</option>`;
  } else {
    selectEl.innerHTML = options
      .map((option) => {
        const policyTag = option.content_policy === "unrestricted" ? " — Unrestricted" : "";
        const stateTag = option.downloadAvailable ? (option.installed ? " (installed)" : "") : " (not available yet)";
        return `<option value="${option.id}"${
          option.id === selectedModelId ? " selected" : ""
        }>${option.label}${policyTag}${stateTag}</option>`;
      })
      .join("");
  }
  selectEl.addEventListener("change", () => onModelSelected(selectEl.value));
  modelGroup.innerHTML = `<label for="model-select">Model</label>`;
  modelGroup.appendChild(selectEl);
  panel.appendChild(modelGroup);

  const selected = findSelectedOption();

  if (selected && currentSelection.default && selected.id !== currentSelection.default.id) {
    const setDefaultButton = document.createElement("button");
    setDefaultButton.className = "set-default-button";
    setDefaultButton.textContent = "Set as default";
    setDefaultButton.addEventListener("click", handleSetDefault);
    panel.appendChild(setDefaultButton);
  }

  if (selected && !selected.downloadAvailable) {
    const note = document.createElement("p");
    note.className = "unavailable-note";
    note.textContent = "No download is configured for this model yet.";
    panel.appendChild(note);
  }

  if (selected && selected.downloadAvailable && !selected.installed) {
    panel.appendChild(renderInstallProgress());
    return;
  }

  if (task.hasImageInput) {
    const imageGroup = document.createElement("div");
    imageGroup.className = "field-group";
    imageGroup.innerHTML = `
      <label for="image-input">Source image</label>
      <input type="file" id="image-input" accept="image/*" />
    `;
    panel.appendChild(imageGroup);
  }

  const promptGroup = document.createElement("div");
  promptGroup.className = "field-group";
  promptGroup.innerHTML = `
    <label for="prompt-input">Prompt</label>
    <textarea id="prompt-input" placeholder="Describe what you want to generate...">${escapeHtml(currentPrompt)}</textarea>
  `;
  const promptTextarea = promptGroup.querySelector("#prompt-input") as HTMLTextAreaElement;
  promptTextarea.addEventListener("input", () => {
    currentPrompt = promptTextarea.value;
  });
  const clearPromptButton = document.createElement("button");
  clearPromptButton.className = "clear-prompt-button";
  clearPromptButton.textContent = "Clear Prompt";
  clearPromptButton.disabled = isGenerating;
  clearPromptButton.addEventListener("click", () => {
    currentPrompt = "";
    promptTextarea.value = "";
  });
  promptGroup.appendChild(clearPromptButton);
  panel.appendChild(promptGroup);

  if (findSelectedOption()?.workflow === "ace-step-1.5") {
    const lyricsGroup = document.createElement("div");
    lyricsGroup.className = "field-group";
    lyricsGroup.innerHTML = `
      <label for="lyrics-input">Lyrics (optional — leave empty for an instrumental)</label>
      <textarea id="lyrics-input" placeholder="[Verse]&#10;...">${escapeHtml(currentLyrics)}</textarea>
    `;
    const lyricsTextarea = lyricsGroup.querySelector("#lyrics-input") as HTMLTextAreaElement;
    lyricsTextarea.addEventListener("input", () => {
      currentLyrics = lyricsTextarea.value;
    });
    panel.appendChild(lyricsGroup);
  }

  if (task.hasDurationInput) {
    const durationGroup = document.createElement("div");
    durationGroup.className = "field-group";
    durationGroup.innerHTML = `
      <label for="duration-input">Duration: <span id="duration-value">${currentDurationSeconds}</span>s</label>
      <input type="range" id="duration-input" min="1" max="30" value="${currentDurationSeconds}" />
    `;
    const durationRangeInput = durationGroup.querySelector("#duration-input") as HTMLInputElement;
    const durationValueEl = durationGroup.querySelector("#duration-value")!;
    durationRangeInput.addEventListener("input", () => {
      currentDurationSeconds = Number(durationRangeInput.value);
      durationValueEl.textContent = durationRangeInput.value;
    });
    panel.appendChild(durationGroup);
  }

  const generateButton = document.createElement("button");
  generateButton.className = "generate-button";
  generateButton.textContent = isGenerating
    ? generatingIsModelSwitch
      ? "Switching model & generating…"
      : "Generating…"
    : "Generate";
  generateButton.disabled = isGenerating || !selected || !selected.downloadAvailable || !selected.installed;
  generateButton.addEventListener("click", handleGenerate);
  panel.appendChild(generateButton);
}

function renderInstallProgress(): HTMLElement {
  const container = document.createElement("div");
  container.className = "install-progress";

  const label = document.createElement("p");
  label.className = "install-progress-label";
  label.textContent = describeInstallPhase(installProgress);
  container.appendChild(label);

  const track = document.createElement("div");
  track.className = "progress-track";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  const dp = installProgress?.downloadProgress;
  if (dp?.totalBytes) {
    fill.style.width = `${Math.min(100, Math.round((dp.downloadedBytes / dp.totalBytes) * 100))}%`;
  }
  track.appendChild(fill);
  container.appendChild(track);

  if (installError) {
    const errorEl = document.createElement("p");
    errorEl.className = "install-error";
    errorEl.textContent = installError;
    container.appendChild(errorEl);

    const retryButton = document.createElement("button");
    retryButton.className = "retry-button";
    retryButton.textContent = "Retry install";
    retryButton.addEventListener("click", () => {
      if (selectedModelId) startInstall(selectedModelId);
    });
    container.appendChild(retryButton);
  }

  return container;
}

function describeInstallPhase(progress: InstallProgress | null): string {
  if (!progress) return "Preparing install…";
  switch (progress.phase) {
    // Engine setup — a one-time cost the first time any model on this
    // engine is installed, ahead of the model's own download below (spec
    // §6: the app should be usable right after install with no separate
    // setup step, so this now happens automatically here).
    case "cloning-source":
      return "Downloading the generation engine (this can take a few minutes)…";
    case "installing-custom-nodes":
      return "Installing engine add-ons…";
    case "configuring-model-paths":
      return "Configuring the engine…";
    case "installing-torch":
      return "Installing PyTorch and CUDA support (this can take several minutes)…";
    case "installing-requirements":
      return "Installing the engine's Python dependencies…";
    // Per-model phases.
    case "downloading": {
      const dp = progress.downloadProgress;
      if (dp?.totalBytes) {
        const pct = Math.round((dp.downloadedBytes / dp.totalBytes) * 100);
        return `Downloading model… ${pct}%`;
      }
      return "Downloading model…";
    }
    case "verifying":
      return "Verifying download…";
    case "creating-venv":
      return "Setting up environment…";
    case "installing-dependencies":
      return "Installing dependencies…";
    case "smoke-testing":
      return "Confirming the install works…";
    case "ready":
      return "Ready";
    case "failed":
      return "Install failed";
    default:
      return "Preparing install…";
  }
}

async function handleGenerate(): Promise<void> {
  if (!activeTaskId || !selectedModelId) return;

  const taskId = activeTaskId;
  const modelId = selectedModelId;
  const task = TASKS.find((t) => t.id === taskId);
  const prompt = currentPrompt.trim();
  const durationInput = document.getElementById("duration-input") as HTMLInputElement | null;
  const durationSeconds = durationInput ? Number(durationInput.value) : undefined;

  const imageInput = document.getElementById("image-input") as HTMLInputElement | null;
  // Electron adds a real filesystem `.path` to renderer File objects, outside the standard File type.
  const sourceImagePath = imageInput?.files?.[0] ? (imageInput.files[0] as unknown as { path: string }).path : undefined;

  if (task?.hasImageInput && !sourceImagePath) {
    lastResult = { status: "error", error: "Choose a source image first." };
    renderRightPanel();
    return;
  }

  isGenerating = true;
  generatingIsModelSwitch = lastGeneratedModelByTask[taskId] !== undefined && lastGeneratedModelByTask[taskId] !== modelId;
  lastResult = null;
  saveMessage = null;
  renderLeftPanel();
  renderRightPanel();

  const lyrics = document.getElementById("lyrics-input") ? currentLyrics : undefined;
  lastResult = await window.api.generate(taskId, modelId, { prompt, durationSeconds, sourceImagePath, lyrics });
  lastGeneratedModelByTask[taskId] = modelId;

  isGenerating = false;
  renderLeftPanel();
  renderRightPanel();
}

function renderRightPanel(): void {
  const panel = document.getElementById("right-panel")!;
  panel.innerHTML = "";

  if (isGenerating) {
    panel.innerHTML = `<p class="preview-empty-state">Generating…</p>`;
    return;
  }

  if (!lastResult) {
    panel.innerHTML = `<p class="preview-empty-state">Your generated output will appear here.</p>`;
    return;
  }

  if (lastResult.status === "error") {
    const banner = document.createElement("div");
    banner.className = "error-banner";
    banner.innerHTML = `<p class="error-title">Generation failed</p><p>${escapeHtml(lastResult.error)}</p>`;

    if (isLikelyOomError(lastResult.error)) {
      const lighterOptions = findLighterInstalledAlternatives();
      if (lighterOptions.length > 0) {
        const suggestion = document.createElement("div");
        suggestion.className = "oom-suggestion";
        const note = document.createElement("p");
        note.textContent = "This looks like it ran out of GPU memory. Try a lighter model:";
        suggestion.appendChild(note);
        for (const option of lighterOptions) {
          const switchButton = document.createElement("button");
          switchButton.className = "retry-button";
          switchButton.textContent = option.label;
          switchButton.addEventListener("click", () => {
            lastResult = null;
            saveMessage = null;
            onModelSelected(option.id);
            renderRightPanel();
          });
          suggestion.appendChild(switchButton);
        }
        banner.appendChild(suggestion);
      }
    }

    const retryButton = document.createElement("button");
    retryButton.className = "retry-button";
    retryButton.textContent = "Retry";
    retryButton.addEventListener("click", handleGenerate);
    banner.appendChild(retryButton);
    panel.appendChild(banner);
    return;
  }

  const selected = findSelectedOption();
  const content = document.createElement("div");
  content.className = "preview-content";

  const isAudio = /\.(wav|mp3)$/i.test(lastResult.output_path);
  if (isAudio) {
    const audio = document.createElement("audio");
    audio.className = "preview-audio";
    audio.controls = true;
    audio.src = toFileUrl(lastResult.output_path);
    content.appendChild(audio);
  } else {
    const img = document.createElement("img");
    img.className = "preview-image";
    img.src = toFileUrl(lastResult.output_path);
    content.appendChild(img);
  }

  const statusLine = document.createElement("p");
  statusLine.className = "status-line";
  statusLine.textContent = `Generated by ${selected?.label ?? selectedModelId}`;
  content.appendChild(statusLine);

  const saveButton = document.createElement("button");
  saveButton.className = "save-button";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", handleSave);
  content.appendChild(saveButton);

  if (saveMessage) {
    const savedLine = document.createElement("p");
    savedLine.className = "status-line";
    savedLine.textContent = saveMessage;
    content.appendChild(savedLine);
  }

  panel.appendChild(content);
}

async function handleSave(): Promise<void> {
  if (!lastResult || lastResult.status !== "success" || !activeTaskId) return;

  const result = await window.api.saveOutput(lastResult.output_path, activeTaskId);
  if (result.saved) {
    saveMessage = `Saved to ${result.path}`;
  } else if (result.error) {
    saveMessage = `Save failed: ${result.error}`;
  } else {
    saveMessage = null; // user cancelled the dialog — not an error, nothing to say
  }
  renderRightPanel();
}

function toFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  return `file:///${encodeURI(normalized)}`;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

renderToolbar();
renderLeftPanel();
renderRightPanel();
