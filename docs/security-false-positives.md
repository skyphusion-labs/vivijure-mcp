# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Fork PR OIDC in coverage workflow

**Finding:** `pull_request` from forks runs with `id-token: write` granted to the job.

**Disposition:** False positive (org CI pattern). Fork PRs execute untrusted code under GitHub's fork isolation; the OIDC token is scoped to the workflow and the upload step is gated (no secrets in job env for fork contexts). Same pattern as vivijure-audio-upscale and other constellation repos.

**Evidence:** `.github/workflows/code-coverage.yml`; upload requires passing tests on protected-branch context.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 verify ~18:04 | Fork PR id-token: write | Org fork-PR CI pattern; upload gated |
