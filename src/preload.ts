import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  transcribe: (base64: string, sampleRate: number): Promise<string> =>
    ipcRenderer.invoke('transcribe', base64, sampleRate),

  saveTranscript: (text: string): Promise<string | null> =>
    ipcRenderer.invoke('save-transcript', text),

  getDesktopSource: (): Promise<string | null> =>
    ipcRenderer.invoke('get-desktop-source'),

  onStatus: (cb: (msg: string) => void) =>
    ipcRenderer.on('status', (_e, msg) => cb(msg)),

  onModelReady: (cb: () => void) =>
    ipcRenderer.once('model-ready', () => cb()),

  downloadUpdate: (): Promise<void> =>
    ipcRenderer.invoke('update:download'),

  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke('update:install'),

  onUpdateAvailable: (cb: (info: { version: string }) => void) =>
    ipcRenderer.on('update:available', (_e, info) => cb(info)),

  onUpdateProgress: (cb: (info: { percent: number }) => void) =>
    ipcRenderer.on('update:progress', (_e, info) => cb(info)),

  onUpdateReady: (cb: () => void) =>
    ipcRenderer.once('update:ready', () => cb()),
});
