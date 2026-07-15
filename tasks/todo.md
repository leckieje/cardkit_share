# AI Chat: Persistent Memory + Data Verification

## Plan

Fix two issues with the AI chat feature:
1. Chat history disappears on page navigation (no persistence, no conversational memory)
2. Generated card text contains hallucinated numbers and firm names that don't match the data

## Checklist

### Phase 1: Chat Memory (localStorage + conversational context)
- [x] Add `chatHistory` array, `loadChatHistory()`, `saveChatHistory()` in `cardkit-shim.js`
- [x] Restore saved messages on page load in `initAI()`
- [x] Include last 6 messages as `history` in chat requests
- [x] Add "Clear" button in `views/wsjpro.html`
- [x] Update Python `/chat` endpoint to use multi-turn format with history

### Phase 2: Reduce Hallucination (prompt hardening)
- [x] Restructure auto-card prompt — verified facts first, grounding instructions last
- [x] Modify auto-card to compute structured stats dict inline
- [x] Return `_stats` alongside generated card JSON in auto-card response

### Phase 3: Auto-Verification After Card Generation
- [x] Add `verifyCardText()` client-side check using `_stats`
- [x] Show verification result in UI (green check or yellow warning)
- [x] Add `/verify-card` endpoint in Python for deeper AI verification
- [x] Add proxy route in `server/routes/sheets.js`
- [x] Add verification result container in `views/wsjpro.html`

### Phase 4: Chat-Based Fact-Checking
- [x] Add `getCurrentCardValues()` helper in `cardkit-shim.js`
- [x] Include `card_values` and `card_context` in chat requests
- [x] Add verify intent detection in Python `/chat` endpoint
- [x] Add verification-focused prompt enrichment when verify intent detected

## Review

### Changes Made

**`scripts/cardkit-shim.js`** — Chat persistence + verification:
- Added localStorage-backed chat history (`ck-ai-chat-history` key, max 50 messages)
- `loadChatHistory()` / `saveChatHistory()` / `restoreChatMessages()` / `clearChatHistory()`
- `handleChat()` now sends `history` (last 6 messages), `card_values`, and `card_context` in requests
- Added `getCurrentCardValues()` and `getCardContext()` helpers
- Added `verifyCardText(card, stats)` for client-side auto-verification after card generation
- Auto-card success handler extracts `_stats` and runs verification

**`views/wsjpro.html`** — UI additions:
- "Clear" button in chat header
- `#ck-verify-result` container for showing verification results

**`sheets-service/ai.py`** — Backend AI improvements:
- `/chat`: Multi-turn format with history, reduced sample rows when history present, verify intent detection with `is_verify_intent()`, enriched verification context via `build_verify_context()`
- `/auto-card` (monthly + quarterly): Prompt restructured with verified facts first, grounding instructions last, returns `_stats` dict
- New `/verify-card` endpoint: recomputes ground truth, checks bigNumberHed, deal counts, and firm names (using AI extraction)

**`server/routes/sheets.js`** — Added proxy route for `/ai/verify-card`

### How to test

1. Load app → ask chat questions → navigate away → return → messages should persist
2. Ask a follow-up question (e.g. "tell me more") → AI should have context
3. Click "AI Auto-fill" → check verification result appears below chat
4. After generating card, type "verify line1" in chat → should compare against computed data
5. Click "Clear" → chat history wiped
