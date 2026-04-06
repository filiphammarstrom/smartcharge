'use strict';

/**
 * Charging rate per 15-minute slot, depending on current battery level.
 * These are approximations — actual rate tapers as battery fills.
 */
function slotChargePercent(batteryLevel) {
  if (batteryLevel < 50) return 5.0;
  if (batteryLevel < 70) return 3.0;
  if (batteryLevel < 80) return 2.0;
  return 1.5;
}

/**
 * Estimates how many 15-min slots are needed to charge from `from` to `to` percent.
 */
function slotsNeeded(from, to) {
  let slots = 0;
  let level = from;
  while (level < to && slots < 200) {
    level += slotChargePercent(level);
    slots++;
  }
  return slots;
}

class Scheduler {
  /**
   * @param {object} opts
   * @param {number}      opts.currentBattery   - Current battery %
   * @param {number}      opts.floor            - Absolute minimum % (default 25)
   * @param {number}      opts.normalTarget     - Normal sweet-spot target % (default 50)
   * @param {object|null} opts.nextTrip         - { departureTime: Date, targetPercent: number }
   * @param {object}      opts.currentSlot      - { time_start, time_end, price } for now
   * @param {number}      opts.avg5day          - 5-day rolling average price (SEK/kWh)
   * @param {Array}       opts.futurePrices     - Future price slots until end of tomorrow
   * @param {object}      opts.priceManager     - PriceManager instance
   */
  constructor(opts) {
    this.currentBattery = opts.currentBattery;
    this.floor = opts.floor ?? 25;
    this.normalTarget = opts.normalTarget ?? 50;
    this.nextTrip = opts.nextTrip || null;
    this.currentSlot = opts.currentSlot;
    this.avg5day = opts.avg5day;
    this.futurePrices = opts.futurePrices || [];
    this.priceManager = opts.priceManager;
  }

  /**
   * Main decision method.
   * Returns { shouldCharge: boolean, target: number, reason: string }
   */
  decide() {
    const battery = this.currentBattery;

    // --- 1. Hard floor: charge immediately if below minimum ---
    if (battery < this.floor) {
      return { shouldCharge: true, target: this.floor, reason: 'below_floor' };
    }

    // --- 2. Determine base target from current price tier ---
    const tier = this._priceTier();
    const baseTarget = this._targetForTier(tier);

    // --- 3. Trip mode ---
    if (this.nextTrip) {
      const result = this._tripDecision(baseTarget, tier);
      if (result) return result;
    }

    // --- 4. Normal mode ---
    if (battery >= baseTarget) {
      return { shouldCharge: false, target: baseTarget, reason: `${tier.toLowerCase()}_target_reached` };
    }

    return { shouldCharge: true, target: baseTarget, reason: `${tier.toLowerCase()}_charging` };
  }

  // ---------------------------------------------------------------------------
  // Trip logic
  // ---------------------------------------------------------------------------

  _tripDecision(baseTarget, tier) {
    const { departureTime, targetPercent } = this.nextTrip;
    const now = new Date();
    const msUntil = departureTime - now;

    if (msUntil <= 0) return null; // trip is past, ignore

    const daysUntil = msUntil / 86400000;

    // Last 24h before departure: schedule cheapest slots regardless of tier
    if (daysUntil < 1) {
      return this._lastNightDecision(targetPercent);
    }

    // 1–2 days before: allow up to 65% if cheap/very_cheap
    // 2–4 days before: allow up to 60% if cheap/very_cheap
    // 4+ days before: normal logic
    let tripCeiling = null;
    if (daysUntil <= 2) tripCeiling = 65;
    else if (daysUntil <= 4) tripCeiling = 60;

    if (!tripCeiling) return null; // 4+ days away, use normal logic

    if (tier === 'EXPENSIVE' || tier === 'OK') {
      // Trip doesn't change expensive/ok behaviour — use normal base target
      if (this.currentBattery >= baseTarget) {
        return { shouldCharge: false, target: baseTarget, reason: 'trip_waiting_cheaper' };
      }
      return { shouldCharge: true, target: baseTarget, reason: `trip_${tier.toLowerCase()}_charging` };
    }

    // Cheap or very cheap: raise ceiling to tripCeiling
    const target = Math.max(baseTarget, tripCeiling);
    if (this.currentBattery >= target) {
      return { shouldCharge: false, target, reason: 'trip_ceiling_reached' };
    }
    return { shouldCharge: true, target, reason: `trip_pre_charge_${daysUntil <= 2 ? '1_2d' : '3_4d'}` };
  }

  /**
   * Last 24h: pick the cheapest N slots between now and departure.
   * Charge if we're currently in one of those slots.
   */
  _lastNightDecision(tripTarget) {
    const needed = slotsNeeded(this.currentBattery, tripTarget);

    if (needed <= 0) {
      return { shouldCharge: false, target: tripTarget, reason: 'trip_target_reached' };
    }

    const windowPrices = this.futurePrices.filter(
      p => p.time_start < this.nextTrip.departureTime
    );

    if (windowPrices.length === 0) {
      // No data — charge now to be safe
      return { shouldCharge: true, target: tripTarget, reason: 'trip_no_price_data' };
    }

    const cheapSlots = this.priceManager.cheapestSlots(windowPrices, needed);
    const chargingNow = this.currentSlot
      ? cheapSlots.some(s => s.time_start.getTime() === this.currentSlot.time_start.getTime())
      : false;

    return {
      shouldCharge: chargingNow,
      target: tripTarget,
      reason: chargingNow ? 'trip_cheap_slot' : 'trip_waiting_for_cheaper_slot',
      scheduledSlots: cheapSlots.map(s => s.time_start.toISOString()),
    };
  }

  // ---------------------------------------------------------------------------
  // Price tier helpers
  // ---------------------------------------------------------------------------

  _priceTier() {
    if (!this.currentSlot) return 'EXPENSIVE'; // no data → conservative
    return this.priceManager.classifyPrice(this.currentSlot.price, this.avg5day);
  }

  /**
   * Base charging target for each price tier.
   * Tesla app enforces the hard upper cap (e.g. 80%).
   */
  _targetForTier(tier) {
    switch (tier) {
      case 'VERY_CHEAP': return 55; // sweet spot ceiling, Tesla app cap handles the rest
      case 'CHEAP':      return 50;
      case 'OK':         return 35;
      case 'EXPENSIVE':  return 25; // floor only — don't actively charge
      default:           return 25;
    }
  }
}

module.exports = { Scheduler, slotsNeeded, slotChargePercent };
