---
name: build-part
description: Build the next piece of the engine (or the one named) as one reviewable pull request, with tests, docs and progress notes.
argument-hint: "[what to build, optional]"
disable-model-invocation: true
---

Build $ARGUMENTS (if empty, the next item in `docs/PROGRESS.md`, or the next priority in `python/README.md`).

1. Read `docs/PROGRESS.md` and the relevant sections of `spec/ENGINE_GUIDE.md`.
2. Create a branch with a descriptive name.
3. Design and implement it your way. Prove it with pytest tests that could actually fail.
4. Document the code and update `docs/` to match what was built.
5. Have `contract-reviewer` check the diff; fix real problems.
6. Run the full test suite and paste the output. Update `docs/PROGRESS.md`.
7. Commit, push, and open a PR with `gh pr create`. In the description: what was built, how it works in plain words, the test output, the shared rules applied, and anything worth checking by hand.
