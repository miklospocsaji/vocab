# 0009 GitHub App auth

Status: accepted (2026-11-02; owner decisions of 2026-11-02)

## Context

M1 acted on GitHub with the owner's `gh` token, so its work looked like the owner's. From M2 the factory runs unattended in AWS and needs its own identity, with credentials that are short-lived and scoped (brief, section 5). GitHub also needs a way to tell the factory about labels and comments, and the factory must be able to trust those calls.

## Decision

- The factory is the GitHub App `vocab-factory` (App id `5586098`, installation id `177972181`), owned by the owner's account and installed on this repository only. These ids are not secret; they live in `infra/cdk.json`.
- Permissions: Contents read and write, Issues read and write, Metadata read. Events: Issues, Issue comment. Pull request permissions join in M3.
- Each worker task holds the App's private key and mints its own installation tokens:
  - a JWT signed with `node:crypto`, valid for under 10 minutes
  - a token requested for this repository only, with exactly the permissions above
  - refreshed when under five minutes from expiry; tokens last an hour
- The local CLI keeps using the owner's `gh auth token`.
- Commits are authored and committed by the App's bot user, `vocab-factory[bot]`.
- Secrets live in Parameter Store as SecureStrings, written by the owner with the AWS CLI: `/factory/github-app-private-key` and `/factory/github-webhook-secret`. ECS injects the key into the worker. Only the webhook Lambda reads the webhook secret.
- Tokens and keys never appear in logs, errors, command lines, remote URLs or git config. Pushes use the credential helper from M1.
- Every webhook delivery is checked against `X-Hub-Signature-256` in constant time, before anything else.
- Only `miklospocsaji` may `/approve`. The Lambda compares `comment.user.login` with the login in `infra/cdk.json`, and ignores comments on pull requests.

## Alternatives

- **A broker Lambda that alone holds the key:** the worker would never see the private key. Rejected with the simplified M2 design (owner decision, 2026-11-02): it adds a Lambda and a network hop, and the role session is already kept from the key by the environment allowlist and the read guard.
- **`@octokit/auth-app`:** less code to write, but a larger dependency tree for about 30 lines of signing.
- **The owner's personal access token in the cloud:** long-lived, broad, and attributes the factory's work to the owner.

## Consequences

- If a worker task were compromised beyond the role's boundaries, the private key would be exposed. That would let an attacker act on this repository's contents and issues until the key is rotated. To rotate: generate a new key in the App's settings, overwrite the parameter, delete the old key.
- A leaked installation token is limited to this repository and expires within an hour.
- The factory's commits and comments are visibly its own.
- A pull request's `/approve` does nothing until M3 extends the command.
