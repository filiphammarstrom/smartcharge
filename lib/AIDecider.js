'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are a smart charging controller for a Tesla car in Sweden.
You make a charging decision every 15 minutes based on real-time electricity spot prices.

Goal: minimize electricity cost while keeping the car usable.

Hard rules (always apply):
- If battery < floor → charge immediately, target = floor
- If a trip is scheduled → ensure the car reaches the trip target before departure

Soft rules:
- Charge during cheap slots (price well below 5-day average)
- Avoid charging during expensive slots unless battery is low
- Target battery should be between floor and normalTarget in normal operation

Call set_charging_decision with your decision.`;

class AIDecider {
  constructor({ apiKey, log, error }) {
    this._client = new Anthropic({ apiKey });
    this._log = log || console.log;
    this._error = error || console.error;
  }

  async decide({ currentBattery, floor, normalTarget, nextTrip, currentSlot, avg5day, futurePrices }) {
    const now = new Date();
    const toSE = d => new Date(d).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' });

    const priceStr = currentSlot
      ? `${currentSlot.price.toFixed(4)} SEK/kWh`
      : 'okänt';

    const diffStr = currentSlot && avg5day
      ? ` (${((currentSlot.price - avg5day) / avg5day * 100).toFixed(0)}% vs 5-dygnssnitt ${avg5day.toFixed(4)})`
      : '';

    const tripStr = nextTrip
      ? `Ja — avgång ${toSE(nextTrip.departureTime)}, mål ${nextTrip.targetPercent}%`
      : 'Ingen';

    const upcoming = (futurePrices || [])
      .slice(0, 16)
      .map(p => `  ${toSE(p.time_start)}: ${p.price.toFixed(4)} SEK/kWh`)
      .join('\n');

    const userMessage =
      `Tid: ${toSE(now)}\n` +
      `Batteri: ${currentBattery}%\n` +
      `Golv (minimum): ${floor}%\n` +
      `Normalmål: ${normalTarget}%\n` +
      `Aktuellt pris: ${priceStr}${diffStr}\n` +
      `Nästa resa: ${tripStr}\n\n` +
      `Kommande priser (4h):\n${upcoming || '(ingen data)'}`;

    const response = await this._client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [
        {
          name: 'set_charging_decision',
          description: 'Returnerar laddningsbeslutet för den här 15-minutsslotten',
          input_schema: {
            type: 'object',
            properties: {
              shouldCharge: { type: 'boolean', description: 'Ladda nu?' },
              target: { type: 'number', description: 'Mål-batteri % (20–100)' },
              reason: { type: 'string', description: 'Kort motivering (max 80 tecken)' },
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
