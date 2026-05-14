'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const PriceManager = require('./lib/PriceManager');
const { Scheduler } = require('./lib/Scheduler');

const DEFAULT_SETTINGS = {
  area: 'SE3',
  floor: 25,
  normalTarget: 50,
  autoCharge: true,
  chargerKw: 11,
  batteryKwh: 82,
  carRangeKm: 400,
};

const INTERVAL_MS = 15 * 60 * 1000;

function distanceToTargetPercent(distanceKm, carRangeKm) {
  const roundTrip = distanceKm * 2;
  const needed = Math.ceil((roundTrip / carRangeKm) * 100) + 15;
  return Math.min(100, Math.max(20, needed));
}

class TeslaSmartChargingApp extends Homey.App {
  async onInit() {
    this.log('Tesla Smart Charging starting...');

    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });

    this._priceManager = new PriceManager(this.homey);
    this._nextTrip = null;
    this._lastCharging = null;
    this._lastDecision = null;
    this._teslaCarFound = false;
    this._teslaBatFound = false;
    this._lastChargeSet = null;
    this._lastChargeSetAt = null;
    this._lastCalendarSync = null;
    this._lastCableConnected = null;
    this._aiCache = null;

    this._registerFlowCards();
    this._restoreTrip();

    this.homey.setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() < 15) {
        this._priceManager.clearCache();
        this._aiCache = null;
        this.log('Price cache cleared (midnight)');
      }
      if (now.getHours() === 14 && now.getMinutes() < 15) {
        this._priceManager.clearCache();
        this._aiCache = null;
        this.log('Price cache cleared (new day-ahead prices available)');
        this._runScheduler().catch(e => this.error('Scheduler error after price refresh:', e));
      }
      if (now.getHours() === 6 && now.getMinutes() < 15) {
        const calUrl = this.homey.settings.get('calendarUrl');
        const apiKey = this.homey.settings.get('anthropicApiKey');
        if (calUrl && apiKey) {
          this.log('Auto calendar sync starting');
          this.syncCalendar().catch(e => this.error('Auto calendar sync failed:', e.message));
        }
      }
    }, INTERVAL_MS);

    await this._runScheduler();

    this.homey.setInterval(() => {
      this._runScheduler().catch(e => this.error('Scheduler error:', e));
    }, INTERVAL_MS);
  }

  async _runScheduler() {
    const settings = this._getSettings();

    if (this._nextTrip && this._nextTrip.departureTime <= new Date()) {
      this.log('Past trip expired, clearing');
      this._nextTrip = null;
      this.homey.settings.set('nextTrip', null);
    }

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

    let currentSlot, avg5day, futurePrices;
    try {
      [currentSlot, avg5day, futurePrices] = await Promise.all([
        this._priceManager.getCurrentSlotPrice(settings.area),
        this._priceManager.get5DayAverage(settings.area),
        this._priceManager.getFuturePrices(settings.area),
      ]);
    } catch (e) {
      this.error('Could not fetch prices:', e.message);
      return;
    }

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

    const currentTarget = this._nextTrip ? this._nextTrip.targetPercent : settings.normalTarget;
    const cableConnected = this._lastCableConnected !== false; // optimistic default
    const alreadyAtTarget = currentBattery >= currentTarget;
    const noPrices = !currentSlot;

    const apiKey = this.homey.settings.get('anthropicApiKey');
    let decision;
    if (apiKey && !alreadyAtTarget && cableConnected && !noPrices) {
      const tier = currentSlot ? this._priceManager.classifyPrice(currentSlot.price, avg5day) : null;
      const batteryBucket = Math.floor(currentBattery / 5) * 5;
      const tripKey = this._nextTrip ? this._nextTrip.departureTime.toISOString() : 'none';
      const cacheKey = `${tier}|${batteryBucket}|${tripKey}`;
      const useCache = this._aiCache && this._aiCache.key === cacheKey;

      if (useCache) {
        this.log('[AI] Conditions unchanged, reusing cached decision');
        decision = this._aiCache.decision;
      } else {
        try {
          const AIDecider = require('./lib/AIDecider');
          const ai = new AIDecider({ apiKey, log: this.log.bind(this), error: this.error.bind(this) });
          decision = await ai.decide({
            currentBattery,
            floor: settings.floor,
            normalTarget: settings.normalTarget,
            nextTrip: this._nextTrip,
            currentSlot,
            avg5day,
            futurePrices,
            chargerKw: settings.chargerKw,
            batteryKwh: settings.batteryKwh,
          });
          this._aiCache = { key: cacheKey, decision };
          this.log('[AI] decision:', JSON.stringify(decision));
        } catch (e) {
          this.error('[AI] failed, falling back to scheduler:', e.message);
          decision = scheduler.decide();
        }
      }
    } else {
      decision = scheduler.decide();
    }

    const priceStr = currentSlot ? currentSlot.price.toFixed(4) : 'n/a';
    const avgStr = avg5day ? avg5day.toFixed(4) : 'n/a';
    const tier = currentSlot ? this._priceManager.classifyPrice(currentSlot.price, avg5day) : 'n/a';

    this.log(
      `[Scheduler] battery=${currentBattery}% tier=${tier} price=${priceStr} avg=${avgStr} ` +
      `target=${decision.target}% → ${decision.shouldCharge ? 'CHARGE' : 'STOP'} (${decision.reason})`
    );

    this._lastDecision = {
      ...decision,
      currentBattery,
      currentPrice: currentSlot ? currentSlot.price : null,
      priceTier: tier,
      avg5day,
      updatedAt: new Date().toISOString(),
    };

    try {
      if (decision.shouldCharge !== this._lastChargeSet) {
        await this._setTeslaCharging(decision.shouldCharge);
      } else {
        this.log(`charging_on unchanged (${decision.shouldCharge}), skipping`);
      }
    } catch (e) {
      this.error('Could not set Tesla charging state:', e.message);
    }

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
  }

  // ---------------------------------------------------------------------------
  // Tesla devices via HomeyAPI
  // ---------------------------------------------------------------------------

  async _getTeslaCarDevice() {
    const devices = await this.homeyApi.devices.getDevices();
    const car = Object.values(devices).find(
      d => d.driverId === 'homey:app:com.tesla.car:car'
    );
    this._teslaCarFound = car != null;
    if (!car) throw new Error('No Tesla car device found');
    return car;
  }

  async _getTeslaBatteryDevice() {
    const devices = await this.homeyApi.devices.getDevices();
    const bat = Object.values(devices).find(
      d => d.driverId === 'homey:app:com.tesla.car:battery'
    );
    this._teslaBatFound = bat != null;
    if (!bat) throw new Error('No Tesla battery device found');
    return bat;
  }

  async _getTeslaBattery() {
    const car = await this._getTeslaCarDevice();
    const cap = car.capabilitiesObj && car.capabilitiesObj.measure_battery;
    if (!cap) throw new Error('measure_battery capability not found');
    return cap.value;
  }

  async _setTeslaCharging(enabled) {
    const bat = await this._getTeslaBatteryDevice();
    const caps = bat.capabilitiesObj || {};
    const chargingPort = caps.charging_port ? caps.charging_port.value : null;
    const chargingCable = caps.charging_port_cable ? caps.charging_port_cable.value : null;

    this._lastCableConnected = !!(chargingPort || chargingCable);
    this.log(`Charging device: port=${chargingPort}, cable=${chargingCable}`);

    if (enabled && !this._lastCableConnected) {
      this.log('Skipping: cable not connected');
      return;
    }

    await bat.setCapabilityValue('charging_on', enabled);
    this._lastChargeSet = enabled;
    this._lastChargeSetAt = new Date().toISOString();
    this.log(`Tesla charging_on set to: ${enabled}`);
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
        const dep = new Date(args.departureTime);
        if (isNaN(dep.getTime())) throw new Error('Invalid departureTime');
        this._setTrip(dep, Number(args.targetPercent));
        await this._runScheduler();
      });
  }

  async _triggerCard(id) {
    await this.homey.flow.getTriggerCard(id).trigger();
  }

  // ---------------------------------------------------------------------------
  // API handlers
  // ---------------------------------------------------------------------------

  async getStatus() {
    const settings = this._getSettings();
    const safeSettings = { ...settings };

    let battery = null;
    try {
      battery = await this._getTeslaBattery();
    } catch (_) {}

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
        ? {
            departureTime: this._nextTrip.departureTime.toISOString(),
            targetPercent: this._nextTrip.targetPercent,
            distanceKm: this._nextTrip.distanceKm || null,
          }
        : null,
      settings: safeSettings,
      aiEnabled: !!this.homey.settings.get('anthropicApiKey'),
      calendarSync: this._lastCalendarSync || null,
    };
  }

  async getPrices() {
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

  async setTrip(body) {
    const { departureTime, targetPercent, distanceKm } = body || {};
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
    if (pct < 20 || pct > 100) throw new Error('targetPercent must be 20-100');

    this._setTrip(dep, pct, distanceKm != null ? Number(distanceKm) : null);
    this._runScheduler().catch(e => this.error(e));
    return {
      ok: true,
      trip: {
        departureTime: dep.toISOString(),
        targetPercent: pct,
        distanceKm: distanceKm || null,
      },
    };
  }

  async syncCalendar() {
    const apiKey = this.homey.settings.get('anthropicApiKey');
    if (!apiKey) throw new Error('Ingen API-nyckel inlagd');

    const calendarUrl = this.homey.settings.get('calendarUrl');
    if (!calendarUrl) throw new Error('Ingen kalender-URL inlagd');

    const CalendarSync = require('./lib/CalendarSync');
    const cs = new CalendarSync({ apiKey, log: this.log.bind(this), error: this.error.bind(this) });
    const trip = await cs.sync(calendarUrl);

    this._lastCalendarSync = { syncedAt: new Date().toISOString(), found: trip != null };

    if (trip) {
      const settings = this._getSettings();
      const pct = distanceToTargetPercent(trip.distanceKm, settings.carRangeKm);
      this._setTrip(trip.departureTime, pct, trip.distanceKm);
      this.log(`[Calendar] Resa hittad: ${trip.eventName} → ${trip.destination} (${trip.distanceKm} km) @ ${pct}%`);
      this._runScheduler().catch(e => this.error(e));
      return { ok: true, trip: { eventName: trip.eventName, destination: trip.destination, distanceKm: trip.distanceKm, departureTime: trip.departureTime.toISOString(), targetPercent: pct, confidence: trip.confidence } };
    }

    this.log('[Calendar] Ingen resa hittad');
    return { ok: true, trip: null };
  }

  async deleteTrip() {
    this._nextTrip = null;
    this.homey.settings.set('nextTrip', null);
    this._runScheduler().catch(e => this.error(e));
    return { ok: true };
  }

  async updateSettings(body) {
    const allowed = ['area', 'floor', 'normalTarget', 'autoCharge', 'chargerKw', 'batteryKwh', 'carRangeKm'];
    const current = this._getSettings();
    for (const key of allowed) {
      if (body[key] !== undefined) current[key] = body[key];
    }
    this.homey.settings.set('appSettings', current);

    if (body.anthropicApiKey !== undefined) {
      this.homey.settings.set('anthropicApiKey', body.anthropicApiKey || null);
    }

    if (body.calendarUrl !== undefined) {
      this.homey.settings.set('calendarUrl', body.calendarUrl || null);
    }

    return { ok: true, settings: current };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _setTrip(departureTime, targetPercent, distanceKm) {
    this._nextTrip = { departureTime, targetPercent, distanceKm: distanceKm || null };
    this.homey.settings.set('nextTrip', {
      departureTime: departureTime.toISOString(),
      targetPercent,
      distanceKm: distanceKm || null,
    });
    this.log(`Trip set: ${departureTime.toISOString()} @ ${targetPercent}%`);
  }

  _restoreTrip() {
    const stored = this.homey.settings.get('nextTrip');
    if (stored && stored.departureTime) {
      const dep = new Date(stored.departureTime);
      if (dep > new Date()) {
        this._nextTrip = {
          departureTime: dep,
          targetPercent: stored.targetPercent,
          distanceKm: stored.distanceKm || null,
        };
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
