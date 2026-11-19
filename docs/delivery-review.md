# Delivery scope and verification

This change establishes a terminal-first evaluation workflow with explicit app integration, local evidence storage/replay, held-out judge measurement and beginner documentation. It does not certify a model or judge's quality on an application-specific dataset. The brand is Johnny Be Good; established evaluation terminology remains unchanged. The old command/environment prefix remains compatible, and the GitHub repository has not been renamed.

## Reviewed decisions

- Save full normalized traces only with explicit artifact capture. Private files are local, existing experiment directories are refused, and replay verifies references/checksums before regrading. Hashes support integrity/comparison; they are not signatures authenticating the dataset author. Arbitrary trace contents are not automatically de-identified.
- Strip saved adapter commands and provider configuration from replay suites. Replay does not call the target and does not enable judges merely because provider keys exist. Explicit model selection can send saved evidence to that provider.
- Separate tuning from held-out measurement, reject overlap, freeze the selected policy and report agreement, coverage, confusion counts and disagreements. Calibration supports one judge or Jev followed by one fallback; unsupported ordering/multiple fallbacks are rejected rather than measuring a different policy from the live cascade. Generic judge exceptions are not mislabeled as confirmed provider outages.
- Reject empty measurements and invalid run selections. A nonzero target exit cannot pass, even when a partial trace was printed. Preserve real failure evidence instead of inventing a response.
- Bound adapter output and terminate the process group created by the runner on POSIX, escalating when necessary. The exercised platform was macOS; this is not a claim of verified Windows descendant-process cleanup.
- Preserve numeric usage fields for compatibility while exposing whether input/output counters were actually reported. Missing instrumentation cannot silently satisfy a token budget. Costs and tokens have separate coverage; estimated/reported cost is not a billing guarantee.
- Group mixed repetition counts instead of assigning the largest k to every case. Show added/removed baseline coverage explicitly; validate baseline files before starting the target or creating artifacts.

## Three-pass review

Correctness: inspected normalization, subprocess lifecycle, archive persistence/reference validation, replay egress, judge-policy parity, split leakage checks, CLI mode/flag handling, result semantics and documentation contracts. Confirmed findings fixed included mismatched calibration policy, empty calibration success, missing usage shown as measured zero, and coverage-only baseline changes shown as unchanged.

Adversarial recheck: re-established those conditions in the code and checked regression tests. Verified actual source CLI capture/replay and a local fake-judge held-out path, not only mocks of the render function. JSON remains unstyled and separate from terminal progress. Source evidence in the architecture document was refreshed against the final implementation.

Sweep: no-emit type check, focused behavioral tests, diff whitespace validation, document targets/source quotes and lockfile consistency were checked. No lint script is declared. No application build, hosted-model evaluation or production application call was performed. New examples are synthetic and clearly labeled. Live model/judge availability and quality remain separate checks.

## Acceptance boundary

The implemented workflows are covered by focused tests: exact known-good/bad outcomes, HTTP application integration, saved runs after stopping the target, trace integrity failures, incomplete/error archives, unsupported/empty inputs, partial usage, judge failures/abstention, held-out independence, mixed repetition counts, plain/color/JSON output and subprocess limits.

Before using this to make quality claims, supply representative application tasks and independent reference labels, pin the intended app/model configuration, inspect disagreements, and validate on data not used to tune the grader. Remote providers and mutable model aliases can change behavior; fingerprints do not guarantee identical future outputs. Environment/session reset and instrumentation remain the application's responsibility. A general-purpose production monitoring service, hosted dashboard and brand artwork are outside this PR.
