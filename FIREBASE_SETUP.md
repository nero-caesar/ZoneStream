# Firebase setup for ZoneStream

ZoneStream uses Firebase Authentication for individual accounts and Cloud Firestore for account profiles, church records, access settings, and the current live service. Firestore data is accessed by server routes using the Firebase Admin SDK; browser reads and writes remain denied by `firestore.rules`.

## Firebase project

- Firebase project: `zonestream-live`.
- Web app: `ZoneStream Web`.
- Email/Password sign-in is enabled for individuals.
- Cloud Firestore uses the Africa South (`africa-south1`) region and production mode.
- Keep the browser Firebase settings in the ignored `.env.local` file under the `NEXT_PUBLIC_FIREBASE_*` names from `.env.example`.
- Keep Admin SDK credentials and `FIREBASE_CHURCH_CODE_SECRET` in `.env.local`. Never use `NEXT_PUBLIC_` for server credentials.

## Individual viewer notifications

Push notifications are optional and available only to signed-in individual accounts. They can alert those devices when an eligible service starts and when the Zonal Church publishes a shared recorded message. Church accounts do not get push subscriptions because their logins are shared by a whole church; their live attendance remains visible in the studio.

To enable web push:

1. In Firebase Console, open **Project settings → General** and copy the Web app's Messaging sender ID into `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` in `.env.local`.
2. Open **Project settings → Cloud Messaging → Web configuration**, generate a Web Push certificate key pair, and copy its public key into `NEXT_PUBLIC_FIREBASE_VAPID_KEY`. Keep only the public key in this variable.
3. Restart the development server. An individual can then sign in, choose **Enable notifications** on their dashboard, and allow the browser prompt.

The browser asks for permission only after the person presses that button. ZoneStream sends only generic live and recording notices, not attendee names. Web push requires HTTPS, except on localhost during development. On iPhone and iPad, add ZoneStream to the Home Screen before enabling notifications.

## Zonal Church sign-in

The Zonal Church is a shared institutional account. Staff sign in with the shared password only; the sign-in form has no email field. `ZONAL_RECOVERY_EMAIL` is a private, server-only recovery address attached to the Firebase Auth account. It is used only to receive password reset links; it is not shown in the app or used as the Zonal Church login name. Google sign-in remains off.

Set `ZONAL_RECOVERY_EMAIL` in the ignored `.env.local` file before initial setup. Open `/signup-page-zonal` locally and choose a passphrase with at least 14 characters. The setup route is only available on localhost during development. Firebase Authentication stores the password and sends recovery emails to the configured private address.

To recover or change the shared password:

1. On the Zonal sign-in page, choose **Forgot or need to change the studio password?**
2. Firebase emails a reset link to `ZONAL_RECOVERY_EMAIL`; only someone with access to that inbox can complete the reset.
3. Set a new password of at least 14 characters, then share it with the trusted Zonal Church team.

The reset request is rate-limited and never reveals the recovery address. Keep the address server-only; do not use a `NEXT_PUBLIC_` variable. For deployment, add the same private environment variable to the hosting environment. If the Zonal Church later gets a dedicated email address, replace the recovery address there and update the Firebase Auth user.

If the reset email cannot be received while developing locally, use **Reset the studio password on this computer** from the Zonal sign-in page. That development-only form updates the shared password directly through the Firebase Admin SDK and is limited to same-origin localhost requests. It is unavailable in production; only use it on the trusted computer that holds the local Firebase Admin credentials.

## Individual and church accounts

- Individuals create accounts and sign in using email and password. Google sign-in is currently off, so no personal or support email is shown on a Google sign-in screen.
- Churches cannot sign themselves up. The signed-in Zonal Church creates church accounts, and the platform generates a permanent 10-digit code for each one.
- A church signs in with only its 10-digit code; ZoneStream looks up its registered name.
- The Zonal Church is the only account allowed to manage the studio and church records.

## Firestore access

The Firestore rules in `firestore.rules` deny all browser reads and writes. App routes use the server-only Admin SDK. Keep the Firebase Admin private key and church-code secret local and out of source control.
