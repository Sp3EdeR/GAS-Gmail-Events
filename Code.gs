var feedFileName = "event_feed";
var feedHeaders = ["start", "summary", "location", "description", "url"];
var feedLabelName = "\u00c9rtes\u00edt\u0151k/Esem\u00e9nyek";
var feedSender = "googlealerts-noreply@google.com";
var googleEventsFeedUrl = "https://raw.githubusercontent.com/Sp3EdeR/autosesemenyek-advcrawler/refs/heads/feed/google_events.json";

/**
 * Updates the event feed and trashes only messages successfully processed this run.
 * @return {Object<string, number>} Run counts for logging and local inspection.
 */
function processEventFeed() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000))
    throw new Error("An event feed update is already running");
  try {
    // Initialize the event feed sheet and read existing rows
    var sheet = getEventFeedSheet();
    Logger.log(`Found sheet "${sheet.getName()}" of "${sheet.getParent().getName()}".`);
    var rows = readEventFeedRows(sheet);
    Logger.log(`Imported ${rows.length} existing event rows from the sheet.`);
    var label = (Gmail.Users.Labels.list("me").labels || []).filter(function(item) {
      return item.name === feedLabelName;
    })[0];

    // Load Gmail messages for the label
    if (!label)
      throw new Error("Gmail label not found: " + feedLabelName);
    var messages = listAlertMessages(label.id);
    Logger.log(`Found ${messages.length} e-mails with label "${feedLabelName}".`);

    // Load existing event data from the spreadsheet by URL key
    var eventsByUrl = new Map();
    for (var row of rows)
      eventsByUrl.set(row[4], row);

    // Process messages and extract events
    for (var message of messages) {
      var subject = "(subject unavailable)";
      var fail = (reason) => new Error(
        `Failed to process message ${JSON.stringify(subject)}: ${reason}`
      );

      var data = Gmail.Users.Messages.get("me", message.id, { format: "full" });
      subject = getMessageHeader(data.payload, "Subject");
      var from = getMessageHeader(data.payload, "From");
      if ((data.labelIds || []).indexOf(label.id) === -1)
        throw fail("Message no longer has the event label");
      var sender = from.trim().match(
        /^(?:(?:[^<>,;"\\\r\n]+|"(?:[^"\\\r\n]|\\[^\r\n])*")\s*)?<([^<>\s,;]+)>$/
      );
      if ((sender ? sender[1] : from.trim()).toLowerCase() !== feedSender)
        throw fail("Unexpected message sender: " + from);
      var html = getMessageHtml(data.payload, data.id);
      if (!html)
        throw fail("Message has no HTML body");

      var events;
      try { events = getAlertEvents(html); } catch (error) { throw fail(error.message); }
      if (!events.length)
        throw fail("No event items found");
      Logger.log(`Parsed ${events.length} events from message ${JSON.stringify(subject)}.`);

      for (var event of events) {
        var existing = eventsByUrl.get(event.url);
        var row = feedHeaders.map((header, i) => event[header] || existing?.[i] || "");
        eventsByUrl.set(event.url, row);
      }
    }
    Logger.log(`Merged parsed events; ${eventsByUrl.size} unique URLs.`);

    // Remove stale events, retaining undated rows.
    var cutoff = getFeedCutoff();
    var beforeFilter = eventsByUrl.size;
    rows = Array.from(eventsByUrl.values()).filter(row =>
      !row[0] || cutoff <= row[0]
    );
    Logger.log(`Removed ${beforeFilter - rows.length} old rows; ${rows.length} rows remain.`);
    var googleEventUrls = getProcessedEventUrls();
    if (googleEventUrls) {
      beforeFilter = rows.length;
      rows = rows.filter(row => row[0] || !googleEventUrls.has(row[4]));
      Logger.log(`Removed ${beforeFilter - rows.length} undated rows already in google_events.json; ${rows.length} rows remain.`);
    }

    writeEventFeedRows(sheet, [feedHeaders].concat(rows));
    SpreadsheetApp.flush();
    Logger.log(`Updated the ${sheet.getName()} sheet.`);

    // Gmail batchModify accepts up to 1,000 explicit message IDs, never thread IDs.
    for (var offset = 0; offset < messages.length; offset += 1000) {
      Gmail.Users.Messages.batchModify({
        ids: messages.slice(offset, offset + 1000).map(function(message) { return message.id; }),
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"]
      }, "me");
      Logger.log(`Deleted ${Math.min(messages.length - offset, 1000)} processed messages.`);
    }
    var result = {messages: messages.length, events: rows.length};
    Logger.log(`Updated the feed with ${rows.length} events from ${messages.length} messages.`);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * @return {Set<string>} Unique event URLs from the crawler feed.
 */
function getProcessedEventUrls() {
  try {
    var response = UrlFetchApp.fetch(googleEventsFeedUrl);
    var events = JSON.parse(response.getContentText());
    if (!Array.isArray(events))
      throw new Error("Expected an array of events");
    var urls = new Set();
    for (var entry of events) {
      var url = entry?.google_evt?.url;
      if (typeof url === "string" && url.trim())
        urls.add(url);
    }
    return urls;
  } catch (error) {
    Logger.log(`Could not load google_events.json (${error.message}).`);
  }
  return null;
}

/**
 * Finds the first spreadsheet named as the feed in Drive, creating it if none exists.
 * @return {GoogleAppsScript.Spreadsheet.Sheet} Destination events sheet.
 */
function getEventFeedSheet() {
  var spreadsheet;
  var files = DriveApp.getFilesByName(feedFileName);
  while (files.hasNext()) {
    var file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      spreadsheet = SpreadsheetApp.openById(file.getId());
      break;
    }
  }
  if (spreadsheet)
    Logger.log(`Opened existing spreadsheet "${feedFileName}" (${spreadsheet.getId()}).`);
  else {
    spreadsheet = SpreadsheetApp.create(feedFileName);
    Logger.log(`Created new spreadsheet "${feedFileName}" (${spreadsheet.getId()}).`);
  }
  var sheet = spreadsheet.getSheetByName("events");
  if (!sheet) {
    var sheets = spreadsheet.getSheets();
    sheet = sheets.length === 1 && sheets[0].getLastRow() === 0 ?
      sheets[0].setName("events") : spreadsheet.insertSheet("events", 0);
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setNumberFormat("@");
    sheet.setFrozenRows(1);
    Logger.log(`Initialized missing "events" sheet.`);
  }
  return sheet;
}

/**
 * Reads existing columns once and maps them to the canonical feed schema.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet Events sheet.
 * @return {Array<Array<string>>} Existing event rows without the header.
 */
function readEventFeedRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (!lastRow)
    return [];
  var columns = sheet.getLastColumn();
  var values = sheet.getRange(1, 1, lastRow, columns).getValues();
  var headers = values.shift();
  var indexes = feedHeaders.map(header => headers.indexOf(header));
  if (values.length && indexes[4] === -1)
    throw new Error("Existing events sheet has data but no url column");
  return values.map(function(row) {
    return indexes.map(function(index, fieldIndex) {
      var value = row[index];
      value = !value ? "" : String(value);
      if (fieldIndex === 0 && value && !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new Error("Invalid event start date: " + value);
      return value;
    });
  });
}

/**
 * Snapshots every matching message ID before any messages are moved to Trash.
 * @param {string} labelId Nested event label ID.
 * @return {Array<Object<string, string>>} Gmail message references.
 */
function listAlertMessages(labelId) {
  var messages = [];
  var pageToken;
  do {
    var options = {
      labelIds: [labelId],
      maxResults: 500,
      q: `from:${feedSender} -in:trash -in:spam`,
      pageToken: pageToken
    };
    var page = Gmail.Users.Messages.list("me", options);
    messages = messages.concat(page.messages || []);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return messages;
}

/**
 * Finds a header in a Gmail MIME payload, ignoring header-name case.
 * @param {Object} payload Gmail message part.
 * @param {string} name Header name.
 * @return {string} Header value, or empty when absent.
 */
function getMessageHeader(payload, name) {
  var header = (payload.headers || []).filter(function(item) {
    return item.name.toLowerCase() === name.toLowerCase();
  })[0];
  return header ? header.value : "";
}

/**
 * Locates an HTML MIME part.
 * @param {Object} payload Gmail message part.
 * @param {string} messageId Owning Gmail message ID.
 * @return {string} Decoded HTML, or empty when absent.
 */
function getMessageHtml(payload, messageId) {
  if (payload.mimeType === "text/html") {
    var body = payload.body || {};
    var data = body.data;
    if (!data && body.attachmentId)
      data = Gmail.Users.Messages.Attachments.get("me", messageId, body.attachmentId).data;
    if (data) {
      var charset = getMessageHeader(payload, "Content-Type")
        .match(/charset\s*=\s*["']?([^\s;"']+)/i);
      return Utilities.newBlob(data)
        .getDataAsString(charset ? charset[1] : "UTF-8");
    }
  }
  var parts = payload.parts || [];
  for (var index = 0; index < parts.length; index++) {
    var html = getMessageHtml(parts[index], messageId);
    if (html)
      return html;
  }
  return "";
}

/**
 * Computes roughly one calendar month ago.
 * @return {string} ISO cutoff date; events on this date are retained.
 */
function getFeedCutoff() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 31);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Replaces feed rows with literal text and clears stale trailing data in one range.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet Destination events sheet.
 * @param {Array<Array<string>>} rows Header and data rows.
 */
function writeEventFeedRows(sheet, rows) {
  var lastRow = sheet.getLastRow();
  var maxRows = sheet.getMaxRows();
  var maxColumns = sheet.getMaxColumns();
  if (rows.length > maxRows)
    sheet.insertRowsAfter(maxRows, rows.length - maxRows);
  if (feedHeaders.length > maxColumns)
    sheet.insertColumnsAfter(maxColumns, feedHeaders.length - maxColumns);
  // Rich text prevents formula injection and spreadsheet date/number coercion.
  var values = rows.map(function(row) {
    return row.map(function(value) {
      return SpreadsheetApp.newRichTextValue().setText(value).build();
    });
  });
  sheet.getRange(1, 1, rows.length, feedHeaders.length).setRichTextValues(values);
  if (lastRow > rows.length)
    sheet.getRange(rows.length + 1, 1, lastRow - rows.length, feedHeaders.length).clearContent();
}
