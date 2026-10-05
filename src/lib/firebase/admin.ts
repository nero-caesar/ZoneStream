import { createRequire } from "node:module";

const requireFromProject = createRequire(`${process.cwd()}/package.json`);

export function getFirebaseAdmin() {
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("ZoneStream is not ready to complete this request right now.");
  }

  // Load Firebase Admin only when a server request actually needs it. This keeps
  // unauthenticated requests and server-rendered pages from crashing at module load.
  const { cert, getApps, initializeApp } = requireFromProject("firebase-admin/app") as typeof import("firebase-admin/app");
  const { getAuth } = requireFromProject("firebase-admin/auth") as typeof import("firebase-admin/auth");
  const { getFirestore } = requireFromProject("firebase-admin/firestore") as typeof import("firebase-admin/firestore");

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
