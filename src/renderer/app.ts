// No imports — file compiles to plain browser-compatible JS

interface ElectronAPI {
  transcribe: (base64: string, sampleRate: number) => Promise<string>;
  saveTranscript: (text: string) => Promise<string | null>;
  getDesktopSource: () => Promise<string | null>;
  onStatus: (cb: (msg: string) => void) => void;
  onModelReady: (cb: () => void) => void;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  onUpdateAvailable: (cb: (info: { version: string }) => void) => void;
  onUpdateProgress: (cb: (info: { percent: number }) => void) => void;
  onUpdateReady: (cb: () => void) => void;
}

const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

// --- State ---
let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let isRecording = false;
let modelReady = false;
let isOutputMode = false;
let capturedSampleRate = 16000;
let pcmChunks: Float32Array[] = [];
let fullTranscript = '';

// --- DOM ---
const modeInputBtn     = document.getElementById('mode-input')       as HTMLButtonElement;
const modeOutputBtn    = document.getElementById('mode-output')      as HTMLButtonElement;
const deviceSection    = document.getElementById('device-section')   as HTMLElement;
const outputSection    = document.getElementById('output-section')   as HTMLElement;
const deviceSelect     = document.getElementById('device-select')    as HTMLSelectElement;
const outputSelect     = document.getElementById('output-select')    as HTMLSelectElement;
const refreshBtn       = document.getElementById('refresh-btn')      as HTMLButtonElement;
const refreshOutputBtn = document.getElementById('refresh-output-btn') as HTMLButtonElement;
const recordBtn        = document.getElementById('record-btn')       as HTMLButtonElement;
const recordLabel      = document.getElementById('record-label')     as HTMLSpanElement;
const transcriptArea   = document.getElementById('transcript')       as HTMLTextAreaElement;
const statusEl         = document.getElementById('status')           as HTMLSpanElement;
const statusDot        = document.getElementById('status-dot')       as HTMLSpanElement;
const levelBar         = document.getElementById('level-bar')        as HTMLElement;
const saveBtn          = document.getElementById('save-btn')         as HTMLButtonElement;
const clearBtn         = document.getElementById('clear-btn')        as HTMLButtonElement;
const copyBtn          = document.getElementById('copy-btn')         as HTMLButtonElement;
const updateBar        = document.getElementById('update-bar')       as HTMLElement;
const updateMsg        = document.getElementById('update-msg')       as HTMLSpanElement;
const updateBtn        = document.getElementById('update-btn')       as HTMLButtonElement;

// --- Init ---
api.onStatus((msg) => {
  statusEl.textContent = msg;
  if (!isRecording) statusDot.className = 'status-dot';
});

api.onModelReady(() => {
  modelReady = true;
  statusDot.className = 'status-dot ready';
  recordBtn.disabled = false;
});

populateDevices();

// --- Mode Toggle ---
modeInputBtn.addEventListener('click', () => {
  if (isRecording) return;
  isOutputMode = false;
  modeInputBtn.classList.add('active');
  modeOutputBtn.classList.remove('active');
  deviceSection.classList.remove('hidden');
  outputSection.classList.add('hidden');
});

modeOutputBtn.addEventListener('click', () => {
  if (isRecording) return;
  isOutputMode = true;
  modeOutputBtn.classList.add('active');
  modeInputBtn.classList.remove('active');
  deviceSection.classList.add('hidden');
  outputSection.classList.remove('hidden');
  populateOutputDevices();
});

// --- Audio Devices ---
async function populateDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (_) {}

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs  = devices.filter((d) => d.kind === 'audioinput');

  deviceSelect.innerHTML = '';
  inputs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Mikrofon ${i + 1}`;
    deviceSelect.appendChild(opt);
  });
}

async function populateOutputDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (_) {}

  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs  = devices.filter((d) => d.kind === 'audiooutput');

  outputSelect.innerHTML = '';
  outputs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Ausgabegerät ${i + 1}`;
    outputSelect.appendChild(opt);
  });
}

refreshBtn.addEventListener('click', populateDevices);
refreshOutputBtn.addEventListener('click', populateOutputDevices);

// --- Recording ---
recordBtn.addEventListener('click', () => {
  if (!modelReady) return;
  isRecording ? stopRecording() : startRecording();
});

async function startRecording() {
  try {
    if (isOutputMode) {
      await startOutputCapture();
    } else {
      await startInputCapture();
    }
    isRecording = true;
    pcmChunks   = [];
    flushTimer  = setInterval(flushChunks, 5000);
    setRecordingUI(true);
  } catch (err) {
    statusEl.textContent = `Fehler beim Öffnen: ${err}`;
  }
}

async function startInputCapture() {
  const deviceId = deviceSelect.value;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId
      ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  attachProcessor(mediaStream);
}

async function startOutputCapture() {
  const sourceId = await api.getDesktopSource();
  if (!sourceId) throw new Error('Kein Desktop-Source gefunden');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } as any,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 1, maxHeight: 1 } } as any,
  });

  mediaStream.getVideoTracks().forEach((t) => t.stop());
  attachProcessor(mediaStream);
}

function attachProcessor(stream: MediaStream) {
  // Use native hardware rate — don't force 16 kHz on the context
  audioCtx  = new AudioContext();
  capturedSampleRate = audioCtx.sampleRate;

  const src = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!isRecording) return;

    const input = e.inputBuffer.getChannelData(0);
    pcmChunks.push(Float32Array.from(input));

    // Update level meter
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    levelBar.style.width = `${Math.min(100, rms * 600)}%`;
  };

  src.connect(processor);
  processor.connect(audioCtx.destination);
}

async function stopRecording() {
  isRecording = false;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  levelBar.style.width = '0%';

  if (pcmChunks.length > 0) {
    await flushChunks();
  }

  processor?.disconnect();
  mediaStream?.getTracks().forEach((t) => t.stop());
  await audioCtx?.close();
  processor = null;
  mediaStream = null;
  audioCtx = null;

  setRecordingUI(false);
  statusEl.textContent = 'Bereit';
  statusDot.className = 'status-dot ready';
}

async function flushChunks() {
  const chunks = pcmChunks.splice(0);
  if (chunks.length === 0) return;
  const totalLen = chunks.reduce((n, c) => n + c.length, 0);
  // Skip chunks shorter than 0.5 s — too short for Whisper
  if (totalLen < capturedSampleRate * 0.5) return;

  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }

  const durationSec = (totalLen / capturedSampleRate).toFixed(1);
  statusEl.textContent = `Transkribiere (${durationSec}s)...`;

  const pcm16k = resampleTo16k(merged, capturedSampleRate);

  try {
    const text = await api.transcribe(float32ToBase64(pcm16k), 16000);
    if (text && text.trim()) {
      fullTranscript += (fullTranscript ? ' ' : '') + text.trim();
      transcriptArea.value = fullTranscript;
      transcriptArea.scrollTop = transcriptArea.scrollHeight;
    } else {
      // Don't overwrite status with empty result
    }
  } catch (err) {
    statusEl.textContent = `Transkriptionsfehler: ${err}`;
  }

  if (isRecording) {
    statusEl.textContent = isOutputMode ? 'Systemton läuft...' : 'Aufnahme läuft...';
    statusDot.className  = 'status-dot recording';
  }
}

function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return input;
  const ratio  = fromRate / 16000;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const lo  = Math.floor(pos);
    const hi  = Math.min(lo + 1, input.length - 1);
    output[i] = input[lo] + (input[hi] - input[lo]) * (pos - lo);
  }
  return output;
}

function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer);
  let binary  = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function setRecordingUI(active: boolean) {
  recordBtn.classList.toggle('recording', active);
  modeInputBtn.disabled  = active;
  modeOutputBtn.disabled = active;

  if (active) {
    recordLabel.textContent = 'Aufnahme stoppen';
    statusEl.textContent    = isOutputMode ? 'Systemton läuft...' : 'Aufnahme läuft...';
    statusDot.className     = 'status-dot recording';
  } else {
    recordLabel.textContent = 'Aufnahme starten';
  }
}

// --- Toolbar ---
saveBtn.addEventListener('click', async () => {
  if (!fullTranscript) return;
  const filePath = await api.saveTranscript(fullTranscript);
  if (filePath) statusEl.textContent = `Gespeichert: ${filePath.split(/[\\/]/).pop()}`;
});

clearBtn.addEventListener('click', () => {
  fullTranscript = '';
  transcriptArea.value = '';
});

copyBtn.addEventListener('click', () => {
  if (!fullTranscript) return;
  navigator.clipboard.writeText(fullTranscript);
  const prev = copyBtn.textContent!;
  copyBtn.textContent = 'Kopiert!';
  setTimeout(() => (copyBtn.textContent = prev), 1500);
});

// --- Auto-Update ---
api.onUpdateAvailable(({ version }) => {
  updateMsg.textContent = `Update v${version} verfügbar`;
  updateBtn.textContent = 'Herunterladen';
  updateBar.classList.remove('hidden');

  updateBtn.onclick = async () => {
    updateBtn.disabled = true;
    updateMsg.textContent = 'Lade herunter...';
    await api.downloadUpdate();
  };
});

api.onUpdateProgress(({ percent }) => {
  updateMsg.textContent = `Herunterladen… ${percent}%`;
});

api.onUpdateReady(() => {
  updateMsg.textContent = 'Update bereit — wird beim Beenden installiert';
  updateBtn.textContent = 'Jetzt neu starten';
  updateBtn.disabled = false;

  updateBtn.onclick = () => api.installUpdate();
});
