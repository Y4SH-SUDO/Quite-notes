import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.quietnotes.app',
  appName: 'Quiet Notes',
  webDir: 'dist/public',
  plugins: {
    LocalNotifications: {
      iconColor: '#c9b999',
    },
  },
};

export default config;
