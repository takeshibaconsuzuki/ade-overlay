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
    Main->>Companion: Query this editor's paste target
    Companion->>Extension: Query active terminal
    Extension-->>Main: Chat terminal ID or ordinary terminal (via companion)
    alt Ordinary terminal
        Main-->>Browser: Release ordinary paste
        Browser->>Browser: Deliver captured plain text through normal paste
    else ADE chat terminal
        Main->>Main: Reserve terminal ID for this document
        Main-->>Browser: Opaque reservation ID
        Browser->>Browser: Extract text and images in source order
        Browser->>Main: paste(reservation ID, items)
        Main->>Main: Consume reservation; print structured diagnostic
        Main-->>Browser: Acknowledge; print developer-console diagnostic
    end
```

- The extension owns terminal identity and reads VS Code's active terminal. Tabs, icons, titles, and accessibility labels do not identify chat terminals.
- Main holds credentials and accepts calls only from the active editor's main frame. Reservation requires a user gesture. One-use reservations belong to the originating document, expire after 30 seconds, and pin the resolved chat terminal even if focus later changes. Focus changes before the query resolves may affect the selected target.
- Image downloads run concurrently across reserved chat pastes. Browser delivery waits for preparation and follows paste order. A failed target query leaves the paste blocked and reports an error in the developer console; the user can retry.
- Chat submission is diagnostic only. It prints ordered text and image bytes, retaining an image's source URL when browser restrictions prevent downloading it. It does not send text or images to the CLI.
