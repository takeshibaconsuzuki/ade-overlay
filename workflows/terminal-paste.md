# Terminal paste

The browser captures clipboard text, HTML, and image files during the paste gesture. Every terminal paste waits for a target query, including ordinary text pastes. Editor text fields keep their normal behavior.

```mermaid
sequenceDiagram
    actor User
    participant Browser as Editor browser
    participant Main as Desktop main
    participant Companion
    participant Extension as Workspace extension
    User->>Browser: Keyboard or context-menu paste
    Browser->>Browser: Capture clipboard; hold native paste
    Browser->>Main: reservePaste()
    Main->>Companion: reservePaste(editor ID, document ID)
    Companion->>Extension: Query active terminal
    Extension->>Extension: Capture target; wait for launch command dispatch
    Extension-->>Companion: Chat terminal ID and provider, or ordinary terminal
    alt Ordinary terminal
        Companion-->>Browser: Release ordinary paste (via main)
        Browser->>Browser: Deliver captured plain text through normal paste
    else ADE chat terminal
        Companion->>Companion: Reserve target for desktop, editor and document
        Companion-->>Browser: Opaque reservation ID (via main)
        Browser->>Browser: Extract text and images in source order
        Browser->>Main: paste(reservation ID, items)
        Main->>Companion: paste(editor ID, document ID, reservation ID, items)
        Companion->>Companion: Consume reservation; store images; provider formats draft
        Companion->>Extension: Paste final payload into reserved terminal ID
        Extension->>Extension: Verify terminal and provider; send without Enter
        Extension-->>Browser: Acknowledge delivery (via companion and main)
    end
```

- The extension records terminal identity and provider at launch, persists both for restoration, and reads VS Code's active terminal. Tabs, icons, titles, and accessibility labels do not identify chat terminals.
- Main holds credentials, supplies a private document identifier, and accepts calls only from the active editor's main frame. Reservation requires a user gesture. The companion owns one-use reservations scoped to the desktop connection, editor and document. They expire after 30 seconds and pin the terminal, provider and extension connection even if focus later changes. Focus changes before the query resolves may affect the selected target.
- Image downloads run concurrently across reserved chat pastes. Browser submission waits for extraction and follows paste order, without waiting for earlier acknowledgements. The companion prepares images concurrently and serializes delivery per target terminal. A failed target query leaves the paste blocked and reports an error in the developer console; the user can retry.
- Paste does not depend on activity hooks or a tracked conversation. The companion uses the provider supplied by the extension, materializes PNG/JPEG/GIF/WebP images in its persistent editor-data cache, and retries image URLs the browser could not read. Preparation must complete before any terminal write. It rechecks the connection before delivery, and the extension validates the target terminal and provider; closed or replaced targets fail without redirecting the paste.
- Providers own terminal formatting: Codex receives separate bracketed text/image-path frames; Claude receives one bracketed draft with inline file mentions in source order, loading the images on user submission. Neither presses Enter. Control characters are removed except tabs and line breaks.
- Cached images survive companion restarts so drafts can refer to them later. Failed paste preparation or delivery reports an error in the editor developer console.
