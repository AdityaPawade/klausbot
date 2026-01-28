# Requirements: clawdbot

**Defined:** 2026-01-28
**Core Value:** 24/7 personal assistant that never forgets, never loses context, and self-improves through use.

## v1 Requirements

### Infrastructure

- [ ] **INFRA-01**: Wrapper process runs 24/7, polls Telegram for new messages
- [ ] **INFRA-02**: On message arrival, wrapper spawns Claude Code session with context
- [ ] **INFRA-03**: Claude Code response sent back to user via Telegram
- [ ] **INFRA-04**: Single-user security — only authorized Telegram chat ID can interact
- [ ] **INFRA-05**: Graceful shutdown and restart without losing state

### Communication

- [ ] **COMM-01**: User can send text messages and receive responses
- [ ] **COMM-02**: Conversation context maintained within session
- [ ] **COMM-03**: "Thinking..." indicator shown while processing
- [ ] **COMM-04**: Errors surfaced transparently (never silent failures)
- [ ] **COMM-05**: Voice messages transcribed and processed as text
- [ ] **COMM-06**: Images analyzed and described/acted upon

### Memory

- [ ] **MEM-01**: All conversations persisted to storage (SQLite or file)
- [ ] **MEM-02**: Hybrid context model — identity files stuffed in context, history via agentic lookup
- [ ] **MEM-03**: Session bootstrap includes: SOUL.md, IDENTITY.md, USER.md, latest message pointer, memory index
- [ ] **MEM-04**: RLM-inspired retrieval — Claude queries conversation history agentic-ally (not fed full history)
- [ ] **MEM-05**: Semantic retrieval — vector embeddings for relevant memory recall
- [ ] **MEM-06**: User preferences extracted and stored in USER.md
- [ ] **MEM-07**: Conversation history queryable by Claude during session

### Identity

- [ ] **IDEN-01**: SOUL.md defines personality, values, boundaries
- [ ] **IDEN-02**: IDENTITY.md defines surface attributes (name, vibe, emoji)
- [ ] **IDEN-03**: USER.md stores info about user (preferences, context)
- [ ] **IDEN-04**: Bootstrap flow — first interaction creates identity files through conversation
- [ ] **IDEN-05**: Identity files consulted every session for consistent personality
- [ ] **IDEN-06**: Claude can update identity files based on learnings

### Cron System

- [ ] **CRON-01**: Cron tasks stored persistently (survive restarts)
- [ ] **CRON-02**: Cron tasks execute at scheduled times by spawning Claude Code
- [ ] **CRON-03**: User can create crons through natural conversation
- [ ] **CRON-04**: User can list, modify, delete existing crons
- [ ] **CRON-05**: Cron execution results sent to user via Telegram

### Skills System

- [ ] **SKILL-01**: Skills are reusable capabilities stored in folder
- [ ] **SKILL-02**: Claude selects appropriate skill based on task
- [ ] **SKILL-03**: Pre-installed skills included (skill-creator, etc.)
- [ ] **SKILL-04**: Claude can create new skills proactively (asks user first)
- [ ] **SKILL-05**: Skills use standard format (SKILL.md or similar)

### Self-Evolution

- [ ] **EVOL-01**: LEARNINGS.md tracks mistakes and insights
- [ ] **EVOL-02**: Claude consults learnings to avoid repeating mistakes
- [ ] **EVOL-03**: Claude can modify own behavior based on feedback
- [ ] **EVOL-04**: All self-modifications version controlled (git)
- [ ] **EVOL-05**: Claude proactively suggests improvements

## v2 Requirements

### Advanced Memory

- **MEM-V2-01**: Memory pruning/archival for old conversations
- **MEM-V2-02**: Sensitive data classification and encryption
- **MEM-V2-03**: Explicit "forget this" command

### Multi-Platform

- **PLAT-01**: Calendar integration (Google Calendar)
- **PLAT-02**: Email integration
- **PLAT-03**: Task manager integration

### Advanced Proactive

- **CRON-V2-01**: Event-triggered tasks (not just time-based)
- **CRON-V2-02**: Chained tasks (task A triggers task B)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-user support | Personal assistant, single user only |
| Web UI | Telegram is the interface |
| Mobile app | Telegram handles mobile |
| Sandbox/restrictions | Runs in VM, fully autonomous by design |
| Multi-agent routing | Premature optimization; Claude Code handles routing |
| OAuth for external services | Deferred to v2 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | TBD | Pending |
| INFRA-02 | TBD | Pending |
| INFRA-03 | TBD | Pending |
| INFRA-04 | TBD | Pending |
| INFRA-05 | TBD | Pending |
| COMM-01 | TBD | Pending |
| COMM-02 | TBD | Pending |
| COMM-03 | TBD | Pending |
| COMM-04 | TBD | Pending |
| COMM-05 | TBD | Pending |
| COMM-06 | TBD | Pending |
| MEM-01 | TBD | Pending |
| MEM-02 | TBD | Pending |
| MEM-03 | TBD | Pending |
| MEM-04 | TBD | Pending |
| MEM-05 | TBD | Pending |
| MEM-06 | TBD | Pending |
| MEM-07 | TBD | Pending |
| IDEN-01 | TBD | Pending |
| IDEN-02 | TBD | Pending |
| IDEN-03 | TBD | Pending |
| IDEN-04 | TBD | Pending |
| IDEN-05 | TBD | Pending |
| IDEN-06 | TBD | Pending |
| CRON-01 | TBD | Pending |
| CRON-02 | TBD | Pending |
| CRON-03 | TBD | Pending |
| CRON-04 | TBD | Pending |
| CRON-05 | TBD | Pending |
| SKILL-01 | TBD | Pending |
| SKILL-02 | TBD | Pending |
| SKILL-03 | TBD | Pending |
| SKILL-04 | TBD | Pending |
| SKILL-05 | TBD | Pending |
| EVOL-01 | TBD | Pending |
| EVOL-02 | TBD | Pending |
| EVOL-03 | TBD | Pending |
| EVOL-04 | TBD | Pending |
| EVOL-05 | TBD | Pending |

**Coverage:**
- v1 requirements: 35 total
- Mapped to phases: 0
- Unmapped: 35 (pending roadmap)

---
*Requirements defined: 2026-01-28*
*Last updated: 2026-01-28 after initial definition*
