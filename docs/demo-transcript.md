# Proposed Product Demo Storyboard

This storyboard proposes a demonstration recording for Pi Agent Web. Timestamps, actions, and
narration are planned scenes, not observations from a completed video or performance evidence.
Demo delivery remains tracked in [Issue #29](https://github.com/leon-zym/pi-agent-web/issues/29).

## Overview

The proposed recording covers these Pi Agent Web workflows:
- Startup and workspace discovery
- Multi-session concurrent background activity
- Seamless navigation without background session disruption
- Fault recovery and session state resynchronization
- Virtualized message history with settled rendering

---

## Scene 1: Workbench Startup and Discovery

- Timestamp: 00:00 - 00:15
- Context: Terminal and Browser.
- Action: The user launches the workbench from the terminal with `npx pi-web`. The Gateway starts on a local loopback port and opens the browser interface.
- Display: The browser navigates to the loopback URL. The application shell loads cleanly with the sidebar displaying recent workspaces and active sessions discovered from the local Pi storage.
- Audio and Narrative: "Pi Agent Web launches as a local supervisor workbench connecting directly to Pi Coding Agent RPC interface."

## Scene 2: Multi-Session Concurrent Activity

- Timestamp: 00:15 - 00:45
- Context: Workspace with two active sessions: Session Alpha and Session Beta.
- Action: In Session Alpha, the user submits a prompt requesting code refactoring across multiple files. Pi begins streaming text and executing tool calls.
- Concurrency: While Session Alpha is actively running and streaming tool execution updates, the user creates Session Beta in the same workspace to inspect a bug report.
- Display: Session Beta opens. In the sidebar, Session Alpha status indicator shows active execution and streaming deltas continuing in the background. Both sessions ingest events independently.
- Audio and Narrative: "Each hot session runs in its own bounded supervisor process. Background sessions continue executing and streaming without interruption."

## Scene 3: Seamless Navigation

- Timestamp: 00:45 - 01:05
- Context: Switching between active and dormant sessions.
- Action: The user clicks between Session Alpha and Session Beta in the sidebar.
- Display: Selecting a session updates the view pointer in the client without triggering upstream process restarts or terminating active background runs.
- Audio and Narrative: "Selection in the browser acts strictly as a view pointer. Navigating between conversations never restarts the supervisor or interrupts running tasks."

## Scene 4: Fault Recovery and Resynchronization

- Timestamp: 01:05 - 01:25
- Context: Network interruption and browser reload.
- Action: The user reloads the browser window while Session Alpha finishes a tool execution sequence.
- Display: The browser reconnects to the local WebSocket gateway. The gateway verifies the authentication token and resynchronizes the session channel.
- State: The recording should check Session Alpha against the authoritative recovery state and show any recovery error or limitation.
- Audio and Narrative: "Pi JSONL is the single durable source of truth. Session recovery uses explicit sequence barriers."

## Scene 5: Virtualized History and Settled Rendering

- Timestamp: 01:25 - 01:40
- Context: A session containing hundreds of messages and tool execution cards.
- Action: The user rapidly scrolls up and down the conversation timeline.
- Display: Show the bounded conversation window and its settled Markdown, code diffs, and tool output. This scene does not establish a frame-rate or memory guarantee.
- Audio and Narrative: "The conversation window limits mounted turns while users navigate older messages."
