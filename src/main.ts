import { app, BrowserWindow, ipcMain, dialog, session, desktopCapturer } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import fs from 'fs';

autoUpdater.autoDownload    = false;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow: BrowserWindow | null = null;
let whisperPipeline: any = null;
let modelReady = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 660,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0d0d14',
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    autoUpdater.checkForUpdates().catch(() => {});
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture'].includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'display-capture'].includes(permission);
  });
}

async function initWhisper() {
  try {
    mainWindow?.webContents.send('status', 'Lade Whisper-Modell...');

    // new Function prevents TypeScript from compiling import() to require()
    const _import = new Function('id', 'return import(id)');
    const { pipeline, env } = await _import('@xenova/transformers');
    env.cacheDir = path.join(app.getPath('userData'), 'models');

    whisperPipeline = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-small',
      {
        progress_callback: (p: any) => {
          if (p.status === 'downloading') {
            const pct = Math.round(p.progress ?? 0);
            mainWindow?.webContents.send('status', `Lade Modell: ${pct}%`);
          }
        },
      }
    );

    modelReady = true;
    mainWindow?.webContents.send('status', 'Bereit');
    mainWindow?.webContents.send('model-ready');
  } catch (err) {
    mainWindow?.webContents.send('status', `Fehler: ${err}`);
  }
}

ipcMain.handle('get-desktop-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources[0]?.id ?? null;
});

ipcMain.handle('transcribe', async (_event, base64: string, sampleRate: number) => {
  if (!modelReady || !whisperPipeline) {
    throw new Error('Modell noch nicht bereit');
  }

  const bytes = Buffer.from(base64, 'base64');
  const float32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

  const result = await whisperPipeline(float32, {
    sampling_rate: 16000,
    language: 'german',
    task: 'transcribe',
  });
  return (result.text as string).trim();
});

ipcMain.handle('save-transcript', async (_event, text: string) => {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);

  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Transkription speichern',
    defaultPath: path.join(app.getPath('documents'), `Transkription_${timestamp}.txt`),
    filters: [
      { name: 'Textdatei', extensions: ['txt'] },
      { name: 'Markdown', extensions: ['md'] },
    ],
  });

  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, text, 'utf-8');
    return result.filePath;
  }

  return null;
});

app.whenReady().then(() => {
  createWindow();
  setTimeout(initWhisper, 800);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Auto-Updater ──────────────────────────────────────────────────────────────

autoUpdater.on('update-available', (info) => {
  mainWindow?.webContents.send('update:available', { version: info.version });
});

autoUpdater.on('download-progress', (progress) => {
  mainWindow?.webContents.send('update:progress', { percent: Math.round(progress.percent) });
});

autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('update:ready');
});

ipcMain.handle('update:download', () => autoUpdater.downloadUpdate());
ipcMain.handle('update:install',  () => autoUpdater.quitAndInstall());
