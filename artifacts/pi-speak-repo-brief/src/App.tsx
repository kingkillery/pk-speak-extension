import { useMemo, useState } from 'react'
import './App.css'

type SectionId = 'overview' | 'surfaces' | 'flows' | 'files' | 'validation'

type Surface = {
  id: string
  command: string
  title: string
  summary: string
  strengths: string[]
  risks: string[]
}

const sections: { id: SectionId; label: string; kicker: string }[] = [
  { id: 'overview', label: 'Overview', kicker: 'What this repo is' },
  { id: 'surfaces', label: 'Surfaces', kicker: 'Operator entry points' },
  { id: 'flows', label: 'Flows', kicker: 'How requests move' },
  { id: 'files', label: 'Files', kicker: 'Where the logic lives' },
  { id: 'validation', label: 'Validation', kicker: 'What is hardened now' },
]

const surfaces: Surface[] = [
  {
    id: 'speak',
    command: '/speak',
    title: 'Spoken replies',
    summary:
      'Turns Pi into a voice assistant with multi-provider TTS and optional audio-first rewriting.',
    strengths: [
      'Auto provider fallback now steps through legacy, elevenlabs, openai, then edge',
      'Keeps the full text reply on screen while producing a speech-friendly spoken version',
      'Supports stop, provider switching, provider diagnostics, and rewrite toggles',
    ],
    risks: [
      'Real-world quality still depends on machine audio config and provider credentials',
      'Legacy speak11 portability is better now, but operator environments still vary',
    ],
  },
  {
    id: 'mono',
    command: '/mono',
    title: 'Always-listening local voice',
    summary:
      'Runs the PK wake phrase flow locally with a faster-whisper listener and session-aware routing.',
    strengths: [
      'Wake sensitivity is operator-tunable with low, medium, and high presets',
      'Short numeric families stay deterministic: PK1 and PK2 remain distinct',
      'Listener shutdown is now explicit and testable instead of relying only on EOF behavior',
    ],
    risks: [
      'Still depends on a healthy local Python and audio stack',
      'Background audio and microphone edge cases remain the main live risk area',
    ],
  },
  {
    id: 'phone',
    command: '/phone',
    title: 'Telegram bridge',
    summary:
      'Pairs a Telegram bot to Pi for text turns, voice notes, and remote replies from a phone.',
    strengths: [
      'Lowest-friction remote path when reliability matters more than low latency',
      'Supports pairing, unpairing, text turns, voice notes, and optional audio replies',
      'Now easier to validate with dedicated remote run sheets and clearer diagnostics',
    ],
    risks: [
      'Still needs a real phone run to prove live pairing and recovery end to end',
      'Bot token and polling health are external dependencies',
    ],
  },
  {
    id: 'remote',
    command: '/remote',
    title: 'HTTP API and mobile web app',
    summary:
      'Hosts /app/, remote turn endpoints, auth, queueing, and runtime diagnostics for browser-based phone control.',
    strengths: [
      'Non-local requests are authenticated, rate-limited, and queue-aware',
      'The mobile app can bootstrap auth with a token and store it per session or device',
      'Diagnostics now include a high-signal summary block for queue, phone linkage, mono state, and active error sources',
    ],
    risks: [
      'Browser microphone use still requires HTTPS in real phone scenarios',
      'The remaining unknown is live network-path behavior, not the basic handler wiring',
    ],
  },
  {
    id: 'sess',
    command: '/sess',
    title: 'Session manager and voice routing',
    summary:
      'Names sessions, assigns aliases, manages compact PK1/PK2 lanes, and drives the detached Ink admin pane.',
    strengths: [
      'The pane is now real, not a stub: rename, alias, remove, focus movement, footer, and toasts all work',
      'Snapshot and non-TTY fallback protect the CLI from raw-mode crashes',
      'Store reload logic keeps the pane, slash commands, and runtime state aligned across surfaces',
    ],
    risks: [
      'The pane itself is tested, but multi-session operator ergonomics still benefit from live dogfooding',
      'Cross-window session naming habits still shape how useful the compact lanes feel in practice',
    ],
  },
]

const fileGroups = [
  {
    label: 'Core runtime',
    items: [
      ['index.ts', 'Extension entry point, command registration, remote orchestration, and status wiring'],
      ['control-server.ts', 'HTTP API, /app/ hosting, auth gates, remote turns, and diagnostics payloads'],
      ['listener-control.ts', 'Graceful child-process shutdown with stdin command plus timed fallback kill'],
      ['runtime-paths.ts', 'Python and speak11 discovery, including env overrides and user-site scanning'],
    ],
  },
  {
    label: 'Voice and routing',
    items: [
      ['listener/listener.py', 'Wake detection and local transcription path'],
      ['voice-routing.ts', 'Route normalization, numeric family handling, and conflict detection'],
      ['session-routing.ts', 'Named sessions, aliases, summaries, removal helpers, and dashboard selectors'],
      ['voice-session-command.ts', 'Natural language bridge from spoken phrases into /sess actions'],
    ],
  },
  {
    label: 'Operator UI',
    items: [
      ['ui/admin.tsx', 'CLI entry for the session manager pane and snapshot fallback'],
      ['ui/components/Dashboard.tsx', 'Main pane renderer for session rows and compact routes'],
      ['ui/components/Toast.tsx', 'Voice and admin toast band'],
      ['ui/hooks/useSessionStore.ts', 'Polling and external-store reload behavior'],
    ],
  },
  {
    label: 'Docs and validation',
    items: [
      ['README.md', 'Main operator guide and troubleshooting reference'],
      ['docs/SESSION_OPERATIONS.md', 'Focused /sess and pane operator guide'],
      ['docs/REMOTE_VALIDATION_CHECKLIST.md', 'Manual phone validation checklist'],
      ['tests/*.test.mjs', 'Regression coverage across remote auth, queueing, routing, UI, and shutdown'],
    ],
  },
]

const validationSlices = [
  {
    title: 'Session manager pane shipped',
    status: 'Done',
    detail:
      'The old placeholder pane was replaced with a working Ink app, including keybindings, focused footer, compact route display, toasts, and a snapshot mode.',
  },
  {
    title: 'Runtime path portability improved',
    status: 'Done',
    detail:
      'Python and speak11 discovery now honor explicit env overrides and scan user-site Python Scripts directories instead of assuming a single Python314 path.',
  },
  {
    title: 'Listener shutdown hardened',
    status: 'Done',
    detail:
      'Mono shutdown now sends an explicit stdin command and keeps a timed kill fallback, with tests covering both paths.',
  },
  {
    title: 'Remote diagnostics made operator-friendly',
    status: 'Done',
    detail:
      'The /v1/diagnostics payload now exposes a compact summary block so operators can see queue state, queue depth, phone linkage, mono state, current target, and active error sources quickly.',
  },
  {
    title: 'Live phone validation',
    status: 'Pending',
    detail:
      'The checklist and run sheet are in place, but real manual verification still needs a phone, Telegram pairing, and an HTTPS or Tailscale path.',
  },
]

const journey = [
  {
    step: '1',
    title: 'Operator chooses a surface',
    body:
      'The repo exposes five human-facing entry points: /speak, /mono, /phone, /remote, and /sess. Each one wraps a distinct operating mode instead of hiding everything behind a single command.',
  },
  {
    step: '2',
    title: 'Voice or remote input enters the runtime',
    body:
      'A turn can begin from the local wake listener, Telegram, the mobile web app, or the current Pi session. The runtime normalizes that into session-aware work with queue controls around remote requests.',
  },
  {
    step: '3',
    title: 'Session routing decides the target',
    body:
      'Named sessions, aliases, and the compact one-versus-two route families are resolved before work is dispatched. Multi-word spoken names stay literal instead of collapsing into numeric shortcuts.',
  },
  {
    step: '4',
    title: 'Output fans back out',
    body:
      'Results can go back to the terminal, to TTS, to Telegram, or to the /app/ browser client. The goal is to preserve the full Pi reply while shaping audio and transport for the current surface.',
  },
]

function App() {
  const [section, setSection] = useState<SectionId>('overview')
  const [selectedSurface, setSelectedSurface] = useState<Surface>(surfaces[3])

  const currentSection = useMemo(
    () => sections.find((entry) => entry.id === section) ?? sections[0],
    [section],
  )

  return (
    <div className="shell">
      <aside className="rail">
        <div>
          <p className="eyebrow">Artifact</p>
          <h1>pi-speak-pk repo brief</h1>
          <p className="rail-copy">
            An interactive orientation artifact for the voice, remote, and session-routing extension that turns Pi into a usable voice workstation.
          </p>
        </div>

        <div className="metric-stack">
          <div className="metric-card">
            <span className="metric-value">5</span>
            <span className="metric-label">primary operator surfaces</span>
          </div>
          <div className="metric-card">
            <span className="metric-value">100</span>
            <span className="metric-label">passing tests at latest verified run</span>
          </div>
          <div className="metric-card metric-card--warning">
            <span className="metric-value">1</span>
            <span className="metric-label">big remaining production proof: live phone validation</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Artifact sections">
          {sections.map((entry) => (
            <button
              key={entry.id}
              className={entry.id === section ? 'nav-item nav-item--active' : 'nav-item'}
              onClick={() => setSection(entry.id)}
            >
              <span className="nav-kicker">{entry.kicker}</span>
              <span className="nav-label">{entry.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="content">
        <section className="hero-panel">
          <div>
            <p className="eyebrow">Repository focus</p>
            <h2>{currentSection.label}</h2>
          </div>
          <div className="hero-notes">
            <span className="pill">Voice-first Pi extension</span>
            <span className="pill">Telegram + browser remote control</span>
            <span className="pill">Named session routing</span>
            <span className="pill">Ink management pane</span>
          </div>
        </section>

        {section === 'overview' && (
          <section className="panel-grid panel-grid--overview">
            <article className="panel panel--feature">
              <p className="panel-kicker">What the repo does</p>
              <h3>Pi becomes a multi-surface voice workstation</h3>
              <p>
                This package is not just text-to-speech bolted onto Pi. It adds spoken replies, local wake listening, Telegram turns, a mobile web app, a remote HTTP API, and a session manager that can route spoken work into the right Pi window.
              </p>
            </article>

            <article className="panel">
              <p className="panel-kicker">Shortest operator paths</p>
              <ul className="command-list">
                <li><code>/speak on</code> for local spoken replies</li>
                <li><code>/mono on</code> for the always-listening PK wake flow</li>
                <li><code>/phone on</code> for reliable Telegram remote control</li>
                <li><code>/remote on</code> then <code>/app/</code> for browser mic plus audio playback</li>
                <li><code>/sess ui</code> for the detached session-management pane</li>
              </ul>
            </article>

            <article className="panel panel--wide">
              <p className="panel-kicker">Runtime map</p>
              <div className="journey-grid">
                {journey.map((item) => (
                  <div key={item.step} className="journey-card">
                    <span className="journey-step">{item.step}</span>
                    <h4>{item.title}</h4>
                    <p>{item.body}</p>
                  </div>
                ))}
              </div>
            </article>
          </section>
        )}

        {section === 'surfaces' && (
          <section className="panel-grid panel-grid--surfaces">
            <article className="panel surface-list-panel">
              <p className="panel-kicker">Choose a control surface</p>
              <div className="surface-list">
                {surfaces.map((surface) => (
                  <button
                    key={surface.id}
                    className={selectedSurface.id === surface.id ? 'surface-chip surface-chip--active' : 'surface-chip'}
                    onClick={() => setSelectedSurface(surface)}
                  >
                    <span>{surface.command}</span>
                    <strong>{surface.title}</strong>
                  </button>
                ))}
              </div>
            </article>

            <article className="panel panel--feature">
              <p className="panel-kicker">Selected surface</p>
              <div className="surface-heading">
                <code>{selectedSurface.command}</code>
                <h3>{selectedSurface.title}</h3>
              </div>
              <p>{selectedSurface.summary}</p>

              <div className="two-column-notes">
                <div>
                  <h4>Strengths now</h4>
                  <ul>
                    {selectedSurface.strengths.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>Watch points</h4>
                  <ul>
                    {selectedSurface.risks.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>
          </section>
        )}

        {section === 'flows' && (
          <section className="panel-grid">
            <article className="panel panel--wide">
              <p className="panel-kicker">Main execution flows</p>
              <div className="flow-columns">
                <div className="flow-card">
                  <h3>Local voice loop</h3>
                  <ol>
                    <li>Operator says <strong>PK</strong> or <strong>PK target</strong></li>
                    <li>The Python listener wakes and transcribes</li>
                    <li>Routing resolves session names, aliases, or compact numeric lanes</li>
                    <li>Pi processes the turn and can answer on screen and in audio</li>
                  </ol>
                </div>
                <div className="flow-card">
                  <h3>Remote phone loop</h3>
                  <ol>
                    <li>Telegram or <code>/app/</code> submits text or voice</li>
                    <li>The control server authenticates and queues the turn</li>
                    <li>STT, routing, and Pi execution run in the current runtime</li>
                    <li>The response returns as text plus optional reply audio</li>
                  </ol>
                </div>
              </div>
            </article>

            <article className="panel">
              <p className="panel-kicker">Remote diagnostics signals</p>
              <ul className="signal-list">
                <li><strong>queueState</strong> tells you whether the remote path is idle, queued, or busy</li>
                <li><strong>queueDepth</strong> shows backlog pressure</li>
                <li><strong>phoneLinked</strong> shows whether Telegram is paired</li>
                <li><strong>monoState</strong> shows off, listening, or active local voice state</li>
                <li><strong>activeErrorSources</strong> surfaces which subsystem is currently failing</li>
              </ul>
            </article>

            <article className="panel">
              <p className="panel-kicker">Why the recent hardening matters</p>
              <p>
                The high-value production work here has been about making failures diagnosable instead of mysterious: better runtime path resolution, cleaner child shutdown, a real management pane, and diagnostics that translate raw nested state into operator-ready signals.
              </p>
            </article>
          </section>
        )}

        {section === 'files' && (
          <section className="panel-grid">
            {fileGroups.map((group) => (
              <article className="panel" key={group.label}>
                <p className="panel-kicker">{group.label}</p>
                <div className="file-list">
                  {group.items.map(([name, summary]) => (
                    <div key={name} className="file-row">
                      <code>{name}</code>
                      <p>{summary}</p>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </section>
        )}

        {section === 'validation' && (
          <section className="panel-grid">
            <article className="panel panel--wide">
              <p className="panel-kicker">Production-readiness slices</p>
              <div className="timeline">
                {validationSlices.map((slice) => (
                  <div key={slice.title} className="timeline-row">
                    <span className={slice.status === 'Pending' ? 'status status--pending' : 'status'}>
                      {slice.status}
                    </span>
                    <div>
                      <h3>{slice.title}</h3>
                      <p>{slice.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="panel">
              <p className="panel-kicker">Automated confidence</p>
              <h3>Latest verified suite</h3>
              <p className="big-stat">100 passing tests</p>
              <p>
                Coverage spans remote auth, queue limits, audio expiry, session routing, listener shutdown, admin CLI behavior, pane state, and voice-command integration.
              </p>
            </article>

            <article className="panel">
              <p className="panel-kicker">Next real-world proof</p>
              <h3>Manual phone run</h3>
              <p>
                The repo now has a detailed checklist and a compact run sheet. The remaining gap is live evidence for Telegram pairing, the web app, auth bootstrap, queue behavior, reply audio, and diagnostics under a real phone path.
              </p>
            </article>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
