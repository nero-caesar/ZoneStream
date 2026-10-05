import { getMessaging } from "firebase-admin/messaging";
import { getFirebaseAdmin } from "../firebase/admin";

export type IndividualNotification = {
  title: string;
  body: string;
  url: string;
  kind: "live_started" | "recording_uploaded";
  tag: string;
};

export async function sendIndividualNotification(notification: IndividualNotification): Promise<number> {
  const { app, firestore } = getFirebaseAdmin();
  const snapshot = await firestore.collection("notificationDevices").where("role", "==", "individual").get();
  const activeDevices = snapshot.docs.filter((document) => {
    const data = document.data();
    return data.active === true && typeof data.fid === "string";
  });
  if (!activeDevices.length) return 0;

  const messaging = getMessaging(app);
  let sentCount = 0;
  const staleDeviceIds: string[] = [];

  for (let offset = 0; offset < activeDevices.length; offset += 500) {
    const batch = activeDevices.slice(offset, offset + 500);
    const response = await messaging.sendEach(batch.map((device) => ({
      fid: device.get("fid") as string,
      data: {
        title: notification.title,
        body: notification.body,
        url: notification.url,
        kind: notification.kind,
        tag: notification.tag,
      },
      webpush: { headers: { Urgency: "high" } },
    })));

    response.responses.forEach((result, index) => {
      if (result.success) sentCount += 1;
      else if (result.error?.code === "messaging/installation-id-not-registered") {
        staleDeviceIds.push(batch[index].id);
      }
    });
  }

  if (staleDeviceIds.length) {
    const batch = firestore.batch();
    staleDeviceIds.forEach((id) => batch.delete(firestore.collection("notificationDevices").doc(id)));
    await batch.commit().catch(() => undefined);
  }

  return sentCount;
}
