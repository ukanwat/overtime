# Harness rules — for the operator, not the agent

The benchmark measures what the model does with good conditions. Every hint we give it is a
capability we can no longer claim to have measured. So the line is:

## We may (this is harness work)

- Provide the environment: engine, plugins, MCP, tools, credentials, disk, compute.
- Provide resources: handbook docs, skill packs, asset sources, reference-image APIs, catalogues
  of ideas. Breadth of available knowledge is a condition, not an answer.
- Provide the demand: the brief, the standards, the definition of failure ("uniform coverage is
  a failure", "it must not look like one company built it"). A spec is not a hint — it is what
  we are asking for. Saying *what good means* is legitimate; saying *what is wrong with its
  build* is not.
- Fix the harness: restart a dead session, relaunch a crashed editor, unblock a port, repair a
  path that resolves to nothing, back the work up, keep sensors working, remove a modal dialog.
- Restart it and tell it that prior work stands and where the new standards are.
- Observe as much as we like, and write down everything we see.

## We must not (this is the agent's job)

- **Diagnose its bugs.** Not "the ground material has no textures", not "the aerial is empty
  sky", not "the buildings are all the same height in district X".
- **Name its errors or hand it the correct API call.** It has introspection tools; using them
  is part of what is being measured.
- **Point at a specific broken thing** and ask it to fix that thing.
- **Edit its code, its assets, its plan or its documents.** Ever.
- Answer a question it asks. Nobody is coming; that is the premise.

## Why this is strict

The interesting result is not "can Opus 5 build a city if told what is wrong with it" — it is
whether the model *notices*. Self-diagnosis is the capability. On this run the agent found and
wrote down, unprompted: an untextured ground material, white blobs it traced to a macro noise
node, black shadowed faces from too little skylight bounce, a missing GameMode and PlayerStart,
a service call that silently leaves material outputs unconnected, and the exact call sequence
that crashed the editor — plus the safe alternative. It does not need our help. Helping only
costs us the finding.

## Contamination log (keep one, and publish it)

Every run leaks something. A result without a contamination log is a result you cannot check, so
keep the log as you go rather than reconstructing it afterwards, and publish it alongside whatever
you claim.

Log an entry whenever any of these happens — each has been seen in practice:

- **The model under test was not the model you meant.** A bare alias can resolve to a different
  generation between sessions. Pin the exact model id, record the id the session actually reported,
  and exclude sessions that ran on something else.
- **A restart note carried diagnosis into the subject.** The failure mode is subtle: a note that
  explains *why* the last session crashed, or enumerates the API errors it hit, has handed the
  agent findings it was supposed to produce. Its handling of those traps can no longer be claimed
  as unassisted. A restart note should say only that prior work stands and where the standards
  changed.
- **The demand was edited because of something you saw a run do.** Adding a requirement after
  observing a fault is legitimate — the brief should get better — but it is not blind authoring.
  Record that the requirement exists because of an observation, even when the text names nothing
  the agent built and prescribes no specific fix.
- **You answered a question the agent should have answered.** Any hint, working API call, or
  "actually the problem is…" belongs here, however small it felt at the time.
