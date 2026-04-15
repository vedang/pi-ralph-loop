![pi-ralph-loop banner](images/banner.png)

Ralph-style autonomous planning loops for pi.

## Commands

### Concrete usage

- `/ralph` (or `/ralph help`) shows usage
- `/ralph <plan-file> [progress-file]`
- `/ralph once <plan-file> [progress-file]`
- `/ralph unit-tests`
- `/ralph once unit-tests`
- `/ralph clean-room`
- `/ralph once clean-room`
- `/ralph [once] <target> --max-iterations <n>`
- `/ralph status`
- `/ralph stop`
- `/ralph-prompt <prompt>`

Example forms:

```text
/ralph
/ralph help
/ralph specs/plan.md
/ralph once specs/plan.md proposals/progress.md
/ralph unit-tests --max-iterations 7
/ralph once unit-tests
/ralph clean-room
/ralph once clean-room
/ralph-prompt improve command parsing coverage
/ralph status
/ralph stop
```

## Behavior

- `/ralph once ...` runs exactly one iteration and then stops after collapsing that iteration.
- `/ralph-prompt <prompt>` seeds a prompt-synthesis pass (`prompt` target) and auto-starts exactly one iteration.
- Ralph works one iteration at a time.
- Each iteration prompt explicitly requires:
  - running relevant feedback loops before finishing,
  - not treating the task as complete while those loops are failing,
  - and making a git commit for the iteration.
- Built-in targets include the same stronger iteration contract in their generated plans, and custom plans receive it via the per-iteration prompt.
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

### `/ralph-prompt <prompt>`

Creates a Ralph task folder with:

- `plan.md`
- `progress.md`

`/ralph-prompt` seeds a synthesis `plan.md` and keeps `progress.md` minimal. It starts one prompt-specific iteration that rewrites `plan.md` into a self-contained execution plan for later `/ralph <plan.md>` use.

Use the rewritten plan with `/ralph <plan.md>` when you want the loop to execute against it.
