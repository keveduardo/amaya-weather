// ═══════════════════════════════════════════════════════════════════
// Pool Temp Service v2
// - pollPool() runs on a 15-min time trigger: logs into iAquaLink
//   (reusing the session when possible), caches the result, and
//   appends a row to the history Google Sheet (incl. salinity).
// - doGet() serves the cached result instantly. ?history=1 returns
//   the last 24 hrs of pool temps for the webpage chart.
// Script Properties needed: IAQUALINK_EMAIL, IAQUALINK_PASSWORD
// (SESSION_ID, CACHED_DATA, SHEET_ID, etc. are managed automatically)
// ═══════════════════════════════════════════════════════════════════

var SERIAL  = "QGR2RQBF42KD";
var API_KEY = "EOOEMOW4YR6QNB11";

// ── Web endpoint ─────────────────────────────────────────────────────
function doGet(e) {
  if (e && e.parameter && e.parameter.history) {
    return jsonOut(getHistory());
  }
  var cached = PropertiesService.getScriptProperties().getProperty("CACHED_DATA");
  if (cached) return jsonOut(JSON.parse(cached));
  return jsonOut(pollPool());   // first run / cache empty — fetch live
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Poller: set a time-driven trigger to run this every 15 minutes ──
//
// ! pollPool takes NO parameters on purpose. A time-driven trigger calls it
// with an event object, so any first parameter would arrive truthy and a
// "force" flag there would silently disable quiet hours forever.
function pollPool() {
  return doPoll(false);
}

// Force a poll, ignoring quiet hours. Run this from the editor after deploying
// so you can verify immediately instead of waiting until 7am for the cache to
// refresh -- doGet serves the CACHE, not live data.
function refreshNow() {
  var r = doPoll(true);
  Logger.log(JSON.stringify(r, null, 2));
  Logger.log("chlorinator_pct = " + r.chlorinator_pct);
  return r;
}

function doPoll(force) {
  var props = PropertiesService.getScriptProperties();
  var now = new Date();

  // Quiet hours: skip polling 10pm–7am (pump is off; matches display night mode)
  var hour = parseInt(Utilities.formatDate(now, "America/Los_Angeles", "H"));
  if (!force && (hour >= 22 || hour < 7)) {
    var quiet = props.getProperty("CACHED_DATA");
    return quiet ? JSON.parse(quiet) : { success: false, pool_temp: null, error: "quiet hours, no cache yet" };
  }

  try {
    var home = fetchHome();

    var result = {
      success: true,
      updated: now.toISOString(),
      air_temp:    home.air_temp !== "" ? parseInt(home.air_temp) : null,
      pool_pump:   home.pool_pump === "1",
      spa_pump:    home.spa_pump === "1",
      pool_heater: home.pool_heater === "1",
      spa_heater:  home.spa_heater === "1",
      pool_set_point: home.pool_set_point !== "" ? parseInt(home.pool_set_point) : null,
      spa_set_point:  home.spa_set_point  !== "" ? parseInt(home.spa_set_point)  : null
    };

    // Salt cell OUTPUT SETTING only. Written to the history sheet already but
    // never returned by doGet, so nothing could read it. homecare fetches this
    // at the moment a water test is logged, so a chlorine reading always
    // carries the output setting that produced it.
    //
    // ! SALINITY IS DELIBERATELY NOT RETURNED. Kevin's call 2026-07-22, and a
    // sound one: a salt cell infers salinity from conductivity, which drifts
    // with water temperature and cell age and is commonly out by several
    // hundred ppm. Salt is recorded from his drop test instead. Putting a
    // controller estimate in the same column as a measurement would quietly
    // degrade the record, and nobody would be able to tell which was which
    // later. Do not add it back.
    var swc = home.swc_info || {};
    result.chlorinator_pct = (swc.swcPoolValue != null && swc.swcPoolValue !== "")
      ? parseInt(swc.swcPoolValue) : null;
    result.chlorinator_status = swc.swcPoolStatus || null;

    // Pool temp: live when pump is running, else last cached reading
    if (home.pool_temp !== "") {
      result.pool_temp = parseInt(home.pool_temp);
      result.pool_temp_live = true;
      props.setProperty("LAST_POOL_TEMP", home.pool_temp);
      props.setProperty("LAST_POOL_TEMP_TIME", now.toISOString());
      props.setProperty("LAST_LIVE_TIME", now.toISOString());  // for pump health check
    } else {
      var cachedTemp = props.getProperty("LAST_POOL_TEMP");
      result.pool_temp = cachedTemp ? parseInt(cachedTemp) : null;
      result.pool_temp_live = false;
      result.pool_temp_time = props.getProperty("LAST_POOL_TEMP_TIME") || null;
    }

    // Spa temp: only meaningful while the spa pump is running
    result.spa_temp = (home.spa_temp !== "" && home.spa_pump === "1")
      ? parseInt(home.spa_temp) : null;

    props.setProperty("CACHED_DATA", JSON.stringify(result));
    logHistory(now, result, home);
    return result;

  } catch (err) {
    // On failure keep serving the last good cache, flagged with the error
    var fallback = props.getProperty("CACHED_DATA");
    var result = fallback ? JSON.parse(fallback) : { pool_temp: null };
    result.success = false;
    result.error = String(err);
    return result;
  }
}

// ── iAquaLink: get_home with session reuse ───────────────────────────
function fetchHome() {
  var sessionId = getSession(false);
  var home = tryGetHome(sessionId);
  if (!home) {                       // session expired — re-login once
    sessionId = getSession(true);
    home = tryGetHome(sessionId);
    if (!home) throw new Error("get_home failed after re-login");
  }
  return home;
}

function tryGetHome(sessionId) {
  if (!sessionId) return null;
  var resp = UrlFetchApp.fetch(
    "https://p-api.iaqualink.net/v1/mobile/session.json" +
    "?actionID=command&command=get_home&serial=" + SERIAL +
    "&sessionID=" + sessionId,
    { muteHttpExceptions: true }
  );
  var data;
  try { data = JSON.parse(resp.getContentText()); } catch (e) { return null; }
  if (!data.home_screen) return null;

  var home = {};
  data.home_screen.forEach(function(item) {
    for (var key in item) home[key] = item[key];
  });
  return home;
}

function getSession(forceLogin) {
  var props = PropertiesService.getScriptProperties();
  if (!forceLogin) {
    var sid = props.getProperty("SESSION_ID");
    if (sid) return sid;
  }
  var resp = UrlFetchApp.fetch("https://prod.zodiac-io.com/users/v1/login", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      apiKey: API_KEY,
      email: props.getProperty("IAQUALINK_EMAIL"),
      password: props.getProperty("IAQUALINK_PASSWORD")
    }),
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());
  if (!data.session_id) throw new Error("Login failed");
  props.setProperty("SESSION_ID", data.session_id);
  return data.session_id;
}

// ── History sheet (auto-created on first poll) ───────────────────────
function logHistory(now, result, home) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("SHEET_ID");
  var ss;
  if (!sheetId) {
    ss = SpreadsheetApp.create("Pool History");
    props.setProperty("SHEET_ID", ss.getId());
    var sh0 = ss.getActiveSheet();
    sh0.setName("History");
    sh0.appendRow(["Timestamp", "Pool Temp", "Live", "Spa Temp", "Air Temp",
                   "Pool Pump", "Spa Pump", "Salinity", "SWC Value", "SWC Status",
                   "Pool Heater", "Spa Heater"]);
    Logger.log("Created history sheet: " + ss.getUrl());
  } else {
    ss = SpreadsheetApp.openById(sheetId);
  }
  var sh = ss.getSheetByName("History") || ss.getActiveSheet();
  var swc = home.swc_info || {};
  sh.appendRow([
    now,
    result.pool_temp,
    result.pool_temp_live,
    result.spa_temp,
    result.air_temp,
    result.pool_pump,
    result.spa_pump,
    home.pool_salinity !== "" ? home.pool_salinity : "",
    (swc.swcPoolValue != null) ? swc.swcPoolValue : "",
    swc.swcPoolStatus || "",
    result.pool_heater,
    result.spa_heater
  ]);
}

// ── History for the webpage chart: rows from the last 24 hours ──────
function getHistory() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("SHEET_ID");
  if (!sheetId) return { temps: [], times: [] };

  var sh = SpreadsheetApp.openById(sheetId).getSheetByName("History");
  var last = sh.getLastRow();
  var n = Math.min(120, last - 1);   // read a bit extra, filter by time below
  if (n < 1) return { temps: [], times: [] };

  var cutoff = Date.now() - 24 * 3600 * 1000;
  var rows = sh.getRange(last - n + 1, 1, n, 2).getValues();
  var temps = [], times = [];
  rows.forEach(function(r) {
    if (typeof r[1] === "number" && r[0] instanceof Date && r[0].getTime() >= cutoff) {
      times.push(r[0]);
      temps.push(r[1]);
    }
  });
  return { temps: temps, times: times };
}

// ── Pump health check: set a daily trigger for 10am–11am ─────────────
// Emails you if no live water-temp reading has arrived since 7am,
// which means the filter pump never started (breaker, failure, schedule).
function checkPumpHealth() {
  var props = PropertiesService.getScriptProperties();
  var tz = "America/Los_Angeles";
  var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

  var lastLive = props.getProperty("LAST_LIVE_TIME");
  var lastLiveDay = lastLive
    ? Utilities.formatDate(new Date(lastLive), tz, "yyyy-MM-dd") : "never";

  if (lastLiveDay === today) return;  // pump reported this morning — all good

  // Avoid duplicate alerts for the same day
  if (props.getProperty("LAST_ALERT_DAY") === today) return;
  props.setProperty("LAST_ALERT_DAY", today);

  var email = props.getProperty("ALERT_EMAIL") || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(
    email,
    "Pool alert: pump has not reported today",
    "No live water temperature reading has come in since 7am.\n\n" +
    "The filter pump may not have started — check for a tripped breaker,\n" +
    "an iAquaLink schedule change, or equipment failure.\n\n" +
    "Last live reading: " + (lastLive || "never") + "\n" +
    "— Amaya Weather pool monitor"
  );
}

// ── Diagnostic: what does iAquaLink ACTUALLY return? ─────────────────
// Run this once from the Apps Script editor and read the log. It dumps every
// field on the home screen, so questions like "does this system report salt?"
// are answered by data rather than by assumption.
function debugHome() {
  var home = fetchHome();
  Logger.log("=== ALL home_screen FIELDS ===");
  Object.keys(home).sort().forEach(function(k) {
    var v = home[k];
    Logger.log(k + " = " + (typeof v === "object" ? JSON.stringify(v) : "'" + v + "'"));
  });
  Logger.log("");
  Logger.log("=== THE ONES THAT MATTER ===");
  Logger.log("pool_salinity : '" + home.pool_salinity + "'   (empty = salt not reported)");
  Logger.log("swc_info      : " + JSON.stringify(home.swc_info || null));
}

// ── Run manually once to authorize + verify ──────────────────────────
function testPoll() {
  Logger.log(JSON.stringify(doPoll(true), null, 2));   // force: quiet hours would return the cache
  Logger.log("Sheet: " + (PropertiesService.getScriptProperties().getProperty("SHEET_ID") || "not yet created"));
}
