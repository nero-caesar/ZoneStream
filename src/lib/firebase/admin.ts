import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export function getFirebaseAdmin() {
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("ZoneStream is not ready to complete this request right now.");
  }

  const appName = "zonestream-admin";
  const app = getApps().find((candidate) => candidate.name === appName)
    ?? initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
    }, appName);

  return {
    app,
    auth: getAuth(app),
    firestore: getFirestore(app),
  };
}
