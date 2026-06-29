# GPS Map Camera

A standalone Android app, separate from the RO audit project, that works
like the "GPS Map Camera" app on the Play Store: take a photo (or pick one
from the gallery) and it gets stamped with the timestamp, GPS coordinates,
a reverse-geocoded address, and a small map thumbnail of the location -
then downscaled to ~8MP and re-compressed.

The built APK is at [dist/GPS-Map-Camera.apk](dist/GPS-Map-Camera.apk).

## How it works

1. **Capture**: `Camera.getPhoto()` (system camera or gallery), with
   `width`/`height` set to ~8MP so Android downscales natively before the
   photo reaches the webview (same reasoning as the audit app's pipeline -
   native Bitmap resize is much faster than decoding a full-resolution
   original in a JS canvas).
2. **Location**: `@capacitor/geolocation` watches position continuously
   while the app is open, so a fix is usually already available the
   instant a photo is taken instead of waiting on one.
3. **Address**: reverse-geocoded via OpenStreetMap's free Nominatim API
   (no key, no billing - has a fair-use rate limit, fine for this app's
   volume). Falls back to just showing coordinates if it's unreachable.
4. **Map thumbnail**: fetched from `staticmap.openstreetmap.de` (also
   free, no key). Best-effort - the stamp just omits the map tile if the
   request fails (e.g. no signal at the exact moment of capture).
5. **Stamping**: a canvas draws the photo, then a semi-transparent bar
   across the bottom with the map thumbnail + timestamp/coordinates/
   address text.
6. **Size optimization**: re-encodes as JPEG starting at quality 0.85,
   stepping down (to a floor of 0.55) if the result is still over ~2MB.
7. **Save/share**: written to the app's private storage
   (`Directory.Data`) and offered via Android's share sheet (`Share.share`)
   to save to Downloads, send via WhatsApp, etc.

### Why OpenStreetMap instead of Google Maps

Real Google Maps tiles need a Google Cloud project with billing enabled
and an API key. This uses free, no-key OpenStreetMap-based services
instead (Nominatim for addresses, staticmap.openstreetmap.de for the map
tile) - the map won't look pixel-identical to Google's style, but it's
zero-cost and needs no account setup.

## Rebuilding

```bash
npm install
npx cap sync android
cd android
# requires JDK 17 + Android SDK (build-tools 34, platform 34) on PATH -
# the photo-audit-app project's mobile/toolchain/ has both already
# provisioned, point local.properties at that android-sdk folder to
# avoid downloading the whole toolchain again.
gradle assembleDebug
# output: android/app/build/outputs/apk/debug/app-debug.apk
```

If the build fails with `IOException: The filename, directory name, or
volume label syntax is incorrect`, it's almost always a `local.properties`
encoding issue (Java `.properties` files treat backslash as an escape
character) - use forward slashes in `sdk.dir`, not backslashes.

## Permissions

- `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` - for the geolocation
  stamp. Capacitor's Geolocation plugin requests these at runtime, but
  doesn't declare them in its own manifest, so they're declared in this
  app's `AndroidManifest.xml`.
- `INTERNET` - for reverse geocoding and the map tile fetch.

## Known limitations

- No live camera preview with the stamp overlay baked in while framing
  the shot (like the real GPS Map Camera app has) - this uses the
  system camera app via an intent, then stamps the result afterward.
  Building a true live preview would need a custom camera plugin
  (e.g. `@capacitor-community/camera-preview`) instead of the standard
  capture flow.
- The map tile and address lookups need internet at the moment of
  capture; offline, the stamp still includes the timestamp and raw
  coordinates, just without the address text or map thumbnail.
