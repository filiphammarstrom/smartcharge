#!/usr/bin/env node
'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const https = require('https');
const http = require('http');

const HOMEY_URL   = (process.env.HOMEY_URL   || '').replace(/\/$/, '');
const HOMEY_TOKEN = process.env.HOMEY_TOKEN  || '';
const APP_PATH    = '/api/app/com.filiphammarstrom.teslacharging';

if (!HOMEY_URL || !HOMEY_TOKEN) {
  process.stderr.write('Sätt HOMEY_URL och HOMEY_TOKEN som miljövariabler.\n');
  process.exit(1);
}

// Known destinations from Stockholm (one-way km)
const DESTINATIONS = {
  'uppsala': 70, 'enköping': 85, 'enkoping': 85,
  'västerås': 110, 'vasteras': 110,
  'eskilstuna': 100, 'södertälje': 35, 'sodertalje': 35,
  'norrköping': 165, 'linköping': 200, 'linkoping': 200,
  'gävle': 180, 'gavle': 180, 'örebro': 200, 'orebro': 200,
  'jönköping': 320, 'jonkoping': 320,
  'sundsvall': 390, 'göteborg': 470, 'goteborg': 470,
  'malmö': 610, 'malmo': 610, 'umeå': 650, 'umea': 650,
  'stockholm': 0,
};

function lookupDistance(destination) {
  const key = destination.toLowerCase().trim();
  return DESTINATIONS[key] || null;
}

function homeyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = HOMEY_URL + APP_PATH + path;
    const url = new URL(fullUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${HOMEY_TOKEN}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          else resolve(parsed);
        } catch (e) { reject(new Error(`Ogiltigt svar: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'get_status',
    description: 'Hämtar aktuell status: batterinivå, laddstatus och senaste AI-beslut.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_prices',
    description: 'Hämtar kommande elpriser (upp till 36h framåt) med prisklass per slot.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_trip',
    description: 'Sätter en kommande bilresa. Ange destination ELLER distanceKm, plus avgångstid.',
    inputSchema: {
      type: 'object',
      properties: {
        destination:   { type: 'string', description: 'Destinationsstad, t.ex. "Göteborg"' },
        distanceKm:    { type: 'number', description: 'Avstånd från Stockholm i km (enkel väg), om destination är okänd' },
        departureTime: { type: 'string', description: 'Avgångstid ISO 8601, t.ex. "2026-05-17T08:00:00"' },
      },
      required: ['departureTime'],
    },
  },
  {
    name: 'delete_trip',
    description: 'Raderar den aktiva resan.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  if (name === 'get_status') {
    const s = await homeyRequest('GET', '/status');
    const d = s.lastDecision;
    const lines = [
      `Batteri: ${s.battery != null ? s.battery + '%' : '–'}`,
      `Laddar: ${d ? (d.shouldCharge ? 'Ja' : 'Nej') : '–'}`,
      `Mål: ${d ? d.target + '%' : '–'}`,
      `Senaste beslut: ${d ? d.reason : '–'}`,
      `Pris nu: ${d && d.currentPrice != null ? d.currentPrice.toFixed(4) + ' SEK/kWh (' + d.priceTier + ')' : '–'}`,
      `Uppdaterat: ${d ? new Date(d.updatedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) : '–'}`,
    ];
    if (s.nextTrip) {
      const dep = new Date(s.nextTrip.departureTime).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      lines.push(`Nästa resa: ${dep}, mål ${s.nextTrip.targetPercent}%${s.nextTrip.distanceKm ? ' (' + s.nextTrip.distanceKm + ' km)' : ''}`);
    } else {
      lines.push('Nästa resa: Ingen');
    }
    return lines.join('\n');
  }

  if (name === 'get_prices') {
    const p = await homeyRequest('GET', '/prices');
    const rows = (p.prices || []).slice(0, 20).map(slot => {
      const t = new Date(slot.time_start).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      const cur = slot.current ? ' ← nu' : '';
      return `${t}  ${slot.price.toFixed(4)} SEK/kWh  ${slot.tier}${cur}`;
    });
    return `5-dygnssnitt: ${p.avg5day ? p.avg5day.toFixed(4) + ' SEK/kWh' : '–'}\n\n${rows.join('\n')}`;
  }

  if (name === 'set_trip') {
    const { destination, departureTime } = args;
    let { distanceKm } = args;

    if (!departureTime) throw new Error('departureTime krävs');

    if (!distanceKm && destination) {
      distanceKm = lookupDistance(destination);
      if (!distanceKm) throw new Error(`Okänt avstånd för "${destination}". Ange distanceKm manuellt.`);
    }
    if (!distanceKm) throw new Error('Ange destination eller distanceKm');

    const result = await homeyRequest('POST', '/trip', { departureTime, distanceKm: Number(distanceKm) });
    const dep = new Date(result.trip.departureTime).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `Resa satt: ${destination || distanceKm + ' km'} — avgång ${dep}, mål ${result.trip.targetPercent}%`;
  }

  if (name === 'delete_trip') {
    await homeyRequest('DELETE', '/trip');
    return 'Resa raderad.';
  }

  throw new Error(`Okänt verktyg: ${name}`);
}

async function main() {
  const server = new Server(
    { name: 'tesla-smartcharge', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args } = req.params;
    try {
      const text = await callTool(name, args || {});
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Fel: ${e.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
