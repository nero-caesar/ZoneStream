"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, inMemoryPersistence, setPersistence } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;

export function isFirebaseClientConfigured(): boolean {
  return Object.values(firebaseConfig).every((value) => typeof value === "string" && value.length > 0);
}

export function getFirebaseClient() {
  if (!isFirebaseClientConfigured()) {
    throw new Error("ZoneStream is not ready to connect right now. Please try again later.");
  }

  const app = getApps().length
    ? getApp()
    : initializeApp({
      ...firebaseConfig,
      ...(messagingSenderId ? { messagingSenderId } : {}),
    });
  const auth = getAuth(app);
  return { app, auth };
}

export async function prepareInMemoryAuth() {
  const { auth } = getFirebaseClient();
  await setPersistence(auth, inMemoryPersistence);
  return auth;
}
