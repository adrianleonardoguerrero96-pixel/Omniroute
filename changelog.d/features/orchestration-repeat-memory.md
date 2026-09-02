- **feat(dashboard):** the orchestration detail drawer gained a "Repeat" action for Cloud Agent,
  A2A and Conductor tasks — a two-click confirm (click once to arm, click again within the
  confirm window to fire) re-submits the original prompt/input as a new run. The button is
  disabled with an explanatory tooltip whenever the original input can't be recovered from the
  loaded task detail (e.g. it never carried a prompt, or the detail failed to load).
- **feat(a2a):** A2A task execution now records which memories were consulted for the task's
  last user message as `metadata.memoryHits` (id/key/type/content-snippet) plus a `memory_hits`
  history event, purely for observability — the retrieved memory is never injected into a
  skill's prompt or behavior. Gated by the `OMNIROUTE_A2A_MEMORY_HITS` kill-switch (default
  enabled; set to `0` to skip the recall lookup entirely). The drawer's new "Memory used"
  section lists these hits for a2a tasks and is omitted whenever there are none.
