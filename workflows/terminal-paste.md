# Terminal paste and file drop

The browser captures clipboard text, HTML, and image files during the paste gesture, or files dropped from the desktop onto a terminal. Every terminal paste or drop waits for a target query, including ordinary text pastes. Editor text fields keep their normal behavior.

```mermaid
sequenceDiagram
    actor User
    participant Browser as Editor browser
    participant Main as Desktop main
    participant Companion
    participant Extension as Workspace extension
    User->>Browser: Keyboard or context-menu paste, or file drop
    Browser->>Browser: Capture clipboard or dropped files; hold native paste; consume drop
    Browser->>Main: reservePaste()
    Main->>Main: For a drop, focus the editor window and wait for page focus
    Main->>Companion: reservePaste(editor ID, document ID)
    Companion->>Extension: Query active terminal
    Extension->>Extension: Capture target; wait for launch command dispatch
    Extension-->>Companion: Chat terminal ID and provider, or ordinary terminal
    alt Ordinary terminal
        Companion-->>Browser: Release ordinary paste (via main)
        Browser->>Browser: Deliver captured plain text through normal paste; discard drops
    else ADE chat terminal
        Companion->>Companion: Reserve target for desktop, editor and document
        Companion-->>Browser: Opaque reservation ID (via main)
        Browser->>Browser: Extract text, images and files in source order
        Browser->>Main: paste(reservation ID, items)
        Main->>Companion: paste(editor ID, document ID, reservation ID, items)
        Companion->>Companion: Consume reservation; store images and files; provider formats draft
        Companion->>Extension: Paste final payload into reserved terminal ID
        Extension->>Extension: Verify terminal and provider; send without Enter
        Extension-->>Browser: Acknowledge delivery (via companion and main)
    end
```

- The extension records terminal identity and provider at launch, persists both for restoration, and reads VS Code's active terminal. Tabs, icons, titles, and accessibility labels do not identify chat terminals.
- Main holds credentials, supplies a private document identifier, and accepts calls only from the active editor's main frame. Reservation requires a user gesture; the preload vouches for trusted native paste and drop events, which carry no DOM activation. The companion owns one-use reservations scoped to the desktop connection, editor and document. They expire after 30 seconds and pin the terminal, provider and extension connection even if focus later changes. Focus changes before the query resolves may affect the selected target.
- Image downloads run concurrently across reserved chat pastes. Browser submission waits for extraction and follows paste order, without waiting for earlier acknowledgements. The companion prepares images concurrently and serializes delivery per target terminal. A failed target query leaves the paste blocked and reports an error in the developer console; the user can retry.
- Paste does not depend on activity hooks or a tracked conversation. The companion uses the provider supplied by the extension, materializes PNG/JPEG/GIF/WebP images in its persistent editor-data cache, and retries image URLs the browser could not read. Preparation must complete before any terminal write. It rechecks the connection before delivery, and the extension validates the target terminal and provider; closed or replaced targets fail without redirecting the paste.
- Providers own terminal formatting: Codex receives separate bracketed text/image-path frames; Claude receives one bracketed draft with inline file mentions in source order, loading the images on user submission. Neither presses Enter. Control characters are removed except tabs and line breaks.
- The browser workbench cannot open or resolve local paths for desktop file drops. ADE consumes drops of desktop files onto a terminal, including terminal tabs covered by VS Code's editor drop target, so VS Code never handles them, and uploads only for a chat reservation. Workbench drags such as Explorer files keep VS Code's path insertion. Folder drops and drops over 32 MiB are rejected before reservation.
- A drop targets the terminal under the pointer. The browser focuses it, and main brings the editor window forward and waits for the page to take focus before the target query, because a window left in the background by a drag from another application does not register focus. A window that cannot take focus fails the drop.
- Dropped PNG/JPEG/GIF/WebP files are delivered as images. Other files keep their sanitized names under the editor-data cache's `paste-files/`, grouped by content hash; Claude receives inline file mentions and Codex receives their paths as text.
- Cached images and files survive companion restarts so drafts can refer to them later. Failed paste preparation or delivery reports an error in the editor developer console.
