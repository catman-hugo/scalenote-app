# AI disclosure

ScaleNote is a personal side project. It is made to learn how to build software and to make an app that its author actually needs.

## How the AI is used

- Most of the code, tests and documentation are written by AI coding tools.
- A human decides what gets built, tests every build on real devices, and reports what is wrong. The AI fixes it.
- The AI does not test on real hardware. It cannot check things like pen pressure, a specific phone or a specific Windows install. Those checks are done by a person, and `PROGRESS.md` says which ones have been done.

## How the code is reviewed

- Two people review the code. They cannot read all of it, so some code has only been checked by running it.
- `PROGRESS.md` lists what has been reviewed by a human and what has not.
- Before the public release (version 2.0.0) the plan is an independent security review by someone who did not write or direct the code.

## What this means for you

- Expect bugs. Some may lose or damage data.
- Keep your own backups of your notes. ScaleNote stores them as plain files in a folder, so any backup tool works.
- Do not use it for anything where losing the data would be serious until it has had a proper review.

## In the code

Comments in the code explain why a choice was made and how a part works, in plain language. Larger choices are written down in `DECISIONS.md`.

## Review status

Nothing has been human-reviewed yet. There is no code yet.
