## Feature 9: Authenticated website download

Add a website button for downloading `iD-Tech-Watch.exe`.

Requirements:

* Show it after the user passes the first login screen.

* Allow the authenticated instructor and director roles.

* Enforce download permissions on the server.

* Do not rely only on the browser UI.

* Place the button in the bottom-right area.

* Style it similarly to the existing monitor button.

* Use a clear label such as:

  `Download iD-Tech-Watch`

* Serve the file through a safe fixed route.

* Do not accept an arbitrary filesystem path from the browser.

* Use an appropriate filename and content type.

* Return a useful error if the executable has not been built.

* Preserve responsive layout and keyboard accessibility.

## Implementation quality

Work within the existing small architecture.

Do not introduce React, Electron, TypeScript, Express, a database, npm, or another major dependency unless the project already uses it.

Prefer:

* Small reusable JavaScript functions
* Existing plain HTML, CSS, and JavaScript patterns
* Existing Node APIs
* Existing C# code
* Existing PowerShell tooling
* Minimal targeted changes
* Clear separation between browser code, server code, student agent code, and Windows launcher code

Security requirements:

* Validate every remote command.
* Enforce authorization server-side.
* Escape all untrusted HTML.
* Prevent command injection.
* Prevent path traversal.
* Avoid unsafe `eval`, shell interpolation, or dynamically constructed PowerShell commands.
* Clean up timers, sockets, event handlers, and child processes.
* Avoid exposing student application inventory to unauthorized users.
* Maintain compatibility with existing clients where practical.
* Handle older or missing command fields defensively.

Do not leave core requested features as:

* TODO comments
* Empty handlers
* Mock buttons
* Console-only simulations
* Pseudocode
* Unconnected helper functions
* UI elements with no backend implementation

## Testing and verification

Use the project’s actual available tooling. Since this repository may not use npm, do not assume `npm test` or `npm run build` exists.

Inspect the README and scripts first.

Run all relevant checks that actually exist, such as:

* JavaScript syntax checks using `node --check`
* Existing test scripts
* Existing PowerShell validation or build scripts
* C# compilation
* Server startup smoke testing
* Agent startup smoke testing
* HTTP route testing
* WebSocket or socket command testing
* Manual browser-interface verification where automated browser tooling is unavailable

At minimum, validate:

* The server starts without syntax errors.
* The website loads.
* Existing login behavior still works.
* Location search ranks matches correctly.
* Unmatched tiles remain visible and clickable.
* Tab autocomplete selects and submits.
* Application autocomplete supports detected and custom entries.
* Message timeouts expire correctly.
* Instructor-disabled messages do not reappear.
* Block durations default to one minute.
* Custom block durations are validated.
* Foreground-window close commands return a result.
* Application rules persist and remain class-scoped.
* The agent reports open applications.
* The watchdog restarts the agent after an accidental close.
* Authorized shutdown prevents both processes from restarting.
* The download route rejects unauthenticated users.
* Instructor and director accounts can download the executable when it exists.
* The download route handles a missing binary safely.
* Runtime paths resolve through the active user’s Documents folder.

Add small focused test scripts where the project has no formal test framework. Do not add a large test dependency.

Do not suppress failures or remove existing functionality merely to get a passing result.

## Completion report

When finished, provide:

1. A summary of the implemented features.
2. A file-by-file summary of meaningful changes.
3. A clear explanation of how the local fuzzy-search ranking works.
4. The exact tests and commands run.
5. The result of each command.
6. Any Windows-specific behavior that could not be executed in the current environment.
7. The exact command to build `iD-Tech-Watch.exe`.
8. The expected executable output path.
9. The runtime installation path beneath the current user’s Documents folder.
10. The administrative shutdown procedure.
11. Known limitations that still genuinely remain.
12. A manual acceptance checklist for every requested feature.
13. Keep a thorough log of your process in /docs/07-22-26--10-03pm-output.md
14. Update README.md accordingly.

Do not stop after reading the repository or producing a plan. Continue implementing until the requested work and all validation possible in the current environment are complete. Take it in reasonable steps, not all at once. Reset/compress context windows when it makes sense and you are at a good reset point, not when it just gets to 100%.