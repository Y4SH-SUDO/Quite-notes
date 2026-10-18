import { Capacitor, registerPlugin } from '@capacitor/core';

type ImmersiveReaderPlugin = {
  enter(): Promise<void>;
  exit(): Promise<void>;
};

const immersiveReaderPlugin = registerPlugin<ImmersiveReaderPlugin>('ImmersiveReader');

export async function enterImmersiveReading(): Promise<void> {
  if (Capacitor.getPlatform() === 'android') {
    await immersiveReaderPlugin.enter();
    return;
  }
  if (document.fullscreenElement) return;
  await document.documentElement.requestFullscreen();
}

export async function exitImmersiveReading(): Promise<void> {
  if (Capacitor.getPlatform() === 'android') {
    await immersiveReaderPlugin.exit();
    return;
  }
  if (document.fullscreenElement) await document.exitFullscreen();
}
