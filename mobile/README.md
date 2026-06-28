# RO Audit Photo App — Offline Android App

A standalone Android app for collecting RO audit photos with **zero internet
required**. Unlike the [web app](../README.md), nothing is uploaded to a
server during the audit — photos are stored on the phone and the PDF report
is generated entirely on-device. Internet is only needed (briefly, once) to
share the finished PDF off the phone, e.g. via WhatsApp.

## Installing the APK on a phone

The built APK is at [dist/RO-Audit-Photo-App.apk](dist/RO-Audit-Photo-App.apk)
(this is a **debug build** — unsigned for a Play Store release, but perfectly
fine for installing directly / "sideloading" on your team's phones).

1. Send the `.apk` file to the phone any way that works (USB cable, Bluetooth,
   WhatsApp/email when there's signal, SD card, etc).
2. On the phone, tap the file to install. Android will warn about installing
   from outside the Play Store ("Install unknown apps") — allow it for this
   one file/app.
3. Open "RO Audit Photo" from the app drawer.

No further setup, accounts, or connectivity needed — it works the same with
the phone in airplane mode.

## How it differs from the web app

| | Web app | This offline app |
|---|---|---|
| Connectivity | Needs a server connection for every action | None, ever, during the audit |
| Storage | Server disk (ephemeral on free hosting) | The phone itself |
| Multiple auditors at once | Single-slot queue (see main README) | N/A — each phone is independent |
| Photo source | Camera or gallery | Camera or gallery (same) |
| PDF generation | Server (sharp + pdfkit) | On-device (canvas + pdf-lib) |
| Sharing the result | Direct download link | Android share sheet, once back online |

## Rebuilding the APK

This is a [Capacitor](https://capacitorjs.com) project wrapping the
`www/` folder (vanilla JS, no bundler/framework — `www/app.js` is the
entire app). To rebuild after editing `www/`:

```bash
cd mobile
npm install
npx cap sync android
cd android
# requires JDK 17 + Android SDK (build-tools 34, platform 34) on PATH
gradle assembleDebug
# output: android/app/build/outputs/apk/debug/app-debug.apk
```

**Windows-specific gotcha:** the Android Gradle Plugin's path handling
breaks if the project lives under a path containing spaces (this repo's
parent folder does: `...\nayara ea 2026\...`). If `gradle assembleDebug`
fails with `IOException: The filename, directory name, or volume label
syntax is incorrect`, copy the `mobile/` folder to a space-free path (e.g.
`D:\build\mobile`), update `android/local.properties`'s `sdk.dir`
accordingly, build there, then copy `app-debug.apk` back.

The Android SDK / Gradle / JDK used to build this aren't checked into git
(see `.gitignore` — they'd live under `mobile/toolchain/`, multi-GB). Install
them yourself or point `ANDROID_HOME`/`JAVA_HOME` at existing installs.

## Editing the checklist

`www/questions.json` is a copy of [`../data/questions.json`](../data/questions.json).
If you change one, change the other to keep both apps in sync.
