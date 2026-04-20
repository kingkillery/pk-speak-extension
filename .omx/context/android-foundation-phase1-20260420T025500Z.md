Task statement
- Continue Android app work by executing the first foundation slice from the production gap analysis.

Desired outcome
- The Android app has a real app shell, a dedicated settings surface, persistent theme controls, and cleaner architecture boundaries for the current conversation flow.

Known facts/evidence
- Current app is a single-screen MVP with one ViewModel and hidden settings in the main scroll surface.
- Theme currently follows system only and does not expose System/Light/Dark user control.
- Conversation code imports a concrete repository implementation to resolve audio URLs.
- Android tests currently pass, but coverage is minimal.

Constraints
- Preserve existing working text, voice, status, and route-target behavior.
- Keep minSdk 29 / targetSdk 35 compatibility.
- Make changes reviewable and incremental rather than rewriting the app wholesale.

Unknowns/open questions
- Whether a two-tab shell is enough for the next product phase or whether a fuller navigation model will be needed later.
- How much of adaptive layout work should land in this pass versus a dedicated follow-up.

Likely codebase touchpoints
- `android-app/app/src/main/java/com/pkkidking/pispeak/MainActivity.kt`
- `android-app/app/src/main/java/com/pkkidking/pispeak/presentation/main/*`
- `android-app/app/src/main/java/com/pkkidking/pispeak/ui/theme/Theme.kt`
- `android-app/app/src/main/java/com/pkkidking/pispeak/data/storage/*`
- `android-app/app/src/main/AndroidManifest.xml`
