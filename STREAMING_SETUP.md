# ZoneStream streaming pilot

ZoneStream's live streaming path uses WebRTC through LiveKit. The Next.js server issues short-lived participant tokens. The host can publish audio and video; audience members can only subscribe.

## Connect LiveKit

1. Create a LiveKit Cloud project on its free Build plan.
2. Copy the project's WebSocket server URL, API key, and API secret.
3. Copy `.env.example` to `.env.local` in the project root and replace the placeholder values.
4. Complete the Firebase setup in [FIREBASE_SETUP.md](FIREBASE_SETUP.md), then restart the development server.
5. Sign in through the Zonal Church portal and open the studio. Enter a program title and start the broadcast. Share the audience link shown in the studio.

Individuals and churches sign in before opening the shared `/stream/watch/...` link. Their registered names and account type are used automatically. The studio shows connected individuals and a directory of registered churches, including church codes and connection times for churches in the live room.

Viewers see an anonymous live connection count. Each connected account session is one connection: people gathered around one church device count as one connection, while a church joining from multiple devices creates multiple connections. The studio shows church join/disconnect activity and milestones for individual viewers without listing individual viewer names.

Individual accounts can opt in to device notifications for an eligible service going live and a new shared recording being published. Church accounts do not receive push notifications because their account is shared; church connections remain visible in the studio. Configure Firebase Web Messaging as described in [FIREBASE_SETUP.md](FIREBASE_SETUP.md). Device-local live recordings do not trigger a shared-video notification.

## Audience access controls

- **All audience access** controls church accounts and regular individual viewers. Turning it off disconnects and blocks both groups. Turning it on allows churches, while the separate regular-individual setting still applies.
- **Regular individual access** controls only regular individuals. Turning it off disconnects and blocks regular individuals; churches remain allowed when All audience access is on.
- **All special access** independently controls every special-code guest. Turning it off disconnects and blocks those guests without changing either regular-access setting.
- Each used special code has its own on/off control. Turning one off disconnects only that guest. Turning it back on allows the same browser session to reconnect with its existing code.

The Zonal Church or Developer Space can generate multiple six-character special-access codes. A code can be used by one signed-in person or church for the live service. The studio then shows the code, the account name and type, and whether that guest is connected, with a separate on/off control. A redeemed code stays reserved through refreshes and stream reconnects. A different login session needs a new code.

Code hashes and encrypted code/session details are stored with the LiveKit room policy. Only the host's server-authorized access endpoint decrypts codes for the studio. Room metadata exposes only access switches and non-identifying code states to connected participants.

Ending the broadcast ends the room and disconnects all participants, including special-code guests.

## Recorded messages and device recordings

Live broadcasts are still recorded automatically on the Studio device. If the browser offers a save-location picker, the recording is written to that chosen file; otherwise the browser downloads it when recording stops. That local broadcast recording is not uploaded to viewers.

Videos uploaded from the Studio now go to the shared Cloudflare R2 library. The signed-in Zonal Church and Developer Space can create uploads. Signed-in individual and church accounts receive temporary playback links from the server. Firestore stores each recording's title and metadata; private R2 objects store the video files.

To connect R2:

1. Create a Standard R2 bucket, for example zonestream-recordings.
2. Create R2 S3 API credentials with Object Read & Write access limited to that bucket. Keep the secret access key private.
3. Copy the account ID, bucket name, access key ID, and secret access key into the corresponding CLOUDFLARE_* variables in the ignored .env.local file. Never use NEXT_PUBLIC_ for these values.
4. In that bucket's CORS settings, allow the ZoneStream development origin http://localhost:3000 and the production app origin. Allow PUT, GET, and HEAD; allow the Content-Type and Range request headers. Add the production origin when the deployed domain is known.
5. Restart the development server. The Studio upload page will enable when the R2 settings are present.

Files up to 100 MiB use one signed upload. Larger videos use multipart uploads with progress updates. The current uploader accepts videos up to 4 TiB. If a multipart upload is abandoned, the app attempts to cancel it; R2 also expires incomplete multipart uploads after its configured lifecycle period.

R2 Standard storage includes 10 GB-month of storage, 1 million write-type operations, and 10 million read-type operations each month, with no internet egress charge. Standard storage above the included amount is currently $0.015 per GB-month; operation charges may apply above their included amounts. Review Cloudflare's current R2 pricing before production use.
## Current boundaries

Church sign-in codes are created by the Zonal Church and provide persistent church login. Keep the church-code encryption secret stable; changing it requires issuing new church codes. The app does not enable Firebase billing, create a Storage bucket, or publish Firebase rules for you.

LiveKit's current free Build plan caps the project at 100 connected participants across its rooms. Larger audiences need a scale and cost review. This app does not configure paid billing.

## Studio password recovery email

Zonal Studio sign-in uses the email already attached to its Firebase account. `ZONAL_RECOVERY_EMAIL` is a separate destination used only for recovery messages, so it can point to the platform owner's inbox without changing that Firebase account.

After a recovery request is approved in Developer Space, ZoneStream creates a Firebase password-reset link for the existing Zonal account and emails that link through EmailJS. Individuals continue to request Firebase's normal password-reset email from their own sign-in page.

To enable Zonal reset emails, create an EmailJS email service and template. Set the template recipient to `{{to_email}}`, include `{{app_name}}`, and make the reset button or link use `{{reset_link}}`. Add `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, and `EMAILJS_PRIVATE_KEY` to the ignored `.env.local` file. The private key must stay server-only. Until these four values are set, Developer Space keeps an approved request available to retry and shows that email delivery needs configuration.
