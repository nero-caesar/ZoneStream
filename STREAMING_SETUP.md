# ZoneStream streaming pilot

ZoneStream's first live streaming path uses WebRTC through LiveKit. The Next.js server creates a short-lived participant token. Hosts can publish audio/video; viewers can only subscribe.

## Connect LiveKit

1. Create a LiveKit Cloud project on its free Build plan.
2. Copy the project's WebSocket server URL, API key, and API secret.
3. Copy `.env.example` to `.env.local` in the project root and replace the placeholder values.
4. Set `LIVEKIT_DEMO_HOST_PIN` to a private studio code. It is only checked by the server and should not be shared with viewers.
5. Restart the development server.
6. Open `/stream/studio`, enter a program title and studio code, then start the broadcast. Share the audience link shown in the studio.

Viewers open the shared `/stream/watch/...` link and enter a display name. The studio can mute/unmute, turn the camera off/on, copy the audience link, and end the room. Ending the room disconnects everyone in it.

## Pilot boundaries

The viewer link is open to anyone who has it. The studio code is shared and has no per-account rate limit. Do not use this pilot for restricted real services or expose the studio publicly yet. Firebase authentication and the Zonal Church program rules still need to be added before that.

LiveKit's current free Build plan caps the project at 100 connected participants across its rooms. It has a hard cap, so new connections stop when an included quota is reached. Larger audiences need a scale and cost review. This app does not configure paid billing.
