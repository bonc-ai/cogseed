# Source-run runtime variants

Source worktrees must not share mutable runtime state. The supported variants
are `main`, `cognition`, `expense`, and `integration`.

```text
~/.orkas/data                                  main data
~/.orkas/runtime-variants/cognition/data       cognition data
~/.orkas/runtime-variants/expense/data         expense data
~/.orkas/runtime-variants/integration/data     integration data
```

Each source variant also gets its own Electron `userData`, application name,
application ID, and single-instance lock. `npm start` defaults to `main`. This
expense worktree's `run.sh` and `run.cmd` default to `expense`; use exactly one
explicit override when necessary:

```bash
./run.sh --variant integration
```

```bat
run.cmd --variant integration
```

Source runs do not own the `mateagent://` or `orkas://` system protocols by
default. Only the explicit `integration` variant registers connector callback
handling. A packaged application always uses the stable `main` identity and
owns its declared protocols.

An invalid variant, conflicting argument/environment values, or a non-main
packaged variant stops startup. The single-instance lock is always retained;
launchers never terminate unrelated Electron processes.
