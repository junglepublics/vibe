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
function setLastRun_(key) {
  var lr = getLastRuns_();
  lr[key] = new Date().toISOString();
  PropertiesService.getUserProperties().setProperty(LASTRUN_KEY, JSON.stringify(lr));
}

// ─── WEB APP ──────────────────────────────────────────────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Calendar Manager')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function setup() { CalendarApp.getAllCalendars(); Logger.log('Authorised. Now deploy as web app.'); }

// ─── PUBLIC API (UI calls these) ──────────────────────────────────────────────

function getSettingsForUI() {
  var cfg = loadConfig_();
  cfg._lastRuns = getLastRuns_();
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

// Detect a Microsoft Teams or Zoom link anywhere in the event (location,
// description, or Google's conferenceData). We never use Teams/Zoom for internal
// DML meetings, so presence of one strongly implies an external meeting.
function hasConferenceLink_(calendarId, ev) {
  var hay = '';
  try { hay += (ev.getLocation() || '') + ' '; } catch(e) {}
  try { hay += (ev.getDescription() || '') + ' '; } catch(e) {}
  try {
    var id = ev.getId().split('@')[0].split('_')[0];
    var adv = Calendar.Events.get(calendarId, id);
    if (adv.location)    hay += adv.location + ' ';
    if (adv.description) hay += adv.description + ' ';
    if (adv.hangoutLink) hay += adv.hangoutLink + ' ';
    if (adv.conferenceData) hay += JSON.stringify(adv.conferenceData) + ' ';
  } catch(e) {}
  hay = hay.toLowerCase();
  return hay.indexOf('teams.microsoft') !== -1 ||
         hay.indexOf('microsoft teams') !== -1 ||
         hay.indexOf('zoom.us')        !== -1 ||
         hay.indexOf('zoom meeting')   !== -1;
}

// ─── COLOUR APPLICATION (shared) ──────────────────────────────────────────────

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

// Colour an event on YOUR calendar view. CalendarApp.setColor() reliably colours
// your personal copy of any event, regardless of organiser (like right-clicking in
// the Google Calendar UI). Accepts a Google named colour, or 'NONE' to clear the
// colour so the event shows your calendar's native base colour.
var VALID_COLOR_NAMES_ = ['PALE_BLUE','PALE_GREEN','MAUVE','PALE_RED','YELLOW','ORANGE','CYAN','GRAY','BLUE','GREEN','RED'];

function resolveColorName_(c) {
  if (!c) return 'NONE';
  if (c === 'NONE') return 'NONE';
  if (c === 'GRAPHITE') return 'GRAY';                            // legacy alias (correct enum is GRAY)
  if (c.charAt(0) === '#') return nearestPaletteName_(c);         // legacy hex → name
  if (VALID_COLOR_NAMES_.indexOf(c) !== -1) return c;            // already valid
  return nearestPaletteName_('#9B59B6');                         // unknown → safe purple
}

function setEventColor_(calendarId, calAppEvent, colorName) {
  var name = resolveColorName_(colorName);
  if (name === 'NONE') {
    try { calAppEvent.setColor(null); } catch(e) {}   // clear → calendar's native colour
    return 'native';
  }
  var enumVal = CalendarApp.EventColor[name];
  if (!enumVal) {                                     // defensive: never call setColor(undefined)
    enumVal = CalendarApp.EventColor.MAUVE;
    name = 'MAUVE(fallback)';
  }
  calAppEvent.setColor(enumVal);
  return name;
}

// ─── BUSY SYNC ────────────────────────────────────────────────────────────────

function runBusySync() {
  var cfg = loadConfig_();
  var res = { created:0, skipped:0, log:[] };
  var now = new Date(), end = new Date(now.getTime() + cfg.syncDaysAhead*86400000);

  var pc = CalendarApp.getCalendarById(cfg.personalCalendarId);
  if (!pc) return { error:'Cannot access Play calendar. Check the ID in Settings.' };
  var wc = CalendarApp.getCalendarById(cfg.workCalendarId);
  if (!wc) return { error:'Cannot access work calendar. Check the ID in Settings.' };

  // Existing synced fingerprints (base IDs)
  var seen = {};
  wc.getEvents(now, end).forEach(function(e) {
    var d = e.getDescription() || '';
    if (e.getTitle() === 'Busy' && d.indexOf('synced:') === 0) {
      var parts = d.replace('synced:','').trim().split(':');
      if (parts.length >= 2) {
        var base = parts.slice(1).join(':').split('@')[0].split('_')[0];
        seen[parts[0] + ':' + base] = true;
      }
    }
  });

  pc.getEvents(now, end).forEach(function(ev) {
    var title = ev.getTitle(), start = ev.getStartTime(), dow = start.getDay();
    if (ev.isAllDayEvent())                              { res.skipped++; res.log.push({type:'skip', msg:'All-day skipped: '+title}); return; }
    if (dow === 0 || dow === 6)                          { res.skipped++; res.log.push({type:'skip', msg:'Weekend skipped: '+title}); return; }

    // Only mirror events you've actually accepted, own, or created solo (no guests).
    // Skip declined, tentative/maybe, and unanswered invitations.
    var st = ev.getMyStatus();
    var acceptedOrMine = (st === null ||
                          st === CalendarApp.GuestStatus.OWNER ||
                          st === CalendarApp.GuestStatus.YES);
    if (!acceptedOrMine) {
      res.skipped++;
      var why = (st === CalendarApp.GuestStatus.NO) ? 'declined'
              : (st === CalendarApp.GuestStatus.MAYBE) ? 'maybe'
              : 'not accepted';
      res.log.push({type:'skip', msg:why.charAt(0).toUpperCase()+why.slice(1)+' skipped: '+title});
      return;
    }

    var base = ev.getId().split('@')[0].split('_')[0];
    var fp   = cfg.personalCalendarId + ':' + base;
    if (seen[fp]) { res.skipped++; res.log.push({type:'skip', msg:'Already synced: '+title}); return; }

    try {
      var b = wc.createEvent('Busy', start, ev.getEndTime(), { description:'synced: '+fp });
      try { setEventColor_(cfg.workCalendarId, b, cfg.colors.hold); } catch(ce) {}
      seen[fp] = true;
      res.created++;
      res.log.push({type:'ok', msg:'Created: '+title+' ('+fmt_(start)+')'});
    } catch(e) {
      res.log.push({type:'err', msg:'Failed: '+title+' — '+e.message});
    }
  });

  setLastRun_('busy');
  return res;
}

// ─── COLOUR CODING ────────────────────────────────────────────────────────────

function runColorCoding() {
  var cfg = loadConfig_();
  var res = { updated:0, skipped:0, log:[] };
  var now = new Date(), end = new Date(now.getTime() + cfg.syncDaysAhead*86400000);

  var wc = CalendarApp.getCalendarById(cfg.workCalendarId);
  if (!wc) return { error:'Cannot access work calendar.' };

  var me = Session.getActiveUser().getEmail();

  wc.getEvents(now, end).forEach(function(ev) {
    if (ev.isAllDayEvent()) { res.skipped++; return; }
    if (ev.getTitle() === 'Busy' && (ev.getDescription()||'').indexOf('synced:') === 0) {
      try {
        var ap = setEventColor_(cfg.workCalendarId, ev, cfg.colors.hold);
        res.updated++;
        res.log.push({type:'ok', msg:'Busy → '+ap+' [synced block]'});
      } catch(e) {
        res.log.push({type:'err', msg:'Busy — '+e.message});
      }
      return;
    }

    // Our own lunch block always uses the lunch colour (never the 'lunch' hold keyword)
    if (isManagedLunch_(ev)) {
      try {
        var lc = setEventColor_(cfg.workCalendarId, ev, cfg.lunch.color);
        res.updated++;
        res.log.push({type:'ok', msg:'Lunch → '+lc+' [managed lunch block]'});
      } catch(e) {
        res.log.push({type:'err', msg:'Lunch — '+e.message});
      }
      return;
    }

    var title = ev.getTitle().toLowerCase();
    var exception = hasException_(ev);
    var emails = attendeeEmails_(cfg.workCalendarId, ev, me);
    var hasConf = hasConferenceLink_(cfg.workCalendarId, ev);
    var cls = classify_(title, emails, cfg, hasConf, exception);

    try {
      var applied = setEventColor_(cfg.workCalendarId, ev, cls.color);
      res.updated++;
      res.log.push({type:'ok', msg:ev.getTitle()+' → '+applied+' ['+cls.reason+']'});
    } catch(e) {
      res.log.push({type:'err', msg:ev.getTitle()+' — '+e.message});
    }
  });

  setLastRun_('colour');
  return res;
}

// Resolve attendee emails (Advanced API first, CalendarApp fallback)
function attendeeEmails_(calendarId, ev, me) {
  var out = [];
  try {
    var id = ev.getId().split('@')[0].split('_')[0];
    var adv = Calendar.Events.get(calendarId, id);
    if (adv.attendees) {
      out = adv.attendees.map(function(a){ return (a.email||'').toLowerCase(); })
                         .filter(function(e){ return e && e !== me; });
    }
  } catch(err) {
    ev.getGuestList(true).forEach(function(g) {
      try { var e = g.getEmail().toLowerCase(); if (e && e !== me) out.push(e); } catch(e2) {}
    });
  }
  return out;
}

// '#exception' anywhere in an event's description turns off all keyword rules
// for that event, so it is coloured purely by who is attending.
function hasException_(ev) {
  try { return /#exception/i.test(ev.getDescription() || ''); } catch(e) { return false; }
}

// The Lunch block this script creates (not a lunch *meeting* someone else made).
function isManagedLunch_(ev) {
  return ev.getTitle() === 'Lunch' && (ev.getDescription() || '').indexOf('lunch-block') !== -1;
}

// STRUCTURE-FIRST CLASSIFICATION
// Reliable signal for meeting-type is WHO is in it, not what it's called.
// So: a few unambiguous intent keywords (focus, hold, reminder) win first;
// then anything WITH attendees is a meeting, classified by participants
// (external beats team); only events WITHOUT attendees fall back to the
// remaining keyword categories (priority, non-meeting) and finally default.
// hasConf = event has a Teams/Zoom link (we never use those internally, so it's external).
// exception = event description contains #exception, so all keyword rules are skipped.
function classify_(title, emails, cfg, hasConf, exception) {
  var k = cfg.keywords, c = cfg.colors;

  // 1. Unambiguous personal-intent blocks — override even if attendees exist
  if (!exception) {
    if (kw_(title, k.focus))    return { color:c.focus,    reason:'focus keyword' };
    if (kw_(title, k.hold))     return { color:c.hold,     reason:'hold keyword' };
    if (kw_(title, k.reminder)) return { color:c.reminder, reason:'reminder keyword' };
  }

  // 2. Teams/Zoom link → external (we only use those with outside parties)
  if (hasConf) return { color:c.external, reason:'Teams/Zoom link → external' };

  // 3. Has attendees → MEETING. Classify by WHO.
  if (emails.length) {
    var ext = 0, intl = 0;
    emails.forEach(function(e){ if (e.indexOf('@'+cfg.workDomain) !== -1) intl++; else ext++; });
    if (ext)  return { color:c.external, reason:ext +' external attendee(s)' };
    return { color:c.team, reason:intl +' DML attendee(s)' };
  }

  // 4. No attendees → solo block. Title keywords are now safe.
  if (!exception) {
    if (kw_(title, k.priority))   return { color:c.priority,   reason:'priority keyword (solo)' };
    if (kw_(title, k.nonmeeting)) return { color:c.nonmeeting, reason:'non-meeting keyword (solo)' };
  }

  return { color:c.default, reason: exception ? 'solo, #exception' : 'solo, no keyword match' };
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
// A slot is BUSY only if it's an accepted meeting (YES/OWNER) that is NOT focus time.
// Focus time, tentative, declined and unmarked events all count as FREE.

function runLunchScheduler() {
  var cfg = loadConfig_(), L = cfg.lunch;
  var res = { scheduled:0, moved:0, skipped:0, log:[] };
  if (!L.enabled) { setLastRun_('lunch'); return { scheduled:0, moved:0, skipped:0, log:[{type:'skip',msg:'Lunch scheduling is disabled.'}] }; }

  var wc = CalendarApp.getCalendarById(cfg.workCalendarId);
  if (!wc) return { error:'Cannot access work calendar.' };

  var now = new Date(), days = parseInt(L.daysAhead) || 7, dur = 60*60000;
  var ws = toMins_(L.windowStart), we = toMins_(L.windowEnd);

  for (var d = 0; d < days; d++) {
    var day = new Date(now.getTime() + d*86400000), dow = day.getDay();
    if (dow === 0 || dow === 6) continue;

    var dStart = new Date(day); dStart.setHours(Math.floor(ws/60), ws%60, 0, 0);
    var dEnd   = new Date(day); dEnd.setHours(Math.floor(we/60), we%60, 0, 0);

    var existing = null, busy = [];
    wc.getEvents(dStart, dEnd).forEach(function(ev) {
      if (ev.isAllDayEvent()) return;
      if (ev.getTitle() === 'Lunch' && (ev.getDescription()||'').indexOf('lunch-block') !== -1) { existing = ev; return; }
      var st = ev.getMyStatus();
      var accepted = (st === CalendarApp.GuestStatus.YES || st === CalendarApp.GuestStatus.OWNER);
      var isFocus  = kw_(ev.getTitle().toLowerCase(), cfg.keywords.focus);
      if (accepted && !isFocus) busy.push({ start:ev.getStartTime().getTime(), end:ev.getEndTime().getTime() });
    });

    var slot  = findSlot_(dStart.getTime(), dEnd.getTime(), dur, busy, L.prefer);
    var label = Utilities.formatDate(day, Session.getScriptTimeZone(), 'EEE dd MMM');

    if (!slot) {
      if (existing) { try { existing.deleteEvent(); } catch(e){} res.log.push({type:'skip', msg:label+': no free slot, removed lunch'}); }
      else          { res.log.push({type:'skip', msg:label+': no free slot'}); }
      res.skipped++;
      continue;
    }

    var ss = new Date(slot.start), se = new Date(slot.end);
    if (existing) {
      if (Math.abs(existing.getStartTime().getTime()-slot.start) < 60000) {
        res.log.push({type:'ok', msg:label+': already at '+hm_(ss)}); continue;
      }
      try { existing.setTime(ss, se); res.moved++; res.log.push({type:'ok', msg:label+': moved to '+hm_(ss)+'–'+hm_(se)}); }
      catch(e) { res.log.push({type:'err', msg:label+': '+e.message}); }
    } else {
      try {
        var nv = wc.createEvent('Lunch', ss, se, { description:'lunch-block: managed by Calendar Manager' });
        try { setEventColor_(cfg.workCalendarId, nv, L.color); } catch(ce){}
        res.scheduled++; res.log.push({type:'ok', msg:label+': created '+hm_(ss)+'–'+hm_(se)});
      } catch(e) { res.log.push({type:'err', msg:label+': '+e.message}); }
    }
  }

  setLastRun_('lunch');
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
  var cfg = loadConfig_();
  if (!cfg.slackToken) return { error:'No Slack token in Settings.' };
  var wc = CalendarApp.getCalendarById(cfg.workCalendarId);
  if (!wc) return { error:'Cannot access work calendar.' };

  var now = new Date(), soon = new Date(now.getTime()+60000);
  var t = now.getHours() + now.getMinutes()/60;
  var afterHours = (t < 9) || (t >= 18.5);

  var text = '', emoji = '', exp = 0;

  if (afterHours) {
    emoji = moon_(); text = 'After hours';
    var nine = new Date(now); if (t >= 18.5) nine.setDate(nine.getDate()+1);
    nine.setHours(9,0,0,0); exp = Math.floor(nine.getTime()/1000);
  } else {
    var evs = wc.getEvents(now, soon).filter(function(e) {
      return !e.isAllDayEvent() && e.getMyStatus() !== CalendarApp.GuestStatus.NO;
    });
    evs.sort(function(a,b) {
      var s = function(e){ return e.getMyStatus() === CalendarApp.GuestStatus.YES ? 0 : 1; };
      return s(a) - s(b);
    });
    if (evs.length) {
      var cur = evs[0], title = cur.getTitle(), low = title.toLowerCase();
      exp = Math.floor(cur.getEndTime().getTime()/1000);
      var isSynced = (title === 'Busy' && (cur.getDescription()||'').indexOf('synced:') === 0);
      if (kw_(low, cfg.keywords.focus))      { emoji=':headphones:'; text='In focus time'; }
      else if (isManagedLunch_(cur) || (low.indexOf('lunch') !== -1 && !hasException_(cur))) { emoji=':bento:'; text='At lunch'; }
      else if (isSynced)                     { emoji=':calendar:';   text='In a meeting'; }
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

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t){ ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runBusySync').timeBased().atHour(7).everyDays(1).inTimezone('Europe/Berlin').create();
  ScriptApp.newTrigger('runColorCoding').timeBased().atHour(7).everyDays(1).inTimezone('Europe/Berlin').create();
  ScriptApp.newTrigger('runLunchScheduler').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('updateSlackStatus').timeBased().everyMinutes(5).create();
  Logger.log('Triggers installed.');
}
