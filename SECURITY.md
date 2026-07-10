# Security policy

## Supported versions

turbovc3 is currently an experimental `0.x` project. Security fixes are applied to the latest released version only.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/jhodges10/turbovc3/security/advisories/new).
Do not open a public issue for suspected vulnerabilities or attach private media to an issue.

Include the affected version or commit, browser/runtime, a minimal reproduction, expected impact, and whether untrusted
media is required to trigger the behavior. You should receive an acknowledgement within seven days. Release timing
will depend on severity, reproduction, and the scope of the fix.

Codec parsers process untrusted binary input. Reports involving out-of-bounds reads, excessive allocation, denial of
service, worker isolation, or unexpected network requests are all in scope.
