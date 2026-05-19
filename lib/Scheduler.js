'use strict';

// Physics-based AC charging taper model.
// 0–80 %: full rate, 80–90 %: 65 %, 90–100 %: 40 %.
function slotChargePercent(batteryLevel, chargerKw = 11, batteryKwh = 82) {
  const baseRate = (chargerKw / batteryKwh) * 100 * 0.25; // % per 15 min at full power
  if (batteryLevel < 80) return baseRate;
  if (batteryLevel < 90) return baseRate * 0.65;
  return baseRate * 0.40;
}

function slotsNeeded(from, to, chargerKw = 11, batteryKwh = 82) {
  let slots = 0;
  let level = from;
  while (level < to && slots < 200) {
    level += slotChargePercent(level, chargerKw, batteryKwh);
    slots++;
  }
  return slots;
}

class Scheduler {
  constructor(opts) {
    this.currentBattery = opts.currentBattery;
    this.floor = opts.floor ?? 20;
    this.normalTarget = opts.normalTarget ?? 50;
    this.nextTrip = opts.nextTrip || null;
    this.currentSlot = opts.currentSlot;
    this.avg5day = opts.avg5day;
    this.futurePrices = opts.futurePrices || [];
    this.priceManager = opts.priceManager;
    this.chargerKw = opts.chargerKw ?? 11;
    this.batteryKwh = opts.batteryKwh ?? 82;
  }

  planSlots(n) {
    if (n <= 0) return [];
    const now = new Date();
    const deadline = this.nextTrip
      ? this.nextTrip.departureTime
      : new Date(now.getTime() + 36 * 3600 * 1000);

    let available = this.futurePrices.filter(
      p => new Date(p.time_start) >= now && new Date(p.time_start) < deadline
    );
    if (this.currentSlot) {
      const cs = this.currentSlot;
      const csStart = new Date(cs.time_start);
      if (csStart < deadline && !available.some(p => new Date(p.time_start).getTime() === csStart.getTime())) {
        available = [cs, ...available];
      }
    }

    const isEmergency = this.currentBattery < this.floor;
    const chosen = isEmergency
      ? available.slice(0, n)
      : [...available].sort((a, b) => a.price - b.price).slice(0, n);

    return chosen
      .sort((a, b) => new Date(a.time_start) - new Date(b.time_start))
      .map(p => ({
        start: new Date(p.time_start),
        end: new Date(new Date(p.time_start).getTime() + 15 * 60000),
      }));
  }

  decide() {
    const battery = this.currentBattery;

    if (battery < this.floor) {
      return { shouldCharge: true, target: this.floor, reason: 'below_floor' };
    }

    const tier = this._priceTier();
    const baseTarget = this._targetForTier(tier);

    if (this.nextTrip) {
      const result = this._tripDecision(baseTarget, tier);
      if (result) return result;
    }

    if (battery >= baseTarget) {
      return { shouldCharge: false, target: baseTarget, reason: `${tier.toLowerCase()}_target_reached` };
    }
    return { shouldCharge: true, target: baseTarget, reason: `${tier.toLowerCase()}_charging` };
  }

  _tripDecision(baseTarget, tier) {
    const { departureTime, targetPercent } = this.nextTrip;
    const msUntil = departureTime - new Date();
    if (msUntil <= 0) return null;

    const daysUntil = msUntil / 86400000;

    if (daysUntil < 1) {
      return this._lastNightDecision(targetPercent, tier);
    }

    let tripCeiling = null;
    if (daysUntil <= 2) tripCeiling = 65;
    else if (daysUntil <= 4) tripCeiling = 60;

    if (!tripCeiling) return null;

    if (tier === 'EXPENSIVE' || tier === 'OK') {
      if (this.currentBattery >= baseTarget) {
        return { shouldCharge: false, target: baseTarget, reason: 'trip_waiting_cheaper' };
      }
      return { shouldCharge: true, target: baseTarget, reason: `trip_${tier.toLowerCase()}_charging` };
    }

    const target = Math.max(baseTarget, tripCeiling);
    if (this.currentBattery >= target) {
      return { shouldCharge: false, target, reason: 'trip_ceiling_reached' };
    }
    return { shouldCharge: true, target, reason: `trip_pre_charge_${daysUntil <= 2 ? '1_2d' : '3_4d'}` };
  }

  _lastNightDecision(tripTarget, tier) {
    const needed = slotsNeeded(this.currentBattery, tripTarget, this.chargerKw, this.batteryKwh);

    if (needed <= 0) {
      return { shouldCharge: false, target: tripTarget, reason: 'trip_target_reached' };
    }

    let windowPrices = this.futurePrices.filter(
      p => p.time_start < this.nextTrip.departureTime
    );

    // Include current slot if it falls before departure but isn't in futurePrices yet
    if (
      this.currentSlot &&
      this.currentSlot.time_start < this.nextTrip.departureTime &&
      !windowPrices.some(p => p.time_start.getTime() === this.currentSlot.time_start.getTime())
    ) {
      windowPrices = [this.currentSlot, ...windowPrices];
    }

    if (windowPrices.length === 0) {
      return { shouldCharge: true, target: tripTarget, reason: 'trip_no_price_data' };
    }

    // Not enough slots left to wait — charge now
    if (windowPrices.length <= needed) {
      return { shouldCharge: true, target: tripTarget, reason: 'trip_urgent_charge_now' };
    }

    // Price is already cheap — don't gamble on marginally cheaper slots
    if (tier === 'VERY_CHEAP' || tier === 'CHEAP') {
      return { shouldCharge: true, target: tripTarget, reason: 'trip_charge_now_price_is_good' };
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

  _priceTier() {
    if (!this.currentSlot) return 'EXPENSIVE';
    return this.priceManager.classifyPrice(this.currentSlot.price, this.avg5day);
  }

  _targetForTier(tier) {
    switch (tier) {
      case 'VERY_CHEAP': return 55;
      case 'CHEAP':      return 50;
      case 'OK':         return 35;
      case 'EXPENSIVE':  return 25;
      default:           return 25;
    }
  }
}

module.exports = { Scheduler, slotsNeeded, slotChargePercent };
