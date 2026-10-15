# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the MPD passwords (the `password` lines of `mpd.conf`) are
  `secret` fields of the Gladys configuration. The integration reads them from
  Gladys at startup, keeps them in memory, sends them only to the player they
  belong to (the MPD `password` command, in clear text: the MPD protocol has
  no encryption, keep it on your local network), and never writes them to
  `/data` nor to the logs. Credentials written inside an address to play are
  removed before any log line.
- **Stored in `/data`**: nothing.
- **Network**: one TCP connection per player, to the addresses and ports typed
  in the configuration, on the local network. The integration opens no port
  and calls no cloud service. The addresses it asks MPD to play are fetched by
  the player itself, not by the integration; `file://` addresses are refused.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
MPD and the systems built on it (moOde, Volumio, piCorePlayer), and the other
devices and services of your network.
