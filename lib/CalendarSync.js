'use strict';

const https = require('https');
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `Du är en assistent som analyserar kalenderhändelser för en Tesla-ägare i Stockholm, Sverige.
Din uppgift är att avgöra om någon av de kommande händelserna innebär en bilresa bort från hemmet.

Indikationer på en bilresa:
- Händelsenamn eller plats innehåller en stad/ort skild från Stockholm
- Händelsenamnet innehåller ord som "resa", "besök", "konferens", "träff" på annan ort
- Platsfältet innehåller en adress utanför Storstockholm

Indikationer på att det INTE är en bilresa:
- Möten utan plats (Zoom, Teams, telefon)
- Händelser i Stockholm-området
- Återkommande vardagshändelser (gym, lunch, möte på jobbet m.m.)

Kända avstånd från Stockholm (enkel väg):
Uppsala 70 km, Enköping 85 km, Västerås 110 km, Norrköping 165 km, Gävle 180 km,
Örebro 200 km, Linköping 200 km, Jönköping 320 km, Sundsvall 390 km,
Göteborg 470 km, Malmö 610 km, Umeå 650 km

Anropa identify_trip med ditt beslut. Hitta max en resa (den närmast i tid).
Om ingen resa hittades, sätt isTrip=false.`;

class CalendarSync {
  constructor({ apiKey, log, error }) {
    this._client = new Anthropic({ apiKey });
    this._log = log || console.log;
    this._error = error || console.error;
  }

  /**
   * Fetches the iCal URL, parses events for the next 7 days,
   * and uses AI to identify if any event is a car trip.
   * Returns { eventName, departureTime, distanceKm, destination, confidence } or null.
   */
  async sync(calendarUrl) {
    let icsData;
    try {
      icsData = await this._fetchIcs(calendarUrl);
    } catch (e) {
      throw new Error(`Kunde inte hämta kalender: ${e.message}`);
    }

    const events = this._parseEvents(icsData);
    const now = new Date();
    const cutoff = new Date(now.getTime() + 7 * 24 * 3600000);
    const upcoming = events.filter(e => e.start > now && e.start < cutoff);

    if (upcoming.length === 0) {
      this._log('[Calendar] Inga kommande händelser inom 7 dagar');
      return null;
    }

    this._log(`[Calendar] ${upcoming.length} händelse(r) inom 7 dagar — frågar AI`);
    return await this._identifyTrip(upcoming);
  }

  _fetchIcs(url) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          this._fetchIcs(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  _parseEvents(icsData) {
    // Unfold continuation lines (RFC 5545)
    const unfolded = icsData.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);

    const events = [];
    let current = null;

    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') {
        current = {};
      } else if (line === 'END:VEVENT' && current) {
        if (current.start) events.push(current);
        current = null;
      } else if (current) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).toUpperCase();
        const val = line.slice(colon + 1);

        if (key.startsWith('DTSTART')) current.start = this._parseDate(line);
        else if (key.startsWith('DTEND')) current.end = this._parseDate(line);
        else if (key === 'SUMMARY') current.summary = this._unescape(val);
        else if (key === 'LOCATION') current.location = this._unescape(val);
        else if (key === 'DESCRIPTION') current.description = this._unescape(val).slice(0, 200);
      }
    }

    return events.sort((a, b) => a.start - b.start);
  }

  _parseDate(line) {
    const match = line.match(/:(\d{8})(T(\d{6})(Z)?)?/);
    if (!match) return null;
    const [, date, , time = '000000', utc] = match;
    const iso = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${time.slice(0,2)}:${time.slice(2,4)}:00${utc ? 'Z' : ''}`;
    const d = new Date(iso);
    return isNaN(d) ? null : d;
  }

  _unescape(str) {
    return str.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ').replace(/\\\\/g, '\\');
  }

  async _identifyTrip(events) {
    const list = events.map((e, i) => {
      const d = e.start.toLocaleString('sv-SE', {
        timeZone: 'Europe/Stockholm', weekday: 'short',
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      let line = `${i + 1}. ${d} — ${e.summary || '(namnlös)'}`;
      if (e.location) line += ` · Plats: ${e.location}`;
      if (e.description) line += ` · Beskr: ${e.description}`;
      return line;
    }).join('\n');

    const response = await this._client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [
        {
          name: 'identify_trip',
          description: 'Rapportera om en bilresa hittades',
          input_schema: {
            type: 'object',
            properties: {
              isTrip:        { type: 'boolean', description: 'Är detta en bilresa?' },
              eventName:     { type: 'string',  description: 'Kalenderhandelens namn' },
              departureTime: { type: 'string',  description: 'Avgångstid ISO 8601 (Europe/Stockholm), t.ex. 2026-05-17T08:00:00' },
              distanceKm:    { type: 'number',  description: 'Avstånd från Stockholm, enkel väg (km)' },
              destination:   { type: 'string',  description: 'Destinationsstad' },
              confidence:    { type: 'string',  enum: ['high', 'medium', 'low'] },
            },
            required: ['isTrip'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'identify_trip' },
      messages: [{ role: 'user', content: `Kommande händelser:\n${list}\n\nFinns det en bilresa här?` }],
    });

    const tool = response.content.find(b => b.type === 'tool_use');
    if (!tool || !tool.input.isTrip) return null;

    const { eventName, departureTime, distanceKm, destination, confidence } = tool.input;
    if (!departureTime || !distanceKm) return null;

    const dep = new Date(departureTime);
    if (isNaN(dep)) return null;

    return { eventName, departureTime: dep, distanceKm: Number(distanceKm), destination, confidence };
  }
}

module.exports = CalendarSync;
