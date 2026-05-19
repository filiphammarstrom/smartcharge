'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { slotsNeeded } = require('./Scheduler');

const SYSTEM_PROMPT = `Du är en smart laddningsplanerare för en Tesla i Sverige.
Din uppgift är att välja exakt N laddningsfönster (à 15 min) från de tillgängliga prisfönstren.
N-värdet anges i meddelandet och är redan beräknat utifrån nuvarande batteri och laddningsmål.

## Regler
- Välj EXAKT N slots. Om N=0, returnera tom lista.
- Välj de N BILLIGASTE tillgängliga fönstren.
- Är batteriet under golv-nivån: välj de N NÄRMASTE fönstren (nödsituation, pris spelar ingen roll).
- Slots behöver INTE vara sammanhängande — OK att ladda 10:30 och sedan 14:00.
- Returnera slots i kronologisk ordning.
- Varje slot: start och end i ISO 8601 med offset, t.ex. "2026-05-17T17:00:00+02:00", end = start + 15 min.`;

class AIDecider {
  constructor({ apiKey, log, error }) {
    this._client = new Anthropic({ apiKey });
    this._log = log || console.log;
    this._error = error || console.error;
  }

  async plan({ currentBattery, floor, normalTarget, nextTrip, currentSlot, avg5day, futurePrices, chargerKw = 11, batteryKwh = 82, slotsNeeded: n }) {
    const now = new Date();
    const toSE = d => new Date(d).toLocaleString('sv-SE', {
      timeZone: 'Europe/Stockholm',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });

    const currentTarget = nextTrip ? nextTrip.targetPercent : normalTarget;
    const pctNeeded = Math.max(0, currentTarget - currentBattery).toFixed(1);

    const slots = nextTrip
      ? (futurePrices || []).filter(p => new Date(p.time_start) < nextTrip.departureTime)
      : (futurePrices || []).slice();

    const priceLines = slots.map(p => {
      const endTime = new Date(new Date(p.time_start).getTime() + 15 * 60000);
      return `${toSE(p.time_start)}–${toSE(endTime)}  ${p.price.toFixed(4)} SEK/kWh`;
    }).join('\n');

    let tripStr = 'Ingen';
    if (nextTrip) {
      const hoursUntil = Math.round((nextTrip.departureTime - now) / 3600000);
      const slotsAvail = Math.floor((nextTrip.departureTime - now) / (15 * 60000));
      tripStr = `Avgång ${toSE(nextTrip.departureTime)} (om ${hoursUntil}h), mål ${nextTrip.targetPercent}%, ${slotsAvail} slots kvar`;
    }

    const userMessage =
      `Tid nu: ${toSE(now)}\n` +
      `Batteri: ${currentBattery}% → Mål: ${currentTarget}% (behöver +${pctNeeded}%)\n` +
      `Antal slots att välja (N): ${n}\n` +
      `Golv (nöd): ${floor}%\n` +
      `5-dagarssnitt: ${avg5day ? avg5day.toFixed(4) + ' SEK/kWh' : 'okänt'}\n` +
      `Nästa resa: ${tripStr}\n\n` +
      `Tillgängliga prisfönster (${slots.length} st):\n` +
      `${priceLines || '(inga priser tillgängliga)'}`;

    const response = await this._client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [
        {
          name: 'set_charging_schedule',
          description: 'Returnerar det planerade laddningsschemat',
          input_schema: {
            type: 'object',
            properties: {
              slots: {
                type: 'array',
                description: 'Lista av laddningsfönster i kronologisk ordning',
                items: {
                  type: 'object',
                  properties: {
                    start: { type: 'string', description: 'Starttid ISO 8601' },
                    end:   { type: 'string', description: 'Sluttid ISO 8601 (start + 15 min)' },
                  },
                  required: ['start', 'end'],
                },
              },
              reason: { type: 'string', description: 'Kort motivering på svenska (max 100 tecken)' },
            },
            required: ['slots', 'reason'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'set_charging_schedule' },
      messages: [{ role: 'user', content: userMessage }],
    });

    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse) throw new Error('AI returnerade inget schema');

    const { slots: rawSlots, reason } = toolUse.input;
    const validSlots = (rawSlots || [])
      .map(s => ({ start: new Date(s.start), end: new Date(s.end) }))
      .filter(s => !isNaN(s.start) && !isNaN(s.end) && s.end > now);

    return { slots: validSlots, reason };
  }
}

module.exports = AIDecider;
