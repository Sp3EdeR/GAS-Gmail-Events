/**
 * Extracts Facebook events exclusively from a Google Alert's inbox markup JSON.
 * @param {string} html Gmail HTML body.
 * @return {Array<Object<string, string>>} Feed events.
 */
function getAlertEvents(html) {
  const scriptRe = /<script\b(?=[^>]*\sdata-scope\s*=\s*["']inboxmarkup["'])(?=[^>]*\stype\s*=\s*["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/gi;

  var found = false;
  var seen = {};
  for (var script of html.matchAll(scriptRe)) {
    found = true;
    var markup = JSON.parse(script[1]);
    if (!markup || !Array.isArray(markup.cards))
      throw new Error("Inbox markup has no cards array");
    for (var card of markup.cards) {
      if (!card || typeof card.title !== "string" ||
          !/^Google\b.*site:facebook\.com\/events/i.test(card.title))
        continue;
      if (!Array.isArray(card.widgets))
        throw new Error("Google Alert inbox card has no widgets array");
      for (var widget of card.widgets) {
        if (!widget || typeof widget.title !== "string" ||
            typeof widget.description !== "string" || typeof widget.url !== "string")
          throw new Error("Google Alert inbox widget has invalid title, description or url");
        var url = normalizeEventUrl(widget.url || "");
        if (!url)
          throw new Error("Undefined event URL found");
        var event = parseAlertEvent(widget.title, widget.description, url);
        seen[url] = event;
      }
    }
  }
  if (!found)
    throw new Error("Message has no inbox markup JSON");
  return Object.values(seen);
}

/**
 * Separates title postfixes and metadata, retaining title-derived location/date.
 * @param {string} summary Inbox widget title.
 * @param {string} description Inbox widget description.
 * @param {string} url Canonical Facebook URL.
 * @return {Object<string, string>} Feed fields.
 */
function parseAlertEvent(summary, description, url) {
  var event = {
    start: "",
    summary: summary.replace(/\s+-\s+Facebook\s*$/i, "").trim(),
    location: "",
    description: description,
    url: url
  };

  // Parse location and date from the title if it contains it
  var title = event.summary.match(/^(.*)\s+in\s+(.+?)\s+on\s+([a-z]+ \d+,? \d{4})$/i);
  if (title) {
    event.summary = title[1].trim();
    event.location = title[2].trim();
    event.start = parseEventDate(title[3]);
  }

  // Match the complete metadata sentence, not arbitrary prose mentioning an event.
  var properties = description.match(new RegExp(
    '^(?:(.+?)\\s+)?event(?:\\s+in\\s+(.+?))?(?:\\s+by\\s+(.+?))?' +
    '(?:\\s+on\\s+(.+?))?\\.\\s*$', "i"
  ));
  if (properties) {
    if (!event.location && properties[2])
      event.location = properties[2].trim();
    if (!event.start && properties[4])
      event.start = parseEventDate(properties[4]);
    var details = [];
    if (properties[3])
      details.push("Szervez\u0151: " + properties[3].trim());
    if (properties[1])
      details.push("T\u00edpus: " + properties[1].trim());
    event.description = details.join("\n");
  }
  return event;
}

/**
 * Unwraps Google links and removes Facebook's optional location/title slug pair.
 * @param {string} value Alert link or stored URL.
 * @return {string} Canonical event URL, or empty for non-event links.
 */
function normalizeEventUrl(value) {
  var url = String(value || "").trim();
  var redirect = url.match(/^https?:\/\/(?:www\.)?google\.[^/]+\/url\?[^#]*?\burl=([^&]+)/i);
  url = decodeURIComponent(redirect[1].replace(/\+/g, " "));
  // Remove Facebook's optional location/title slug pair from the URL
  url = url.replace(/\/events\/[^/]+\/[^/]+\/(\d+).*/i, "/events/$1");
  // Ensure we've got a canonical Facebook event URL
  var eventUrl = url.match(/^https?:\/\/www\.facebook\.com\/events\/(\d+)\/?(?:[?#].*)?$/i);
  if (!eventUrl)
    throw new Error("Invalid Facebook event URL: " + url);
  return "https://www.facebook.com/events/" + eventUrl[1];
}

/**
 * Parses English calendar dates without shifting date-only values.
 * @param {string} value Facebook date text, e.g. "May 3, 2026".
 * @return {string} ISO date (YYYY-MM-DD).
 */
function parseEventDate(value) {
  var text = String(value || "").trim();
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];
  var monthsReg = months.map(m => `${m.slice(0, 3)}(?:${m.slice(3)})?`);
  monthsReg = new RegExp(String.raw`\b(${monthsReg.join("|")}) +(\d{1,2}),? +(\d{4})\b`, "i");
  var english = text.match(monthsReg);

  if (!english)
    throw new Error("Invalid date format: " + text);
  var year = Number(english[3]);
  var month = months.map(m => m.slice(0, 3)).indexOf(english[1].slice(0, 3).toLowerCase()) + 1;
  var day = Number(english[2]);
  var date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day)
    throw new Error("Invalid date format: " + text);
  return date.toISOString().slice(0, 10);
}
