#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import https from 'https';
import http from 'http';

const BASE = (process.env.HOMEY_API_BASE || '').replace(/\/$/, '');
const TOKEN = process.env.HOMEY_TOKEN || '';

if (!BASE) {
  process.stderr.write('HOMEY_API_BASE is required\n');
  process.exit(1);
}

function homeyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (_) { resolve(raw); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'get_status',
    description: 'Hämta aktuell status: batteri-%, senaste laddningsbeslut, aktiv resa och inställningar.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_prices',
    description: 'Hämta kommande elpriser med prisnivå (VERY_CHEAP/CHEAP/NORMAL/EXPENSIVE/VERY_EXPENSIVE) per timme.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_trip',
    description: 'Sätt nästa resa. Ange antingen distanceKm (appen räknar ut mål-%) eller targetPercent direkt.',
    inputSchema: {
      type: 'object',
      properties: {
        departureTime: { type: 'string', description: 'Avgångstid ISO 8601, t.ex. 2026-05-20T08:00:00' },
        distanceKm:    { type: 'number', description: 'Avstånd enkel väg i km (appen räknar ut mål-%)' },
        targetPercent: { type: 'number', description: 'Mål-batteri % (20–100), används om distanceKm saknas' },
      },
      required: ['departureTime'],
    },
  },
  {
    name: 'delete_trip',
    description: 'Ta bort aktiv resa så att appen återgår till normalladdning.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sync_calendar',
    description: 'Synka iCal-kalendern och låt AI identifiera kommande bilresor. Sätter automatiskt nästa resa om en hittas.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_settings',
    description: 'Uppdatera appinställningar. Alla fält är valfria.',
    inputSchema: {
      type: 'object',
      properties: {
        area:         { type: 'string', enum: ['SE1','SE2','SE3','SE4'], description: 'Elområde' },
        floor:        { type: 'number', description: 'Golv-% (nödladdning under denna nivå)' },
        normalTarget: { type: 'number', description: 'Normal mål-% utan aktiv resa' },
        autoCharge:   { type: 'boolean', description: 'Aktivera/inaktivera automatisk laddning' },
        chargerKw:    { type: 'number', description: 'Laddeffekt i kW' },
        batteryKwh:   { type: 'number', description: 'Batterikapacitet i kWh' },
        carRangeKm:   { type: 'number', description: 'Räckvidd vid 100% i km' },
      },
    },
  },
];

const server = new Server(
  { name: 'tesla-smartcharge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    let result;

    if (name === 'get_status') {
      result = await homeyRequest('GET', '/status');
    } else if (name === 'get_prices') {
      result = await homeyRequest('GET', '/prices');
    } else if (name === 'set_trip') {
      result = await homeyRequest('POST', '/trip', args);
    } else if (name === 'delete_trip') {
      result = await homeyRequest('DELETE', '/trip');
    } else if (name === 'sync_calendar') {
      result = await homeyRequest('POST', '/calendar-sync');
    } else if (name === 'update_settings') {
      result = await homeyRequest('POST', '/settings', args);
    } else {
      throw new Error(`Okänt verktyg: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Fel: ${e.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
