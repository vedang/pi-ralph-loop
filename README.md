# pi-ralph-loop

Ralph-style autonomous planning loops for pi.

## Commands

- `/ralph <plan-file> [progress-file]`
- `/ralph unit-tests`
- `/ralph clean-room`
- `/ralph status`
- `/ralph stop`

## Behavior

- Ralph works one iteration at a time.
- After each iteration, the extension collapses context and starts the next iteration fresh.
- The durable state lives on disk in planning artifacts, not in chat history.
- Manual user input stops the active Ralph loop.

## Workflow-native defaults

Built-in Ralph targets materialize their artifacts under:

```text
.agents/plans/YYYYMMDDThhmmss--<four-word-folder-name>__inprogress/
```

### `/ralph unit-tests`

Creates a Ralph task folder with:

- `plan.md`
- `progress.md`

The generated plan drives an autonomous loop that inspects the current repository, identifies missing or weak tests, and keeps iterating until the necessary automated coverage is in place.

### `/ralph clean-room`

Creates a Ralph task folder with:

- `plan.md`
- `progress.md`
- `spec.md`

The generated plan drives an autonomous loop that reads the current repository and incrementally builds a clean-room `spec.md` suitable for an independent implementation in another language.
