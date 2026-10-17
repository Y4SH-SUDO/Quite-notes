import {
  createBackup,
  embeddedImageCount,
  parseBackupText,
  type BackupWorkerRequest,
  type BackupWorkerResponse,
} from './backup';

self.onmessage = (event: MessageEvent<BackupWorkerRequest>) => {
  try {
    let response: BackupWorkerResponse;
    if (event.data.action === 'parse') {
      const backup = parseBackupText(event.data.text);
      response = { ok: true, value: backup, imageCount: embeddedImageCount(backup.notes) };
    } else {
      const backup = createBackup(event.data.notes, event.data.settings);
      response = { ok: true, value: JSON.stringify(backup, null, 2) };
    }
    self.postMessage(response);
  } catch (error) {
    const response: BackupWorkerResponse = {
      ok: false,
      error: error instanceof Error ? error.message : 'Backup processing failed.',
    };
    self.postMessage(response);
  }
};
