'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `Du är en smart laddningskontroller för en Tesla i Sverige.
Du fattar ett laddningsbeslut var 15:e minut baserat på spotpriset på el.

Övergripande mål:
1. Håll batteriet nära 50% i normalläge — det är bra för batterihälsan långsiktigt.
2. Ladda helst när elen är billig. Om priset just nu är högt men sjunker om några timmar, vänta.
3. Om en resa är planerad: se till att bilen når resmålets batterinivå i god tid före avgång.
   Välj de billigaste slottarna inom det tillgängliga tidsfönstret för att nå resmålet.
4. Ladda alltid om batteriet är under golvet (nödsituation).

Beslutslogik:
- Titta på hela prislistan, inte bara nuet. Är det billigare att vänta?
- I normalläge: ladda om batteri < 50% OCH priset är rimligt (under eller nära snittet).
  Undvik att ladda om priset är klart över snittet — vänta på billigare tillfälle.
- Med resa: beräkna om det finns tillräckligt med billiga slots kvar före avgång.
  Om det finns gott om tid och billigare slots väntar — vänta. Om det är bråttom — ladda nu.

Anropa set_charging_decision med ditt beslut och en kort motivering på svenska.`;

class AIDecider {
  constructor({ apiKey, log, error }) {
    this._client = new Anthropic({ apiKey });
    this._log = log || console.log;
    this._error = error || console.error;
  }

  async decide({ currentBattery, floor, normalTarget, nextTrip, currentSlot, avg5day, futurePrices }) {
    const now = new Date();
    const toSE = d => new Date(d).toLocaleString('sv-SE', {
      timeZone: 'Europe/Stockholm',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });

    const priceStr = currentSlot
      ? `${currentSlot.price.toFixed(4)} SEK/kWh`
      : 'okänt';

    const diffPct = currentSlot && avg5day
      ? ` (${((currentSlot.price - avg5day) / avg5day * 100).toFixed(0)}% vs snitt)`
      : '';

    const tripStr = nextTrip
      ? `Ja — avgång ${toSE(nextTrip.departureTime)}, mål ${nextTrip.targetPercent}%`
      : 'Ingen';

    // Format all future prices compactly; group consecutive equal-price slots
    const slots = (futurePrices || []).slice();
    const priceLines = slots.map(p => {
      const t = new Date(p.time_start).toLocaleString('sv-SE', {
        timeZone: 'Europe/Stockholm',
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      return `${t}  ${p.price.toFixed(4)}`;
    }).join('\n');

    // Highlight cheapest slots
    const sorted = [...slots].sort((a, b) => a.price - b.price).slice(0, 8);
    const cheapLines = sorted.map(p =>
      `  ${toSE(p.time_start)}  ${p.price.toFixed(4)} SEK/kWh`
    ).join('\n');

    const userMessage =
      `Tid nu: ${toSE(now)}\n` +
      `Batteri: ${currentBattery}%\n` +
      `Golv (nödladdning under): ${floor}%\n` +
      `Normalmål: ${normalTarget}%\n` +
      `Aktuellt pris: ${priceStr}${diffPct}\n` +
      `5-dygnssnitt: ${avg5day ? avg5day.toFixed(4) + ' SEK/kWh' : 'okänt'}\n` +
      `Nästa resa: ${tripStr}\n\n` +
      `De 8 billigaste kommande slottarna:\n${cheapLines || '(ingen data)'}\n\n` +
      `Alla kommande priser (${slots.length} slots, datum/tid → SEK/kWh):\n` +
      `${priceLines || '(ingen data)'}`;

    const response = await this._client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [
        {
          name: 'set_charging_decision',
          description: 'Sätter laddningsbeslutet för den aktuella 15-minutsslotten',
          input_schema: {
            type: 'object',
            properties: {
              shouldCharge: { type: 'boolean', description: 'Ladda nu?' },
              target: { type: 'number', description: 'Mål-batteri % (20–100)' },
              reason: { type: 'string', description: 'Kort motivering på svenska (max 100 tecken)' },
            },
            required: ['shouldCharge', 'target', 'reason'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'set_charging_decision' },
      messages: [{ role: 'user', content: userMessage }],
    });

    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse) throw new Error('AI returnerade inget laddningsbeslut');

    const { shouldCharge, target, reason } = toolUse.input;
    return {
      shouldCharge: Boolean(shouldCharge),
      target: Math.max(floor, Math.min(100, Number(target))),
      reason,
    };
  }
}

module.exports = AIDecider;
