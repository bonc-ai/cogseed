# Source-run runtime variants

Source worktrees must not share mutable runtime state. The supported variants
are `main`, `cognition`, `expense`, `integration`, and `optimization`.

```text
~/.cogseed/data                                  main data
~/.cogseed/runtime-variants/cognition/data       cognition data
~/.cogseed/runtime-variants/expense/data         expense data
~/.cogseed/runtime-variants/integration/data     integration data
~/.cogseed/runtime-variants/optimization/data    optimization data
```

Each source variant also gets its own Electron `userData`, application name,
application ID, and single-instance lock. A worktree launcher is locked to its
assigned identity: this worktree always uses `integration`. Run cognition,
expense, or optimization module development from their dedicated worktrees;
neither `--variant` nor `COGSEED_RUNTIME_VARIANT` may override this integration
worktree's identity.
The launcher also rejects an inherited `COGSEED_WORKSPACE_ROOT`, because accepting
a shared legacy override would defeat the data and Electron `userData` boundary.

Source runs do not own the `cogseed://` or `cogseed://` system protocols by
default. Only the explicit `integration` variant registers connector callback
handling. A packaged application always uses the stable `main` identity and
owns its declared protocols.

An invalid variant, conflicting argument/environment values, or a non-main
packaged variant stops startup. The single-instance lock is always retained;
launchers never terminate unrelated Electron processes.
