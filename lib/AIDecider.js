'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `Du är en smart laddningskontroller för en Tesla i Sverige.
Du fattar ett laddningsbeslut var 15:e minut baserat på spotpriset på el.

## Mål
- Håll batteriet nära normalTarget (vanligen 50%) för bra batterihälsa.
- Ladda helst när elen är billig. Om priset är högt nu men sjunker om några timmar — vänta.
- Är det dyrt HELA de kommande 36 timmarna och ingen resa är bokad: det är OK att låta
  batteriet ligga på golvet (t.ex. 20–25%) och vänta. Ladda INTE bara för att det är lågt.
- Ladda omedelbart om batteriet är UNDER golvet — det är nödsituation.

## Reseläge
- Om en resa är bokad: se till att bilen når resmålets batterinivå i god tid före avgång.
- Välj de billigaste tillgängliga slottarna inom tidsfönstret fram till avgång.
- Är det <36h till avgång och batteriet är långt under resmålet: ladda nu även om priset är högt —
  bättre att betala lite mer än att stå utan laddning.
- Är det >3 dagar kvar: använd normalprislogiken, höj taket lite vid billiga slots.

## Beslutslogik
1. Batteri under golvet → ladda omedelbart (nöd).
2. Resa inom 36h → välj billigaste slots för att nå resmålet.
3. Inga resor, normalpris (under snitt) → ladda mot normalTarget.
4. Inga resor, dyrt (över snitt) → ladda INTE även om batteri = golvet; vänta på billigare el.

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

    let tripStr = 'Ingen';
    if (nextTrip) {
      const hoursUntil = Math.round((nextTrip.departureTime - now) / 3600000);
      const distStr = nextTrip.distanceKm ? `, avstånd ${nextTrip.distanceKm} km` : '';
      tripStr = `Avgång ${toSE(nextTrip.departureTime)} (om ${hoursUntil}h), mål ${nextTrip.targetPercent}%${distStr}`;
    }

    // Whether any upcoming slot is cheap (to help AI reason about waiting)
    const cheapSoon = (futurePrices || []).some(p => avg5day && p.price < avg5day * 0.9);

    // Format all future prices compactly
    const slots = (futurePrices || []).slice();
    const priceLines = slots.map(p => {
      const t = new Date(p.time_start).toLocaleString('sv-SE', {
        timeZone: 'Europe/Stockholm',
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      return `${t}  ${p.price.toFixed(4)}`;
    }).join('\n');

    // Highlight cheapest upcoming slots
    const sorted = [...slots].sort((a, b) => a.price - b.price).slice(0, 8);
    const cheapLines = sorted.map(p =>
      `  ${toSE(p.time_start)}  ${p.price.toFixed(4)} SEK/kWh`
    ).join('\n');

    const userMessage =
      `Tid nu: ${toSE(now)}\n` +
      `Batteri: ${currentBattery}%\n` +
      `Golv (nödladdning): ${floor}%\n` +
      `Normalmål (batterihälsa): ${normalTarget}%\n` +
      `Aktuellt pris: ${priceStr}${diffPct}\n` +
      `5-dygnssnitt: ${avg5day ? avg5day.toFixed(4) + ' SEK/kWh' : 'okänt'}\n` +
      `Billigare el inom 36h: ${cheapSoon ? 'Ja' : 'Nej — dyrt hela perioden'}\n` +
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
