# 0008 No worker egress control

Status: accepted (2026-11-06; owner decision of 2026-11-02); amended 2026-11-09 (the build container)

## Context

From M2, agent roles run unattended in Fargate worker tasks (ADR 0002, ADR 0010). A role session reads untrusted content (issue bodies, web pages) and holds an Anthropic API key in its own process. A prompt-injected session that could reach any host could leak what it can read.

The brief first planned a network layer against that (section 5, before 2026-11-02):
- worker tasks in private subnets
- one t4g.nano NAT instance in a single AZ, running a domain-allowlist proxy for the Anthropic API, GitHub, the npm registry and the preview URL, and nothing else
- free S3 and DynamoDB gateway endpoints
- no NAT Gateway (about $38 a month) or Network Firewall, which would not fit the budget

That layer also forced the webhook Lambda into the VPC, if it was to touch the ledger, along with interface endpoints or a NAT for the AWS APIs it calls.

## Decision

- **No network-level egress control** (owner, 2026-11-02). The owner removed the proxy and its learning goal from the brief, and accepts the risk below.
- Worker tasks run in the public subnets of a small VPC with a public IP and a security group with no ingress. They reach the internet directly. There is no NAT instance, NAT Gateway, Network Firewall, private subnet or VPC endpoint.
- Aurora sits in the same subnets with no public address, and accepts only port 5432 from the worker's security group (ADR 0003, amended).
- What limits an agent instead, all inside the worker:
  - **No Bash for the proposal author** (ADR 0007, amendment of 2026-11-04). It cannot run commands, so it cannot open connections of its own. For a role with Bash, the runner's sandbox would fail every command on Fargate, where it very likely cannot start.
  - **`WebFetch` domain rules per role.** The proposal author may fetch `github.com` and `raw.githubusercontent.com` only. Under `permissionMode: "dontAsk"`, any other host is denied.
  - **The read guard.** Read, Grep and Glob are denied outside the worktree, including `/proc`, so a session cannot read a process's environment.
  - **An allowlisted session environment.** The runner passes the session only the variables it names, so GitHub tokens, the App's private key, the ledger credentials and the ECS credential endpoint never reach it.
  - **A spend-limited API key** in a dedicated Anthropic workspace with a $20 monthly limit, which can be revoked.
- The live boundary tests ("Write outside the allowed paths is denied", "WebFetch outside GitHub is denied", "Reading a process environment is denied", "Proposal author cannot run commands") run again on every Agent SDK upgrade, and in Fargate once ("Boundaries hold in Fargate").

## Alternatives

- **The NAT instance with a domain-allowlist proxy** (the design above): a real second layer, and the cheapest one, at about $3–4 a month plus its upkeep. Rejected by the owner for its complexity in a pet project. It remains the design to return to: private subnets for the worker, the proxy on a NAT instance, gateway endpoints for S3 and DynamoDB, and `HTTPS_PROXY` in the task definition. Only the worker touches the ledger, so the webhook Lambda would stay outside the VPC.
- **A NAT Gateway, or Network Firewall:** managed and highly available, but about $38 a month and more, beyond the $50 monthly budget for the whole account.
- **Security group egress rules only:** cheap, but they filter by IP address, and the Anthropic API and GitHub sit behind changing address ranges, so they cannot express a domain allowlist.

## Consequences

- **Accepted risk:** a bug or a changed SDK default in the tool rules, the read guard or the environment allowlist could let a prompt-injected session reach any host and leak what it can read. There is no network layer behind those checks. The most a leak exposes in M2 is the API key (spend-limited, revocable) and the session's worktree. The installation token and the App's private key stay in the worker's process, outside the session (ADR 0009).
- The worker's network is a public subnet and a security group, with no routing infrastructure, so it costs nothing while idle.
- Only the worker touches the ledger, so every state runs as a worker task (`add-cloud-proposal-run` design). That keeps the webhook Lambda out of the VPC.
- **Reconsider before M3.** The test author and implementer need Bash and run code they wrote. An allowlist entry such as `pnpm test` does not contain that code. M3 decides how those roles run, and whether this ADR still holds.

## Amendment 2026-11-09: the build container

M3 runs the test author and implementer, which have Bash and run code they wrote, in a build container that holds only the model credential (ADR 0011). The decision above stands: still no network layer, for the same reasons of cost and upkeep, and because a domain allowlist would have to admit the Anthropic API, which is where a leaked key is used anyway.

What changes in the build container:
- The read guard and the environment allowlist still apply to the session's own tools, but not to the code it runs. A test run by `pnpm exec vitest` can read `/proc/1/environ` and open any connection.
- What that code can reach is what the container holds: the model credential, the clone of the change branch (public), and the build task role's access to `work-items/*` in the artifact bucket. No GitHub token, App key, ledger credential or webhook secret: the entry point refuses to start with any of them in its environment.

New accepted risks (owner, 2026-11-08 and 2026-11-09):
- **The model credential can leak.** In the cloud it is the API key, limited by the $20 monthly workspace limit and revocable. Locally it is the owner's subscription token, which has no spend limit of its own and lasts until revoked or expired.
- **A build output can be forged or overwritten** with the build task role's credentials. The worker re-checks every patch's paths before it commits, and the PR's CI run is an independent check.

The worker itself is unchanged: it never runs agent-written code, and its roles have no Bash.
