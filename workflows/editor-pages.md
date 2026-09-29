# Editor pages

- Desktop main owns one editor window and retained pages keyed by editor identity. Selection belongs to the window; document readiness belongs to each page.
- Pages share persistent browser storage per companion origin. They have no Node access or preload bridge and remain alive when hidden.
- Sources: [editor window](../src/main/editor-window.ts), [page readiness](../src/main/editor-page.ts).

## Select an editor page

```mermaid
flowchart TD
    Open([Editor session ready]) --> Resolve[Reuse a valid page, otherwise create its replacement]
    Resolve --> Select[Select view and hide the previous view]
    Select --> Window[Show or recreate the editor window]
    Window --> Wait[Await current document readiness]
    Wait --> Sync[Register page for background settings sync]
    Sync --> Ready([Page ready for navigation])
    click Wait "editor-pages.md#follow-document-readiness"
    click Sync "settings.md#schedule-synchronization"
```

- A closed editor window is recreated around retained pages on the next open. Selecting another worktree does not unload the previous one.
- Missing pages are created; failed pages and pages with an old process credential are replaced.
- Selection happens before the readiness wait. A different navigation can select another page during that wait; completing the old load does not change selection.
- A page failure during opening rejects the wait and disposes that failed page. A later open can create a replacement.

## Follow document readiness

```mermaid
stateDiagram-v2
    [*] --> Loading: First document load
    Loading --> Ready: Main document response accepted and DOM ready
    Loading --> Loading: New main document supersedes the previous load
    Ready --> Loading: Browser reload or new main document
    Loading --> Failed: Main document fails, stops early, or exceeds 30 seconds
    Ready --> Failed: Renderer exits
    Loading --> Disposed: View removed or desktop quits
    Ready --> Disposed: View removed or desktop quits
    Failed --> Disposed: Failed page replaced or view removed
    Disposed --> [*]
```

- Opening waits through superseded document loads until the current document is ready. Readiness has a 30-second deadline and does not wait for subresources or extension terminal restoration.
- Removing a worktree from an accepted desktop snapshot disposes its page. A new process credential also replaces the old page at its next open.
- [Window closure](desktop.md#close-a-window) and process lifetime are different: closing only the editor window hides pages; quitting the desktop disposes them.

## Request browser permissions

```mermaid
flowchart TD
    Request([Editor or extension frame requests a browser permission]) --> Trusted{Frame belongs to the active authenticated editor view?}
    Trusted -->|No| Denied([Permission denied])
    Trusted -->|Yes| Kind{Requested capability?}
    Kind -->|Clipboard write or microphone only| Allowed([Application grants permission])
    Kind -->|Clipboard read| Gesture{Current user gesture?}
    Gesture -->|Yes| Allowed
    Gesture -->|No| Denied
    Kind -->|Other capability| Denied
```

- The owning editor view must be active; its extension frames remain subject to VS Code and Chromium frame policies. Operating-system microphone permission still applies.
- Top-level navigation stays inside the editor's companion origin and path. New browser windows are denied.
