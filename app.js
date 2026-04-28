'use strict';

const Homey = require('homey');
const PriceManager = require('./lib/PriceManager');
const { Scheduler } = require('./lib/Scheduler');

const DEFAULT_SETTINGS = {
  area: 'SE3',
  floor: 25,
  normalTarget: 50,
  autoCharge: true,
};

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

    this._registerFlowCards();
    this._restoreTrip();

    await this._logTeslaDevices();

    // Clear price cache at midnight
    this.homey.setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() < 15) {
        this._priceManager.clearCache();
        this.log('Price cache cleared');
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

    const scheduler = new Scheduler({
      currentBattery,
      floor: settings.floor,
      normalTarget: settings.normalTarget,
      nextTrip: this._nextTrip,
      currentSlot,
      avg5day,
      futurePrices,
      priceManager: this._priceManager,
    });

    const decision = scheduler.decide();
    const priceStr = currentSlot ? currentSlot.price.toFixed(4) : 'n/a';
    const avgStr = avg5day ? avg5day.toFixed(4) : 'n/a';
    const tier = currentSlot ? this._priceManager.classifyPrice(currentSlot.price, avg5day) : 'n/a';
    this.log(
      `[Scheduler] batteri=${currentBattery}% tier=${tier} pris=${priceStr} avg=${avgStr} ` +
      `mål=${decision.target}% → ${decision.shouldCharge ? 'LADDAR' : 'STOPPAR'} (${decision.reason})`
    );

    try {
      await this._setTeslaCharging(decision.shouldCharge);
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

  // App: "Tesla bil och energi" by Ronny Winkler (com.tesla.car)
  // We search by capability to be agnostic of internal driver naming.

  async _findTeslaDevice(capability) {
    const devices = await this.homey.devices.getDevices();
    return Object.values(devices).find(
      d => d.driverUri
        && d.driverUri.includes('com.tesla.car')
        && d.capabilitiesObj
        && capability in d.capabilitiesObj
    ) || null;
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
    return cap.value;
  }

  async _setTeslaCharging(enabled) {
    const bat = await this._getTeslaBatteryDevice();
    await bat.setCapabilityValue('charging_on', enabled);
    this._lastChargeSet = enabled;
    this._lastChargeSetAt = new Date().toISOString();
    this.log(`Tesla charging_on satt till: ${enabled}`);
  }

  async _logTeslaDevices() {
    // Log what's available on this.homey so we can diagnose SDK3 device access
    const homeyKeys = [
      ...Object.getOwnPropertyNames(this.homey),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(this.homey) || {}),
    ].filter((v, i, a) => a.indexOf(v) === i).sort();
    this.log('[Debug] this.homey properties:', homeyKeys.join(', '));
    this.log('[Debug] this.homey.devices:', typeof this.homey.devices, this.homey.devices == null ? '(null/undefined)' : '(exists)');
    this.log('[Debug] this.homey.drivers:', typeof this.homey.drivers, this.homey.drivers == null ? '(null/undefined)' : '(exists)');

    // Inspect drivers manager
    if (this.homey.drivers) {
      const driverMethods = [
        ...Object.getOwnPropertyNames(this.homey.drivers),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(this.homey.drivers) || {}),
      ].filter((v, i, a) => a.indexOf(v) === i && typeof this.homey.drivers[v] === 'function').sort();
      this.log('[Debug] this.homey.drivers methods:', driverMethods.join(', '));

      try {
        const drivers = await this.homey.drivers.getDrivers();
        const driverList = Object.values(drivers).map(d => `${d.id}(app:${d.appId || '?'})`).join(', ');
        this.log('[Debug] drivers found:', driverList || '(none)');
      } catch (e) {
        this.log('[Debug] drivers.getDrivers() failed:', e.message);
      }
    }

    // Inspect apps manager
    if (this.homey.apps) {
      const appMethods = [
        ...Object.getOwnPropertyNames(this.homey.apps),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(this.homey.apps) || {}),
      ].filter((v, i, a) => a.indexOf(v) === i && typeof this.homey.apps[v] === 'function').sort();
      this.log('[Debug] this.homey.apps methods:', appMethods.join(', '));
    }

    try {
      const devices = await this.homey.devices.getDevices();
      const teslaDevices = Object.values(devices).filter(
        d => d.driverUri && d.driverUri.includes('com.tesla.car')
      );
      if (teslaDevices.length === 0) {
        this.log('[Tesla] Inga enheter från com.tesla.car hittades i Homey');
        return;
      }
      for (const d of teslaDevices) {
        const caps = d.capabilitiesObj ? Object.keys(d.capabilitiesObj).join(', ') : '(inga)';
        this.log(`[Tesla] Enhet: "${d.name}" | driverId: ${d.driverId} | capabilities: ${caps}`);
      }
    } catch (e) {
      this.error('[Tesla] Kunde inte lista enheter:', e.message);
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
        // args.departureDate = "YYYY-MM-DD", args.departureTime = "HH:MM"
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
    let battery = null;
    try { battery = await this._getTeslaBattery(); } catch (_) {}
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
        ? { departureTime: this._nextTrip.departureTime.toISOString(), targetPercent: this._nextTrip.targetPercent }
        : null,
      settings,
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
    const { departureTime, targetPercent } = body;
    if (!departureTime || targetPercent == null) throw new Error('departureTime and targetPercent required');
    const dep = new Date(departureTime);
    if (isNaN(dep.getTime())) throw new Error('Invalid departureTime');
    const pct = Number(targetPercent);
    if (pct < 20 || pct > 100) throw new Error('targetPercent must be 20–100');
    this._setTrip(dep, pct);
    this._runScheduler().catch(e => this.error(e));
    return { ok: true, trip: { departureTime: dep.toISOString(), targetPercent: pct } };
  }

  async apiDeleteTrip() {
    this._nextTrip = null;
    this.homey.settings.set('nextTrip', null);
    this._runScheduler().catch(e => this.error(e));
    return { ok: true };
  }

  async apiPostSettings(body) {
    const allowed = ['area', 'floor', 'normalTarget', 'autoCharge'];
    const current = this._getSettings();
    for (const key of allowed) {
      if (body[key] !== undefined) current[key] = body[key];
    }
    this.homey.settings.set('appSettings', current);
    return { ok: true, settings: current };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _setTrip(departureTime, targetPercent) {
    this._nextTrip = { departureTime, targetPercent };
    this.homey.settings.set('nextTrip', {
      departureTime: departureTime.toISOString(),
      targetPercent,
    });
    this.log(`Trip set: ${departureTime.toISOString()} @ ${targetPercent}%`);
  }

  _restoreTrip() {
    const stored = this.homey.settings.get('nextTrip');
    if (stored && stored.departureTime) {
      const dep = new Date(stored.departureTime);
      if (dep > new Date()) {
        this._nextTrip = { departureTime: dep, targetPercent: stored.targetPercent };
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
