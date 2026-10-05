import { createHmac } from "node:crypto";

export function getProgramMonitorRoomName(roomName: string, secret: string): string {
  const digest = createHmac("sha256", secret).update("zonestream-program-monitor:").update(roomName).digest("hex");
  return `zs-monitor-${digest.slice(0, 32)}`;
}
