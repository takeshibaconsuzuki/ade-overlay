#!/usr/bin/env bash
#
# Debug helper: fire a fake Claude chat hook at the local server so you can flip
# a chat to busy / idle / dormant without running a real agent. Mirrors what
# Claude Code POSTs to the hook sink (see src/server/chats/providers/claude.ts).
#
# Usage:
#   scripts/chat-hook.sh busy ["a prompt line"]   # UserPromptSubmit -> busy
#   scripts/chat-hook.sh idle                      # Stop            -> idle
#   scripts/chat-hook.sh dormant                   # SessionEnd      -> dormant
#
# Env overrides:
#   CHAT_ID      conversation/session id            (default: debug-chat)
#   WORKTREE_ID  worktreeId query param             (default: unset)
#   ORIGIN       server origin                      (default: http://127.0.0.1:3000)
#
# Note: without a real transcript the chat has no title, so the row shows the
# loading skeleton for the title and the prompt as its description.

set -euo pipefail

status="${1:-busy}"
prompt="${2:-Debug prompt from chat-hook.sh}"
chat_id="${CHAT_ID:-debug-chat}"
origin="${ORIGIN:-http://127.0.0.1:3000}"

case "$status" in
  busy)    event="UserPromptSubmit" ;;
  idle)    event="Stop" ;;
  dormant) event="SessionEnd" ;;
  *)
    echo "usage: $0 {busy|idle|dormant} [prompt]" >&2
    exit 1
    ;;
esac

url="${origin}/chats/hooks/claude"
if [[ -n "${WORKTREE_ID:-}" ]]; then
  url="${url}?worktreeId=${WORKTREE_ID}"
fi

# Build the JSON body with a small node helper so the prompt is escaped safely.
body="$(CHAT_ID="$chat_id" EVENT="$event" PROMPT="$prompt" node -e \
  'process.stdout.write(JSON.stringify({hook_event_name:process.env.EVENT,session_id:process.env.CHAT_ID,prompt:process.env.PROMPT}))')"

echo "POST $url"
echo "  $body"
curl -sS -X POST "$url" \
  -H 'Content-Type: application/json' \
  -d "$body"
echo
