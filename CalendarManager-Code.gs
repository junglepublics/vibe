/**
 * CALENDAR MANAGER — Code.gs
 * ---------------------------------------------------------------------------
 * SETUP
 *   1. Paste this into a new Apps Script project as "Code.gs"
 *   2. Add an HTML file named exactly "index" and paste index.html into it
 *   3. Services (+ in left sidebar) > add "Google Calendar API"
 *   4. Run setup() once to authorise
 *   5. Deploy > New deployment > Web app > Execute as Me > Only myself
 *   6. (Optional) Run installTriggers() once for full automation
 * ---------------------------------------------------------------------------
 */

var CONFIG_KEY    = 'calendarManagerConfig';
var LASTRUN_KEY   = 'calendarManagerLastRun';
var LASTMSG_KEY   = 'calendarManagerLastMsg';
var SLACKSET_KEY  = 'calendarManagerSlackSet';   // text of the last status the script set

// Google Calendar's 11 named colours (for nearest-match fallback on events you don't own)
var GC_PALETTE_ = [
  { name:'PALE_BLUE',  r:164, g:189, b:252 },
  { name:'PALE_GREEN', r:81,  g:183, b:73  },
  { name:'MAUVE',      r:168, g:125, b:220 },
  { name:'PALE_RED',   r:246, g:145, b:178 },
  { name:'YELLOW',     r:251, g:215, b:91  },
  { name:'ORANGE',     r:255, g:184, b:120 },
  { name:'CYAN',       r:70,  g:214, b:219 },
  { name:'GRAY',       r:97,  g:97,  b:97  },
  { name:'BLUE',       r:84,  g:132, b:237 },
  { name:'GREEN',      r:11,  g:128, b:67  },
  { name:'RED',        r:220, g:33,  b:39  }
];

// ─── CONFIG ────────────────────────────────────────────────────────────────

function getDefaultConfig_() {
  return {
    personalCalendarId: 'prateek.shankar@gmail.com',
    workCalendarId:     'prateek@darkmatterlabs.org',
    workDomain:         'darkmatterlabs.org',
    syncDaysAhead:      14,
    slackToken:         '',
    keywords: {
      focus:      'focus, deep work',
      priority:   'flight, aic, urgent, visa, appointment, passport',
      nonmeeting: 'lecture, webinar, benjamin, glacier dialogue, tvgf, sparks of regeneration, cl7, cc6, disclosure day',
      hold:       'busy, hold, block, tentative, booked, lunch',
      reminder:   'reminder, remind'
    },
    // Each category maps to one of Google Calendar's named colours (the only
    // per-event colours Google reliably supports). 'NONE' = leave uncoloured,
    // so the event shows your calendar's native base colour (amethyst).
    colors: {
      default:    'NONE',        // leave native = amethyst
      team:       'MAUVE',       // grape / purple
      external:   'PALE_GREEN',  // sage / green
      nonmeeting: 'BLUE',        // blueberry
      focus:      'PALE_BLUE',   // lavender / lilac
      priority:   'RED',         // tomato
      hold:       'GRAY',        // grey (enum member is GRAY, shown as 'Graphite')
      reminder:   'PALE_RED',    // flamingo
      personal:   'YELLOW'       // banana
    },
    workHours: { start:'09:00', end:'18:30' },   // Slack 'After hours' boundaries
    lunch: {
      enabled:     true,
      windowStart: '12:30',
      windowEnd:   '14:30',
      prefer:      'earliest',   // earliest | middle | latest
      daysAhead:   7,
      color:       'YELLOW'
    }
  };
}

function loadConfig_() {
  var def = getDefaultConfig_();
  var raw = PropertiesService.getUserProperties().getProperty(CONFIG_KEY);
  if (!raw) return def;
  try {
    var saved = JSON.parse(raw);
    saved.keywords = Object.assign(def.keywords, saved.keywords || {});
    saved.lunch    = Object.assign(def.lunch,    saved.lunch    || {});

    // Normalise colours: any legacy HEX values become the nearest named colour.
    // Going forward everything is stored as a Google named colour (or 'NONE').
    var sc = saved.colors || {};
    var nc = {};
    Object.keys(def.colors).forEach(function(k) {
      var v = sc[k] || def.colors[k];
      if (v && v.charAt(0) === '#') v = nearestPaletteName_(v);   // migrate old hex
      nc[k] = v || def.colors[k];
    });
    saved.colors = nc;
    if (saved.lunch.color && saved.lunch.color.charAt(0) === '#') {
      saved.lunch.color = nearestPaletteName_(saved.lunch.color);
    }
    return Object.assign(def, saved);
  } catch(e) {
    return def;
  }
}

function saveConfig_(cfg) {
  PropertiesService.getUserProperties().setProperty(CONFIG_KEY, JSON.stringify(cfg));
}

// ─── LAST-RUN TRACKING ───────────────────────────────────────────────────────

function getLastRuns_() {
  var raw = PropertiesService.getUserProperties().getProperty(LASTRUN_KEY);
  return raw ? JSON.parse(raw) : {};
}
function getLastMsgs_() {
  var raw = PropertiesService.getUserProperties().getProperty(LASTMSG_KEY);
  return raw ? JSON.parse(raw) : {};
}
function setLastMsg_(key, msg) {
  var lm = getLastMsgs_();
  lm[key] = msg;
  PropertiesService.getUserProperties().setProperty(LASTMSG_KEY, JSON.stringify(lm));
}
function setLastRun_(key, msg) {
  var lr = getLastRuns_();
  lr[key] = new Date().toISOString();
  PropertiesService.getUserProperties().setProperty(LASTRUN_KEY, JSON.stringify(lr));
  if (msg !== undefined) setLastMsg_(key, msg);
}

// ─── WEB APP ──────────────────────────────────────────────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Calendar Manager')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setup() { CalendarApp.getAllCalendars(); Logger.log('Authorised. Now deploy as web app.'); }

// Run this from the editor to try the calendar jobs and read results in the Execution log.
// It makes real changes (creates/removes Busy + Lunch blocks, recolours events).
function testRun() {
  [['Busy sync', runBusySync], ['Colour coding', runColorCoding], ['Lunch', runLunchScheduler]].forEach(function(j) {
    var r = j[1]();
    Logger.log('=== ' + j[0] + ' ===');
    if (r.error) { Logger.log('ERROR: ' + r.error); return; }
    Logger.log(JSON.stringify({ created:r.created, deleted:r.deleted, updated:r.updated, unchanged:r.unchanged, scheduled:r.scheduled, moved:r.moved, skipped:r.skipped }));
    (r.log || []).forEach(function(l) { if (l.type !== 'skip') Logger.log((l.type === 'err' ? 'ERR  ' : '     ') + l.msg); });
  });
}

// ─── PUBLIC API (UI calls these) ──────────────────────────────────────────────

function getSettingsForUI() {
  var cfg = loadConfig_();
  cfg._lastRuns = getLastRuns_();
  cfg._lastMsgs = getLastMsgs_();
  return cfg;
}

function saveSettingsFromUI(data) {
  var cfg = loadConfig_();
  ['personalCalendarId','workCalendarId','workDomain','slackToken'].forEach(function(k) {
    if (data[k] !== undefined) cfg[k] = data[k];
  });
  if (data.syncDaysAhead !== undefined) cfg.syncDaysAhead = parseInt(data.syncDaysAhead) || 14;
  if (data.keywords) cfg.keywords = Object.assign(cfg.keywords, data.keywords);
  if (data.colors)   cfg.colors   = Object.assign(cfg.colors,   data.colors);
  if (data.lunch)    cfg.lunch    = Object.assign(cfg.lunch,    data.lunch);
  if (data.workHours) cfg.workHours = Object.assign(cfg.workHours, data.workHours);
  saveConfig_(cfg);
  return { ok: true };
}

// Run all four in sequence — used by the Overview "Run all now" button
function resetColorsToDefaults() {
  var cfg = loadConfig_();
  var def = getDefaultConfig_();
  cfg.colors = def.colors;
  cfg.lunch.color = def.lunch.color;
  saveConfig_(cfg);
  return { ok:true, colors:cfg.colors };
}

function runAll() {
  var out = {};
  out.busy   = runBusySync();
  out.lunch  = runLunchScheduler();
  out.colour = runColorCoding();
  out.slack  = updateSlackStatus();
  return out;
}

// ─── CALENDAR API HELPERS ─────────────────────────────────────────────────────
// Everything below reads events with ONE Calendar.Events.list call per calendar
// per job (attendees, description, location, conference data, colour all come
// back together) and only writes when something actually needs to change.

// Calendar event colour IDs (same order as Google's named colours)
var COLOR_IDS_ = { PALE_BLUE:'1', PALE_GREEN:'2', MAUVE:'3', PALE_RED:'4', YELLOW:'5',
                   ORANGE:'6', CYAN:'7', GRAY:'8', BLUE:'9', GREEN:'10', RED:'11' };
var VALID_COLOR_NAMES_ = Object.keys(COLOR_IDS_);
var NO_NOTIFY_ = { sendUpdates:'none' };

// Kept only for migrating legacy hex configs to named colours.
function nearestPaletteName_(hex) {
  var c = hex.replace('#','');
  var r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
  var best = GC_PALETTE_[0], bd = Infinity;
  GC_PALETTE_.forEach(function(p) {
    var d = (r-p.r)*(r-p.r) + (g-p.g)*(g-p.g) + (b-p.b)*(b-p.b);
    if (d < bd) { bd = d; best = p; }
  });
  return best.name;
}

function resolveColorName_(c) {
  if (!c || c === 'NONE') return 'NONE';
  if (c === 'GRAPHITE') return 'GRAY';                            // legacy alias
  if (c.charAt(0) === '#') return nearestPaletteName_(c);         // legacy hex → name
  if (VALID_COLOR_NAMES_.indexOf(c) !== -1) return c;
  return 'MAUVE';                                                 // unknown → safe purple
}

// '' = no colour set on the event (shows the calendar's native colour)
function colorId_(name) {
  var n = resolveColorName_(name);
  return n === 'NONE' ? '' : COLOR_IDS_[n];
}

function listEvents_(calendarId, timeMin, timeMax) {
  var out = [], token;
  do {
    var r = Calendar.Events.list(calendarId, {
      timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken: token,
      fields: 'nextPageToken,items(id,summary,description,location,hangoutLink,colorId,eventType,' +
              'start,end,conferenceData(entryPoints(uri)),' +
              'attendees(email,self,organizer,resource,responseStatus))'
    });
    out = out.concat(r.items || []);
    token = r.nextPageToken;
  } while (token);
  return out;
}

function isTimed_(ev)   { return !!(ev.start && ev.start.dateTime); }
function startMs_(ev)   { return new Date(ev.start.dateTime).getTime(); }
function endMs_(ev)     { return new Date(ev.end.dateTime).getTime(); }
function baseId_(id)    { return String(id).split('@')[0].split('_')[0]; }
function titleOf_(ev)   { return ev.summary || ''; }
function descOf_(ev)    { return ev.description || ''; }

// 'owner' | 'accepted' | 'tentative' | 'declined' | 'needsAction'
// No guest list (solo event) or not on the list = yours.
function myResponse_(ev) {
  var a = ev.attendees || [];
  for (var i = 0; i < a.length; i++) {
    if (a[i].self) return a[i].organizer ? 'owner' : (a[i].responseStatus || 'needsAction');
  }
  return 'owner';
}
function isAccepted_(ev) { var r = myResponse_(ev); return r === 'owner' || r === 'accepted'; }

// '#exception' anywhere in an event's description turns off all keyword rules
// for that event, so it is coloured purely by who is attending.
function hasException_(ev) { return /#exception/i.test(descOf_(ev)); }

// The Lunch block this script creates (not a lunch *meeting* someone else made).
function isManagedLunch_(ev) { return titleOf_(ev) === 'Lunch' && descOf_(ev).indexOf('lunch-block') !== -1; }

function isSyncedBusy_(ev) { return titleOf_(ev) === 'Busy' && descOf_(ev).indexOf('synced:') === 0; }

// Attendees other than you and room/resource calendars
function attendeeEmails_(ev) {
  return (ev.attendees || [])
    .filter(function(a) { return a.email && !a.self && !a.resource; })
    .map(function(a) { return a.email.toLowerCase(); });
}

// Detect a Microsoft Teams or Zoom link anywhere in the event (location,
// description, or Google's conferenceData). We never use Teams/Zoom for internal
// DML meetings, so presence of one strongly implies an external meeting.
function hasConferenceLink_(ev) {
  var hay = (ev.location || '') + ' ' + descOf_(ev) + ' ' + (ev.hangoutLink || '') + ' ';
  if (ev.conferenceData && ev.conferenceData.entryPoints) {
    hay += ev.conferenceData.entryPoints.map(function(p) { return p.uri || ''; }).join(' ');
  }
  hay = hay.toLowerCase();
  return hay.indexOf('teams.microsoft') !== -1 ||
         hay.indexOf('microsoft teams') !== -1 ||
         hay.indexOf('zoom.us')        !== -1 ||
         hay.indexOf('zoom meeting')   !== -1;
}

// ─── BUSY SYNC ────────────────────────────────────────────────────────────────
// Mirrors accepted weekday events from Play to the work calendar as "Busy".
// A block is identified by (source event, start, end), so recurring events sync
// per occurrence, moved/shortened events are re-created, and blocks whose source
// event was deleted, declined or moved are removed.

function runBusySync() {
  var cfg = loadConfig_();
  var res = { created:0, deleted:0, skipped:0, log:[] };
  var now = new Date(), end = new Date(now.getTime() + cfg.syncDaysAhead*86400000);

  var source, workEvents;
  try { source = listEvents_(cfg.personalCalendarId, now, end); }
  catch(e) { return { error:'Cannot access Play calendar. Check the ID in Settings. (' + e.message + ')' }; }
  try { workEvents = listEvents_(cfg.workCalendarId, now, end); }
  catch(e) { return { error:'Cannot access work calendar. Check the ID in Settings. (' + e.message + ')' }; }

  var key = function(id, s, e) { return baseId_(id) + '|' + s + '|' + e; };

  // Existing synced blocks (from this source calendar), keyed the same way
  var have = {};
  workEvents.forEach(function(b) {
    if (!isTimed_(b) || !isSyncedBusy_(b)) return;
    var parts = descOf_(b).replace('synced:','').trim().split(':');
    if (parts.length < 2 || parts[0] !== cfg.personalCalendarId) return;
    have[key(parts.slice(1).join(':'), startMs_(b), endMs_(b))] = b;
  });

  var cid = colorId_(cfg.colors.hold);
  var valid = {};

  source.forEach(function(ev) {
    var title = titleOf_(ev);
    if (!isTimed_(ev))                                    { res.skipped++; res.log.push({type:'skip', msg:'All-day skipped: '+title}); return; }
    if (ev.eventType === 'workingLocation')               { res.skipped++; return; }
    var dow = new Date(ev.start.dateTime).getDay();
    if (dow === 0 || dow === 6)                           { res.skipped++; res.log.push({type:'skip', msg:'Weekend skipped: '+title}); return; }

    // Only mirror events you've accepted, own, or created solo (no guests).
    var st = myResponse_(ev);
    if (st !== 'owner' && st !== 'accepted') {
      res.skipped++;
      var why = st === 'declined' ? 'Declined' : st === 'tentative' ? 'Maybe' : 'Not accepted';
      res.log.push({type:'skip', msg:why+' skipped: '+title});
      return;
    }

    var k = key(ev.id, startMs_(ev), endMs_(ev));
    valid[k] = true;
    if (have[k]) { res.skipped++; return; }

    try {
      var block = {
        summary: 'Busy',
        description: 'synced: ' + cfg.personalCalendarId + ':' + ev.id,
        start: { dateTime: ev.start.dateTime },
        end:   { dateTime: ev.end.dateTime }
      };
      if (cid) block.colorId = cid;
      Calendar.Events.insert(block, cfg.workCalendarId, NO_NOTIFY_);
      have[k] = true;
      res.created++;
      res.log.push({type:'ok', msg:'Created: '+title+' ('+fmt_(new Date(ev.start.dateTime))+')'});
    } catch(e) {
      res.log.push({type:'err', msg:'Failed: '+title+' — '+e.message});
    }
  });

  // Remove blocks whose source event no longer qualifies
  Object.keys(have).forEach(function(k) {
    var b = have[k];
    if (valid[k] || b === true) return;
    try {
      Calendar.Events.remove(cfg.workCalendarId, b.id, NO_NOTIFY_);
      res.deleted++;
      res.log.push({type:'ok', msg:'Removed stale block ('+fmt_(new Date(b.start.dateTime))+')'});
    } catch(e) {
      res.log.push({type:'err', msg:'Could not remove block — '+e.message});
    }
  });

  setLastRun_('busy', res.created + ' added · ' + res.deleted + ' removed · ' + res.skipped + ' skipped');
  return res;
}

// ─── COLOUR CODING ────────────────────────────────────────────────────────────
// One list call; an event is only written to when its colour is actually wrong.

function runColorCoding() {
  var cfg = loadConfig_();
  var res = { updated:0, unchanged:0, skipped:0, log:[] };
  var now = new Date(), end = new Date(now.getTime() + cfg.syncDaysAhead*86400000);

  var events;
  try { events = listEvents_(cfg.workCalendarId, now, end); }
  catch(e) { return { error:'Cannot access work calendar. (' + e.message + ')' }; }

  events.forEach(function(ev) {
    // all-day events, working location, out-of-office, birthdays etc. are left alone
    if (!isTimed_(ev) || (ev.eventType && ev.eventType !== 'default' && ev.eventType !== 'focusTime')) { res.skipped++; return; }

    var cls = classifyEvent_(ev, cfg);
    var want = colorId_(cls.color);
    if ((ev.colorId || '') === want) { res.unchanged++; return; }

    try {
      Calendar.Events.patch({ colorId: want || null }, cfg.workCalendarId, ev.id, NO_NOTIFY_);
      res.updated++;
      res.log.push({type:'ok', msg:titleOf_(ev)+' → '+resolveColorName_(cls.color)+' ['+cls.reason+']'});
    } catch(e) {
      res.log.push({type:'err', msg:titleOf_(ev)+' — '+e.message});
    }
  });

  setLastRun_('colour', res.updated + ' recoloured · ' + res.unchanged + ' already right');
  return res;
}

// Colour category for one event (shared by the colour job and the UI preview).
function classifyEvent_(ev, cfg) {
  if (isSyncedBusy_(ev))   return { cat:'hold',  color:cfg.colors.hold, reason:'synced Busy block' };
  if (isManagedLunch_(ev)) return { cat:'lunch', color:cfg.lunch.color, reason:'managed lunch block' };
  return classify_(titleOf_(ev).toLowerCase(), attendeeEmails_(ev), cfg, hasConferenceLink_(ev), hasException_(ev));
}

// Dry run for the UI: how the next 7 days WOULD be coloured, with nothing written.
function getPreview() {
  var cfg = loadConfig_(), tz = Session.getScriptTimeZone();
  var now = new Date();
  var from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var to = new Date(from.getTime() + 7*86400000);
  var events;
  try { events = listEvents_(cfg.workCalendarId, from, to); }
  catch(e) { return { error:'Cannot read work calendar. (' + e.message + ')' }; }

  var days = [], byKey = {};
  events.forEach(function(ev) {
    if (!isTimed_(ev) || (ev.eventType && ev.eventType !== 'default' && ev.eventType !== 'focusTime')) return;
    var s = new Date(ev.start.dateTime), e = new Date(ev.end.dateTime);
    var key = Utilities.formatDate(s, tz, 'yyyy-MM-dd');
    if (!byKey[key]) {
      byKey[key] = { key:key, label:Utilities.formatDate(s, tz, 'EEEE d MMM'), events:[] };
      days.push(byKey[key]);
    }
    var cls = classifyEvent_(ev, cfg);
    byKey[key].events.push({
      time:   Utilities.formatDate(s, tz, 'HH:mm') + '–' + Utilities.formatDate(e, tz, 'HH:mm'),
      title:  titleOf_(ev) || '(no title)',
      color:  resolveColorName_(cls.color),
      cat:    cls.cat,
      reason: cls.reason,
      change: (ev.colorId || '') !== colorId_(cls.color),
      past:   e.getTime() < now.getTime()
    });
  });
  return { days:days, today:Utilities.formatDate(now, tz, 'yyyy-MM-dd') };
}

// STRUCTURE-FIRST CLASSIFICATION
// Reliable signal for meeting-type is WHO is in it, not what it's called.
// So: unambiguous personal-intent keywords (focus, reminder) win first, and the
// hold keywords (incl. 'lunch') win only for solo blocks; then anything WITH
// attendees is a meeting, classified by participants (external beats team); only
// events WITHOUT attendees fall back to the remaining keyword categories
// (priority, non-meeting) and finally default.
// hasConf = event has a Teams/Zoom link (we never use those internally, so it's external).
// exception = event description contains #exception, so all keyword rules are skipped.
function classify_(title, emails, cfg, hasConf, exception) {
  var k = cfg.keywords, c = cfg.colors;

  // 1. Personal-intent blocks. 'hold' words only count when nobody else is invited,
  //    so a lunch *meeting* is coloured by its attendees like any other meeting.
  if (!exception) {
    if (kw_(title, k.focus))                     return { cat:'focus', color:c.focus,    reason:'focus keyword' };
    if (!emails.length && kw_(title, k.hold))    return { cat:'hold', color:c.hold,     reason:'hold keyword (solo)' };
    if (kw_(title, k.reminder))                  return { cat:'reminder', color:c.reminder, reason:'reminder keyword' };
  }

  // 2. Teams/Zoom link → external (we only use those with outside parties)
  if (hasConf) return { cat:'external', color:c.external, reason:'Teams/Zoom link → external' };

  // 3. Has attendees → MEETING. Classify by WHO.
  if (emails.length) {
    var ext = 0, intl = 0;
    emails.forEach(function(e){ if (e.indexOf('@'+cfg.workDomain) !== -1) intl++; else ext++; });
    if (ext)  return { cat:'external', color:c.external, reason:ext +' external attendee(s)' };
    return { cat:'team', color:c.team, reason:intl +' DML attendee(s)' };
  }

  // 4. No attendees → solo block. Title keywords are now safe.
  if (!exception) {
    if (kw_(title, k.priority))   return { cat:'priority', color:c.priority,   reason:'priority keyword (solo)' };
    if (kw_(title, k.nonmeeting)) return { cat:'nonmeeting', color:c.nonmeeting, reason:'non-meeting keyword (solo)' };
  }

  return { cat:'default', color:c.default, reason: exception ? 'solo, #exception' : 'solo, no keyword match' };
}

// Whole-token keyword match. A keyword matches only if it appears as a complete
// token in the title (bounded by start/end of string or any non-alphanumeric char),
// so 'cl7' won't match inside 'particle' and 'review' won't match 'reviewer'.
// Multi-word keywords like 'glacier dialogue' are matched as a phrase.
function kw_(text, str) {
  if (!str) return false;
  var terms = str.toLowerCase().split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  return terms.some(function(t) {
    var esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)', 'i').test(text);
  });
}

// ─── LUNCH SCHEDULER ───────────────────────────────────────────────────────────
// A slot is BUSY only if it's an accepted meeting (yours/accepted) that is NOT focus time.
// Focus time, tentative, declined and unmarked events all count as FREE.
// One list call covers every day; days are grouped in memory.

function runLunchScheduler() {
  var cfg = loadConfig_(), L = cfg.lunch;
  var res = { scheduled:0, moved:0, skipped:0, log:[] };
  if (!L.enabled) { setLastRun_('lunch', 'Disabled'); return { scheduled:0, moved:0, skipped:0, log:[{type:'skip',msg:'Lunch scheduling is disabled.'}] }; }

  var now = new Date(), nowMs = now.getTime(), days = parseInt(L.daysAhead) || 7, dur = 60*60000;
  var ws = toMins_(L.windowStart), we = toMins_(L.windowEnd);
  var at = function(offset, mins) { return new Date(now.getFullYear(), now.getMonth(), now.getDate()+offset, Math.floor(mins/60), mins%60, 0, 0); };

  var events;
  try { events = listEvents_(cfg.workCalendarId, at(0, ws), at(days-1, we)); }
  catch(e) { return { error:'Cannot access work calendar. (' + e.message + ')' }; }
  var timed = events.filter(isTimed_);
  var cid = colorId_(L.color);

  for (var d = 0; d < days; d++) {
    var dStart = at(d, ws), dEnd = at(d, we), dow = dStart.getDay();
    if (dow === 0 || dow === 6) continue;
    var winS = dStart.getTime(), winE = dEnd.getTime();
    if (winE <= nowMs) continue;                                   // window already over

    var lunches = [], busy = [];
    timed.forEach(function(ev) {
      var s = startMs_(ev), e = endMs_(ev);
      if (e <= winS || s >= winE) return;
      if (isManagedLunch_(ev)) { lunches.push(ev); return; }
      var isFocus = kw_(titleOf_(ev).toLowerCase(), cfg.keywords.focus);
      if (isAccepted_(ev) && !isFocus) busy.push({ start:s, end:e });
    });
    var existing = lunches.shift() || null;
    lunches.forEach(function(x) { try { Calendar.Events.remove(cfg.workCalendarId, x.id, NO_NOTIFY_); } catch(e) {} });  // duplicates

    var label = Utilities.formatDate(dStart, Session.getScriptTimeZone(), 'EEE dd MMM');

    // Lunch already under way: leave it alone
    if (existing && startMs_(existing) <= nowMs) { res.log.push({type:'ok', msg:label+': lunch already started'}); continue; }
    // Today: the part of the window that has passed is not available
    if (!existing && winS < nowMs) busy.push({ start:winS, end:nowMs });

    var slot = findSlot_(winS, winE, dur, busy, L.prefer);

    if (!slot) {
      if (existing) { try { Calendar.Events.remove(cfg.workCalendarId, existing.id, NO_NOTIFY_); } catch(e){} res.log.push({type:'skip', msg:label+': no free slot, removed lunch'}); }
      else          { res.log.push({type:'skip', msg:label+': no free slot'}); }
      res.skipped++;
      continue;
    }

    var ss = new Date(slot.start), se = new Date(slot.end);
    if (existing) {
      if (Math.abs(startMs_(existing) - slot.start) < 60000) { continue; }   // already in the right place
      try {
        Calendar.Events.patch({ start:{ dateTime:ss.toISOString() }, end:{ dateTime:se.toISOString() } }, cfg.workCalendarId, existing.id, NO_NOTIFY_);
        res.moved++; res.log.push({type:'ok', msg:label+': moved to '+hm_(ss)+'–'+hm_(se)});
      } catch(e) { res.log.push({type:'err', msg:label+': '+e.message}); }
    } else {
      try {
        var lunch = {
          summary: 'Lunch',
          description: 'lunch-block: managed by Calendar Manager',
          start: { dateTime:ss.toISOString() },
          end:   { dateTime:se.toISOString() }
        };
        if (cid) lunch.colorId = cid;
        Calendar.Events.insert(lunch, cfg.workCalendarId, NO_NOTIFY_);
        res.scheduled++; res.log.push({type:'ok', msg:label+': created '+hm_(ss)+'–'+hm_(se)});
      } catch(e) { res.log.push({type:'err', msg:label+': '+e.message}); }
    }
  }

  setLastRun_('lunch', res.scheduled + ' added · ' + res.moved + ' moved · ' + res.skipped + ' no free slot');
  return res;
}

function findSlot_(winS, winE, dur, busy, prefer) {
  busy.sort(function(a,b){ return a.start - b.start; });
  var free = [], cur = winS;
  busy.forEach(function(b) {
    var s = Math.max(b.start, winS), e = Math.min(b.end, winE);
    if (s > cur && s - cur >= dur) free.push({ start:cur, end:s });
    if (e > cur) cur = e;
  });
  if (winE - cur >= dur) free.push({ start:cur, end:winE });
  if (!free.length) return null;

  if (prefer === 'latest') { var l = free[free.length-1]; return { start:l.end-dur, end:l.end }; }
  if (prefer === 'middle') {
    var m = free[Math.floor(free.length/2)], mid = (m.start+m.end)/2;
    var s = mid - dur/2, e = mid + dur/2;
    if (s < m.start) { s = m.start; e = s+dur; }
    if (e > m.end)   { e = m.end;   s = e-dur; }
    return { start:s, end:e };
  }
  return { start:free[0].start, end:free[0].start+dur };
}

// ─── SLACK STATUS ───────────────────────────────────────────────────────────────

function updateSlackStatus() {
  var r = slackSync_();
  setLastMsg_('slack', r.error ? 'Error: ' + r.error : r.msg);
  return r;
}

function slackSync_() {
  var cfg = loadConfig_();
  if (!cfg.slackToken) return { error:'No Slack token in Settings.' };
  var now = new Date(), soon = new Date(now.getTime()+60000);
  var tm = now.getHours()*60 + now.getMinutes();
  var startM = toMins_(cfg.workHours.start), endM = toMins_(cfg.workHours.end);
  var afterHours = (tm < startM) || (tm >= endM);

  var text = '', emoji = '', exp = 0;

  if (afterHours) {
    emoji = moon_(); text = 'After hours';
    var next = new Date(now); if (tm >= endM) next.setDate(next.getDate()+1);
    next.setHours(Math.floor(startM/60), startM%60, 0, 0); exp = Math.floor(next.getTime()/1000);
  } else {
    var evs;
    try {
      evs = listEvents_(cfg.workCalendarId, now, soon).filter(function(e) {
        return isTimed_(e) && myResponse_(e) !== 'declined';
      });
    } catch(e) { return { error:'Cannot access work calendar. (' + e.message + ')' }; }
    evs.sort(function(a,b) { return (isAccepted_(a) ? 0 : 1) - (isAccepted_(b) ? 0 : 1); });
    if (evs.length) {
      var cur = evs[0], title = titleOf_(cur), low = title.toLowerCase();
      exp = Math.floor(endMs_(cur)/1000);
      if (kw_(low, cfg.keywords.focus))      { emoji=':headphones:'; text='In focus time'; }
      else if (isManagedLunch_(cur) || (low.indexOf('lunch') !== -1 && !hasException_(cur))) { emoji=':bento:'; text='At lunch'; }
      else if (isSyncedBusy_(cur))           { emoji=':calendar:';   text='In a meeting'; }
      else                                   { emoji=':calendar:';   text='In a meeting: ' + truncate_(title, 90); }
    }
  }

  try {
    // Never overwrite a status you set yourself in Slack. We remember the text
    // we last set; if the current status is non-empty and differs, it's manual.
    var g = JSON.parse(UrlFetchApp.fetch('https://slack.com/api/users.profile.get', {
      headers:{ 'Authorization':'Bearer '+cfg.slackToken },
      muteHttpExceptions:true
    }).getContentText());
    if (!g.ok) return { error: slackError_(g.error, 'users.profile:read') };

    var curText = (g.profile.status_text || ''), curEmoji = (g.profile.status_emoji || '');
    var curExp  = g.profile.status_expiration || 0;
    var last    = PropertiesService.getUserProperties().getProperty(SLACKSET_KEY);
    var isEmpty = !curText && !curEmoji;
    var isOurs  = last !== null && curText === last;   // compare text only: Slack may rewrite emoji codes

    setLastRun_('slack');
    if (!isEmpty && !isOurs) {
      return { ok:true, msg:'Your own Slack status ("' + truncate_(curText || curEmoji, 40) + '") left alone' };
    }
    if (!text && isEmpty)                  return { ok:true, msg:'No change (no active meeting)' };
    if (text && curText === text && curExp === exp) return { ok:true, msg:'No change: ' + text };

    var j = slackSetStatus_(cfg.slackToken, text, emoji, exp);
    if (!j.ok) return { error: slackError_(j.error, 'users.profile:write') };
    if (text) PropertiesService.getUserProperties().setProperty(SLACKSET_KEY, text);
    else      PropertiesService.getUserProperties().deleteProperty(SLACKSET_KEY);
    return { ok:true, msg: text ? ('Status set: '+emoji+' '+text) : 'Status cleared (no active meeting)' };
  } catch(e) { return { error:'Request failed: '+e.message }; }
}

// Used by the "Clear status" button — clears unconditionally, even a manual status.
function clearSlackStatus() {
  var cfg = loadConfig_();
  if (!cfg.slackToken) return { error:'No Slack token in Settings.' };
  try {
    var j = slackSetStatus_(cfg.slackToken, '', '', 0);
    if (!j.ok) return { error: slackError_(j.error, 'users.profile:write') };
    PropertiesService.getUserProperties().deleteProperty(SLACKSET_KEY);
    return { ok:true, msg:'Status cleared' };
  } catch(e) { return { error:'Request failed: '+e.message }; }
}

function slackSetStatus_(token, text, emoji, exp) {
  var r = UrlFetchApp.fetch('https://slack.com/api/users.profile.set', {
    method:'post',
    headers:{ 'Authorization':'Bearer '+token, 'Content-Type':'application/json; charset=utf-8' },
    payload:JSON.stringify({ profile:{ status_text:text, status_emoji:emoji, status_expiration:exp } }),
    muteHttpExceptions:true
  });
  return JSON.parse(r.getContentText());
}

function slackError_(err, scope) {
  var m = 'Slack error: ' + err;
  if (err === 'missing_scope') m += ' — add ' + scope + ' under User Token Scopes at api.slack.com/apps, reinstall, repaste token.';
  return m;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function moon_() {
  var p = ((( (new Date().getTime() - new Date(2000,0,6).getTime())/86400000 ) % 29.53058867) + 29.53058867) % 29.53058867;
  return p<1.85?'🌑':p<7.38?'🌒':p<9.22?'🌓':p<14.77?'🌔':p<16.61?'🌕':p<22.15?'🌖':p<23.99?'🌗':'🌘';
}
function truncate_(s, n) { return s.length > n ? s.substr(0, n-1) + '…' : s; }
function toMins_(hhmm) { var p = hhmm.split(':'); return parseInt(p[0])*60 + parseInt(p[1]); }
function fmt_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'EEE dd MMM, HH:mm'); }
function hm_(d)  { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm'); }

// ─── TRIGGERS ────────────────────────────────────────────────────────────────
// Calendar jobs run when either calendar changes (plus an hourly safety net).
// Our own writes re-fire the change trigger, so a short debounce and a lock keep
// that from looping; a run that finds nothing to change writes nothing.

var LASTSYNC_KEY = 'calendarManagerLastSync';

function syncCalendars() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(20000)) return;
  try {
    runBusySync();
    runColorCoding();
    runLunchScheduler();
  } finally {
    lock.releaseLock();
  }
}

function onCalendarChange() {
  var props = PropertiesService.getUserProperties();
  if (Date.now() - Number(props.getProperty(LASTSYNC_KEY) || 0) < 30000) return;
  props.setProperty(LASTSYNC_KEY, String(Date.now()));
  syncCalendars();
  props.setProperty(LASTSYNC_KEY, String(Date.now()));   // swallow the echo from our own writes
}

function installTriggers() {
  var cfg = loadConfig_();
  ScriptApp.getProjectTriggers().forEach(function(t){ ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncCalendars').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('onCalendarChange').forUserCalendar(cfg.personalCalendarId).onEventUpdated().create();
  if (cfg.workCalendarId !== cfg.personalCalendarId) {
    ScriptApp.newTrigger('onCalendarChange').forUserCalendar(cfg.workCalendarId).onEventUpdated().create();
  }
  ScriptApp.newTrigger('updateSlackStatus').timeBased().everyMinutes(5).create();
  Logger.log('Triggers installed.');
}
