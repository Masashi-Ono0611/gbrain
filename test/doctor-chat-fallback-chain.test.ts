// checkChatFallbackChainInert was removed in patch 94 (the check's premise —
// "no production chat path consumes chat_fallback_chain" — went stale once
// patch 83/93 wired chatWithFallback into propose_takes, facts.extract, and
// synthesize's judge client). This file is kept as an empty stub rather than
// deleted: the Air->Mini overlay deploy tooling (gbrain-overlay-export.py)
// only supports 'M'/'A' git-diff statuses against upstream/master's
// merge-base, not 'D' — a real delete here would block every future overlay
// export until the tool grows delete support. Safe to actually delete once
// that support lands, or once an upstream release makes this path vanish on
// its own.
