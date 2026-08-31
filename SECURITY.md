# Security policy

## Supported versions

Pi Agent Web is a development preview and has not published a stable release. Security fixes are
made only on the current `main` branch. Historical commits are not supported and do not receive
backports.

When the project publishes its first stable release, this policy will be updated before that release
is described as supported. The intended policy is to support only the latest stable release.

## Report a vulnerability

Do not open a public Issue for a suspected vulnerability or include exploit details in a public
discussion. Use GitHub's private reporting form:

[Report a vulnerability privately](https://github.com/leon-zym/pi-agent-web/security/advisories/new)

Include the affected commit, operating system, Pi version, a minimal reproduction, expected and
observed behavior, and the security impact. Remove real provider credentials, private paths, Session
history, and other personal data from the report. A synthetic fixture is preferred.

The maintainer targets an acknowledgement within seven calendar days. Triage and remediation time
depend on severity and complexity; this preview does not promise a fixed resolution SLA. Please
coordinate public disclosure with the maintainer. The target disclosure window is no more than 90
days after acknowledgement, unless a shorter or longer window is agreed for user safety.

## Security boundary

Pi Agent Web is a local, single-user control surface. The Gateway listens on loopback, requires
same-origin authentication, and controls local Pi processes, provider configuration, and native Pi
Session history.

Reports are in scope when they show an unintended boundary failure such as:

- remote, cross-origin, or unauthenticated access to the local Gateway;
- Workspace or Session path traversal, symlink escape, or unsafe deletion;
- unintended disclosure of provider credentials, private Session content, or local files;
- bypass of Session generation, controller lease, or fencing checks;
- malformed upstream or Browser data crossing a validated product boundary.

The product is not a hosted service, LAN server, multi-user system, or security boundary against a
hostile process running as the same operating-system user. Public reverse proxies, shared accounts,
compromised local users, unsupported Pi versions, and users intentionally approving sensitive file
content are outside the supported threat model.

## Repository security maintenance

GitHub private vulnerability reporting, vulnerability alerts, Dependabot security updates, secret
scanning, and push protection are enabled. Credential-free dependency, deterministic, packaged
Browser, and package-install checks remain part of the release gate. Real-provider tests are
explicit and are never required for pull requests or forks.
