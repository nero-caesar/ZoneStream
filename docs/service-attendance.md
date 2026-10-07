# Service attendance and quality

New services save a report in the server-only `serviceReports` collection. Each LiveKit participant SID has a separate visit; account IDs deduplicate individual totals. Church and presenter connections never count as individual viewers. Developer-issued access stays private in Zonal responses and exports; Developer Studio can request the private report.

Studio refreshes its count from LiveKit every five seconds. Normal join/leave events and authenticated viewer/presenter updates save attendance; reconciliation detects absent connections. End-service captures the connected individual count before deleting the room. Reports include reconnect visits and gaps, combined church attendance, peak/end individuals, codes and presenters. Overlapping visits do not double-count attendance duration.

## LiveKit webhook setup

Configure a webhook in the LiveKit Cloud project's Settings → Webhooks:

`https://zone-stream.vercel.app/api/stream/webhook`

Select the same API key configured as `LIVEKIT_API_KEY` in Vercel. The endpoint verifies the signed Authorization header with that key's secret. Do not add an unsigned proxy. LiveKit participant join/leave notifications provide server timestamps even when a device disappears unexpectedly. Without this dashboard configuration, polling detects missing connections within the polling period while Studio remains connected; a network outage can delay detection. Older services cannot have missing historical attendance reconstructed.

## Exports

Save as PDF opens the browser print window: select Save as PDF. Download picture creates PNG pages with every attendance entry and gap; download the listed pages individually. The data download preserves the full report as JSON. Times in visual exports use the operator device's timezone.

## Quality

Studio and presenters request 1080p at 30 frames per second with simulcast and a 4.5 Mbps maximum top layer. Viewers adapt to their connection and displayed video size. Studio requests the highest available presenter layer for the source on air, with lower-quality backstage previews. The separate presenter monitor publisher uses the same quality settings; presenter subscriptions remain restricted to the public monitor room.

Local recordings use a 1920×1080 canvas at 30 fps and requested 8 Mbps video / 192 kbps audio. Actual quality depends on the camera, original presenter feed, browser encoder, device capacity and network. Enlarging a low-resolution source cannot restore lost detail. These local recordings do not use LiveKit cloud Egress recording.
