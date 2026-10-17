import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import { firebaseClientConfig, isFirebaseConfigured } from './firebase-config';

export function getFirebaseServices(): {
  app: FirebaseApp;
  auth: Auth;
  firestore: Firestore;
  storage: FirebaseStorage | undefined;
} {
  if (!isFirebaseConfigured()) {
    throw new Error('Cloud sync is not configured. Add the Firebase web configuration to the app environment.');
  }
  const app = getApps().length ? getApp() : initializeApp(firebaseClientConfig());
  return {
    app,
    auth: getAuth(app),
    firestore: getFirestore(app),
    storage: firebaseClientConfig().storageBucket ? getStorage(app) : undefined,
  };
}
