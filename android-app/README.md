# Pi Speak Android App

This app is a remote client for a Pi Speak tray/gateway host. It should not hold Gemini, Vertex AI, or ElevenLabs credentials.

## Run Locally

Prerequisite: Android Studio or the checked-in Gradle wrapper.

```powershell
.\gradlew.bat assembleDebug
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

The app connects by scanning the `/setup` QR served by `pi-speak-tray` or `/pk-remote`. The host machine owns all provider credentials and can use Codex, ElevenLabs, or Vertex AI server-side.
