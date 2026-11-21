# GAS-Gmail-Events

Google Apps Script backend subproject of [Autós Események Naptára](https://github.com/Sp3EdeR/autosesemenyek). It collects Google Alerts results into a candidate feed that can be used to find new events not yet in the calendar.
The spreadsheet is post-processed further in the backend pipeline; calendar membership checks and calendar insertion belong to that pipeline, not this script.

This is a project-specific integration, not a general-purpose reusable package. Individual parts may be reused subject to the [license](LICENSE).

## Feed Processing

Run `processEventFeed()` to find or create the `event_feed` spreadsheet and its
`events` sheet. The script owns columns A:E, in this order:

| Column | Content |
| --- | --- |
| `start` | ISO `YYYY-MM-DD`; empty if no complete date can be parsed |
| `summary` | Title without the location/date or ` - Facebook` postfix |
| `location` | Location from the title, or Facebook metadata if absent there |
| `description` | Plain-text snippet, or organizer/type lines from metadata |
| `url` | De-Googled, normalized Facebook event URL |

Messages must have the Gmail label `Értesítők/Események` to be considered for processing. Create a Gmail filter to apply this label to incoming mails with sender `googlealerts-noreply@google.com`. IMPORTANT: in the filter actions, uncheck the "Never send it to Spam"! Events are extracted exclusively from the `<script data-scope="inboxmarkup" type="application/json">` payload in the decoded HTML body.

Events dated before one calendar month ago are removed to reduce spreadsheet bloat. A second filter removes undated events whose exact URL is already in the crawler's `google_events.json` feed and logs the number removed. If the feed cannot be fetched or parsed, the script logs that it skipped the second filter and keeps the undated rows.

## Apps Script Setup

1. Create a standalone Apps Script project in the Gmail account receiving alerts.
2. Add [Code.gs](Code.gs) and [EventParser.gs](EventParser.gs). Enable the manifest in project settings and use [appsscript.json](appsscript.json).
3. The manifest registers the **Advanced Gmail service, v1**, and the V8 runtime. With a standard Google Cloud project, also enable the Gmail API in that project.
4. Run `processEventFeed()` manually once and authorize Gmail modification, spreadsheet access, Drive discovery, and external requests. Add a time-driven trigger as needed.

The feed spreadsheet is found by Drive name `event_feed`: the first Google Sheets file with that name is used, and one is created if none exists. Use an empty sheet or the named header columns above.

## Local Simulation And Debugging

Initialize the simulator submodule if necessary, then install its MIME parser:

```sh
git submodule update --init test
npm install --prefix test
node test/run-gas.cjs processEventFeed
```

The default input directory is `${CWD}/test-mails`. To use another directory:

```sh
node test/run-gas.cjs processEventFeed --eml-dir "path/to/eml-directory"
```

Export applicable Google Alerts e-mails to *.eml and place them in this directory for testing and debugging.

## License

See [LICENSE](LICENSE) for the GNU GPL v3 terms. The simulator is a separate Git
submodule with its own [license](test/LICENSE). Changes under `test/` must be
published in that submodule and its parent pointer updated separately.