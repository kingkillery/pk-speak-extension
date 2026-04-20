Pass 1 -- Phase Intent

Phase 1: Foundation and Product Spine
The production version of this app is not just a thin remote control for Pi; it is a dependable mobile client that can be opened cold, recover from flaky network conditions, protect credentials, and clearly communicate what state the remote system is in. This phase turns the current MVP slice into a stable app spine with real app identity, proper state modeling, settings architecture, navigation structure, and release-safe network behavior. Its boundary is core infrastructure and product framing, not feature expansion into advanced remote workflows. The primary deliverables are a modularized app shell, resilient session/bootstrap flows, durable preferences and theme controls, and release-grade security and configuration.

Phase 2: Core Conversation Experience
The best production version is a fast push-to-talk and text companion that feels trustworthy during real usage, not only during happy-path demos. This phase focuses on the main interaction loop: selecting where speech goes, recording safely, sending turns reliably, rendering turn history, handling playback, and recovering from interruptions or failures without user confusion. Its boundary is the conversation surface and session targeting ergonomics rather than platform hardening or launch readiness. The primary deliverables are a polished multi-state conversation UI, explicit permission and error flows, richer result presentation, and a history-aware remote interaction model.

Phase 3: Hardening, Trust, and Launch Readiness
Once the product spine and core conversation loop are solid, the production bar shifts to observability, accessibility, test depth, policy compliance, and release repeatability. This phase ensures the app can be maintained, reviewed, and safely shipped across Android 10 through Android 15 with confidence. Its boundary includes validation, performance, telemetry, and launch operations, not foundational architectural rewrites. The primary deliverables are strong automated coverage, instrumentation and Compose UI tests, accessibility and adaptive-layout parity, crash and analytics hooks, and a documented release path.

Pass 2 -- Workstream Decomposition

Phase 1

A. Architecture and Contracts
Split the current single-screen flow into app, settings, conversation, and routing feature boundaries with cleaner state contracts and repository interfaces that no longer leak implementation details into the ViewModel.
Validate: ViewModels depend only on domain interfaces and feature contracts; no presentation class imports concrete repository implementations.

B. Implementation and Wiring
Add app-level navigation, explicit startup/bootstrap handling, theme preferences, environment configuration, and stronger network client wiring for release and staging behavior.
Validate: Fresh install can open, configure, persist settings, restore state, and switch theme mode without restart.

C. Surface Area and Ergonomics
Replace the hidden settings toggle model with a clearer information architecture that exposes connection state, active target, and settings without requiring one scrolling screen to hold everything.
Validate: A new user can discover connection setup, session targeting, and send actions in under three taps from the landing screen.

D. Validation and Hardening
Introduce foundational unit tests around settings, validation, state reduction, and URL or auth handling, plus stricter manifest and backup posture.
Validate: Core non-UI logic has deterministic unit coverage and the app manifest reflects release-safe defaults.

Phase 2

A. Architecture and Contracts
Define explicit contracts for turn history, recording lifecycle, voice upload states, playback states, and route-target selection so the UI can represent transient and failed states cleanly.
Validate: Each conversation state has a named model and no UI branch depends on ad hoc nullable combinations.

B. Implementation and Wiring
Implement conversation history, richer turn cards, resilient recording and upload handling, retry affordances, and better audio playback control including cancellation and completion states.
Validate: Text and voice turns can be sent repeatedly across success, failure, retry, and playback scenarios without stale UI or broken recorder state.

C. Surface Area and Ergonomics
Refine the interaction model into a production talk surface with clearer hierarchy, actionable errors, permission education, session chips, and tablet-aware layouts.
Validate: The main flow remains usable on phone and expanded-width devices, and critical actions stay visible without long scrolling.

D. Validation and Hardening
Cover permission flows, malformed responses, long-running requests, upload failures, and server-unavailable cases with tests and device verification.
Validate: Manual QA matrix covers Android 10 and Android 15 for voice, text, playback, permission deny, and offline recovery.

Phase 3

A. Architecture and Contracts
Add observability and release contracts for crash reporting, analytics, diagnostics, and privacy-safe event collection.
Validate: All critical user journeys and failures emit structured telemetry without leaking tokens or transcript-sensitive data.

B. Implementation and Wiring
Integrate crash reporting, analytics, stricter network security config, release logging controls, and CI tasks for debug, staging, and release artifacts.
Validate: `assembleDebug`, `assembleStaging`, `assembleRelease`, and `test` run cleanly and produce the expected artifacts.

C. Surface Area and Ergonomics
Close launch-blocking polish gaps including accessibility labels, focus order, contrast review, loading states, and branded assets instead of framework defaults.
Validate: Accessibility audit passes for major surfaces and branded launcher assets replace default Android placeholders.

D. Validation and Hardening
Expand test coverage to Compose UI and instrumentation, verify adaptive layout parity, and produce a release checklist for Play readiness and operator rollout.
Validate: Pre-release checklist is executable, repeatable, and backed by automated and manual evidence.

Pass 3 -- Sequencing & Dependencies

Phase 1 should execute in the order A -> B -> C -> D because the current app still concentrates all product behavior into one ViewModel and one screen, so feature-level ergonomics will stay brittle until the state and module boundaries are cleaned up first. Wiring the app shell and settings model next creates the stable seams needed for better surfaces. Only after that should the UX be reorganized, because otherwise the team would be polishing a layout built on unstable state rules. Foundational validation belongs last in the phase because it should lock the new contracts rather than document the old MVP.

Phase 2 should execute in the order A -> B -> C -> D because the conversation model needs named states before resilient behavior can be implemented cleanly. Once recording, send, retry, playback, and history are properly wired, the surface can be reshaped around those explicit states. Hardening then verifies the real flow on devices and across failure paths rather than testing placeholder assumptions. Phase 2 depends on Phase 1 navigation, settings, and architecture work, since conversation history and multi-surface UX are hard to maintain inside the current single-screen structure.

Phase 3 should execute in the order A -> B -> C -> D because observability and release contracts define what must be measured and protected before integrations are added. Wiring telemetry, network security, and CI next gives the product a release-capable backbone. Surface polish follows, since accessibility and branding should be applied to nearly-final screens, not moving targets. Final validation closes the loop by proving parity across devices, build types, and launch criteria. Phase 3 depends on Phase 2 because launch-readiness coverage is only meaningful once the real user journey exists.

Pass 4 -- Acceptance & Parity Gates

Phase 1 done criteria
- The app has separate app shell, settings, and conversation concerns instead of one monolithic screen and ViewModel.
- Theme appearance offers System, Light, and Dark, persists instantly, and is reachable from settings.
- Connection setup, token storage, and target routing are represented as explicit product surfaces rather than a hidden panel.
- Release and staging builds do not rely on default placeholder networking assumptions beyond configured endpoints.
- Manifest, backup behavior, and launcher branding are reviewed and no longer use default platform placeholders.
- Parity gate: app startup, settings restore, and connection editing behave consistently on Android 10 and Android 15.

Phase 2 done criteria
- Voice, text, and playback states are represented explicitly and never require guessing from stale fields.
- Turn history persists for the active session and shows transcript, reply, audio state, and retry affordances.
- Permission denial, recorder failure, upload failure, and server failure all produce actionable UI with recovery paths.
- The main interaction surface keeps primary actions visible on compact and expanded layouts.
- Audio playback can be started, stopped, and retried without leaking state between turns.
- Parity gate: text and voice journeys produce consistent state transitions across phone and expanded-width layouts.

Phase 3 done criteria
- Unit, Compose UI, and instrumentation coverage exists for the main happy paths and critical failures.
- Crash reporting and analytics are wired with privacy-safe event shapes and disabled debug noise in release-safe builds.
- Release assets, accessibility labels, focus order, and contrast meet production review expectations.
- CI or documented local release commands build, test, and package all three variants repeatably.
- A launch checklist exists covering manual device QA, network edge cases, permission cases, and release verification.
- Parity gate: the same release checklist passes on minSdk and latest Android before declaring the app production-ready.

[Completed Planned Tasks]
- Three build variants exist with debug, staging, and release outputs configured in [app/build.gradle.kts](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\build.gradle.kts:26).
- Edge-to-edge startup is enabled in [MainActivity.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\MainActivity.kt:11).
- Secure persistence exists for base URL, token, and audio preferences in [SecureSettingsStore.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\data\storage\SecureSettingsStore.kt:12).
- The app already supports status fetch, route target update, text turn send, voice turn send, and reply audio playback through [MainViewModel.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\presentation\main\MainViewModel.kt:25).
- Basic DTO mapping tests exist and `./gradlew.bat test` currently exits successfully.

[A to Z Gaps]
- App shell and feature modularization: The product is still effectively a single-screen MVP with one ViewModel and one large Compose file; split navigation, settings, and conversation concerns into maintainable feature boundaries. (0% complete)
- Theme appearance selector: The theme currently only follows `isSystemInDarkTheme()` with no user-facing System/Light/Dark control required by the Android standard. See [Theme.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\ui\theme\Theme.kt:135). (0% complete)
- Adaptive layouts and tablet parity: The UI is a vertically scrolling single-column phone layout with no `WindowSizeClass` or expanded-screen treatment. See [MainScreen.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\presentation\main\MainScreen.kt:149). (0% complete)
- Settings information architecture: Connection settings are hidden behind an animated drawer section in the main scroll rather than a clear settings surface, which makes setup and diagnostics harder to find. See [MainScreen.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\presentation\main\MainScreen.kt:203). (0% complete)
- Conversation history and session memory: The app only shows the latest transcript and reply, with no turn history, session grouping, or recovery after process death. (0% complete)
- Explicit UI state model: `MainUiState` collapses connection, route, turn, recorder, playback, and error state into one flat object, which will break down as product complexity grows. See [MainUiState.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\presentation\main\MainUiState.kt:5). (0% complete)
- Concrete repository leakage in presentation: The ViewModel imports `PiSpeakRepositoryImpl.resolveAudioUrl`, which breaks the intended layer boundary. See [MainViewModel.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\presentation\main\MainViewModel.kt:8) and [MainViewModel.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\presentation\main\MainViewModel.kt:189). (0% complete)
- Network stack hardening: Retrofit is configured with a placeholder base URL and only debug logging; there is no network security config, certificate pinning, auth refresh strategy, or structured error mapping for release. See [AppModule.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\core\AppModule.kt:55). (0% complete)
- Release-safe app identity: The manifest still uses default Android launcher icons and allows backup by default, both of which are below production bar. See [AndroidManifest.xml](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\AndroidManifest.xml:7). (0% complete)
- Recording lifecycle resilience: The recorder wrapper is thin and does not model interruptions, double-tap races, audio focus conflicts, or partial-file cleanup beyond the simplest path. See [AppAudioRecorder.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\core\AppAudioRecorder.kt:18). (0% complete)
- Playback state and transport UX: Playback is fire-and-forget with no exposed loading, playing, stopped, or retry state, which limits confidence during slow or failed audio fetches. (0% complete)
- Permission UX: Microphone permission is requested inline but there is no education, denial rationale, or permanently-denied recovery path to app settings. See [MainScreen.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\main\java\com\pkkidking\pispeak\presentation\main\MainScreen.kt:91). (0% complete)
- Accessibility and semantics: The current UI emphasizes visual styling, but it lacks an explicit accessibility pass for content descriptions, focus order, touch targets, and state announcements. (0% complete)
- Testing depth: Test coverage is currently limited to DTO mapping; there are no ViewModel, repository, audio, Compose UI, or instrumentation tests. See [RemoteDtosTest.kt](C:\dev\Desktop-Projects\pi-speak-extension\android-app\app\src\test\java\com\pkkidking\pispeak\data\model\RemoteDtosTest.kt:1). (0% complete)
- Offline and degraded-network behavior: There is no cached status model, explicit offline banner, request timeout UX, or retry queue for common degraded scenarios. (0% complete)
- Observability and privacy-safe telemetry: There is no crash reporting, analytics, or operator diagnostics for key failures like record start failure, route update failure, or upload timeout. (0% complete)
- Release automation and evidence: The app lacks a documented Android release checklist with minSdk/latest device verification, accessibility verification, and staging or release smoke evidence. (0% complete)
