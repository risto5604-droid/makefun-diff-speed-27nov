# makefun-diff-speed-27nov

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/risto5604-droid/makefun-diff-speed-27nov/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/risto5604-droid/makefun-diff-speed-27nov/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for makefun-diff 1.0.0: an exact line diff that answers exactly as make.fun's own patch does, computed with a banded Myers search over interned line ids in typed arrays. Lines are interned to small integer ids (one open-addressing table keyed by an FNV-1a hash, verified exactly), the common prefix and suffix are stripped, and the middle is searched with Myers's greedy search — keeping on each diagonal the path reaching furthest into the old text, deletion winning ties — restricted to the band the true path must stay in (the cap comes from the multiset-difference lower bound, with an unbanded fallback, so the script is the reference's script line for line). The patch rendering follows makefun-diff's rule: 3 kept lines of context, runs at most 6 kept lines apart share a hunk, deletions before insertions, `%` after a line with no newline.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=38hw3qgw&utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
