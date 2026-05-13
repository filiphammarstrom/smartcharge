'use strict';

const Homey = require('homey');
const PriceManager = require('./lib/PriceManager');
const { Scheduler } = require('./lib/Scheduler');
const AIDecider = require('./lib/AIDecider');
const CalendarSync = require('./lib/CalendarSync');

const DEFAULT_SETTINGS = {
  area: 'SE3',
  floor: 20,
  normalTarget: 50,
  autoCharge: true,
  apiKey: '',
  carRangeKm: 400,
  chargerKw: 11,
  batteryKwh: 82,
  calendarUrl: '',
};

// Calculates target battery % from trip distance.
// Assumes round trip + 15 % arrival buffer; capped at 100 %.
function distanceToTargetPercent(distanceKm, carRangeKm) {
  const roundTrip = distanceKm * 2;
  const needed = Math.ceil((roundTrip / carRangeKm) * 100) + 15;
  return Math.min(100, Math.max(20, needed));
}

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

class TeslaSmartChargingApp extends Homey.App {
  async onInit() {
    this.log('Tesla Smart Charging starting...');

    this._priceManager = new PriceManager(this.homey);
    this._nextTrip = null;
    this._lastCharging = null;
    this._lastDecision = null;
    this._teslaCarFound = false;
    this._teslaBatFound = false;
    this._lastChargeSet = null;
    this._lastChargeSetAt = null;
    this._batteryCache = null;
    this._BATTERY_CACHE_MS = 5 * 60 * 1000;
    this._lastCalendarSync = null;  // { foundTrip, syncedAt }

    this._registerFlowCards();
    this._restoreTrip();

    await this._logTeslaDevices();

    // Clear price cache at midnight and at 14:00 when next-day prices are published
    this.homey.setInterval(() => {
      const now = new Date();
      const h = now.getHours();
      const m = now.getMinutes();
      if ((h === 0 || h === 14) && m < 15) {
        this._priceManager.clearCache();
        this.log('Price cache cleared');
        this._syncCalendar().catch(e => this.error('Calendar sync error:', e));
      }
    }, INTERVAL_MS);

    // Run immediately, then every 15 minutes
    await this._runScheduler();
    this.homey.setInterval(() => {
      this._runScheduler().catch(e => this.error('Scheduler error:', e));
    }, INTERVAL_MS);
  }

  async _runScheduler() {
    const settings = this._getSettings();
    if (!settings.autoCharge) {
      this.log('Auto charge disabled, skipping');
      return;
    }

    let currentBattery;
    try {
      currentBattery = await this._getTeslaBattery();
    } catch (e) {
      this.error('Could not read Tesla battery:', e.message);
      return;
    }

    const area = settings.area;

    let currentSlot, avg5day, futurePrices;
    try {
      [currentSlot, avg5day, futurePrices] = await Promise.all([
        this._priceManager.getCurrentSlotPrice(area),
        this._priceManager.get5DayAverage(area),
        this._priceManager.getFuturePrices(area),
      ]);
    } catch (e) {
      this.error('Could not fetch prices:', e.message);
      return;
    }

    let decision;
    const priceStr = currentSlot ? currentSlot.price.toFixed(4) : 'n/a';
    const avgStr = avg5day ? avg5day.toFixed(4) : 'n/a';
    const tier = currentSlot ? this._priceManager.classifyPrice(currentSlot.price, avg5day) : 'n/a';

    if (settings.apiKey) {
      try {
        const ai = new AIDecider({ apiKey: settings.apiKey, log: this.log.bind(this), error: this.error.bind(this) });
        decision = await ai.decide({ currentBattery, floor: settings.floor, normalTarget: settings.normalTarget, nextTrip: this._nextTrip, currentSlot, avg5day, futurePrices, chargerKw: settings.chargerKw, batteryKwh: settings.batteryKwh });
        this.log(
          `[AI] batteri=${currentBattery}% tier=${tier} pris=${priceStr} avg=${avgStr} ` +
          `mål=${decision.target}% → ${decision.shouldCharge ? 'LADDAR' : 'STOPPAR'} (${decision.reason})`
        );
      } catch (e) {
        this.error('[AI] Beslut misslyckades, faller tillbaka på regelbaserad scheduler:', e.message);
        decision = null;
      }
    }

    if (!decision) {
      const scheduler = new Scheduler({
        currentBattery,
        floor: settings.floor,
        normalTarget: settings.normalTarget,
        nextTrip: this._nextTrip,
        currentSlot,
        avg5day,
        futurePrices,
        priceManager: this._priceManager,
        chargerKw: settings.chargerKw,
        batteryKwh: settings.batteryKwh,
      });
      decision = scheduler.decide();
      this.log(
        `[Scheduler] batteri=${currentBattery}% tier=${tier} pris=${priceStr} avg=${avgStr} ` +
        `mål=${decision.target}% → ${decision.shouldCharge ? 'LADDAR' : 'STOPPAR'} (${decision.reason})`
      );
    }

    try {
      if (decision.shouldCharge !== this._lastChargeSet) {
        await this._setTeslaCharging(decision.shouldCharge);
      } else {
        this.log(`Tesla charging_on oförändrat (${decision.shouldCharge}), skippar API-anrop`);
      }
    } catch (e) {
      this.error('Could not set Tesla charging state:', e.message);
      return;
    }

    // Flow triggers on state transitions
    if (decision.shouldCharge && this._lastCharging === false) {
      this._triggerCard('cheap_charging_started').catch(e => this.error(e));
    }
    if (!decision.shouldCharge && this._lastCharging === true) {
      this._triggerCard('cheap_charging_ended').catch(e => this.error(e));
    }
    if (decision.reason === 'below_floor' && this._lastCharging !== true) {
      this._triggerCard('emergency_charging_activated').catch(e => this.error(e));
    }

    this._lastCharging = decision.shouldCharge;
    this._lastDecision = {
      ...decision,
      currentBattery,
      currentPrice: currentSlot ? currentSlot.price : null,
      priceTier: tier,
      avg5day,
      updatedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Tesla device – find by capability, not by driverId
  // ---------------------------------------------------------------------------

  async _findTeslaDevice(capability) {
    const teslaApp = await this.homey.apps.getApp('com.tesla.car');
    const drivers = await teslaApp.getDrivers();
    for (const driver of Object.values(drivers)) {
      const devices = await driver.getDevices();
      for (const device of Object.values(devices)) {
        if (device.capabilitiesObj && capability in device.capabilitiesObj) {
          return device;
        }
      }
    }
    return null;
  }

  async _getTeslaCarDevice() {
    const dev = await this._findTeslaDevice('measure_battery');
    this._teslaCarFound = dev !== null;
    if (!dev) throw new Error('Ingen Tesla-enhet med measure_battery hittades (com.tesla.car)');
    return dev;
  }

  async _getTeslaBatteryDevice() {
    const dev = await this._findTeslaDevice('charging_on');
    this._teslaBatFound = dev !== null;
    if (!dev) throw new Error('Ingen Tesla-enhet med charging_on hittades (com.tesla.car)');
    return dev;
  }

  async _getTeslaBattery() {
    const car = await this._getTeslaCarDevice();
    const cap = car.capabilitiesObj && car.capabilitiesObj['measure_battery'];
    if (!cap) throw new Error('measure_battery capability saknas på Tesla-bilenheten');
    this._batteryCache = { value: cap.value, ts: Date.now() };
    return cap.value;
  }

  _getCachedBattery() {
    if (this._batteryCache && (Date.now() - this._batteryCache.ts) < this._BATTERY_CACHE_MS) {
      return this._batteryCache.value;
    }
    return null;
  }

  async _setTeslaCharging(enabled) {
    const bat = await this._getTeslaBatteryDevice();
    await bat.setCapabilityValue('charging_on', enabled);
    this._lastChargeSet = enabled;
    this._lastChargeSetAt = new Date().toISOString();
    this.log(`Tesla charging_on satt till: ${enabled}`);
  }

  async _logTeslaDevices() {
    // Inspect this.homey.apps to find working method
    try {
      const allMethods = [];
      let proto = this.homey.apps;
      while (proto) {
        Object.getOwnPropertyNames(proto).forEach(n => { if (!allMethods.includes(n)) allMethods.push(n); });
        proto = Object.getPrototypeOf(proto);
      }
      this.log('[Debug] homey.apps methods:', allMethods.filter(n => typeof this.homey.apps[n] === 'function').sort().join(', '));
    } catch (e) {
      this.log('[Debug] homey.apps inspect failed:', e.message);
    }

    // Try getInstalled()
    try {
      const installed = await this.homey.apps.getInstalled();
      this.log('[Debug] getInstalled keys:', Object.keys(installed).join(', ').slice(0, 300));
      const teslaApp = installed['com.tesla.car'];
      if (!teslaApp) { this.log('[Debug] com.tesla.car not found in installed'); return; }
      this.log('[Debug] teslaApp type:', typeof teslaApp);
      const teslaMethods = [];
      let proto = teslaApp;
      while (proto) { Object.getOwnPropertyNames(proto).forEach(n => { if (!teslaMethods.includes(n)) teslaMethods.push(n); }); proto = Object.getPrototypeOf(proto); }
      this.log('[Debug] teslaApp methods:', teslaMethods.filter(n => typeof teslaApp[n] === 'function').sort().join(', '));
    } catch (e) {
      this.log('[Debug] getInstalled failed:', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------------

  _registerFlowCards() {
    this._cheapChargingStarted = this.homey.flow.getTriggerCard('cheap_charging_started');
    this._cheapChargingEnded = this.homey.flow.getTriggerCard('cheap_charging_ended');
    this._emergencyChargingActivated = this.homey.flow.getTriggerCard('emergency_charging_activated');

    this.homey.flow
      .getConditionCard('is_cheap_electricity')
      .registerRunListener(async () => {
        const settings = this._getSettings();
        const [slot, avg] = await Promise.all([
          this._priceManager.getCurrentSlotPrice(settings.area),
          this._priceManager.get5DayAverage(settings.area),
        ]);
        if (!slot) return false;
        const tier = this._priceManager.classifyPrice(slot.price, avg);
        return tier === 'CHEAP' || tier === 'VERY_CHEAP';
      });

    this.homey.flow
      .getActionCard('set_next_trip')
      .registerRunListener(async args => {
        const dep = new Date(`${args.departureDate}T${args.departureTime}:00`);
        this._setTrip(dep, args.targetPercent);
        await this._runScheduler();
      });
  }

  async _triggerCard(id) {
    await this.homey.flow.getTriggerCard(id).trigger();
  }

  // ---------------------------------------------------------------------------
  // API handlers – called from api.js (Homey SDK 3 pattern)
  // ---------------------------------------------------------------------------

  async apiGetStatus() {
    const settings = this._getSettings();
    const safeSettings = { ...settings, apiKey: settings.apiKey ? '••••••••' : '' };
    const battery = this._getCachedBattery();
    return {
      battery,
      teslaStatus: {
        carFound: this._teslaCarFound,
        batteryDeviceFound: this._teslaBatFound,
        lastChargeSet: this._lastChargeSet,
        lastChargeSetAt: this._lastChargeSetAt,
      },
      lastDecision: this._lastDecision,
      nextTrip: this._nextTrip
        ? { departureTime: this._nextTrip.departureTime.toISOString(), targetPercent: this._nextTrip.targetPercent, distanceKm: this._nextTrip.distanceKm ?? null }
        : null,
      settings: safeSettings,
      aiEnabled: Boolean(settings.apiKey),
      calendarSync: this._lastCalendarSync || null,
    };
  }

  async apiGetPrices() {
    const settings = this._getSettings();
    const [prices, avg] = await Promise.all([
      this._priceManager.getFuturePrices(settings.area),
      this._priceManager.get5DayAverage(settings.area),
    ]);
    return {
      avg5day: avg,
      prices: prices.map(p => ({
        time_start: p.time_start.toISOString(),
        time_end: p.time_end.toISOString(),
        price: p.price,
        tier: this._priceManager.classifyPrice(p.price, avg),
        current: this._priceManager.isCurrentSlot(p),
      })),
    };
  }

  async apiPostTrip(body) {
    const { departureTime, targetPercent, distanceKm } = body;
    if (!departureTime) throw new Error('departureTime required');
    const dep = new Date(departureTime);
    if (isNaN(dep.getTime())) throw new Error('Invalid departureTime');

    let pct;
    if (distanceKm != null) {
      const settings = this._getSettings();
      pct = distanceToTargetPercent(Number(distanceKm), settings.carRangeKm);
    } else if (targetPercent != null) {
      pct = Number(targetPercent);
    } else {
      throw new Error('distanceKm or targetPercent required');
    }
    if (pct < 20 || pct > 100) throw new Error('targetPercent must be 20–100');

    this._setTrip(dep, pct, distanceKm != null ? Number(distanceKm) : null);
    this._runScheduler().catch(e => this.error(e));
    return { ok: true, trip: { departureTime: dep.toISOString(), targetPercent: pct, distanceKm: distanceKm ?? null } };
  }

  async apiDeleteTrip() {
    this._nextTrip = null;
    this.homey.settings.set('nextTrip', null);
    this._runScheduler().catch(e => this.error(e));
    return { ok: true };
  }

  async apiPostSettings(body) {
    const allowed = ['area', 'floor', 'normalTarget', 'autoCharge', 'apiKey', 'carRangeKm', 'chargerKw', 'batteryKwh', 'calendarUrl'];
    const current = this._getSettings();
    for (const key of allowed) {
      if (body[key] !== undefined) current[key] = body[key];
    }
    this.homey.settings.set('appSettings', current);
    return { ok: true, settings: { ...current, apiKey: current.apiKey ? '••••••••' : '' } };
  }

  // ---------------------------------------------------------------------------
  // Calendar sync
  // ---------------------------------------------------------------------------

  async _syncCalendar() {
    const settings = this._getSettings();
    if (!settings.calendarUrl || !settings.apiKey) return;

    let trip;
    try {
      const sync = new CalendarSync({ apiKey: settings.apiKey, log: this.log.bind(this), error: this.error.bind(this) });
      trip = await sync.sync(settings.calendarUrl);
    } catch (e) {
      this.error('[Calendar] Synkfel:', e.message);
      this._lastCalendarSync = { foundTrip: null, syncedAt: new Date().toISOString(), error: e.message };
      return;
    }

    this._lastCalendarSync = {
      foundTrip: trip ? { eventName: trip.eventName, destination: trip.destination, distanceKm: trip.distanceKm, departureTime: trip.departureTime.toISOString(), confidence: trip.confidence } : null,
      syncedAt: new Date().toISOString(),
    };

    if (!trip) {
      this.log('[Calendar] Ingen resa hittad i kalender');
      return;
    }

    // Only set if no manual trip exists or calendar trip is sooner
    const shouldSet = !this._nextTrip || trip.departureTime < this._nextTrip.departureTime;
    if (!shouldSet) {
      this.log(`[Calendar] Resa hittad (${trip.destination}) men manuell resa är snarare — skippar`);
      return;
    }

    const pct = distanceToTargetPercent(trip.distanceKm, settings.carRangeKm);
    this._setTrip(trip.departureTime, pct, trip.distanceKm);
    this.log(`[Calendar] Resa satt: ${trip.destination} (${trip.distanceKm} km) → ${pct}% kl ${trip.departureTime.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}`);
    this._runScheduler().catch(e => this.error(e));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _setTrip(departureTime, targetPercent, distanceKm = null) {
    this._nextTrip = { departureTime, targetPercent, distanceKm };
    this.homey.settings.set('nextTrip', {
      departureTime: departureTime.toISOString(),
      targetPercent,
      distanceKm,
    });
    const distStr = distanceKm != null ? ` (${distanceKm} km)` : '';
    this.log(`Trip set: ${departureTime.toISOString()} @ ${targetPercent}%${distStr}`);
  }

  _restoreTrip() {
    const stored = this.homey.settings.get('nextTrip');
    if (stored && stored.departureTime) {
      const dep = new Date(stored.departureTime);
      if (dep > new Date()) {
        this._nextTrip = { departureTime: dep, targetPercent: stored.targetPercent, distanceKm: stored.distanceKm ?? null };
        this.log(`Restored trip: ${dep.toISOString()} @ ${stored.targetPercent}%`);
      }
    }
  }

  _getSettings() {
    const stored = this.homey.settings.get('appSettings') || {};
    return { ...DEFAULT_SETTINGS, ...stored };
  }
}

module.exports = TeslaSmartChargingApp;
