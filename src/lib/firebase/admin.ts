import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

export function getFirebaseAdmin() {
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    const missingVariables = [
      !projectId ? "FIREBASE_ADMIN_PROJECT_ID or NEXT_PUBLIC_FIREBASE_PROJECT_ID" : null,
      !clientEmail ? "FIREBASE_ADMIN_CLIENT_EMAIL" : null,
      !privateKey ? "FIREBASE_ADMIN_PRIVATE_KEY" : null,
    ].filter((variable): variable is string => variable !== null);
    console.error("[ZoneStream Firebase Admin] Missing environment variable(s)", missingVariables);
    throw new Error("ZoneStream is not ready to complete this request right now.");
  }

  // Initialize Firebase Admin only when a server request actually needs it.
  const appName = "zonestream-admin";
  let app: ReturnType<typeof initializeApp>;
  try {
    app = getApps().find((candidate) => candidate.name === appName)
      ?? initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
        projectId,
      }, appName);
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as { name?: unknown; code?: unknown }
      : null;
    console.error("[ZoneStream Firebase Admin] Initialization failed", {
      name: typeof details?.name === "string" ? details.name : typeof error,
      code: typeof details?.code === "string" ? details.code : undefined,
    });
    throw error;
  }

  return {
    app,
    auth: getAuth(app),
    firestore: getFirestore(app),
  };
}
